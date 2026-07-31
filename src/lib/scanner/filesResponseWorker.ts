import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { withoutWakatimeCredential } from "@/lib/wakatime/credential";

import type { FileCatalogScan } from "./index";

const FILES_RESPONSE_WORKER_TIMEOUT_MS = 60_000;
const FILES_RESPONSE_WORKER_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
const FILES_RESPONSE_WORKER_STDERR_MAX_BYTES = 4 * 1024;

export type FilesResponseRepresentation = {
  body: string;
  contentType: string;
  etag: string;
  timing: string;
};

export type FilesResponseWorkerRequest = {
  type: "project";
  url: string;
  headers: Array<[string, string]>;
  snapshot?: FileCatalogScan;
  snapshotFile?: string;
};

export interface FilesResponseWorkerRuntime {
  launch?: { executable: string; workerPath: string };
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type FilesResponseWorkerWireRepresentation = Omit<FilesResponseRepresentation, "body"> & {
  bodyFile: string;
};

function representation(value: unknown): FilesResponseWorkerWireRepresentation | null {
  if (!record(value)
    || typeof value.bodyFile !== "string"
    || typeof value.contentType !== "string"
    || typeof value.etag !== "string"
    || typeof value.timing !== "string") return null;
  return value as unknown as FilesResponseWorkerWireRepresentation;
}

function workerLaunch(cwd = process.cwd()): { executable: string; workerPath: string } {
  const source = path.join(cwd, "src/lib/filesResponse.worker.ts");
  const bundled = path.join(cwd, ".next/server/files-response-worker.js");
  if (fs.existsSync(source) && fs.existsSync("/usr/local/bin/bun-container")) {
    return { executable: "/usr/local/bin/bun-container", workerPath: source };
  }
  if (fs.existsSync(bundled)) return { executable: process.execPath, workerPath: bundled };
  return { executable: process.execPath, workerPath: source };
}

export function filesResponseWorkerEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.NODE_ENV !== "test"
    && env.LLV_FILES_RESPONSE_WORKER !== "1"
    && env.LLV_FILES_RESPONSE_WORKER_DISABLED !== "1";
}

export function buildFilesResponseInWorker(
  request: FilesResponseWorkerRequest,
  runtime: FilesResponseWorkerRuntime = {},
): Promise<FilesResponseRepresentation> {
  const launch = runtime.launch ?? workerLaunch(runtime.cwd);
  const useNice = runtime.launch === undefined && fs.existsSync("/usr/bin/nice");
  const child = spawn(useNice ? "/usr/bin/nice" : launch.executable, [
    ...(useNice ? ["-n", "10", launch.executable] : []),
    launch.workerPath,
  ], {
    cwd: runtime.cwd ?? process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...withoutWakatimeCredential(runtime.env ?? process.env),
      LLV_FILES_RESPONSE_WORKER: "1",
    },
  });
  return new Promise<FilesResponseRepresentation>((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    const finish = (error?: Error, result?: FilesResponseRepresentation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result!);
    };
    const fail = (message: string) => {
      try { child.kill("SIGKILL"); } catch { /* child already exited */ }
      finish(new Error(message));
    };
    const timer = setTimeout(() => {
      const detail = stderr.trim();
      fail(`files response worker timed out${detail ? `: ${detail}` : ""}`);
    }, runtime.timeoutMs ?? FILES_RESPONSE_WORKER_TIMEOUT_MS);
    child.once("error", (error) => finish(error));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > FILES_RESPONSE_WORKER_OUTPUT_MAX_BYTES) {
        fail("files response worker exceeded output limit");
        return;
      }
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`;
      if (Buffer.byteLength(stderr) > FILES_RESPONSE_WORKER_STDERR_MAX_BYTES) {
        stderr = Buffer.from(stderr).subarray(-FILES_RESPONSE_WORKER_STDERR_MAX_BYTES).toString("utf8");
      }
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        const detail = stderr.trim();
        finish(new Error(`files response worker emitted invalid JSON${detail ? `: ${detail}` : ""}`));
        return;
      }
      const result = representation(parsed);
      if (code !== 0 || !result) {
        const detail = stderr.trim();
        finish(new Error(`files response worker exited before completion (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`));
        return;
      }
      const resultDirectory = runtime.env?.LLV_STATE_DIR
        ? path.resolve(runtime.env.LLV_STATE_DIR, "files-response-results")
        : path.resolve(statePath("files-response-results"));
      const bodyFile = path.resolve(result.bodyFile);
      if (path.dirname(bodyFile) !== resultDirectory) {
        finish(new Error("files response worker returned an invalid body path"));
        return;
      }
      try {
        const body = fs.readFileSync(bodyFile, "utf8");
        fs.rmSync(bodyFile, { force: true });
        finish(undefined, { ...result, body });
      } catch (error) {
        finish(error instanceof Error ? error : new Error("files response worker body is unavailable"));
      }
    });
    child.stdin.once("error", (error) => finish(error));
    child.stdin.end(JSON.stringify(request));
  });
}
