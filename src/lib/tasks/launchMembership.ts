import { loadPipelinesForProjection } from "@/lib/pipelines/store";
import { projectInfoFromCwd } from "@/lib/scanner/describe";

import { commitTaskMembership, type MembershipInput, type MembershipResult } from "./membership";

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

/** The membership a reserved launch commits: explicit tasks of a bound
    pipeline, a fallback task per task-less container, or one placeholder
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
  if (launch.origin?.kind === "container" && launch.origin.containerId) {
    const containerId = launch.origin.containerId;
    if (launch.origin.container === "pipeline") {
      const taskIds = (pipelineTaskIds(containerId) ?? []).filter((id) => id.trim());
      if (taskIds.length) return { project, origin: { kind: "launch", key: launch.clientAttemptId ?? receipt.launchId }, title, identity, explicitTaskIds: taskIds };
      return { project, origin: { kind: "pipeline", key: containerId }, title, identity };
    }
    return { project, origin: { kind: "flow", key: containerId }, title, identity };
  }
  return { project, origin: { kind: "launch", key: launch.clientAttemptId ?? receipt.launchId }, title, identity };
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
    if (!result.ok && result.status === 404 && input.explicitTaskIds && launch.origin?.containerId) {
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
