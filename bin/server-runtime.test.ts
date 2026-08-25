import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { loadFlows } from "@/lib/flows/store";
import { loadArchivedPipelines, loadPipelines } from "@/lib/pipelines/store";
import { structuredHostsEnabled as structuredHostsEnabledInApp } from "@/lib/runtime/flags";
import { loadWorkflows } from "@/lib/workflows/store";
import { RuntimeHostFence } from "@/runtime-host/runtimeHostFence";

import {
  cliRuntimeHostConfig,
  cliRuntimeHostEnvironment,
  structuredHostsEnabled as structuredHostsEnabledInLauncher,
  viewerServerBunRuntime,
  viewerChildProcessOptions,
  WAKATIME_CREDENTIAL_ENV,
  withoutWakatimeCredential,
} from "./server-runtime.mjs";

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not reserve a launcher test port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

test("the CLI derives a distinct managed runtime host for each install", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-package-"));
  const firstPackageRoot = path.join(sandbox, "first");
  const secondPackageRoot = path.join(sandbox, "second");
  const stateDirectory = path.join(sandbox, "state");
  const ambientSocket = path.join(sandbox, "operator-runtime.sock");
  const firstBundle = path.join(firstPackageRoot, "dist", "runtime-host.mjs");
  const secondBundle = path.join(secondPackageRoot, "dist", "runtime-host.mjs");
  fs.mkdirSync(path.dirname(firstBundle), { recursive: true });
  fs.mkdirSync(path.dirname(secondBundle), { recursive: true });
  fs.writeFileSync(firstBundle, "export {};\n");
  fs.writeFileSync(secondBundle, "export {};\n");
  try {
    const options = {
      env: { LLV_STATE_DIR: stateDirectory, LLV_RUNTIME_HOST_SOCKET: ambientSocket },
      home: path.join(sandbox, "home"),
    };
    const first = cliRuntimeHostConfig(firstPackageRoot, options);
    const second = cliRuntimeHostConfig(secondPackageRoot, options);

    expect(first.entrypoint).toBe(firstBundle);
    expect(second.entrypoint).toBe(secondBundle);
    expect(path.dirname(first.socketPath)).toBe(stateDirectory);
    expect(path.dirname(second.socketPath)).toBe(stateDirectory);
    expect(path.basename(first.socketPath)).toMatch(/^runtime-host-[a-f0-9]{16}\.sock$/);
    expect(path.basename(second.socketPath)).toMatch(/^runtime-host-[a-f0-9]{16}\.sock$/);
    expect(first.socketPath).not.toBe(second.socketPath);
    expect(first.socketPath).not.toBe(ambientSocket);
    expect(second.socketPath).not.toBe(ambientSocket);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("the CLI uses the source runtime host in a checkout", () => {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-source-"));
  const source = path.join(packageRoot, "src", "runtime-host", "main.ts");
  const stateDirectory = path.join(packageRoot, "state");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, "export {};\n");
  try {
    const config = cliRuntimeHostConfig(packageRoot, {
      env: { LLV_STATE_DIR: stateDirectory },
      home: path.join(packageRoot, "home"),
    });
    expect(config.entrypoint).toBe(source);
    expect(path.dirname(config.socketPath)).toBe(stateDirectory);
  } finally {
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
});

test("the CLI runtime environment enables the host and strips ambient WakaTime credentials", () => {
  const socketPath = "/runtime/viewer.sock";
  const env: Record<string, string | undefined> = cliRuntimeHostEnvironment({
    PATH: "/usr/bin",
    LLV_STRUCTURED_HOSTS: "off",
    LLV_RUNTIME_EVENTS: "0",
    LLV_SPAWN_TRANSPORT: "tmux",
    NEXT_PUBLIC_RUNTIME_UI: "0",
    [WAKATIME_CREDENTIAL_ENV]: "fixture-value",
  }, socketPath);

  expect(env).toMatchObject({
    PATH: "/usr/bin",
    LLV_RUNTIME_HOST_SOCKET: socketPath,
    LLV_STRUCTURED_HOSTS: "1",
    LLV_RUNTIME_EVENTS: "1",
    LLV_SPAWN_TRANSPORT: "structured",
    NEXT_PUBLIC_RUNTIME_UI: "1",
  });
  expect(env[WAKATIME_CREDENTIAL_ENV]).toBeUndefined();
});

test("the CLI rejects a ready runtime socket owned by another process", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-incumbent-"));
  const packageRoot = path.resolve(import.meta.dir, "..");
  const stateDirectory = path.join(sandbox, "state");
  const environment: Record<string, string | undefined> = {
    ...process.env,
    HOME: path.join(sandbox, "home"),
    XDG_CONFIG_HOME: path.join(sandbox, "config"),
    LLV_STATE_DIR: stateDirectory,
    TMPDIR: path.join(sandbox, "tmp"),
    LLV_LANG: "en",
    LLV_RUNTIME_HOST_FENCE_WAIT_MS: "0",
  };
  const socketPath = cliRuntimeHostConfig(packageRoot, { env: environment, home: environment.HOME }).socketPath;
  const fence = new RuntimeHostFence(`${socketPath}.lock`);
  const listener = net.createServer((socket) => socket.end());
  fs.mkdirSync(environment.HOME!, { recursive: true });
  fs.mkdirSync(environment.XDG_CONFIG_HOME!, { recursive: true });
  fs.mkdirSync(environment.TMPDIR!, { recursive: true });
  fence.acquire();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(socketPath, resolve);
  });

  const child = Bun.spawn([
    process.execPath,
    "--bun",
    path.join(import.meta.dir, "cli.mjs"),
    "--no-open",
    "--port",
    String(await availablePort()),
  ], { cwd: packageRoot, env: environment, stdout: "pipe", stderr: "pipe" });
  try {
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Couldn't start the structured runtime host");
    expect(stderr).toContain(`runtime host socket is owned by pid ${process.pid}`);
    expect(stderr).toContain("stop the other agent-log-viewer instance");
  } finally {
    if (!child.killed) child.kill();
    await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    fence.release();
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}, 10_000);

