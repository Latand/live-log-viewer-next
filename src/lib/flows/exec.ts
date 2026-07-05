import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveBinary } from "@/lib/agent/cli";
import { claudeTranscriptPath } from "@/lib/agent/transcript";

import type { RoleConfig } from "./types";
import { atomicWriteText, outputPathFor, stderrPathFor } from "./store";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export interface HeadlessRunResult {
  status: "running" | "done" | "failed" | "timeout";
  stdout: string;
  stderr: string;
  finalOutput: string;
  /** Session/thread id parsed from the run's `--json` event stream. */
  sessionId: string | null;
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface HeadlessReviewLaunch {
  sessionId: string | null;
  reviewerPath: string | null;
}

interface RunningReview {
  child: ChildProcess;
  startedAt: number;
  stdout: string;
  stderr: string;
  outputPath: string | null;
  sessionId: string | null;
  /** Last agent message seen in the `--json` event stream: the verdict
      fallback when the --output-last-message file never appeared. */
  lastAgentMessage: string;
  /** Offset of the first unscanned byte of stdout (JSONL event parsing). */
  scanned: number;
  result: HeadlessRunResult | null;
  timer: NodeJS.Timeout;
}

const runs = new Map<string, RunningReview>();

function runKey(flowId: string, round: number): string {
  return `${flowId}:${round}`;
}

function killOrphanReviewProcess(outputPath: string): void {
  const res = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  if (res.error || res.status !== 0) return;
  for (const line of res.stdout.split("\n")) {
    if (!line.includes(outputPath) || !/\bcodex\b/.test(line)) continue;
    const match = /^\s*(\d+)\s+/.exec(line);
    const pid = match ? Number(match[1]) : 0;
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try {
      process.kill(pid, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }, 3_000).unref();
    } catch {
      /* already gone or not ours */
    }
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_KEYS = new Set(["session_id", "sessionId", "thread_id", "threadId", "rollout_id"]);

/** Depth-limited walk for a session/thread id key anywhere in a parsed event. */
function findSessionId(value: unknown, depth = 0): string | null {
  if (!value || typeof value !== "object" || depth > 4) return null;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (ID_KEYS.has(key) && typeof item === "string" && UUID_RE.test(item)) return item;
    const nested = findSessionId(item, depth + 1);
    if (nested) return nested;
  }
  return null;
}

/** Agent-message text from a `--json` event, across known event shapes. */
function agentMessageOf(event: Record<string, unknown>): string | null {
  const item = event.item as Record<string, unknown> | undefined;
  if (item && (item.type === "agent_message" || item.item_type === "agent_message") && typeof item.text === "string") {
    return item.text;
  }
  const msg = event.msg as Record<string, unknown> | undefined;
  if (msg?.type === "agent_message" && typeof msg.message === "string") return msg.message;
  return null;
}

/** Consumes newly arrived stdout lines of a run: id + last agent message. */
function scanEvents(run: RunningReview): void {
  const end = run.stdout.lastIndexOf("\n");
  if (end < run.scanned) return;
  const fresh = run.stdout.slice(run.scanned, end);
  run.scanned = end + 1;
  for (const line of fresh.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      if (!run.sessionId) run.sessionId = findSessionId(event);
      const message = agentMessageOf(event);
      if (message) run.lastAgentMessage = message;
    } catch {
      /* partial or non-JSON line — ignore */
    }
  }
}

export function reviewerCommand(
  role: RoleConfig,
  prompt: string,
  outputPath: string,
  cwd: string,
): { command: string; args: string[]; outputPath: string | null; sessionId: string | null; reviewerPath: string | null } {
  if (role.engine === "claude") {
    const sessionId = crypto.randomUUID();
    const args = [
      "-p",
      prompt,
      "--dangerously-skip-permissions",
      "--session-id",
      sessionId,
      "--disallowedTools",
      "Edit,Write,NotebookEdit",
    ];
    if (role.model) args.push("--model", role.model);
    return { command: resolveBinary("claude"), args, outputPath: null, sessionId, reviewerPath: claudeTranscriptPath(cwd, sessionId) };
  }
  /* --json turns stdout into a JSONL event stream whose first events carry
     the session/thread id — a structured contract instead of parsing the
     human banner. The verdict itself still arrives via --output-last-message. */
  const args = ["exec", prompt, "--json", "--output-last-message", outputPath, "--sandbox", "read-only"];
  if (role.model) args.push("-m", role.model);
  if (role.effort) args.push("-c", `model_reasoning_effort=${role.effort}`);
  return { command: resolveBinary("codex"), args, outputPath, sessionId: null, reviewerPath: null };
}

