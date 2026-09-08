import { agentRegistry } from "@/lib/agent/registry";
import { turnStateFromRecords } from "@/lib/accounts/migration/turnState";
import { loadPipelines, withPipelineMutation } from "@/lib/pipelines/store";
import type { Pipeline } from "@/lib/pipelines/types";
import { readStableTailRecords } from "@/lib/scanner/activity";
import { lastAssistantMessageFromRecords } from "./findings";
import { resolveBaseRef, resolveCleanFlowHead } from "./git";
import { loadFlows, patchFlowRows } from "./store";
import type { Flow, FlowAgentDecision, FlowDecisionRequest } from "./types";

/** Reuse the settlement parser, independently of scanner activity/host liveness. */
export async function flowTurn(flow: Flow) {
  const read = await readStableTailRecords(flow.implementerPath);
  if (read.integrity !== "complete") return null;
  const engine = flow.roles.implementer.engine;
  const turn = turnStateFromRecords(read.records, engine);
  const terminal = [...read.records].reverse().find((record) => {
    const payload = record.payload as Record<string, unknown> | undefined;
    return engine === "codex"
      ? ["task_complete", "turn_complete", "turn_completed", "turn_aborted"].includes(String(payload?.type))
      : record.type === "result" || record.type === "assistant";
  });
  const payload = terminal?.payload as Record<string, unknown> | undefined;
  const successful = engine === "codex"
    ? Boolean(terminal && payload?.type !== "turn_aborted" && !payload?.error && !payload?.codex_error_info)
    : Boolean(terminal && terminal.is_error !== true && terminal.isApiErrorMessage !== true);
  let turnId: string | null = null;
  for (const record of [...read.records].reverse()) {
    const payload = record.payload as Record<string, unknown> | undefined;
    if (engine === "codex" && ["task_started", "turn_started", "task_complete", "turn_complete", "turn_completed", "turn_aborted"].includes(String(payload?.type))) {
      turnId = typeof payload?.turn_id === "string" ? payload.turn_id : null;
      break;
    }
    if (engine === "claude" && record.type === "user") {
      const message = record.message as { content?: unknown } | undefined;
      if (Array.isArray(message?.content) && message.content.some((part) => part?.type === "tool_result")) continue;
      if (typeof record.uuid === "string") turnId = record.uuid;
      break;
    }
  }
  return {
    turnId,
    state: turn.state,
    successful,
    terminalAt: turn.terminalAt,
    message: lastAssistantMessageFromRecords(read.records, engine === "codex" ? "codex-sessions" : "claude-projects", 0),
  };
}

export function decisionStageMatches(flow: Flow, stage: FlowDecisionRequest["stage"], pipelines: readonly Pipeline[]): boolean {
  const memberships = pipelines.flatMap((pipeline) => pipeline.runs.flatMap((run) =>
    run.attempts.filter((attempt) => attempt.flowId === flow.id).map((attempt) => ({ pipeline, run, attempt }))));
  if (!memberships.length) return stage === undefined;
  if (memberships.length !== 1 || !stage) return false;
  const { pipeline, run, attempt } = memberships[0]!;
  return pipeline.id === stage.pipelineId && run.stageId === stage.stageId && attempt.n === stage.attempt
    && pipeline.state === "running" && pipeline.cursor?.stageId === run.stageId
    && run.attempts.at(-1) === attempt && !attempt.historical;
}

function requestOf(decision: FlowAgentDecision): FlowDecisionRequest {
  return {
    clientRequestId: decision.clientRequestId, flowId: decision.flowId, decision: decision.decision,
    reason: decision.reason, expectedRevision: decision.expectedRevision, expectedHead: decision.expectedHead,
    round: decision.round, turnId: decision.turnId, ...(decision.stage ? { stage: decision.stage } : {}),
  };
}

export function decisionOwner(flow: Flow, caller: string | null): boolean {
  return caller !== null && caller === flow.implementerConversationId;
}

export type DecisionPorts = {
  turn: typeof flowTurn;
  pipelines: () => readonly Pipeline[];
  head: typeof decisionHead;
};
export function decisionHead(cwd: string, decision: FlowDecisionRequest["decision"]): string | null {
  if (decision === "submit-review" || decision === "completed") return resolveCleanFlowHead(cwd);
  const result = resolveBaseRef(cwd, "head");
  return result.ok ? result.sha : null;
}
const ports: DecisionPorts = { turn: flowTurn, pipelines: loadPipelines, head: decisionHead };

