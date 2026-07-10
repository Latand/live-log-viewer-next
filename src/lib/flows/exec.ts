import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveBinary } from "@/lib/agent/cli";
import { claudeManagedEnvironment, claudeSettingsPath } from "@/lib/accounts/claude";
import { claudeTranscriptPath } from "@/lib/agent/transcript";

import type { FlowEngine, RoleConfig, Round } from "./types";
import { outputPathFor, stderrPathFor, stdoutPathFor } from "./store";

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
  pid: number | null;
  sessionId: string | null;
  reviewerPath: string | null;
}

export interface HeadlessCodexAccount {
  home: string;
  managed: boolean;
}
export interface HeadlessClaudeAccount { home: string; projectsDir: string; managed: boolean; }

/* The reviewer runs detached with file-backed stdio, so it survives a viewer
   restart. This in-memory record only adds what disk cannot know: the exact
   exit code and the in-process timeout timer. Everything in
   headlessReviewStatus must stay derivable from the round + artifacts alone. */
interface LiveRun {
  child: ChildProcess;
  startedAt: number;
  exit: { code: number | null; signal: NodeJS.Signals | null } | null;
  timer: NodeJS.Timeout;
}

const runs = new Map<string, LiveRun>();

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
    killTree(pid);
  }
}

function pidAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM the reviewer's process group (detached spawn = group leader),
    escalating to SIGKILL; falls back to the single pid when no group exists. */
function killTree(pid: number, escalateMs = 3_000): void {
  const signalTree = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        /* already gone */
      }
    }
  };
  signalTree("SIGTERM");
  setTimeout(() => {
    if (pidAlive(pid)) signalTree("SIGKILL");
  }, escalateMs).unref();
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

/** Session id + last agent message from a captured `--json` stdout stream. */
export function scanEventStream(stdout: string): { sessionId: string | null; lastAgentMessage: string } {
  let sessionId: string | null = null;
  let lastAgentMessage = "";
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, unknown>;
      if (!sessionId) sessionId = findSessionId(event);
      const message = agentMessageOf(event);
      if (message) lastAgentMessage = message;
    } catch {
      /* partial or non-JSON line — ignore */
    }
  }
  return { sessionId, lastAgentMessage };
}

export function reviewerCommand(
  role: RoleConfig,
  prompt: string,
  outputPath: string,
  cwd: string,
  codexAccount?: HeadlessCodexAccount | null,
  claudeAccount?: HeadlessClaudeAccount | null,
): { command: string; args: string[]; env: NodeJS.ProcessEnv; outputPath: string | null; sessionId: string | null; reviewerPath: string | null } {
  if (role.engine === "claude") {
    const sessionId = crypto.randomUUID();
    /* Headless reviewers need approval-free command access for tests, builds,
       linters, and local diagnostics. The read-only rule lives in the prompt. */
    const args = [
      "-p",
      prompt,
      "--dangerously-skip-permissions",
      "--session-id",
      sessionId,
    ];
    if (role.model) args.push("--model", role.model);
    if (role.effort) args.push("--effort", role.effort);
    const settings = claudeAccount?.managed ? claudeSettingsPath() : null;
    if (settings) args.push("--settings", settings);
    return { command: resolveBinary("claude"), args, env: claudeAccount?.managed ? claudeManagedEnvironment(claudeAccount.home) : process.env, outputPath: null, sessionId, reviewerPath: claudeTranscriptPath(cwd, sessionId, claudeAccount?.projectsDir) };
  }
  /* --json turns stdout into a JSONL event stream whose first events carry
     the session/thread id — a structured contract instead of parsing the
     human banner. The verdict itself still arrives via --output-last-message. */
  const args = ["exec", prompt, "--json", "--output-last-message", outputPath, "--dangerously-bypass-approvals-and-sandbox"];
  if (codexAccount?.managed) args.unshift("-c", "cli_auth_credentials_store=file");
  if (role.model) args.push("-m", role.model);
  if (role.effort) args.push("-c", `model_reasoning_effort=${role.effort}`);
  return {
    command: resolveBinary("codex"),
    args,
    env: codexAccount?.home ? { ...process.env, CODEX_HOME: codexAccount.home } : process.env,
    outputPath,
    sessionId: null,
    reviewerPath: null,
  };
}

