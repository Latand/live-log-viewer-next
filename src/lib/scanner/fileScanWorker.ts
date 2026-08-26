import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { systemScheduler, type DeadlineScheduler } from "@/lib/deadline";
import { scheduleTranscriptIndex, type TranscriptIndexFeed } from "@/lib/search/transcriptFeed";
import { withoutWakatimeCredential } from "@/lib/wakatime/credential";

import type { FileCatalogScan, FileScanOptions } from "./index";
import {
  beginProjectCatalogScan,
  isProjectCatalogScanCurrent,
  publishConversationCatalogForScan,
} from "./projectCatalog";

const FILE_SCAN_WORKER_TIMEOUT_MS = 5 * 60_000;
const FILE_SCAN_WORKER_OUTPUT_MAX_BYTES = 32 * 1024 * 1024;
const FILE_SCAN_WORKER_STDERR_MAX_BYTES = 4 * 1024;

type SerializableFileScanOptions = Omit<FileScanOptions, "onResourceSnapshot" | "signal">;

type FileScanWorkerMessage =
  | { type: "resource"; snapshot: FileCatalogScan }
  | { type: "complete"; snapshot: FileCatalogScan };

export interface FileScanWorkerRuntime {
  launch?: { executable: string; workerPath: string };
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal | null;
  scheduler?: DeadlineScheduler;
  transcriptIndexScheduler?: (feed: TranscriptIndexFeed) => void;
}

function abortError(): Error {
  return new DOMException("file scan cancelled", "AbortError");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fileCatalogScan(value: unknown): value is FileCatalogScan {
  return record(value)
    && Array.isArray(value.files)
    && Array.isArray(value.projectCatalog)
    && typeof value.complete === "boolean"
    && (value.conversationCatalog === undefined || Array.isArray(value.conversationCatalog))
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
  if (fs.existsSync(bundled)) {
    const bun = process.versions.bun ? process.execPath : (process.env.LLV_BUN_EXECUTABLE || "bun");
    return { executable: bun, workerPath: bundled };
  }
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
  if (runtime.signal?.aborted) return Promise.reject(abortError());
  const catalogScanToken = beginProjectCatalogScan(false);
  const launch = runtime.launch ?? workerLaunch(runtime.cwd);
  /* Full-corpus scans are background freshness work. Keep the interactive
     Next process ahead of their CPU demand on a busy operator host. Explicit
     test/runtime launch seams retain their exact command. */
  const useNice = runtime.launch === undefined && fs.existsSync("/usr/bin/nice");
  const child = spawn(useNice ? "/usr/bin/nice" : launch.executable, [
    ...(useNice ? ["-n", "10", launch.executable] : []),
    launch.workerPath,
  ], {
    cwd: runtime.cwd ?? process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...withoutWakatimeCredential(runtime.env ?? process.env),
      LLV_FILE_SCANNER_WORKER: "1",
    },
  });
  return new Promise<FileCatalogScan>((resolve, reject) => {
    const scheduler = runtime.scheduler ?? systemScheduler;
    let settled = false;
    let listening = false;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let completed: FileCatalogScan | null = null;
    let completedConversationCatalog: FileCatalogScan["conversationCatalog"];
    let terminationError: Error | null = null;
    let timer: unknown;
    const finish = (error?: Error, snapshot?: FileCatalogScan) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) {
        scheduler.clearTimeout(timer);
        timer = undefined;
      }
      if (listening) {
        runtime.signal?.removeEventListener("abort", onAbort);
        listening = false;
      }
      if (error) reject(error);
      else resolve(snapshot!);
    };
    const terminate = (error: Error) => {
      if (settled || terminationError) return;
      terminationError = error;
      try { child.kill("SIGKILL"); } catch { /* child already exited */ }
      if (child.exitCode !== null || child.signalCode !== null) finish(error);
    };
    const fail = (message: string) => {
      terminate(new Error(message));
    };
    const onAbort = () => terminate(abortError());
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
        if (message.type === "resource") {
          onResourceSnapshot?.(message.snapshot);
        } else {
          const { conversationCatalog, ...snapshot } = message.snapshot;
          /* The full scanner runs in a child process. Its process-global
             publication cannot update the parent that serves /api/conversations,
             so carry the completed uncapped catalog over the existing worker
             response. Publication waits for successful worker exit below. */
          completedConversationCatalog = conversationCatalog;
          completed = snapshot;
        }
      }
    };
    timer = scheduler.setTimeout(() => {
      timer = undefined;
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
      if (terminationError) {
        finish(terminationError);
        return;
      }
      consume();
      if (code !== 0 || !completed) {
        const detail = stderr.trim();
        finish(new Error(`file scanner worker exited before completion (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}`));
        return;
      }
      if (completedConversationCatalog) {
        const currentScan = isProjectCatalogScanCurrent(catalogScanToken);
        publishConversationCatalogForScan(completedConversationCatalog, catalogScanToken, completed.complete);
        if (currentScan) {
          (runtime.transcriptIndexScheduler ?? scheduleTranscriptIndex)({
            complete: completed.complete,
            sources: completedConversationCatalog.map((entry) => ({
              path: entry.path,
              project: entry.project,
              engine: entry.engine,
              size: entry.size,
              mtimeMs: entry.mtime * 1_000,
            })),
          });
        }
      }
      finish(undefined, completed);
    });
    child.stdin.once("error", (error) => {
      if (!terminationError) finish(error);
    });
    if (runtime.signal) {
      runtime.signal.addEventListener("abort", onAbort, { once: true });
      listening = true;
      if (runtime.signal.aborted) onAbort();
    }
    child.stdin.end(JSON.stringify({ type: "scan", options }));
  });
}