export async function flowDecisionContext(flow: Flow) {
  const turn = await flowTurn(flow);
  const stages = loadPipelines().flatMap((pipeline) => pipeline.runs.flatMap((run) =>
    run.attempts.filter((attempt) => attempt.flowId === flow.id).map((attempt) => ({ pipelineId: pipeline.id, stageId: run.stageId, attempt: attempt.n }))));
  return { expectedRevision: flow.revision ?? 0, expectedHead: decisionHead(flow.cwd, "continue-fixing"), round: flow.rounds.length,
    turnId: turn?.turnId ?? null, ...(stages.length === 1 ? { stage: stages[0] } : {}) };
}

/** The original key is replayed before revision/turn checks, but after owner checks.
 * Acceptance has no runtime effects. A later flow tick consumes it only on completion. */
export async function submitFlowDecision(request: FlowDecisionRequest, caller: string | null, dependencies: DecisionPorts = ports): Promise<{ flowId: string; decision: FlowAgentDecision; replayed: boolean }> {
  // Pipeline settlement already acquires this lease before touching flow rows.
  // Follow that order so stage retry/rotation cannot race decision admission.
  if (dependencies === ports) return withPipelineMutation((pipelines) =>
    submitFlowDecision(request, caller, { ...ports, pipelines: () => pipelines }));
  const snapshot = loadFlows().find((flow) => flow.id === request.flowId);
  if (!snapshot || !decisionOwner(snapshot, caller)) throw new Error("flow decision owner could not be verified");
  const existing = snapshot.agentDecisions?.find((item) => item.clientRequestId === request.clientRequestId);
  if (existing) {
    if (existing.owner !== caller || JSON.stringify(requestOf(existing)) !== JSON.stringify(request)) throw new Error("flow decision idempotency conflict");
    return { flowId: snapshot.id, decision: existing, replayed: true };
  }
  const turn = await dependencies.turn(snapshot);
  let accepted: FlowAgentDecision | undefined;
  patchFlowRows([request.flowId], ([flow]) => {
    if (!flow || !decisionOwner(flow, caller)) throw new Error("flow decision owner changed");
    const duplicate = flow.agentDecisions?.find((item) => item.clientRequestId === request.clientRequestId);
    if (duplicate) {
      if (duplicate.owner !== caller || JSON.stringify(requestOf(duplicate)) !== JSON.stringify(request)) throw new Error("flow decision idempotency conflict");
      accepted = duplicate;
      return [];
    }
    if (flow.revision !== request.expectedRevision || flow.implementerPath !== snapshot.implementerPath) throw new Error("stale flow decision revision or generation");
    const registered = agentRegistry().conversation(caller as `conversation_${string}`);
    if (registered && registered.generations.at(-1)?.path !== flow.implementerPath) throw new Error("flow decision transcript generation has rotated");
    if (!["waiting_ready", "fixing"].includes(flow.state)
      && !(flow.state === "needs_decision" && flow.decisionRequired)) throw new Error("flow cannot accept a decision from its current state");
    if (request.round !== flow.rounds.length) throw new Error("stale flow decision round");
    if (!turn?.turnId || turn.turnId !== request.turnId || turn.state === "unknown") throw new Error("flow decision turn is unavailable or stale");
    if (!decisionStageMatches(flow, request.stage, dependencies.pipelines())) throw new Error("flow decision stage attempt is stale or unavailable");
    if (!/^[0-9a-f]{40}$/.test(request.expectedHead) || dependencies.head(flow.cwd, request.decision) !== request.expectedHead) throw new Error("flow decision HEAD is unavailable, changed or not clean for review/completion");
    if (request.decision === "submit-review" && flow.roundLimit > 0 && flow.rounds.length >= flow.roundLimit) throw new Error("flow review round limit reached");
    if (flow.agentDecisions?.some((item) => item.disposition === "accepted" || (item.turnId === request.turnId && item.transcriptPath === flow.implementerPath))) throw new Error("this flow turn already has a decision");
    if ((flow.agentDecisions?.length ?? 0) >= 512) throw new Error("flow decision receipt capacity reached");
    accepted = { ...request, owner: caller!, transcriptPath: flow.implementerPath, acceptedAt: new Date().toISOString(), disposition: "accepted" };
    flow.agentDecisions = [...(flow.agentDecisions ?? []), accepted];
    flow.decisionRequired = false;
    flow.state = flow.rounds.length ? "fixing" : "waiting_ready";
    flow.stateDetail = "agent decision accepted; awaiting authoritative turn completion";
    return [flow];
  });
  return { flowId: request.flowId, decision: accepted!, replayed: false };
}

/** A generation rotation must not let a successor complete its predecessor's decision. */
export function decisionStillOwned(flow: Flow, decision: FlowAgentDecision): boolean {
  if (!decisionOwner(flow, decision.owner) || flow.implementerPath !== decision.transcriptPath) return false;
  const current = agentRegistry().conversation(decision.owner as `conversation_${string}`);
  return !current || current.generations.at(-1)?.path === decision.transcriptPath;
}
