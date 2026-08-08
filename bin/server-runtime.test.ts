import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { loadFlows } from "@/lib/flows/store";
import { loadArchivedPipelines, loadPipelines } from "@/lib/pipelines/store";
import { structuredHostsEnabled as structuredHostsEnabledInApp } from "@/lib/runtime/flags";
import { loadWorkflows } from "@/lib/workflows/store";

import {
  structuredHostsEnabled as structuredHostsEnabledInLauncher,
  viewerServerBunRuntime,
  viewerChildProcessOptions,
  WAKATIME_CREDENTIAL_ENV,
  withoutWakatimeCredential,
} from "./server-runtime.mjs";

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
