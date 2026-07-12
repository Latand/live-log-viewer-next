import { spawnSync } from "node:child_process";

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
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([^/]+\/[^/]+)$/.exec(trimmed);
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
