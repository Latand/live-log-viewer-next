#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  discardWakatimeEnvironmentCredential,
  viewerChildProcessOptions,
  viewerServerBunRuntime,
} from "./server-runtime.mjs";

discardWakatimeEnvironmentCredential();

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function deployedPackageRoot() {
  const configRoot = process.env.XDG_CONFIG_HOME || join(process.env.HOME || "/home/user", ".config");
  const stateDir = process.env.LLV_STATE_DIR || join(configRoot, "agent-log-viewer", "state");
  const targetFile = process.env.LLV_VIEWER_DEPLOY_TARGET || join(stateDir, "viewer-release.json");
  let target;
  try {
    target = JSON.parse(readFileSync(targetFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return packageRoot;
    throw new Error(`Could not read the Viewer release target: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!target
    || typeof target !== "object"
    || Array.isArray(target)
    || typeof target.image !== "string"
    || typeof target.container !== "string"
    || typeof target.endpoint !== "string"
    || typeof target.revision !== "string"
    || !/^[0-9a-f]{40}$/.test(target.revision)) {
    throw new Error("The active Viewer release target is invalid.");
  }
  const runtime = target.mcpRuntime;
  if (runtime === undefined) return packageRoot;
  if (!runtime
    || typeof runtime !== "object"
    || runtime.source !== "managed"
    || typeof runtime.releaseId !== "string"
    || !/^[a-z0-9-]+$/.test(runtime.releaseId)
    || typeof runtime.revision !== "string"
    || runtime.revision !== target.revision
    || !/^[0-9a-f]{40}$/.test(runtime.revision)
    || typeof runtime.artifactDigest !== "string"
    || !/^[0-9a-f]{64}$/.test(runtime.artifactDigest)
    || typeof runtime.stagedAt !== "string") {
    throw new Error("The active Viewer release has an invalid MCP runtime identity.");
  }
  const releasesRoot = join(stateDir, "mcp-runtime", "releases");
  const releaseRoot = join(releasesRoot, runtime.releaseId);
  const bundle = join(releaseRoot, "dist", "mcp-server.mjs");
  let bundled;
  try {
    bundled = readFileSync(bundle);
  } catch (error) {
    /* Same policy as an absent release target: a runtime the deployment never
       published (or already retired) falls back to this image's own bundle
       instead of leaving the operator with no MCP server at all. */
    if (error?.code === "ENOENT") return packageRoot;
    throw new Error(`Could not read the published MCP runtime bundle: ${error instanceof Error ? error.message : String(error)}`);
  }
  const artifactDigest = createHash("sha256").update(bundled).digest("hex");
  if (artifactDigest !== runtime.artifactDigest) {
    throw new Error("MCP runtime bundle digest does not match the active release.");
  }
  return releaseRoot;
}

const selectedPackageRoot = deployedPackageRoot();
const bundled = join(selectedPackageRoot, "dist", "mcp-server.mjs");
const source = join(selectedPackageRoot, "src", "lib", "mcp", "entry.ts");

async function runChild(runtime, entry) {
  const child = spawn(runtime, [entry], viewerChildProcessOptions({ cwd: selectedPackageRoot, stdio: "inherit" }));
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
