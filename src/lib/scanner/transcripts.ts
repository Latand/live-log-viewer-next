import fs from "node:fs";
import path from "node:path";

import type { FileEntry } from "../types";
import { globalCache } from "./caches";
import {
  agentProcesses,
  argvEngine,
  isHelperArgv,
  pidAlive,
  pidWritesPath,
  readArgv,
  readCwd,
  writingHolders,
  type AgentEngine,
  type AgentProcess,
} from "./process";
import { ROOTS } from "./roots";

/**
 * Pid attribution for interactive transcripts (claude-projects and
 * codex-sessions .jsonl), so the tmux composer and the kill control work for
 * live REPL agents the same way they do for background tasks. Signals, most
 * trusted first:
 *
 *  1. A process holding the transcript open for writing (codex keeps its
 *     rollout fd open; claude does not).
 *  2. `--session-id <uuid>` in argv matching the transcript basename — exact,
 *     covers daemon-spawned claude sessions.
 *  3. cwd match: the only tty-attached claude/codex whose cwd maps to the
 *     transcript's project, assigned to the freshest unresolved transcript of
 *     that project. Any ambiguity leaves pid null — kill and send-keys hang
 *     off this pid, so no pid beats a neighbour's pid.
 */

const MAX_TRANSCRIPT_CANDIDATES = 12;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// The head of a rollout is immutable, so the cwd parsed out of it is cached
// for good ("" when the head has no cwd yet).
const codexCwdCache = globalCache<string>("codex-cwd");

export function transcriptEngine(pathname: string): AgentEngine | null {
  if (!pathname.endsWith(".jsonl")) return null;
  if (pathname.startsWith(ROOTS["claude-projects"] + path.sep)) return "claude";
  if (pathname.startsWith(ROOTS["codex-sessions"] + path.sep)) return "codex";
  return null;
}

/**
 * Subagent transcripts are written by their parent session's process; pointing
 * the composer at that pid would type into the parent REPL, so only top-level
 * sessions participate.
 */
function isTranscriptCandidate(entry: FileEntry): boolean {
  if (entry.activity === "idle" || entry.pid !== null) return false;
  if (entry.root === "codex-sessions") return entry.path.endsWith(".jsonl");
  if (entry.root !== "claude-projects" || !entry.path.endsWith(".jsonl")) return false;
  const base = path.basename(entry.path);
  return !base.startsWith("agent-") && !entry.path.includes(path.sep + "subagents" + path.sep);
}

function sessionIdFromPath(pathname: string): string | null {
  const matches = path.basename(pathname).match(UUID_RE);
  return matches?.at(-1)?.toLowerCase() ?? null;
}

function argvSessionId(argv: string[]): string | null {
  const flag = argv.indexOf("--session-id");
  const value = flag >= 0 ? argv[flag + 1] : undefined;
  return value ? value.toLowerCase() : null;
}

/** Claude project slugs encode the session cwd with every non-alphanumeric as "-". */
function slugifyCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

function claudeSlug(pathname: string): string {
  return path.relative(ROOTS["claude-projects"], pathname).split(path.sep)[0] ?? "";
}

