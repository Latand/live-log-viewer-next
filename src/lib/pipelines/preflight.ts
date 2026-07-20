import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { realExec, type ExecPort, type ExecResult } from "@/lib/workflows/provision";

import type { PipelineRepoPreflight, PipelineRepoPreflightErrorCode } from "./types";

export interface PipelineRepoPreflightPorts {
  homeDir(): string;
  stat(pathname: string): { isDirectory(): boolean };
  access(pathname: string, mode: number): void;
  exec: ExecPort;
}

/** Repository probes must not hang the picker or the creation request. A bounded
    git exec kills a stuck probe under a short deadline; the killed run surfaces as
    a `probe_failed` transient (code `null`), never a false `not_git` (#353 AC3). */
const GIT_PROBE_TIMEOUT_MS = 4000;

const boundedGitExec: ExecPort = (command, args, cwd) => {
  if (command !== "git") return realExec(command, args, cwd);
  const res = spawnSync(command, args, { cwd, encoding: "utf8", timeout: GIT_PROBE_TIMEOUT_MS });
  if (res.error) {
    const reason = (res.error as NodeJS.ErrnoException).code === "ETIMEDOUT"
      ? `git ${args.join(" ")} timed out after ${GIT_PROBE_TIMEOUT_MS}ms`
      : res.error.message;
    return { code: null, stdout: "", stderr: reason };
  }
  return { code: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
};

const DEFAULT_PORTS: PipelineRepoPreflightPorts = {
  homeDir: os.homedir,
  stat: fs.statSync,
  access: fs.accessSync,
  exec: boundedGitExec,
};

/** Git's definitive "this is not a repository" verdict. A non-zero exit that
    lacks this message (a lock, dubious ownership, a filesystem hiccup) is
    transient, and a `code: null` run never even reached a verdict — both stay
    `probe_failed` so fidelity is preserved (#353 AC3). */
const NOT_A_REPO_RE = /not a (?:git )?repository/i;

type ProbeOutcome =
  | { value: string }
  | { failCode: "not_git" | "probe_failed"; detail: string };

/** A definitive not_git stays a bare coded verdict; only a transient probe_failed
    carries its underlying reason so fidelity is preserved without noise. */
function probeFailure(
  outcome: Extract<ProbeOutcome, { failCode: string }>,
  pathname: string,
): Extract<PipelineRepoPreflight, { ok: false }> {
  if (outcome.failCode === "not_git") return { ok: false, code: "not_git", path: pathname };
  return { ok: false, code: "probe_failed", path: pathname, detail: outcome.detail };
}

function classifyGitProbe(result: ExecResult): ProbeOutcome {
  const stdout = result.stdout.trim();
  if (result.code === 0 && stdout) return { value: stdout };
  const detail = (result.stderr || result.stdout || "").trim();
  if (result.code !== null && result.code !== 0 && NOT_A_REPO_RE.test(result.stderr)) {
    return { failCode: "not_git", detail: detail || "not a git repository" };
  }
  return { failCode: "probe_failed", detail: detail || "the git repository probe failed" };
}

/* ── Preflight cache (#353 AC2) ──────────────────────────────────────────────
   The picker validates a repository, then creation validates it again a moment
   later — two identical Git probe chains for the same unchanged repo (the
   production trace showed 1.108s + a duplicate 1.301s draft POST). A short-TTL,
   bounded cache of *successful* preflights lets creation reuse the picker's
   probe: keyed by both the request path and the canonical repoDir it resolves
   to, so the create request (which passes the canonical repoDir back) hits it.
   Only successes are cached — a failure always re-probes so a transient never
   sticks. Opt-in, so unit tests and one-off validations stay deterministic. */
type PreflightSuccess = Extract<PipelineRepoPreflight, { ok: true }>;
const PREFLIGHT_CACHE_TTL_MS = 5000;
const PREFLIGHT_CACHE_MAX = 32;
const preflightCache = new Map<string, { result: PreflightSuccess; at: number }>();

export function clearPipelinePreflightCache(): void {
  preflightCache.clear();
}

function readPreflightCache(key: string, now: number): PreflightSuccess | null {
  const hit = preflightCache.get(key);
  if (!hit) return null;
  if (now - hit.at > PREFLIGHT_CACHE_TTL_MS) {
    preflightCache.delete(key);
    return null;
  }
  return hit.result;
}

function writePreflightCache(keys: readonly string[], result: PreflightSuccess, now: number): void {
  for (const key of keys) {
    preflightCache.delete(key);
    preflightCache.set(key, { result, at: now });
  }
  while (preflightCache.size > PREFLIGHT_CACHE_MAX) {
    const oldest = preflightCache.keys().next().value;
    if (oldest === undefined) break;
    preflightCache.delete(oldest);
  }
}

function normalizeRepoPath(rawPath: string, homeDir: string): string {
  const trimmed = rawPath.trim();
  const expanded = trimmed === "~" || trimmed.startsWith("~/")
    ? path.join(homeDir, trimmed.slice(1))
    : trimmed;
  return path.resolve(expanded);
}

function denied(
  ports: PipelineRepoPreflightPorts,
  pathname: string,
  mode: number,
): boolean {
  try {
    ports.access(pathname, mode);
    return false;
  } catch {
    return true;
  }
}

export interface PreflightOptions {
  /** Reuse and populate the short-TTL success cache so creation avoids repeating
      the picker's Git probes (#353 AC2). Opt-in — off keeps one-off validations
      and unit tests fully deterministic. */
  cache?: boolean;
  now?: () => number;
}

export function preflightPipelineRepo(
  rawPath: string,
  ports: PipelineRepoPreflightPorts = DEFAULT_PORTS,
  options: PreflightOptions = {},
): PipelineRepoPreflight {
  const candidate = normalizeRepoPath(rawPath, ports.homeDir());
  const now = options.now ?? Date.now;
  if (options.cache) {
    const cached = readPreflightCache(candidate, now());
    if (cached) return cached;
  }
  let stat: { isDirectory(): boolean };
  try {
    stat = ports.stat(candidate);
  } catch (error) {
    return {
      ok: false,
      code: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "repo_untraversable",
      path: candidate,
    };
  }
  if (!stat.isDirectory()) return { ok: false, code: "not_directory", path: candidate };
  if (denied(ports, candidate, fs.constants.R_OK)) return { ok: false, code: "repo_unreadable", path: candidate };
  if (denied(ports, candidate, fs.constants.X_OK)) return { ok: false, code: "repo_untraversable", path: candidate };

  const topLevel = classifyGitProbe(ports.exec("git", ["rev-parse", "--show-toplevel"], candidate));
  if ("failCode" in topLevel) return probeFailure(topLevel, candidate);
  const repoDir = path.resolve(topLevel.value);
  if (repoDir !== candidate) {
    if (denied(ports, repoDir, fs.constants.R_OK)) return { ok: false, code: "repo_unreadable", path: repoDir };
    if (denied(ports, repoDir, fs.constants.X_OK)) return { ok: false, code: "repo_untraversable", path: repoDir };
  }

  const common = classifyGitProbe(ports.exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], repoDir));
  if ("failCode" in common) return probeFailure(common, repoDir);
  const gitCommonDir = path.resolve(repoDir, common.value);
  if (denied(ports, gitCommonDir, fs.constants.W_OK | fs.constants.X_OK)) {
    return { ok: false, code: "git_metadata_unwritable", path: gitCommonDir };
  }

  const worktreeParent = path.dirname(repoDir);
  if (denied(ports, worktreeParent, fs.constants.W_OK | fs.constants.X_OK)) {
    return { ok: false, code: "worktree_parent_unwritable", path: worktreeParent };
  }
  const result: PreflightSuccess = { ok: true, repoDir, gitCommonDir, worktreeParent };
  if (options.cache) writePreflightCache([...new Set([candidate, repoDir])], result, now());
  return result;
}

export function pipelineRepoPreflightStatus(code: PipelineRepoPreflightErrorCode): 400 | 403 | 503 {
  if (code === "probe_failed") return 503;
  return code === "missing" || code === "not_directory" || code === "not_git" ? 400 : 403;
}

export function pipelineRepoPreflightError(result: Extract<PipelineRepoPreflight, { ok: false }>): string {
  switch (result.code) {
    case "missing": return `directory does not exist: ${result.path}`;
    case "not_directory": return `not a directory: ${result.path}`;
    case "repo_unreadable": return `repository is not readable: ${result.path}`;
    case "repo_untraversable": return `repository cannot be traversed: ${result.path}`;
    case "not_git": return `not a git repository: ${result.path}`;
    case "probe_failed": return `the git repository probe failed for ${result.path}${result.detail ? `: ${result.detail}` : ""}`;
    case "git_metadata_unwritable": return `Git metadata is not writable: ${result.path}`;
    case "worktree_parent_unwritable": return `pipeline worktree parent is not writable: ${result.path}`;
  }
}
