#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  discardWakatimeEnvironmentCredential,
  viewerChildProcessOptions,
  viewerServerBunRuntime,
} from "./server-runtime.mjs";

discardWakatimeEnvironmentCredential();

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundled = join(packageRoot, "dist", "mcp-server.mjs");
const source = join(packageRoot, "src", "lib", "mcp", "entry.ts");

async function runChild(runtime, entry) {
  const child = spawn(runtime, [entry], viewerChildProcessOptions({ cwd: packageRoot, stdio: "inherit" }));
  let childExited = false;
  const forwardInterrupt = () => {
    if (!childExited) child.kill("SIGINT");
  };
  const forwardTermination = () => {
    if (!childExited) child.kill("SIGTERM");
  };
  process.on("SIGINT", forwardInterrupt);
  process.on("SIGTERM", forwardTermination);
  await new Promise((resolve) => {
    let settled = false;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      childExited = true;
      process.removeListener("SIGINT", forwardInterrupt);
      process.removeListener("SIGTERM", forwardTermination);
      process.exitCode = exitCode;
      resolve();
    };
    child.once("error", (error) => {
      console.error(`Could not start the Viewer MCP server: ${error.message}`);
      finish(1);
    });
    child.once("exit", (code, signal) => {
      finish(code ?? (signal ? 1 : 0));
    });
  });
}

if (existsSync(bundled)) {
  const bunRuntime = viewerServerBunRuntime();
  if (bunRuntime && !process.versions.bun) await runChild(bunRuntime, bundled);
  else await import(pathToFileURL(bundled).href);
} else if (process.versions.bun) {
  await import(pathToFileURL(source).href);
} else {
  const bun = process.env.LLV_BUN_EXECUTABLE || "bun";
  await runChild(bun, source);
}
