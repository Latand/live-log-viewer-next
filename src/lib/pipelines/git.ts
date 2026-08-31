import type { ExecPort, ExecResult } from "@/lib/workflows/provision";

import type { Pipeline } from "./types";
import { pathIsDeclaredOutput } from "./stageAccess";

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

function changedWorktreePaths(exec: ExecPort, cwd: string): { ok: true; paths: string[] } | { ok: false; error: string } {
  const tracked = exec("git", ["diff", "--name-only", "--no-renames", "-z", "HEAD", "--"], cwd);
  if (tracked.code !== 0) return failure("checking tracked stage output paths", tracked);
  const untracked = exec("git", ["ls-files", "--others", "--exclude-standard", "-z", "--"], cwd);
  if (untracked.code !== 0) return failure("checking untracked stage output paths", untracked);
  const paths = `${tracked.stdout}\0${untracked.stdout}`.split("\0").filter(Boolean);
  return { ok: true, paths: [...new Set(paths)] };
}

export function commitPipelineStage(
  pipeline: Pipeline,
  stageId: string,
  allowCommit: boolean,
  exec: ExecPort,
  declaredOutputs: readonly string[] = [],
  protectedHead: string | null = allowCommit ? null : pipeline.lastPassedCommit,
): PipelineGitResult {
  const status = exec("git", ["status", "--porcelain"], pipeline.worktreeDir);
  if (status.code !== 0) return failure("checking the pipeline worktree", status);
  const initialHead = exec("git", ["rev-parse", "HEAD"], pipeline.worktreeDir);
  if (initialHead.code !== 0 || !initialHead.stdout.trim()) return failure("recording the passed stage commit", initialHead);
  if (protectedHead !== null && initialHead.stdout.trim() !== protectedHead) {
    return { ok: false, error: `read-only stage ${stageId} created a commit` };
  }
  if (!status.stdout.trim()) return { ok: true, sha: initialHead.stdout.trim() };
  if (!allowCommit) {
    if (declaredOutputs.length === 0) return { ok: false, error: `read-only stage ${stageId} modified the pipeline worktree` };
    const changed = changedWorktreePaths(exec, pipeline.worktreeDir);
    if (!changed.ok) return changed;
    const refused = changed.paths.filter((candidate) => !pathIsDeclaredOutput(candidate, declaredOutputs));
    if (refused.length > 0 || changed.paths.length === 0) {
      return { ok: false, error: `read-only stage ${stageId} modified undeclared worktree paths` };
    }
  }
  const add = exec("git", ["add", "-A", ...(allowCommit ? [] : ["--", ...declaredOutputs])], pipeline.worktreeDir);
  if (add.code !== 0) return failure("staging the passed stage", add);
  const commit = exec("git", ["commit", "-m", `pipeline(${pipeline.id}): complete ${stageId}`], pipeline.worktreeDir);
  if (commit.code !== 0) return failure("committing the passed stage", commit);
  const head = exec("git", ["rev-parse", "HEAD"], pipeline.worktreeDir);
  if (head.code !== 0 || !head.stdout.trim()) return failure("recording the passed stage commit", head);
  return { ok: true, sha: head.stdout.trim() };
}

export type PipelineWorktreeChanges =
  | { ok: true; paths: string[]; truncated: boolean }
  | { ok: false; error: string };

/** Lists the uncommitted paths a pipeline worktree still holds. Closing a
    pipeline (#670) must never discard stage work, so the close only reads this
    — it reports what it left behind instead of resetting or cleaning. */
export function pipelineWorktreeChanges(
  pipeline: Pick<Pipeline, "worktreeDir">,
  exec: ExecPort,
  limit = 20,
): PipelineWorktreeChanges {
  const status = exec("git", ["status", "--porcelain"], pipeline.worktreeDir);
  if (status.code !== 0) return failure("checking the pipeline worktree", status);
  const paths = status.stdout
    .split("\n")
    .map((line) => line.trimEnd())
    /* Porcelain v1 lines are `XY <path>`; a rename carries `<old> -> <new>`. */
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3).split(" -> ").at(-1)!.trim())
    .filter((entry) => entry.length > 0);
  return { ok: true, paths: paths.slice(0, limit), truncated: paths.length > limit };
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

/** Reads the authoritative remote pipeline branch without relying on a stale
    tracking ref. Approval fences use this alongside the clean local HEAD. */
export function currentPipelineRemoteBranchHead(pipeline: Pipeline, exec: ExecPort): PipelineGitResult {
  if (!validPipelineBranch(pipeline.branch)) return { ok: false, error: "the pipeline branch is invalid" };
  const remote = exec("git", ["ls-remote", "--heads", "origin", `refs/heads/${pipeline.branch}`], pipeline.worktreeDir);
  if (remote.code !== 0) return failure("checking the remote pipeline branch", remote);
  const sha = remote.stdout.trim().split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{40}$/i.test(sha)) return { ok: false, error: "the remote pipeline branch has no exact commit SHA" };
  return { ok: true, sha };
}

export type PipelinePublishResult =
  | { ok: true; sha: string; remote: "published" | "unavailable" }
  | { ok: true; sha: string; remote: "unreachable"; detail: string }
  | { ok: false; error: string };

const REMOTE_READ_TIMEOUT = "5s";

/** A publication tick gets one bounded remote read. The engine tick is already
    the retry loop, so retrying or sleeping inside this synchronous adapter only
    multiplies event-loop stalls. `timeout` exists in both the runtime image and
    the Linux host namespace used by agent shims. */
