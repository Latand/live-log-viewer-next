import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standaloneServer = path.join(root, "dist/standalone/server.js");
const observationMs = 60_000;
const startupTimeoutMs = 30_000;
const outputLimitBytes = 2 * 1024 * 1024;

function command(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk) => {
      output = `${output}${chunk}`;
      if (Buffer.byteLength(output) > outputLimitBytes) {
        output = Buffer.from(output).subarray(-outputLimitBytes).toString("utf8");
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(`${command} stopped with ${signal ?? code ?? "unknown"}${output.trim() ? `: ${output.trim()}` : ""}`));
    });
  });
}

function pathWithoutBunContainer(environmentPath = "") {
  return environmentPath.split(path.delimiter)
    .filter(Boolean)
    .filter((directory) => !existsSync(path.join(directory, "bun-container")))
    .join(path.delimiter);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function availablePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("smoke probe could not reserve a port");
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

function probe(port, pathname) {
  return new Promise((resolve) => {
    const request = http.get({ hostname: "127.0.0.1", port, path: pathname, timeout: 5_000 }, (response) => {
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

function workerFailure(output) {
  return output.split("\n").find((line) => (
    line.includes("Cannot find module")
    || line.includes("Module not found")
    || /worker(?:_|\s)exited/i.test(line)
    || /worker exit/i.test(line)
  ));
}

async function waitForOk(port, pathname, child, output) {
  const deadline = Date.now() + startupTimeoutMs;
  let status = 0;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    const failure = workerFailure(output());
    if (failure) throw new Error(`worker failure before ${pathname} became ready: ${failure}`);
    status = await probe(port, pathname);
    if (status === 200) return;
    await delay(250);
  }
  throw new Error(`${pathname} did not answer 200 (last status ${status})${output() ? `: ${output()}` : ""}`);
}

function scrubOutput(output, tempDirectory) {
  return output
    .replaceAll(tempDirectory, "<package-smoke>")
    .replaceAll(root, "<repo>")
    .trim();
}

async function stop(child) {
  const signalGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  };
  signalGroup("SIGTERM");
  await Promise.race([
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once("exit", resolve)),
    delay(2_000),
  ]);
  signalGroup("SIGKILL");
}

async function main() {
  if (!existsSync(standaloneServer)) {
    console.log("SKIP npm package smoke: run node scripts/prepack.mjs first.");
    return;
  }

  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "agent-log-viewer-package-smoke-"));
  let server;
  try {
    const packageDirectory = path.join(tempDirectory, "pack");
    const extractDirectory = path.join(tempDirectory, "extract");
    const homeDirectory = path.join(tempDirectory, "home");
    const configDirectory = path.join(tempDirectory, "config");
    const stateDirectory = path.join(tempDirectory, "state");
    const runtimeTempDirectory = path.join(tempDirectory, "runtime-tmp");
    await Promise.all([
      mkdir(packageDirectory),
      mkdir(extractDirectory),
      mkdir(homeDirectory),
      mkdir(configDirectory),
      mkdir(stateDirectory),
      mkdir(runtimeTempDirectory),
    ]);

    const packOutput = await command("npm", [
      "pack",
      "--ignore-scripts",
      "--pack-destination",
      packageDirectory,
      "--silent",
    ], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: homeDirectory,
        npm_config_cache: path.join(tempDirectory, "npm-cache"),
      },
    });
    console.log("npm package smoke: packed current standalone output.");
    const tarballs = (await readdir(packageDirectory)).filter((name) => name.endsWith(".tgz"));
    if (tarballs.length !== 1) throw new Error(`npm pack produced ${tarballs.length} tarballs: ${packOutput}`);
    await command("tar", ["-xzf", path.join(packageDirectory, tarballs[0]), "-C", extractDirectory]);

    const extractedPackage = path.join(extractDirectory, "package");
    if (existsSync(path.join(extractedPackage, "src"))) throw new Error("packed package unexpectedly contains src/");
    const runtimePath = pathWithoutBunContainer(process.env.PATH);
    if (!runtimePath) throw new Error("smoke PATH is empty after removing bun-container");
    const bunRuntime = process.versions.bun ? process.execPath : (process.env.LLV_BUN_EXECUTABLE || "bun");
    const port = await availablePort();
    const runtimeEnvironment = {
      PATH: runtimePath,
      HOME: homeDirectory,
      XDG_CONFIG_HOME: configDirectory,
      LLV_STATE_DIR: stateDirectory,
      TMPDIR: runtimeTempDirectory,
      NODE_ENV: "production",
      LLV_STRUCTURED_HOSTS: "off",
      LLV_WAKATIME_ENABLED: "1",
    };
    let output = "";
    const collect = (chunk) => {
      output = `${output}${chunk}`;
      if (Buffer.byteLength(output) > outputLimitBytes) {
        output = Buffer.from(output).subarray(-outputLimitBytes).toString("utf8");
      }
    };
    server = spawn(bunRuntime, ["--bun", "dist/standalone/server.js"], {
      cwd: extractedPackage,
      detached: true,
      env: {
        ...runtimeEnvironment,
        HOSTNAME: "127.0.0.1",
        PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", collect);
    server.stderr.on("data", collect);
    server.once("error", collect);

    const safeOutput = () => scrubOutput(output, tempDirectory);
    await waitForOk(port, "/api/files", server, safeOutput);
    console.log("npm package smoke: /api/files returned 200.");
    await waitForOk(port, "/api/resources", server, safeOutput);
    console.log("npm package smoke: /api/resources returned 200; observing worker health.");
    const observationDeadline = Date.now() + observationMs;
    while (Date.now() < observationDeadline) {
      if (server.exitCode !== null || server.signalCode !== null) {
        throw new Error(`standalone server exited during smoke observation: ${safeOutput()}`);
      }
      const failure = workerFailure(safeOutput());
      if (failure) throw new Error(`worker failure during smoke observation: ${failure}`);
      await delay(250);
    }
    await stop(server);
    server = undefined;

    output = "";
    const cliPort = await availablePort();
    server = spawn(bunRuntime, [
      "--bun",
      "bin/cli.mjs",
      "--no-open",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(cliPort),
    ], {
      cwd: extractedPackage,
      detached: true,
      env: runtimeEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", collect);
    server.stderr.on("data", collect);
    server.once("error", collect);
    await waitForOk(cliPort, "/api/files", server, safeOutput);
    const cliFailure = workerFailure(safeOutput());
    if (cliFailure) throw new Error(`worker failure during CLI smoke: ${cliFailure}`);
    console.log("npm package smoke passed: direct and CLI launches served /api/files; workers stayed healthy for 60 seconds.");
  } finally {
    if (server) await stop(server);
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
