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

function validPipelineBranch(value: string): boolean {
  return validBaseBranch(value);
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

/** Returns the clean checked-out SHA only when this worktree still owns its
    persisted branch. Review evidence must name this exact revision. */
export function currentPipelineBranchHead(pipeline: Pipeline, exec: ExecPort): PipelineGitResult {
  if (!validPipelineBranch(pipeline.branch)) return { ok: false, error: "the pipeline branch is invalid" };
  const status = exec("git", ["status", "--porcelain"], pipeline.worktreeDir);
  if (status.code !== 0) return failure("checking the pipeline worktree", status);
  if (status.stdout.trim()) return { ok: false, error: "the pipeline worktree has uncommitted changes; choose whether to commit or discard them before retrying review" };
  const branch = exec("git", ["branch", "--show-current"], pipeline.worktreeDir);
  if (branch.code !== 0) return failure("checking the pipeline branch", branch);
  if (branch.stdout.trim() !== pipeline.branch) return { ok: false, error: "the pipeline worktree is not checked out on its persisted branch" };
  const head = exec("git", ["rev-parse", "HEAD"], pipeline.worktreeDir);
  if (head.code !== 0) return failure("resolving the pipeline branch HEAD", head);
  const sha = head.stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(sha)) return { ok: false, error: "resolving the pipeline branch HEAD: expected an exact commit SHA" };
  return { ok: true, sha };
}

/**
 * Resolves the exact revision a retried reviewer will receive. A remote repair
 * fast-forwards the shared worktree; a local repair stays intact; divergence
 * parks for an operator and preserves both repair tips. Failed write-stage
 * retries continue to use resetPipelineStage.
 */
export function synchronizePipelineRetryHead(pipeline: Pipeline, exec: ExecPort): PipelineGitResult {
  const local = currentPipelineBranchHead(pipeline, exec);
  if (!local.ok) return local;

  const remoteProbe = exec("git", ["ls-remote", "--heads", "origin", `refs/heads/${pipeline.branch}`], pipeline.worktreeDir);
  if (remoteProbe.code !== 0) return failure("checking the remote pipeline branch", remoteProbe);
  if (!remoteProbe.stdout.trim()) return local;

  const fetch = exec(
    "git",
    ["fetch", "--no-tags", "origin", `+refs/heads/${pipeline.branch}:refs/remotes/origin/${pipeline.branch}`],
    pipeline.worktreeDir,
  );
  if (fetch.code !== 0) return failure("fetching the remote pipeline branch", fetch);
  const remote = exec("git", ["rev-parse", `refs/remotes/origin/${pipeline.branch}`], pipeline.worktreeDir);
  if (remote.code !== 0) return failure("resolving the remote pipeline branch", remote);
  const remoteSha = remote.stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(remoteSha)) return { ok: false, error: "resolving the remote pipeline branch: expected an exact commit SHA" };
  if (remoteSha === local.sha) return local;

  const localIsAncestor = exec("git", ["merge-base", "--is-ancestor", local.sha, remoteSha], pipeline.worktreeDir);
  if (localIsAncestor.code === 0) {
    const merge = exec("git", ["merge", "--ff-only", `refs/remotes/origin/${pipeline.branch}`], pipeline.worktreeDir);
    if (merge.code !== 0) return failure("fast-forwarding the pipeline worktree to its remote repair", merge);
    return { ok: true, sha: remoteSha };
  }
  if (localIsAncestor.code !== 1) return failure("comparing local and remote pipeline revisions", localIsAncestor);

  const remoteIsAncestor = exec("git", ["merge-base", "--is-ancestor", remoteSha, local.sha], pipeline.worktreeDir);
  if (remoteIsAncestor.code === 0) return local;
  if (remoteIsAncestor.code !== 1) return failure("comparing local and remote pipeline revisions", remoteIsAncestor);
  return { ok: false, error: "the local and remote pipeline branches diverged; choose which repair to keep before retrying review" };
}