test("the CLI names a missing Bun prerequisite before starting the Viewer", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-missing-bun-"));
  const nodeSearchPath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((directory) => !path.basename(directory).startsWith("bun-node-"))
    .join(path.delimiter);
  const nodeExecutable = Bun.which("node", { PATH: nodeSearchPath });
  if (!nodeExecutable) throw new Error("the launcher prerequisite test requires Node");
  const environment: Record<string, string | undefined> = {
    ...process.env,
    PATH: nodeSearchPath,
    HOME: path.join(sandbox, "home"),
    XDG_CONFIG_HOME: path.join(sandbox, "config"),
    LLV_STATE_DIR: path.join(sandbox, "state"),
    TMPDIR: path.join(sandbox, "tmp"),
    LLV_BUN_EXECUTABLE: path.join(sandbox, "missing-bun"),
  };
  delete environment.LLV_RUNTIME_HOST_SOCKET;
  const child = Bun.spawn([
    nodeExecutable,
    path.join(import.meta.dir, "cli.mjs"),
    "--no-open",
    "--port",
    String(await availablePort()),
  ], { cwd: path.resolve(import.meta.dir, ".."), env: environment, stdout: "pipe", stderr: "pipe" });
  try {
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain("Couldn't start the structured runtime host");
    expect(stderr).toContain("Bun executable");
    expect(stderr).toContain("is unavailable");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}, 10_000);

test("structured hosts select Bun for a CLI process launched by Node", () => {
  expect(viewerServerBunRuntime({
    env: { LLV_STRUCTURED_HOSTS: "1" },
    versions: { node: "20.9.0" },
    execPath: "/usr/bin/node",
  })).toBe("bun");
  expect(viewerServerBunRuntime({
    env: { LLV_STRUCTURED_HOSTS: "1", LLV_BUN_EXECUTABLE: "/opt/bun/bin/bun" },
    versions: { node: "20.9.0" },
    execPath: "/usr/bin/node",
  })).toBe("/opt/bun/bin/bun");
});

test("the packaged helper makes the same structured-runtime choice under Node", () => {
  const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), "server-runtime.mjs");
  const nodeSearchPath = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter((directory) => !path.basename(directory).startsWith("bun-node-"))
    .join(path.delimiter);
  const nodeExecutable = Bun.which("node", { PATH: nodeSearchPath });
  if (!nodeExecutable) throw new Error("the packaged runtime test requires Node");
  const probe = Bun.spawnSync([
    nodeExecutable,
    "--input-type=module",
    "--eval",
    `import { viewerServerBunRuntime } from ${JSON.stringify(pathToFileURL(helper).href)}; process.stdout.write(String(viewerServerBunRuntime()));`,
  ], {
    env: { ...process.env, PATH: nodeSearchPath, LLV_STRUCTURED_HOSTS: "1", LLV_BUN_EXECUTABLE: "/verified/bun" },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(probe.exitCode).toBe(0);
  expect(probe.stdout.toString()).toBe("/verified/bun");
});

