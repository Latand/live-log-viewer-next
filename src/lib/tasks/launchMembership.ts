import { loadPipelinesForProjection } from "@/lib/pipelines/store";
import { projectInfoFromCwd } from "@/lib/scanner/describe";

import { commitTaskMembership, type MembershipIdentity, type MembershipInput, type MembershipResult } from "./membership";

/**
 * Task membership at the shared launch boundary (#1586).
 *
 * Every Viewer launch — operator drafts, agent-initiated spawns, pipeline
 * stages, review-flow rounds, the raw runtime transport — reserves its durable
 * launch receipt through `AgentRegistry.beginSpawnRequest` before anything is
 * actuated, and every caller has finished its own admission checks by then.
 * The registry calls {@link admitReservedLaunch} right after the receipt exists:
 * the launch's task membership is committed with the reserved launch and
 * conversation identity in one task-file transaction. A membership the store
 * cannot record fails the receipt and aborts the launch, so no agent ever
 * starts outside every task.
 *
 * A receipt that was reserved and later recovered for its first execution (a
 * queued pinned launch whose account became admissible) passes the same
 * prerequisite again through {@link admitRecoveredLaunch} before actuation: a
 * membership recorded at reservation converges, one that never was (a receipt
 * older than this rule, a task deleted while queued) is recorded now, and an
 * unavailable store keeps the launch from executing.
 */

export interface ReservedLaunch {
  engine: string;
  cwd: string;
  clientAttemptId?: string | null;
  explicitProject?: string | null;
  launchProfile?: { title?: string | null } | null;
  launchDisplay?: { prompt: string } | null;
  origin?: { kind: string; container?: string; containerId?: string } | null;
  purpose?: string | null;
  /** Explicit task targets of a task-local launch (a band's «+ Agent», the
      dedicated task spawn route). All must exist; none is created. */
  taskIds?: readonly string[] | null;
  /** The conversation a reviewer launch reviews; the reviewer joins its tasks. */
  reviewsConversationId?: string | null;
  /** The conversation that initiated an agent-initiated launch; the child
      joins its tasks, as the board draws it under the parent. */
  parentConversationId?: string | null;
  parentArtifactPath?: string | null;
}

export interface ReservedReceipt {
  launchId: string;
  conversationId: string;
}

export class LaunchMembershipError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "LaunchMembershipError";
  }
}

const engineOf = (engine: string): "claude" | "codex" | null => (engine === "claude" || engine === "codex" ? engine : null);

/** The membership a reserved launch commits: its explicit tasks, the tasks of a
    bound pipeline, the tasks of the work a reviewer reviews or a child's
    parent does, a fallback task per task-less container, or one placeholder
    keyed by the client attempt (or the launch id for keyless launches). */
export function launchMembershipInput(
  launch: ReservedLaunch,
  receipt: ReservedReceipt,
  pipelineTaskIds: (pipelineId: string) => readonly string[] | null,
  projectForCwd: (cwd: string) => string | null,
): MembershipInput {
  const identity = { launchId: receipt.launchId, conversationId: receipt.conversationId, clientAttemptId: launch.clientAttemptId ?? null, engine: engineOf(launch.engine) };
  const project = launch.explicitProject?.trim() || projectForCwd(launch.cwd) || "other";
  const title = launch.launchProfile?.title?.trim() || launch.launchDisplay?.prompt || null;
  const launchOrigin = { kind: "launch" as const, key: launch.clientAttemptId ?? receipt.launchId };
  const explicit = (launch.taskIds ?? []).filter((id) => id.trim());
  /* Explicit targets carry their own project: the operator chose the task, and
     the launch directory (a worktree, a scratch checkout) may derive another. */
  if (explicit.length) return { project: "", origin: launchOrigin, title, identity, explicitTaskIds: explicit };
  /* A reviewer belongs to the work it reviews, a child to the work its parent
     does: their recorded membership is the launch's task context. */
  const reviewed: MembershipIdentity[] = [];
  for (const conversationId of [launch.reviewsConversationId, launch.parentConversationId]) {
    if (conversationId && !reviewed.some((identity) => identity.conversationId === conversationId)) {
      reviewed.push({ conversationId, path: conversationId === launch.parentConversationId ? launch.parentArtifactPath ?? null : null });
    }
  }
  if (launch.origin?.kind === "container" && launch.origin.containerId) {
    const containerId = launch.origin.containerId;
    if (launch.origin.container === "pipeline") {
      const taskIds = (pipelineTaskIds(containerId) ?? []).filter((id) => id.trim());
      if (taskIds.length) return { project, origin: launchOrigin, title, identity, explicitTaskIds: taskIds };
      return { project, origin: { kind: "pipeline", key: containerId }, title, identity };
    }
    return { project, origin: { kind: "flow", key: containerId }, title, identity, inherit: reviewed };
  }
  return { project, origin: launchOrigin, title, identity, ...(reviewed.length ? { inherit: reviewed } : {}) };
}

