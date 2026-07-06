import fs from "node:fs";
import path from "node:path";

import { procBackend } from "@/lib/proc";
import { ROOTS } from "./roots";

/* Outlives the client's 10 s /api/files poll so these memos survive a full
   poll instead of rebuilding every request; freshness-critical callers (a
   rebuild right after a kill) pass fresh=true to bypass the memo. */
const HOLDERS_TTL_MS = 12_000;
const MAX_PATH_HOLDER_CANDIDATES = 256;

export type AgentEngine = "claude" | "codex";

/** A live claude/codex process observed via the proc backend. `tty` is 0 without a terminal. */
export interface AgentProcess {
  pid: number;
  engine: AgentEngine;
  argv: string[];
  cwd: string;
  tty: number;
}

let outputMemo: { at: number; map: Map<string, number> } | null = null;
let pathMemo: { at: number; key: string; map: Map<string, number> } | null = null;
let agentMemo: { at: number; list: AgentProcess[] } | null = null;

export function pidAlive(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0 && procBackend.pidAlive(pid);
}

/**
 * All fds anywhere on the system whose target ends in ".output", mapped to
 * one holding pid each (first found wins; read vs. write mode is not
 * distinguished — a background task's own output file only ever has one
 * holder in practice). Scoped to the claude-tasks root: on Linux that scope
 * is free (the backend already walks all of /proc), on the portable backend
 * it bounds an `lsof +D` search to a small directory tree instead of the
 * whole machine.
 */
export function outputHolders(fresh = false): Map<string, number> {
  const now = Date.now();
  if (!fresh && outputMemo && now - outputMemo.at < HOLDERS_TTL_MS) return outputMemo.map;

  const holders = new Map<string, number>();
  procBackend.scanFdTargetsUnder(ROOTS["claude-tasks"], (target, pid) => {
    if (target.endsWith(".output") && !holders.has(target)) holders.set(target, pid);
  });

  outputMemo = { at: now, map: holders };
  return holders;
}

function realpathSafe(pathname: string): string | null {
  try {
    return fs.realpathSync(pathname);
  } catch {
    return null;
  }
}

/** Maps each of `paths` to a pid holding it open for writing, when one exists. */
export function writingHolders(paths: Iterable<string>, fresh = false): Map<string, number> {
  const aliasToPath = new Map<string, string>();
  for (const pathname of paths) {
    if (aliasToPath.size >= MAX_PATH_HOLDER_CANDIDATES * 2) break;
    if (!pathname) continue;
    aliasToPath.set(pathname, pathname);
    const real = realpathSafe(pathname);
    if (real) aliasToPath.set(real, pathname);
  }

  const key = [...aliasToPath.keys()].sort().join("\0");
  const now = Date.now();
  if (!fresh && pathMemo && pathMemo.key === key && now - pathMemo.at < HOLDERS_TTL_MS) return pathMemo.map;

  const holders = new Map<string, number>();
  if (aliasToPath.size > 0) {
    procBackend.scanFdTargetsFor([...aliasToPath.keys()], (target, pid, writable) => {
      // writable() goes last: it is the only per-fd probe with a real cost
      // (an lstat on Linux), so only alias-matched fds ever pay for it.
      const pathname = aliasToPath.get(target);
      if (pathname && !holders.has(pathname) && writable()) holders.set(pathname, pid);
    });
  }

  pathMemo = { at: now, key, map: holders };
  return holders;
}

/** True when `pid` currently keeps `pathname` open for writing. */
export function pidWritesPath(pid: number, pathname: string): boolean {
  return procBackend.pidWritesPath(pid, pathname);
}

/** True when `pid` currently keeps `pathname` open in any mode. */
export function pidHoldsPath(pid: number, pathname: string): boolean {
  return procBackend.pidHoldsPath(pid, pathname);
}

export function readArgv(pid: number): string[] {
  return procBackend.readArgv(pid);
}

/** Working directory of `pid`, or null when it cannot be determined. */
export function readCwd(pid: number): string | null {
  return procBackend.readCwd(pid);
}

/** Textual argv, space-joined — only used for a substring check, so the loss
    of exact token boundaries versus readArgv() does not matter to callers. */
export function readCmdlineText(pid: number): string {
  return procBackend.readArgv(pid).join(" ");
}

/**
 * Engine of a process judged by its first two argv tokens (the binary may run
 * through node/bun, pushing the real entrypoint to argv[1]). Matching the
 * basename exactly ("claude", "claude.exe", "codex") keeps sibling binaries
 * like `codex-telegram-mcp` out.
 */
export function argvEngine(argv: string[]): AgentEngine | null {
  for (const token of argv.slice(0, 2)) {
    const base = path.basename(token);
    if (base === "claude" || base === "claude.exe") return "claude";
    if (base === "codex" || base === "codex.exe") return "codex";
  }
  return null;
}

// Claude Code internal workers: the session daemon plus its pty host/spare
// wrappers. They share the engine binary and often the project cwd, so they
// must not compete with the real interactive CLI for pid attribution.
const HELPER_ARGS = new Set(["daemon", "--bg-pty-host", "--bg-spare"]);

export function isHelperArgv(argv: string[]): boolean {
  return argv.some((token) => HELPER_ARGS.has(token));
}

/** ppid of `pid`; null when the process is gone or its parent is pid 1. */
export function readPpid(pid: number): number | null {
  return procBackend.readPpid(pid);
}

/**
 * Value of `name` in `pid`'s environment. On the portable backend this is
 * always null — see proc/portable.ts's readEnvVar for why — so callers must
 * already tolerate a missing value (they do: it is one signal among several).
 */
export function readEnvVar(pid: number, name: string): string | null {
  return procBackend.readEnvVar(pid, name);
}

/** All non-helper claude/codex processes currently alive, memoised briefly. */
export function agentProcesses(fresh = false): AgentProcess[] {
  const now = Date.now();
  if (!fresh && agentMemo && now - agentMemo.at < HOLDERS_TTL_MS) return agentMemo.list;

  const list: AgentProcess[] = [];
  for (const proc of procBackend.listProcesses()) {
    const engine = argvEngine(proc.argv);
    if (engine === null || isHelperArgv(proc.argv)) continue;
    if (proc.cwd === null) continue;
    list.push({ pid: proc.pid, engine, argv: proc.argv, cwd: proc.cwd, tty: proc.tty });
  }
  agentMemo = { at: now, list };
  return list;
}