export function startHeadlessReview(
  flowId: string,
  round: number,
  role: RoleConfig,
  cwd: string,
  prompt: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  codexAccount?: HeadlessCodexAccount | null,
  claudeAccount?: HeadlessClaudeAccount | null,
): HeadlessReviewLaunch {
  const key = runKey(flowId, round);
  if (runs.has(key)) return { pid: null, sessionId: null, reviewerPath: null };
  const outputPath = outputPathFor(flowId, round);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const built = reviewerCommand(role, prompt, outputPath, cwd, codexAccount, claudeAccount);
  /* Detached + file-backed stdio: the reviewer must not die with the viewer.
     A plain child shares the dev server's process group, so Ctrl+C on the
     server delivers SIGINT to the reviewer too; detached makes it a group
     leader and the log files replace the pipes we can no longer hold. */
  const stdoutFd = fs.openSync(stdoutPathFor(flowId, round), "w");
  const stderrFd = fs.openSync(stderrPathFor(flowId, round), "w");
  let child: ChildProcess;
  try {
    child = spawn(built.command, built.args, {
      cwd,
      env: built.env,
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
  child.unref();
  const run: LiveRun = {
    child,
    startedAt: Date.now(),
    exit: null,
    timer: setTimeout(() => {
      if (!run.exit && child.pid) killTree(child.pid);
    }, timeoutMs),
  };
  run.timer.unref();
  runs.set(key, run);
  child.on("error", () => {
    clearTimeout(run.timer);
    run.exit = { code: null, signal: null };
  });
  child.on("close", (code, signal) => {
    clearTimeout(run.timer);
    run.exit = { code, signal };
  });
  return { pid: child.pid ?? null, sessionId: built.sessionId, reviewerPath: built.reviewerPath };
}

function readOptional(filePath: string | null): string {
  if (!filePath) return "";
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

/**
 * Reviewer run state derived from the round's persisted pid plus the on-disk
 * artifacts, with the in-memory record only sharpening the exit code. This is
 * the restart seam: after the viewer reboots the `runs` map is empty, but the
 * detached reviewer keeps running and this function still reports it
 * faithfully — running while the pid is alive, done once the last-message
 * artifact (codex) or captured stdout (claude) carries the verdict.
 *
 * Returns null only when nothing was ever observed for the round: no live
 * record, no persisted pid, no stdout artifact.
 */
export function headlessReviewStatus(
  flowId: string,
  round: number,
  persisted: Pick<Round, "reviewerPid" | "spawnStartedAt">,
  engine: FlowEngine,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): HeadlessRunResult | null {
  const run = runs.get(runKey(flowId, round));
  const stdout = readOptional(stdoutPathFor(flowId, round));
  const pid = run?.child.pid ?? persisted.reviewerPid ?? null;
  if (!run && pid === null && !stdout) return null;
  const stderr = readOptional(stderrPathFor(flowId, round));
  const scanned = scanEventStream(stdout);
  const startedAt = run?.startedAt ?? Date.parse(persisted.spawnStartedAt ?? "");
  const elapsed = Number.isFinite(startedAt) ? Date.now() - startedAt : 0;
  const alive = run ? run.exit === null && pidAlive(pid) : pidAlive(pid);
  if (alive) {
    /* Re-arm the timeout across restarts: the in-memory timer died with the
       old process, so the reconstruction path enforces the budget itself. */
    if (!run && elapsed >= timeoutMs && pid) killTree(pid);
    return { status: "running", stdout, stderr, finalOutput: "", sessionId: scanned.sessionId, code: null, signal: null };
  }
  const outputPath = engine === "codex" ? outputPathFor(flowId, round) : null;
  const finalOutput = readOptional(outputPath).trim() || scanned.lastAgentMessage || (engine === "claude" ? stdout.trim() : "");
  const exit = run?.exit ?? null;
  const timedOut = !finalOutput && elapsed >= timeoutMs;
  const status: HeadlessRunResult["status"] =
    exit?.code === 0 || finalOutput ? "done" : timedOut ? "timeout" : "failed";
  return { status, stdout, stderr, finalOutput, sessionId: scanned.sessionId, code: exit?.code ?? null, signal: exit?.signal ?? null };
}

export function forgetHeadlessReview(flowId: string, round: number, persistedPid?: number | null): void {
  const key = runKey(flowId, round);
  const run = runs.get(key);
  runs.delete(key);
  const pid = run?.child.pid ?? persistedPid ?? null;
  if (run) clearTimeout(run.timer);
  if (pid) {
    if (pidAlive(pid)) killTree(pid);
    return;
  }
  /* No pid survived (round predates pid persistence) — fall back to matching
     the codex process by its --output-last-message argument. */
  killOrphanReviewProcess(outputPathFor(flowId, round));
}
