import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { codexSessionRoots } from "@/lib/accounts/codex";

import type { RootKey } from "../types";

const HOME = os.homedir();

/**
 * Claude Code writes background-task output under a per-uid "claude-<uid>"
 * directory inside the OS temp dir. On Linux `os.tmpdir()` is normally "/tmp"
 * itself, so both candidates below coincide. On macOS `os.tmpdir()` resolves
 * to a per-session path under $TMPDIR (e.g. /var/folders/xx/yyyy/T), which is
 * where the CLI actually creates it — "/tmp/claude-<uid>" would never exist
 * there. Whichever candidate already exists wins; with neither existing yet
 * (fresh install, no background task run so far) the tmpdir-based one is kept
 * since that is what the current platform's CLI would create.
 */
function claudeTasksRoot(): string {
  const uid = process.getuid?.() ?? 1000;
  const tmpdirCandidate = path.join(os.tmpdir(), "claude-" + uid);
  const legacyCandidate = "/tmp/claude-" + uid;
  if (tmpdirCandidate === legacyCandidate) return tmpdirCandidate;
  if (fs.existsSync(tmpdirCandidate)) return tmpdirCandidate;
  if (fs.existsSync(legacyCandidate)) return legacyCandidate;
  return tmpdirCandidate;
}

export const ROOTS: Record<RootKey, string> = {
  "codex-sessions": path.join(HOME, ".codex/sessions"),
  "claude-projects": path.join(HOME, ".claude/projects"),
  "claude-tasks": claudeTasksRoot(),
};

/** Every scanner root, including the account-specific Codex homes. */
export function scanRootEntries(): [RootKey, string][] {
  return [
    ...codexSessionRoots().map((root): [RootKey, string] => ["codex-sessions", root]),
    ["claude-projects", ROOTS["claude-projects"]],
    ["claude-tasks", ROOTS["claude-tasks"]],
  ];
}

export const EXTS = [".log", ".jsonl", ".output", ".txt"] as const;

export const MAX_CHUNK = 768 * 1024;

/** Max entries returned by /api/files (most recent first). */
export const FILE_CAP = 400;

function realpathSafe(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Security gate for /api/log: the resolved real path must live under one of
 * the whitelisted roots. Mirrors `path_allowed` in the Python prototype.
 */
export function pathAllowed(candidate: string): boolean {
  const real = realpathSafe(candidate);
  if (!real) return false;
  return scanRootEntries().some(([, root]) => {
    const rootReal = realpathSafe(root);
    return rootReal !== null && real.startsWith(rootReal + path.sep);
  });
}

/** The registered Codex session root containing a path, when it has one. */
export function codexSessionRootFor(candidate: string): string | null {
  for (const root of codexSessionRoots()) {
    try {
      const real = fs.realpathSync(candidate);
      const rootReal = fs.realpathSync(root);
      if (real.startsWith(rootReal + path.sep)) return root;
    } catch {
      continue;
    }
  }
  return null;
}