export interface LaunchMembershipPorts {
  commit: (input: MembershipInput) => MembershipResult;
  pipelineTaskIds: (pipelineId: string) => readonly string[] | null;
  projectForCwd: (cwd: string) => string | null;
}

export const productionLaunchMembershipPorts: LaunchMembershipPorts = {
  commit: (input) => commitTaskMembership(input),
  pipelineTaskIds: (pipelineId) => {
    try {
      return loadPipelinesForProjection().find((pipeline) => pipeline.id === pipelineId)?.taskIds ?? null;
    } catch {
      return null;
    }
  },
  projectForCwd: (cwd) => projectInfoFromCwd(cwd)?.project ?? null,
};

/**
 * Commit the membership of a launch whose receipt was just reserved. A resume
 * successor keeps its conversation's existing membership (the identity resolves
 * to the held assignment, minting nothing). On failure `fail` retires the
 * receipt and the error propagates to the launching caller.
 */
export function admitReservedLaunch(
  launch: ReservedLaunch,
  receipt: ReservedReceipt,
  fail: (reason: string) => void,
  ports: LaunchMembershipPorts = productionLaunchMembershipPorts,
): MembershipResult {
  let input = launchMembershipInput(launch, receipt, ports.pipelineTaskIds, ports.projectForCwd);
  let result: MembershipResult;
  try {
    result = ports.commit(input);
    /* A pipeline whose recorded task no longer exists falls back to its
       container task rather than refusing the stage. */
    if (!result.ok && result.status === 404 && input.explicitTaskIds && !launch.taskIds?.length && launch.origin?.containerId) {
      input = { ...input, origin: { kind: "pipeline", key: launch.origin.containerId }, explicitTaskIds: undefined };
      result = ports.commit(input);
    }
  } catch (error) {
    const reason = `task membership could not be recorded: ${error instanceof Error ? error.message : String(error)}`;
    fail(reason);
    throw new LaunchMembershipError(reason, 503);
  }
  if (!result.ok) {
    fail(result.error);
    throw new LaunchMembershipError(result.error, result.status);
  }
  return result;
}

/** The durable receipt fields the membership prerequisite reads when a
    reserved launch is recovered for its first execution. */
export interface RecoverableReceipt extends ReservedReceipt {
  engine: string;
  cwd: string;
  clientAttemptId: string | null;
  explicitProject: string | null;
  launchProfile: { title?: string | null };
  launchDisplay: { prompt: string } | null;
}

/**
 * Re-establish the membership prerequisite for a receipt about to execute for
 * the first time after its reservation. The receipt carries no task targets
 * (they were validated and committed under its attempt key at reservation), so
 * this resolves by that key, then by the conversation, and mints a placeholder
 * only for a launch that has none. Throws {@link LaunchMembershipError} when
 * the store refuses or is unavailable; the caller keeps the launch from
 * executing.
 */
export function admitRecoveredLaunch(receipt: RecoverableReceipt, ports: LaunchMembershipPorts = productionLaunchMembershipPorts): MembershipResult {
  const launch: ReservedLaunch = {
    engine: receipt.engine,
    cwd: receipt.cwd,
    clientAttemptId: receipt.clientAttemptId,
    explicitProject: receipt.explicitProject,
    launchProfile: receipt.launchProfile,
    launchDisplay: receipt.launchDisplay,
  };
  return admitReservedLaunch(launch, receipt, () => undefined, ports);
}
