import { cp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

import {
  discardWakatimeEnvironmentCredential,
  viewerChildProcessOptions,
  withoutWakatimeCredential,
} from "../bin/server-runtime.mjs";

discardWakatimeEnvironmentCredential();

const root = process.cwd();
const nextBin = join(root, "node_modules", ".bin", "next");
const standaloneDir = join(root, ".next", "standalone");
const staticDir = join(root, ".next", "static");
const distDir = join(root, "dist");
const distStandaloneDir = join(distDir, "standalone");
const runtimeHostBundle = join(distDir, "runtime-host.mjs");

const standaloneServerBootstrap = `const { spawn } = require("node:child_process");

if (process.versions.bun) {
  require("./server.bun.js");
} else {
  const bun = process.env.LLV_BUN_EXECUTABLE || "bun";
  const child = spawn(bun, ["--bun", __filename, ...process.argv.slice(2)], {
    env: process.env,
    stdio: "inherit",
  });
  child.once("error", (error) => {
    console.error(\`Failed to start the Bun server runtime: \${error.message}\`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
`;

function runNextBuild() {
  return new Promise((resolve, reject) => {
    const env = { ...withoutWakatimeCredential(process.env), LLV_STANDALONE: "1" };
    for (const key of Object.keys(env)) {
      if (key.startsWith("__NEXT_PRIVATE_")) delete env[key];
    }
    const child = spawn(nextBin, ["build", "--webpack"], viewerChildProcessOptions({
      cwd: root,
      env,
      stdio: "inherit",
    }));

    child.on("error", (error) => {
      reject(new Error(`Failed to start ${nextBin}: ${error.message}`));
    });

    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          signal
            ? `Standalone build failed after signal ${signal}.`
            : `Standalone build failed with exit code ${code}.`,
        ),
      );
    });
  });
}

function runMcpBuild() {
  return new Promise((resolve, reject) => {
    const bun = process.env.LLV_BUN_EXECUTABLE || "bun";
    const child = spawn(bun, ["run", "build:mcp"], viewerChildProcessOptions({
      cwd: root,
      env: withoutWakatimeCredential(process.env),
      stdio: "inherit",
    }));
    child.on("error", (error) => reject(new Error(`Failed to start ${bun}: ${error.message}`)));
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(signal ? `MCP build stopped after signal ${signal}.` : `MCP build failed with exit code ${code}.`));
    });
  });
}

function runRuntimeHostBuild() {
  return new Promise((resolve, reject) => {
    const bun = process.env.LLV_BUN_EXECUTABLE || "bun";
    const child = spawn(bun, [
      "build",
      "src/runtime-host/main.ts",
      "--target=bun",
      "--format=esm",
      `--outfile=${runtimeHostBundle}`,
    ], viewerChildProcessOptions({
      cwd: root,
      env: withoutWakatimeCredential(process.env),
      stdio: "inherit",
    }));
    child.on("error", (error) => reject(new Error(`Failed to start ${bun}: ${error.message}`)));
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(signal ? `Runtime host build stopped after signal ${signal}.` : `Runtime host build failed with exit code ${code}.`));
    });
  });
}

async function findStandaloneServer(dir) {
  const directServer = join(dir, "server.js");
  if (existsSync(directServer)) {
    return dir;
  }

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === ".next") {
      continue;
    }

    const found = await findStandaloneServer(join(dir, entry.name));
    if (found) {
      return found;
    }
  }

  return null;
}

async function main() {
  await runNextBuild();

  const appStandaloneDir = await findStandaloneServer(standaloneDir);
  if (!appStandaloneDir) {
    throw new Error("Standalone build did not produce .next/standalone/server.js.");
  }

  await rm(distDir, { recursive: true, force: true });
  await cp(standaloneDir, distStandaloneDir, { recursive: true });
  if (appStandaloneDir !== standaloneDir) {
    await cp(appStandaloneDir, distStandaloneDir, { recursive: true });
    await rm(join(distStandaloneDir, ".claude"), { recursive: true, force: true });
  }
  await cp(staticDir, join(distStandaloneDir, ".next", "static"), { recursive: true });
  await rename(join(distStandaloneDir, "server.js"), join(distStandaloneDir, "server.bun.js"));
  await writeFile(join(distStandaloneDir, "server.js"), standaloneServerBootstrap);
  await runRuntimeHostBuild();
  await runMcpBuild();

  if (!existsSync(join(distStandaloneDir, "server.js")) || !existsSync(runtimeHostBundle)) {
    throw new Error("Prepack did not produce the standalone server and runtime host bundles.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
