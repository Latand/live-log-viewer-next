#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundled = join(packageRoot, "dist", "mcp-server.mjs");

if (existsSync(bundled)) {
  await import(pathToFileURL(bundled).href);
} else {
  const bun = process.env.LLV_BUN_EXECUTABLE || "bun";
  const source = join(packageRoot, "src", "lib", "mcp", "entry.ts");
  const child = spawn(bun, [source], { cwd: packageRoot, env: process.env, stdio: "inherit" });
  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.once("SIGINT", () => forward("SIGINT"));
  process.once("SIGTERM", () => forward("SIGTERM"));
  child.once("error", (error) => {
    console.error(`Could not start the Viewer MCP server: ${error.message}`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}
