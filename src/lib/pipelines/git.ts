import type { ExecPort, ExecResult } from "@/lib/workflows/provision";

import type { Pipeline } from "./types";

export type PipelineGitResult = { ok: true; sha: string; baseBranch?: string } | { ok: false; error: string };
export type PipelineBaseResult = { ok: true; baseBranch: string; baseRef: string } | { ok: false; error: string };

function failure(step: string, result: ExecResult): { ok: false; error: string } {
  return { ok: false, error: `${step}: ${(result.stderr || result.stdout || "no output").trim()}` };
}

function validBaseBranch(value: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.includes("@{") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock")
  );
}

export function resolvePipelineBase(
  repoDir: string,
  input: { baseBranch?: string; baseRef?: string },
  exec: ExecPort,
): PipelineBaseResult {
  const baseBranch = input.baseBranch?.trim() || "main";
  if (!validBaseBranch(baseBranch)) return { ok: false, error: "the pipeline base branch is invalid" };
  const requestedRef = input.baseRef?.trim();
  if (!requestedRef) {
    const fetch = exec(
      "git",
      ["fetch", "--no-tags", "origin", `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`],
      repoDir,
    );
    if (fetch.code !== 0) return failure(`fetching origin/${baseBranch}`, fetch);
  }
  const ref = requestedRef || `origin/${baseBranch}`;
  const resolved = exec("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], repoDir);
  if (resolved.code !== 0) return failure(`resolving pipeline base ${ref}`, resolved);
  const baseRef = resolved.stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(baseRef)) return { ok: false, error: `resolving pipeline base ${ref}: expected an exact commit SHA` };
  return { ok: true, baseBranch, baseRef };
}

export function provisionPipelineWorktree(pipeline: Pipeline, exec: ExecPort): PipelineGitResult {
  if (!pipeline.baseBranch || !/^[0-9a-f]{40}$/i.test(pipeline.baseRef)) {
    return { ok: false, error: "the pipeline base is unresolved" };
  }
  const add = exec("git", ["worktree", "add", "-b", pipeline.branch, pipeline.worktreeDir, pipeline.baseRef], pipeline.repoDir);
  if (add.code !== 0) {
    const probe = exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], pipeline.worktreeDir);
    if (probe.code !== 0 || probe.stdout.trim() !== pipeline.branch) return failure("git worktree add", add);
  }
  const base = exec("git", ["rev-parse", "HEAD"], pipeline.worktreeDir);
  if (base.code !== 0 || !base.stdout.trim()) return failure("resolving the pipeline base ref", base);
  if (base.stdout.trim() !== pipeline.baseRef) return { ok: false, error: "the pipeline worktree does not match its persisted base" };
  return { ok: true, sha: pipeline.baseRef, baseBranch: pipeline.baseBranch };
}

export function commitPipelineStage(pipeline: Pipeline, stageId: string, allowCommit: boolean, exec: ExecPort): PipelineGitResult {
  const status = exec("git", ["status", "--porcelain"], pipeline.worktreeDir);
  if (status.code !== 0) return failure("checking the pipeline worktree", status);
  if (status.stdout.trim()) {
    if (!allowCommit) return { ok: false, error: `read-only stage ${stageId} modified the pipeline worktree` };
    const add = exec("git", ["add", "-A"], pipeline.worktreeDir);
    if (add.code !== 0) return failure("staging the passed stage", add);
    const commit = exec("git", ["commit", "-m", `pipeline(${pipeline.id}): complete ${stageId}`], pipeline.worktreeDir);
    if (commit.code !== 0) return failure("committing the passed stage", commit);
  }
  const head = exec("git", ["rev-parse", "HEAD"], pipeline.worktreeDir);
  if (head.code !== 0 || !head.stdout.trim()) return failure("recording the passed stage commit", head);
  return { ok: true, sha: head.stdout.trim() };
}

export function resetPipelineStage(pipeline: Pipeline, exec: ExecPort): PipelineGitResult {
  if (!pipeline.lastPassedCommit) return { ok: false, error: "the pipeline has no passed-stage commit" };
  const reset = exec("git", ["reset", "--hard", pipeline.lastPassedCommit], pipeline.worktreeDir);
  if (reset.code !== 0) return failure("resetting the pipeline stage", reset);
  const clean = exec("git", ["clean", "-fd"], pipeline.worktreeDir);
  if (clean.code !== 0) return failure("cleaning the pipeline stage", clean);
  return { ok: true, sha: pipeline.lastPassedCommit };
}
