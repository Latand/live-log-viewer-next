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
