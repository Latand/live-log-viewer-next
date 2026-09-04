import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "bun:test";

const fixtures = new Set<string>();
const children = new Set<ReturnType<typeof spawn>>();
const listeners = new Set<net.Server>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  await Promise.all([...children].map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      Bun.sleep(3_000),
    ]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }));
  children.clear();
  await Promise.all([...listeners].map((listener) => new Promise<void>((resolve, reject) => {
    listener.close((error) => error ? reject(error) : resolve());
  })));
  listeners.clear();
  await Promise.all([...fixtures].map((fixture) => rm(fixture, { recursive: true, force: true })));
  fixtures.clear();
});

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("could not reserve a TCP port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function nonLoopbackIpv4Address(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  throw new Error("the CLI exposure regression needs a non-loopback IPv4 interface");
}

async function probe(hostname: string, port: number): Promise<number> {
  return new Promise((resolve) => {
    const request = http.get({ hostname, port, path: "/api/files", timeout: 1_000 }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("timeout", () => {
      request.destroy();
      resolve(0);
    });
    request.once("error", () => resolve(0));
  });
}

async function waitForStatus(hostname: string, port: number, expected: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await probe(hostname, port) === expected) return;
    await Bun.sleep(50);
  }
  throw new Error(`listener at ${hostname}:${port} did not reach status ${expected}`);
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(null);
    }, timeoutMs);
    const onExit = (code: number | null) => {
      clearTimeout(timeout);
      resolve(code);
    };
    child.once("exit", onExit);
    if (child.exitCode !== null) {
      child.off("exit", onExit);
      clearTimeout(timeout);
      resolve(child.exitCode);
    }
  });
}

function captureOutput(child: ReturnType<typeof spawn>) {
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });

  return {
    async waitFor(text: string, timeoutMs: number): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (output.includes(text)) return;
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`CLI exited before ${JSON.stringify(text)} appeared:\n${output}`);
        }
        await Bun.sleep(25);
      }
      throw new Error(`CLI output did not include ${JSON.stringify(text)}:\n${output}`);
    },
  };
}

async function checkoutFixture(options: { ignoreHostname?: boolean } = {}): Promise<{ cli: string; env: NodeJS.ProcessEnv }> {
  const fixture = await mkdtemp(path.join(tmpdir(), "llv-cli-exposure-"));
  fixtures.add(fixture);
  const bin = path.join(fixture, "bin");
  const nextBin = path.join(fixture, "node_modules", ".bin");
  const runtimeHost = path.join(fixture, "dist", "runtime-host.mjs");
  const home = path.join(fixture, "home");
  const state = path.join(fixture, "state");
  await Promise.all([
    mkdir(bin, { recursive: true }),
    mkdir(nextBin, { recursive: true }),
    mkdir(path.dirname(runtimeHost), { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(state, { recursive: true }),
  ]);
  await Promise.all([
    copyFile(path.resolve("bin/cli.mjs"), path.join(bin, "cli.mjs")),
    copyFile(path.resolve("bin/server-runtime.mjs"), path.join(bin, "server-runtime.mjs")),
    copyFile(path.resolve("bin/tailscale.mjs"), path.join(bin, "tailscale.mjs")),
    writeFile(path.join(fixture, "package.json"), JSON.stringify({ type: "module", version: "0.0.0" })),
    writeFile(path.join(nextBin, "next"), `
const hostnameIndex = process.argv.indexOf("--hostname");
const hostname = ${options.ignoreHostname ? JSON.stringify("0.0.0.0") : "hostnameIndex === -1 ? \"0.0.0.0\" : process.argv[hostnameIndex + 1]"};
const server = Bun.serve({
  hostname,
  port: Number(process.env.PORT),
  fetch() { return new Response("ok"); },
});
const stop = () => { server.stop(true); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
`),
    writeFile(runtimeHost, `
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
const socketPath = process.env.LLV_RUNTIME_HOST_SOCKET;
const fencePath = process.env.LLV_RUNTIME_HOST_FENCE;
mkdirSync(path.dirname(socketPath), { recursive: true });
rmSync(socketPath, { force: true });
const server = net.createServer((socket) => socket.end());
server.listen(socketPath, () => writeFileSync(fencePath, JSON.stringify({
  pid: process.pid,
  startIdentity: process.pid + ":fixture",
  acquisitionId: "fixture-acquisition-id",
})));
const stop = () => server.close(() => {
  rmSync(socketPath, { force: true });
  rmSync(fencePath, { force: true });
  process.exit(0);
});
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
`),
  ]);
  return {
    cli: path.join(bin, "cli.mjs"),
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      LLV_STATE_DIR: state,
      TMPDIR: path.join(fixture, "tmp"),
      LLV_BUN_EXECUTABLE: process.execPath,
    },
  };
}

test("the checkout next start path keeps the default listener on loopback", async () => {
  const fixture = await checkoutFixture();
  await mkdir(fixture.env.TMPDIR!, { recursive: true });
  const port = await availablePort();
  const child = spawn(process.execPath, ["--bun", fixture.cli, "--no-open", "--port", String(port)], {
    cwd: path.dirname(path.dirname(fixture.cli)),
    env: fixture.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const output = captureOutput(child);

  await waitForStatus("127.0.0.1", port, 200);
  await output.waitFor("Agent Log Viewer", 10_000);
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  expect(await probe(nonLoopbackIpv4Address(), port)).toBe(0);
});

test("a pre-existing non-loopback listener does not impersonate a widened Viewer bind", async () => {
  const fixture = await checkoutFixture();
  await mkdir(fixture.env.TMPDIR!, { recursive: true });
  const port = await availablePort();
  const nonLoopbackAddress = nonLoopbackIpv4Address();
  const unrelated = http.createServer((_request, response) => {
    response.writeHead(204);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    unrelated.once("error", reject);
    unrelated.listen({ host: nonLoopbackAddress, port, exclusive: true }, resolve);
  });
  listeners.add(unrelated);

  const child = spawn(process.execPath, ["--bun", fixture.cli, "--no-open", "--port", String(port)], {
    cwd: path.dirname(path.dirname(fixture.cli)),
    env: fixture.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  const output = captureOutput(child);

  await waitForStatus("127.0.0.1", port, 200);
  await output.waitFor("Agent Log Viewer", 10_000);
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  expect(await probe(nonLoopbackAddress, port)).toBe(204);
});

test("the CLI rejects a checkout server that binds beyond the requested loopback address", async () => {
  const fixture = await checkoutFixture({ ignoreHostname: true });
  await mkdir(fixture.env.TMPDIR!, { recursive: true });
  const port = await availablePort();
  const child = spawn(process.execPath, ["--bun", fixture.cli, "--no-open", "--port", String(port)], {
    cwd: path.dirname(path.dirname(fixture.cli)),
    env: fixture.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);

  await waitForStatus("127.0.0.1", port, 200);
  const exitCode = await waitForExit(child, 2_000);
  expect(exitCode).toBe(1);
  expect(await probe(nonLoopbackIpv4Address(), port)).toBe(0);
});
