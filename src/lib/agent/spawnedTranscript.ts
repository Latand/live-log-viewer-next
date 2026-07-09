import fs from "node:fs";
import path from "node:path";

import { headCwd } from "@/lib/agent/transcript";
import { isNativeCodexSubagentTranscript } from "@/lib/scanner/codexNative";
import { readPpid, writingHolders } from "@/lib/scanner/process";
import { ROOTS } from "@/lib/scanner/roots";

import type { AgentEngine } from "./cli";

const CODEX_DISCOVERY_TIMEOUT_MS = 2_500;
const CODEX_DISCOVERY_POLL_MS = 150;
const CODEX_MTIME_SLOP_MS = 5_000;
const CODEX_MAX_CANDIDATES = 32;
const CODEX_MAX_SCAN_DEPTH = 6;
const ANCESTRY_MAX_DEPTH = 64;

export interface SpawnedTranscriptLookupEnv {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  candidatePaths?: (sinceMs: number) => string[];
  holderPidByPath?: (paths: Iterable<string>) => Map<string, number>;
  parentPidOf?: (pid: number) => number | null;
  timeoutMs?: number;
  pollMs?: number;
}

export interface SpawnedTranscriptLookup {
  engine: AgentEngine;
  knownTranscript?: string | null;
  panePid?: number | null;
  cwd: string;
  startedAtMs: number;
  /** The single Codex sessions directory selected for this fresh spawn. */
  codexSessionsDir?: string | null;
  env?: SpawnedTranscriptLookupEnv;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recentCodexSessionPaths(sinceMs: number, sessionsDir = ROOTS["codex-sessions"]): string[] {
  const minMtime = sinceMs - CODEX_MTIME_SLOP_MS;
  const candidates: { path: string; mtimeMs: number }[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > CODEX_MAX_SCAN_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const pathname = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(pathname, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        const st = fs.statSync(pathname);
        if (st.mtimeMs >= minMtime) candidates.push({ path: pathname, mtimeMs: st.mtimeMs });
      } catch {
        continue;
      }
    }
  };
  walk(sessionsDir, 0);
  return candidates
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, CODEX_MAX_CANDIDATES)
    .map((candidate) => candidate.path);
}

function pidReachesAncestor(pid: number, ancestor: number, parentPidOf: (pid: number) => number | null): boolean {
  const seen = new Set<number>();
  for (let cursor: number | null = pid; cursor !== null && !seen.has(cursor); cursor = parentPidOf(cursor)) {
    if (cursor === ancestor) return true;
    seen.add(cursor);
    if (seen.size > ANCESTRY_MAX_DEPTH) break;
  }
  return false;
}

function cwdCompatible(pathname: string, cwd: string): boolean {
  const recorded = headCwd(pathname, { bytes: 8192, maxLines: 10 });
  return recorded === null || recorded === cwd;
}

function isNativeCodexSubagent(pathname: string): boolean {
  try {
    const st = fs.statSync(pathname);
    return isNativeCodexSubagentTranscript(pathname, st.size);
  } catch {
    return false;
  }
}

function resolveCodexCandidate(
  paths: string[],
  panePid: number,
  cwd: string,
  env: Required<Pick<SpawnedTranscriptLookupEnv, "holderPidByPath" | "parentPidOf">>,
): string | null {
  const holders = env.holderPidByPath(paths);
  for (const pathname of paths) {
    const holder = holders.get(pathname);
    if (
      holder !== undefined &&
      cwdCompatible(pathname, cwd) &&
      !isNativeCodexSubagent(pathname) &&
      pidReachesAncestor(holder, panePid, env.parentPidOf)
    ) {
      return pathname;
    }
  }
  return null;
}

export async function resolveSpawnedTranscriptPath(input: SpawnedTranscriptLookup): Promise<string | null> {
  if (input.knownTranscript) return input.knownTranscript;
  if (input.engine !== "codex") return null;
  const panePid = input.panePid;
  if (typeof panePid !== "number" || !Number.isInteger(panePid) || panePid <= 0) return null;

  const env = input.env ?? {};
  const now = env.now ?? Date.now;
  const wait = env.sleep ?? sleep;
  const candidatePaths = env.candidatePaths ?? ((sinceMs: number) => recentCodexSessionPaths(sinceMs, input.codexSessionsDir ?? ROOTS["codex-sessions"]));
  const holderPidByPath = env.holderPidByPath ?? ((paths: Iterable<string>) => writingHolders(paths, true));
  const parentPidOf = env.parentPidOf ?? readPpid;
  const timeoutMs = env.timeoutMs ?? CODEX_DISCOVERY_TIMEOUT_MS;
  const pollMs = env.pollMs ?? CODEX_DISCOVERY_POLL_MS;
  const deadline = now() + timeoutMs;

  for (;;) {
    const hit = resolveCodexCandidate(candidatePaths(input.startedAtMs), panePid, input.cwd, { holderPidByPath, parentPidOf });
    if (hit) return hit;
    if (now() >= deadline) return null;
    await wait(pollMs);
  }
}