function codexSessionCwd(pathname: string): string {
  const cached = codexCwdCache.get(pathname);
  if (cached !== undefined && cached !== "") return cached;
  let head = "";
  try {
    const fd = fs.openSync(pathname, "r");
    try {
      const buf = Buffer.alloc(8192);
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.toString("utf8", 0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
  let cwd = "";
  try {
    const first = JSON.parse(head.split("\n")[0] ?? "{}") as { payload?: { cwd?: unknown } };
    cwd = typeof first.payload?.cwd === "string" ? first.payload.cwd : "";
  } catch {
    cwd = "";
  }
  codexCwdCache.set(pathname, cwd);
  return cwd;
}

/** Project key an entry must share with a process cwd for the fallback match. */
function projectKey(entry: FileEntry): string | null {
  if (entry.root === "claude-projects") {
    const slug = claudeSlug(entry.path);
    return slug ? "claude:" + slug : null;
  }
  const cwd = codexSessionCwd(entry.path);
  return cwd ? "codex:" + cwd : null;
}

function processKey(proc: AgentProcess): string {
  return proc.engine === "claude" ? "claude:" + slugifyCwd(proc.cwd) : "codex:" + proc.cwd;
}

function markRunning(entry: FileEntry, pid: number): void {
  entry.pid = pid;
  entry.proc = "running";
}

/**
 * Assigns pids to interactive transcript entries in place. `entries` arrive
 * mtime-desc from the scanner; the freshest transcripts win both the candidate
 * cap and the per-project fallback slot.
 */
export function assignTranscriptPids(entries: FileEntry[]): void {
  const candidates = entries.filter(isTranscriptCandidate).slice(0, MAX_TRANSCRIPT_CANDIDATES);
  if (candidates.length === 0) return;

  const holders = writingHolders(candidates.map((entry) => entry.path));
  const claimed = new Set<number>();
  const unheld: FileEntry[] = [];
  for (const entry of candidates) {
    const holder = holders.get(entry.path) ?? null;
    if (holder !== null && pidAlive(holder)) {
      markRunning(entry, holder);
      claimed.add(holder);
    } else {
      unheld.push(entry);
    }
  }
  if (unheld.length === 0) return;

  const procs = agentProcesses().filter((proc) => !claimed.has(proc.pid));

  const bySession = new Map<string, AgentProcess[]>();
  for (const proc of procs) {
    const sid = argvSessionId(proc.argv);
    if (!sid) continue;
    const key = proc.engine + ":" + sid;
    const list = bySession.get(key);
    if (list) list.push(proc);
    else bySession.set(key, [proc]);
  }
  const unmatched: FileEntry[] = [];
  for (const entry of unheld) {
    const sid = sessionIdFromPath(entry.path);
    const engine = entry.root === "codex-sessions" ? "codex" : "claude";
    const owners = (sid ? (bySession.get(engine + ":" + sid) ?? []) : []).filter((proc) => !claimed.has(proc.pid));
    if (owners.length === 1) {
      markRunning(entry, owners[0].pid);
      claimed.add(owners[0].pid);
    } else {
      unmatched.push(entry);
    }
  }
  if (unmatched.length === 0) return;

  // cwd fallback: only tty-attached processes qualify — daemon-spawned
  // sessions without a terminal have no pane to compose into and would only
  // add ambiguity.
  const byProject = new Map<string, AgentProcess[]>();
  for (const proc of procs) {
    if (proc.tty === 0 || claimed.has(proc.pid)) continue;
    const key = processKey(proc);
    const list = byProject.get(key);
    if (list) list.push(proc);
    else byProject.set(key, [proc]);
  }
  const takenKeys = new Set<string>();
  for (const entry of unmatched) {
    const key = projectKey(entry);
    if (key === null || takenKeys.has(key)) continue;
    takenKeys.add(key);
    const owners = (byProject.get(key) ?? []).filter((proc) => !claimed.has(proc.pid));
    if (owners.length === 1) {
      markRunning(entry, owners[0].pid);
      claimed.add(owners[0].pid);
    }
  }
}

/**
 * Fresh revalidation for kill: re-checks the pid against /proc at request time
 * so a pid recycled since the scanner pass cannot be signalled. The process
 * must still be the right engine and either write the transcript, own its
 * session id, or sit in the transcript's project cwd.
 */
export function verifyTranscriptPid(pathname: string, pid: number): boolean {
  const engine = transcriptEngine(pathname);
  if (engine === null || !pidAlive(pid)) return false;
  const argv = readArgv(pid);
  if (argvEngine(argv) !== engine || isHelperArgv(argv)) return false;

  if (pidWritesPath(pid, pathname)) return true;
  const sid = sessionIdFromPath(pathname);
  if (sid !== null && argvSessionId(argv) === sid) return true;

  const cwd = readCwd(pid);
  if (cwd === null) return false;
  if (engine === "claude") return slugifyCwd(cwd) === claudeSlug(pathname);
  const sessionCwd = codexSessionCwd(pathname);
  return sessionCwd !== "" && sessionCwd === cwd;
}
