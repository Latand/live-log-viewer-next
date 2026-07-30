import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { withoutWakatimeCredential } from "@/lib/wakatime/credential";

import type { FileCatalogScan, FileScanOptions } from "./index";

const FILE_SCAN_WORKER_TIMEOUT_MS = 5 * 60_000;
const FILE_SCAN_WORKER_OUTPUT_MAX_BYTES = 32 * 1024 * 1024;
const FILE_SCAN_WORKER_STDERR_MAX_BYTES = 4 * 1024;

type SerializableFileScanOptions = Omit<FileScanOptions, "onResourceSnapshot">;

type FileScanWorkerMessage =
  | { type: "resource"; snapshot: FileCatalogScan }
  | { type: "complete"; snapshot: FileCatalogScan };

export interface FileScanWorkerRuntime {
  launch?: { executable: string; workerPath: string };
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fileCatalogScan(value: unknown): value is FileCatalogScan {
  return record(value)
    && Array.isArray(value.files)
    && Array.isArray(value.projectCatalog)
    && typeof value.complete === "boolean"
    && (value.pinOverlayPaths === undefined || Array.isArray(value.pinOverlayPaths));
}

function workerMessage(value: unknown): FileScanWorkerMessage | null {
  if (!record(value)
    || (value.type !== "resource" && value.type !== "complete")
    || !fileCatalogScan(value.snapshot)) return null;
  return value as unknown as FileScanWorkerMessage;
}

function workerLaunch(cwd = process.cwd()): { executable: string; workerPath: string } {
  const source = path.join(cwd, "src/lib/fileScanner.worker.ts");
  const bundled = path.join(cwd, ".next/server/file-scanner-worker.js");
  if (fs.existsSync(source) && fs.existsSync("/usr/local/bin/bun-container")) {
    return { executable: "/usr/local/bin/bun-container", workerPath: source };
  }
  if (fs.existsSync(bundled)) return { executable: process.execPath, workerPath: bundled };
  return { executable: process.execPath, workerPath: source };
}

export function fileScanWorkerEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.NODE_ENV !== "test"
    && env.LLV_FILE_SCANNER_WORKER !== "1"
    && env.LLV_FILE_SCANNER_WORKER_DISABLED !== "1";
}

export function collectFileScanInWorker(
  options: SerializableFileScanOptions,
  onResourceSnapshot?: (snapshot: FileCatalogScan) => void,
  runtime: FileScanWorkerRuntime = {},
): Promise<FileCatalogScan> {
  const launch = runtime.launch ?? workerLaunch(runtime.cwd);
  const child = spawn(launch.executable, [launch.workerPath], {
    cwd: runtime.cwd ?? process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...withoutWakatimeCredential(runtime.env ?? process.env),
      LLV_FILE_SCANNER_WORKER: "1",
    },
  });
  return new Promise<FileCatalogScan>((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let completed: FileCatalogScan | null = null;
    const finish = (error?: Error, snapshot?: FileCatalogScan) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(snapshot!);
    };
    const fail = (message: string) => {
      try { child.kill("SIGKILL"); } catch { /* child already exited */ }
      finish(new Error(message));
    };
    const consume = () => {
      while (true) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        const raw = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        if (!raw) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          fail("file scanner worker emitted invalid JSON");
          return;
        }
        const message = workerMessage(parsed);
        if (!message) {
          fail("file scanner worker emitted an invalid message");
          return;
        }
        if (message.type === "resource") onResourceSnapshot?.(message.snapshot);
        else completed = message.snapshot;
      }
    };
    const timer = setTimeout(() => {
      fail("file scanner worker timed out");
    }, runtime.timeoutMs ?? FILE_SCAN_WORKER_TIMEOUT_MS);
    child.once("error", (error) => finish(error));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > FILE_SCAN_WORKER_OUTPUT_MAX_BYTES) {
        fail("file scanner worker exceeded output limit");
        return;
      }
      stdout += chunk;
      consume();
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`;
      if (Buffer.byteLength(stderr) > FILE_SCAN_WORKER_STDERR_MAX_BYTES) {
        stderr = Buffer.from(stderr).subarray(-FILE_SCAN_WORKER_STDERR_MAX_BYTES).toString("utf8");
      }
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      consume();
      if (code !== 0 || !completed) {
        const detail = stderr.trim();
        finish(new Error(`file scanner worker exited before completion (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`));
        return;
      }
      finish(undefined, completed);
    });
    child.stdin.once("error", (error) => finish(error));
    child.stdin.end(JSON.stringify({ type: "scan", options }));
  });
}