/* Structured hosting is on by default, and it genuinely needs Bun (`bun:sqlite`
   journal, kernel start tokens on macOS). A launcher that still keyed on a
   literal "1" would run the default configuration under Node — where startup
   adoption throws the Darwin runtime requirement and the release controllers
   never start. */
test("an unset structured-hosts variable still selects Bun for the launcher", () => {
  expect(viewerServerBunRuntime({
    env: {},
    versions: { node: "20.9.0" },
    execPath: "/usr/bin/node",
  })).toBe("bun");
});

/* `bin/` is plain JS outside the TS build, so its predicate is a copy. This
   pins the copy to the original: one truth table, both readers. */
test.each([
  [undefined],
  [""],
  ["1"],
  ["0"],
  [" 0 "],
  ["\"0\""],
  ["'0'"],
  ["false"],
  ["OFF"],
  ["no"],
  ["yes"],
] as const)("the launcher mirror and the app definition agree on %p", (value) => {
  const env = value === undefined ? {} : { LLV_STRUCTURED_HOSTS: value };
  expect(structuredHostsEnabledInLauncher(env)).toBe(structuredHostsEnabledInApp(env));
  expect(viewerServerBunRuntime({ env, versions: { node: "20.9.0" }, execPath: "/usr/bin/node" }))
    .toBe("bun");
});

test("hot SQLite stores select Bun when optional Bun features are disabled", () => {
  expect(viewerServerBunRuntime({
    env: { LLV_AGENT_REGISTRY_SQLITE: "off", LLV_STRUCTURED_HOSTS: "0" },
    versions: { node: "20.9.0" },
    execPath: "/usr/bin/node",
  })).toBe("bun");
});

test("documented development and production scripts pin Bun and open every hot collection", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
    engines: Record<string, string>;
    scripts: Record<string, string>;
  };
  expect(packageJson.engines.bun).toBeTruthy();
  expect(packageJson.scripts.dev).toContain("bun --bun");
  expect(packageJson.scripts.start).toContain("bun --bun");

  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-bun-startup-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    expect(loadFlows()).toEqual([]);
    expect(loadPipelines()).toEqual([]);
    expect(loadArchivedPipelines()).toEqual([]);
    expect(loadWorkflows()).toEqual([]);
    const db = new Database(path.join(sandbox, "state.sqlite"), { readonly: true, strict: true });
    const collections = db.query<{ collection: string }, []>("SELECT collection FROM state_collections ORDER BY collection").all();
    db.close();
    expect(collections.map((row) => row.collection)).toEqual(["flows", "pipelines", "pipelines_archive", "workflows"]);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("Viewer child processes receive no ambient WakaTime key material", () => {
  const placeholder = ["child", "fixture", "value"].join("-");
  const env = withoutWakatimeCredential({
    PATH: process.env.PATH,
    KEEP_ME: "kept",
    [WAKATIME_CREDENTIAL_ENV]: placeholder,
  });
  const probe = Bun.spawnSync([
    process.execPath,
    "--eval",
    "process.stdout.write(JSON.stringify({ keep: process.env.KEEP_ME, key: process.env.WAKATIME_API_KEY ?? null }))",
  ], { env, stdout: "pipe", stderr: "pipe" });

  expect(probe.exitCode).toBe(0);
  expect(JSON.parse(probe.stdout.toString())).toEqual({ keep: "kept", key: null });
  expect(JSON.stringify(env)).not.toContain(placeholder);
});

test("published launcher child options capture no ambient WakaTime key material", () => {
  const placeholder = ["launcher", "fixture", "value"].join("-");
  const options = viewerChildProcessOptions({
    cwd: "/viewer",
    env: {
      PATH: process.env.PATH,
      KEEP_ME: "kept",
      [WAKATIME_CREDENTIAL_ENV]: placeholder,
    },
    stdio: "ignore",
  });

  expect(options.env.KEEP_ME).toBe("kept");
  expect(options.env[WAKATIME_CREDENTIAL_ENV]).toBeUndefined();
  expect(JSON.stringify(options)).not.toContain(placeholder);
});
