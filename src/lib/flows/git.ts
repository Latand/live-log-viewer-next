import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { Flow } from "./types";

/** Base-ref resolution for a flow's review scope, isolated from the state machine. */

export function resolveBaseRef(cwd: string, baseMode: Flow["baseMode"]): { ok: true; sha: string } | { ok: false; error: string } {
  const args =
    baseMode === "head"
      ? ["rev-parse", "HEAD"]
      : ["merge-base", "HEAD", defaultBranch(cwd) ?? "origin/main"];
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    return { ok: false, error: (res.stderr || res.stdout || "failed to resolve git base ref").trim() };
  }
  const sha = res.stdout.trim();
  return sha ? { ok: true, sha } : { ok: false, error: "git returned an empty base ref" };
}

function defaultBranch(cwd: string): string | null {
  const remote = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd, encoding: "utf8" });
  if (remote.status === 0 && remote.stdout.trim()) return remote.stdout.trim().replace(/^origin\//, "origin/");
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    const res = spawnSync("git", ["rev-parse", "--verify", candidate], { cwd, encoding: "utf8" });
    if (res.status === 0) return candidate;
  }
  return null;
}

export function githubRepositoryFromRemote(remote: string): string | null {
  const trimmed = remote.trim().replace(/\.git$/, "");
  const ssh = new RegExp(String.raw`^(?:ssh:\/\/)?git` + "@" + String.raw`github\.com[:/]([^/]+\/[^/]+)$`).exec(trimmed);
  if (ssh) return ssh[1] ?? null;
  try {
    const url = new URL(trimmed);
    if (url.hostname !== "github.com") return null;
    const repository = url.pathname.replace(/^\//, "");
    return /^[^/]+\/[^/]+$/.test(repository) ? repository : null;
  } catch {
    return null;
  }
}

/* ── Project-root → GitHub repository (issue #290 readiness issue links) ── */

const REPOSITORY_CACHE_TTL_MS = 10 * 60_000;
const repositoryCacheHost = globalThis as typeof globalThis & {
  __llvRepositoryCache?: Map<string, { repository: string | null; at: number }>;
};
const repositoryCache = repositoryCacheHost.__llvRepositoryCache ??= new Map<string, { repository: string | null; at: number }>();

function gitDirectory(root: string): string | null {
  const dotGit = path.join(root, ".git");
  try {
    const stat = fs.lstatSync(dotGit);
    if (stat.isDirectory()) return dotGit;
    if (!stat.isFile()) return null;
    const pointer = fs.readFileSync(dotGit, "utf8").slice(0, 4096);
    const match = /^gitdir:\s*(.+)\s*$/im.exec(pointer);
    return match?.[1] ? path.resolve(root, match[1]) : null;
  } catch {
    return null;
  }
}

function commonGitDirectory(directory: string): string {
  try {
    const common = fs.readFileSync(path.join(directory, "commondir"), "utf8").trim();
    return common ? path.resolve(directory, common) : directory;
  } catch {
    return directory;
  }
}

function originRemoteFromConfig(root: string): string | null {
  const directory = gitDirectory(root);
  if (!directory) return null;
  let config: string;
  try {
    config = fs.readFileSync(path.join(commonGitDirectory(directory), "config"), "utf8");
  } catch {
    return null;
  }
  let origin = false;
  for (const line of config.split(/\r?\n/)) {
    const section = /^\s*\[\s*remote\s+"([^"]+)"\s*\]\s*$/i.exec(line);
    if (section) {
      origin = section[1] === "origin";
      continue;
    }
    if (/^\s*\[/.test(line)) {
      origin = false;
      continue;
    }
    if (!origin) continue;
    const value = /^\s*url\s*=\s*(.*?)\s*$/i.exec(line)?.[1];
    const url = value?.replace(/\s+[;#].*$/, "").trim();
    if (url) return url;
  }
  return null;
}

/** GitHub `owner/repo` of a project root's origin remote. The files route calls
    this for every catalog row, so it reads local Git metadata directly instead
    of serially spawning one `git` process per project on the HTTP event loop. */
export function repositoryForProjectRoot(root: string, nowMs = Date.now()): string | null {
  const cached = repositoryCache.get(root);
  if (cached && nowMs - cached.at < REPOSITORY_CACHE_TTL_MS) return cached.repository;
  let repository: string | null = null;
  try {
    const remote = originRemoteFromConfig(root);
    if (remote) repository = githubRepositoryFromRemote(remote);
  } catch {
    repository = null;
  }
  repositoryCache.set(root, { repository, at: nowMs });
  return repository;
}

/** Test seam: drop the per-root repository cache. */
export function resetRepositoryCache(): void {
  repositoryCache.clear();
}

export function resolveFlowMergeIdentity(cwd: string): { repository: string; headRef: string; headSha: string } | null {
  const remote = spawnSync("git", ["remote", "get-url", "origin"], { cwd, encoding: "utf8" });
  const branch = spawnSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" });
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  if (remote.status !== 0 || branch.status !== 0 || head.status !== 0) return null;
  const repository = githubRepositoryFromRemote(remote.stdout);
  const headRef = branch.stdout.trim();
  const headSha = head.stdout.trim();
  return repository && headRef && /^[0-9a-f]{40}$/i.test(headSha) ? { repository, headRef, headSha } : null;
}

export function resolveCleanFlowHead(cwd: string): string | null {
  const status = spawnSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
    cwd,
    encoding: "utf8",
    timeout: 2_000,
  });
  if (status.status !== 0 || status.stdout.trim()) return null;
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", timeout: 2_000 });
  const sha = head.stdout.trim();
  return head.status === 0 && /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}

export function resolveFlowRemoteHead(cwd: string, headRef: string): string | null {
  const remote = spawnSync("git", ["ls-remote", "--heads", "origin", `refs/heads/${headRef}`], {
    cwd,
    encoding: "utf8",
    timeout: 5_000,
  });
  if (remote.status !== 0) return null;
  const sha = remote.stdout.trim().split(/\s+/)[0] ?? "";
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : null;
}