function readRemotePipelineBranch(
  pipeline: Pipeline,
  exec: ExecPort,
  step: string,
): { ok: true; sha: string } | { ok: false; error: string } {
  const result = exec(
    "timeout",
    ["--signal=KILL", REMOTE_READ_TIMEOUT, "git", "ls-remote", "--heads", "origin", `refs/heads/${pipeline.branch}`],
    pipeline.worktreeDir,
  );
  if (result.code === 0) return { ok: true, sha: result.stdout.trim().split(/\s+/)[0] ?? "" };
  if (result.code === 124 || result.code === 137) {
    return { ok: false, error: `${step}: git remote read timed out after ${REMOTE_READ_TIMEOUT}` };
  }
  return failure(step, result);
}

export interface PipelinePublishRequest {
  /** The immutable revision the pipeline accepted. This exact object is what
      gets pushed and what the publication is revalidated against. */
  acceptedSha: string;
  /** What the caller last recorded as published; a match short-circuits the
      whole probe. */
  publishedSha?: string | null;
}

/**
 * Publishes the accepted pipeline revision so the review layer can fence on the
 * exact revision it reviews. The orchestrator owns this step: a builder that
 * commits a usable head without pushing it must still hand off
 * deterministically, and every review round fences on `origin/<branch>`
 * (captureReviewHead), so a branch nobody published strands the handoff.
 *
 * The accepted SHA is an input, never re-derived here, and the push source is
 * that immutable object rather than `refs/heads/<branch>`. A branch ref is a
 * moving target: between capturing the head and running the push, a concurrent
 * stage can advance it, and pushing the ref would publish a commit the pipeline
 * never accepted — leaving review fenced on a different target than the one
 * that passed. Pushing `<sha>:refs/heads/<branch>` makes that unrepresentable,
 * and the fast-forward and confirmation checks compare against the same
 * immutable SHA, so a mid-flight advance can only fail the publication, never
 * redirect it.
 *
 * A repo with no `origin` reports `unavailable` — there is nothing to publish
 * to, which is a different fact from a failed publication and never a stall on
 * its own.
 */
export function publishPipelineBranch(pipeline: Pipeline, exec: ExecPort, request: PipelinePublishRequest): PipelinePublishResult {
  const acceptedSha = request.acceptedSha;
  if (!/^[0-9a-f]{40}$/i.test(acceptedSha)) {
    return { ok: false, error: `the accepted pipeline revision is not an exact commit SHA: ${acceptedSha || "absent"}` };
  }
  const local = currentPipelineBranchHead(pipeline, exec);
  if (!local.ok) return local;
  /* The worktree must still hold the accepted revision when publication starts.
     A head that has moved on is not this publication's business to push. */
  if (local.sha !== acceptedSha) {
    return { ok: false, error: `the pipeline worktree is at ${local.sha}, not the accepted revision ${acceptedSha}; nothing was published` };
  }
  if (request.publishedSha && request.publishedSha === acceptedSha) return { ok: true, sha: acceptedSha, remote: "published" };

  const origin = exec("git", ["remote", "get-url", "origin"], pipeline.worktreeDir);
  if (origin.code !== 0 || !origin.stdout.trim()) return { ok: true, sha: acceptedSha, remote: "unavailable" };

  const probe = readRemotePipelineBranch(pipeline, exec, "checking the remote pipeline branch");
  if (!probe.ok) return { ok: true, sha: acceptedSha, remote: "unreachable", detail: probe.error };
  const remoteSha = probe.sha;
  if (remoteSha === acceptedSha) return { ok: true, sha: acceptedSha, remote: "published" };
  if (remoteSha) {
    if (!/^[0-9a-f]{40}$/i.test(remoteSha)) return { ok: false, error: "the remote pipeline branch has no exact commit SHA" };
    /* A revision pushed from another checkout is not in this worktree's object
       database, and `merge-base` cannot reason about a commit it does not have
       — it fails outright, which would report a transient git error where the
       truth is a divergence. Fetch it first, and only when it is genuinely
       unknown, so an ordinary fast-forward still costs no extra round trip. */
    const known = exec("git", ["cat-file", "-e", `${remoteSha}^{commit}`], pipeline.worktreeDir);
    if (known.code !== 0) {
      const fetched = exec(
        "git",
        ["fetch", "--no-tags", "origin", `+refs/heads/${pipeline.branch}:refs/remotes/origin/${pipeline.branch}`],
        pipeline.worktreeDir,
      );
      if (fetched.code !== 0) return failure("fetching the remote pipeline branch", fetched);
    }
    /* Only a fast-forward is ever published. A remote revision the ACCEPTED
       revision does not contain is someone else's repair; overwriting it would
       discard work, so the pipeline parks and lets the operator choose. */
    const remoteIsAncestor = exec("git", ["merge-base", "--is-ancestor", remoteSha, acceptedSha], pipeline.worktreeDir);
    if (remoteIsAncestor.code === 1) {
      return { ok: false, error: "the local and remote pipeline branches diverged; choose which revision to publish before the review stage can start" };
    }
    if (remoteIsAncestor.code !== 0) return failure("comparing local and remote pipeline revisions", remoteIsAncestor);
  }

  const push = exec("git", ["push", "origin", `${acceptedSha}:refs/heads/${pipeline.branch}`], pipeline.worktreeDir);
  if (push.code !== 0) return failure("publishing the pipeline branch", push);
  const confirm = readRemotePipelineBranch(pipeline, exec, "confirming the published pipeline branch");
  if (!confirm.ok) return { ok: true, sha: acceptedSha, remote: "unreachable", detail: confirm.error };
  const publishedHead = confirm.sha;
  if (publishedHead !== acceptedSha) {
    return { ok: false, error: `publishing the pipeline branch did not land: origin/${pipeline.branch} is ${publishedHead || "absent"}, expected ${acceptedSha}` };
  }
  return { ok: true, sha: acceptedSha, remote: "published" };
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