export function startHeadlessReview(
  flowId: string,
  round: number,
  role: RoleConfig,
  cwd: string,
  prompt: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): HeadlessReviewLaunch {
  const key = runKey(flowId, round);
  if (runs.has(key)) return { sessionId: null, reviewerPath: null };
  const outputPath = outputPathFor(flowId, round);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const built = reviewerCommand(role, prompt, outputPath, cwd);
  const child = spawn(built.command, built.args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const run: RunningReview = {
    child,
    startedAt: Date.now(),
    stdout: "",
    stderr: "",
    outputPath: built.outputPath,
    sessionId: built.sessionId,
    lastAgentMessage: "",
    scanned: 0,
    result: null,
    timer: setTimeout(() => {
      if (!run.result) {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!run.result) child.kill("SIGKILL");
        }, 3_000).unref();
      }
    }, timeoutMs),
  };
  run.timer.unref();
  runs.set(key, run);

  child.stdout?.on("data", (chunk: Buffer) => {
    run.stdout += chunk.toString("utf8");
    scanEvents(run);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    run.stderr += chunk.toString("utf8");
  });
  child.on("error", (error) => {
    clearTimeout(run.timer);
    run.result = {
      status: "failed",
      stdout: run.stdout,
      stderr: `${run.stderr}\n${error instanceof Error ? error.message : String(error)}`.trim(),
      finalOutput: run.lastAgentMessage || (run.outputPath ? "" : run.stdout.trim()),
      sessionId: run.sessionId,
      code: null,
      signal: null,
    };
  });
  child.on("close", (code, signal) => {
    if (run.result) return;
    clearTimeout(run.timer);
    scanEvents(run);
    const timedOut = Date.now() - run.startedAt >= timeoutMs && code === null;
    /* The artifact file is authoritative; the event stream's last agent
       message covers runs where the file never appeared. Raw stdout is JSONL
       under --json, so it is a debugging artifact, never the verdict. */
    const captured = readOptional(run.outputPath) || run.lastAgentMessage || (run.outputPath ? "" : run.stdout.trim());
    if (run.stderr.trim()) atomicWriteText(stderrPathFor(flowId, round), run.stderr);
    run.result = {
      status: timedOut ? "timeout" : code === 0 ? "done" : "failed",
      stdout: run.stdout,
      stderr: run.stderr,
      finalOutput: captured,
      sessionId: run.sessionId,
      code,
      signal,
    };
  });
  return { sessionId: built.sessionId, reviewerPath: built.reviewerPath };
}

function readOptional(filePath: string | null): string {
  if (!filePath) return "";
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

export function headlessReviewStatus(flowId: string, round: number): HeadlessRunResult | null {
  const run = runs.get(runKey(flowId, round));
  if (!run) return null;
  return run.result ?? {
    status: "running",
    stdout: run.stdout,
    stderr: run.stderr,
    finalOutput: "",
    sessionId: run.sessionId,
    code: null,
    signal: null,
  };
}

export function forgetHeadlessReview(flowId: string, round: number): void {
  const key = runKey(flowId, round);
  const run = runs.get(key);
  runs.delete(key);
  if (!run) {
    killOrphanReviewProcess(outputPathFor(flowId, round));
    return;
  }
  if (run.result) return;
  clearTimeout(run.timer);
  run.child.kill("SIGTERM");
  setTimeout(() => {
    if (!run.result) run.child.kill("SIGKILL");
  }, 3_000).unref();
}
