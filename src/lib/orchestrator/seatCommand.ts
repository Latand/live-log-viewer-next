import type { NextRequest } from "next/server";
import fs from "node:fs";

import { withAccountMutationLock } from "@/lib/accounts/accountMutation";
import { validExplicitProject } from "@/lib/accounts/migration/contracts";
import { agentRegistry, identityMaterializationFence } from "@/lib/agent/registry";
import { ensureOperatorSpawnCapability } from "@/lib/agent/operatorCapability";
import { defaultModelFor } from "@/lib/agent/models";
import { internalServiceHeaders, rotationActor, type ViewerActor } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { deliverConversationMessage } from "@/lib/delivery";
import { structuredHostsEnabled } from "@/lib/runtime/flags";
import { projectForCwd } from "@/lib/scanner/describe";
import { resolveSpawnRole } from "@/lib/roles/registry";
import { MAX_STRUCTURED_TEXT_BYTES } from "@/lib/runtime/structuredContent";
import { derivedSpawnTitle } from "@/lib/title";

import { loadTasks } from "@/lib/tasks/store";
import {
  boundHistoryBody,
  composeSuccessorMandate,
  fallbackHistory,
  launchOverheadBytes,
  mandatePreflight,
  mandateTooLargeBody,
  splitMandate,
  summarizeHandoffsHeadless,
  type HandoffDigestOutcome,
  type HandoffDigestRequest,
  type HandoffParts,
} from "./handoffDigest";
import { ORCHESTRATOR_PROMPT_VERSION, ORCHESTRATOR_SYSTEM_PROMPT, orchestratorMandateForDelivery, orchestratorMandateStale } from "./prompt";
import {
  activeOrchestratorSeats,
  beginOrchestratorSeatIntent,
  completeOrchestratorSeatIntent,
  failOrchestratorSeatIntent,
  canonicalOrchestratorProject,
  orchestratorSeatFor,
  repairOrchestratorSeatRuntimeIdentity,
  type OrchestratorSeat,
  type OrchestratorSeatTrigger,
} from "./seats";

/* The one confirm behind the board draft's Orchestrator role: DESIGNATE this
 * project's orchestrator and INJECT the operator-edited mandate, atomically.
 *
 * "Atomically" here is the durable-intent shape, because delivery cannot always
 * settle synchronously (a structured spawn is accepted 202 and launches
 * deferred). The order is:
 *
 *  1. persist the PENDING intent (grants nothing, delivers nothing);
 *  2. run the one side effect that carries the mandate — a spawn whose first
 *     prompt IS the mandate (the durable launch receipt delivers it exactly
 *     once, replayed by `clientAttemptId`), or a message delivery to the
 *     selected EXISTING conversation (deduplicated by `clientMessageId`);
 *  3. ACTIVATE the seat in one write that also revokes a differing
 *     predecessor.
 *
 * A crash at any point leaves either nothing (intent pending, nothing
 * delivered) or a completed pair; the retry replays the same
 * `clientRequestId` through every layer and completes exactly once. A
 * designation with no delivered mandate, or a delivered mandate with no
 * designation, cannot survive a retry.
 *
 * An intent that recorded an error is the exception, and deliberately so
 * (issue #1067): it is TERMINAL, so the next begin clears it into durable
 * history and composes afresh rather than replaying the mandate that failed —
 * which is why no failed designation stays pending. Exactly-once still holds
 * there, because both delivery mechanisms above key on the request id itself.
 *
 * Selecting an existing conversation never spawns: mode is decided by the
 * presence of `conversationId`, and the delivery path reuses the composer's
 * own resume machinery, so a dead selected session is revived rather than
 * duplicated.
 */

export interface SeatCommandDependencies {
  /** POST /api/spawn in-process, on the operator's own authority. */
  spawn(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
  /** Deliver the mandate to an existing conversation, idempotent on
      `clientMessageId`. */
  deliver(input: { conversationId: string; path: string | null; clientMessageId: string; text: string }): Promise<{ ok: boolean; error?: string; outcome?: string }>;
  /** Registry-backed eligibility of a conversation offered for adoption. */
  conversationTarget(conversationId: string): ExistingConversationTarget | null;
  /** Bounded open work for a rotation handoff; empty when unknown. */
  projectTasks(project: string): { id: string; status: string; text: string }[];
  /** Compact the predecessor's prior handoffs into ONE bounded history
      section. Never blocks rotation: every unhappy path — no account, timeout,
      error, empty or over-budget output — answers `fallback` with its reason,
      and a thrown error is treated the same way. */
  summarizeHandoffs(request: HandoffDigestRequest): Promise<HandoffDigestOutcome>;
  /** Durable outcome of the spawn a pending intent's request attempted, read
      from the launch receipt, for reconciling an accepted launch whose
      accepting request died before activation. */
  launchSettlement(input: { launchId: string | null; clientRequestId: string }): LaunchSettlement;
  /** Persist the active seat's role, membership, and rotation lineage. */
  stampRegistryIdentity(seat: OrchestratorSeat): void;
  /** Durable runtime identity for legacy seats that predate engine/model. */
  runtimeIdentity(conversationId: string): { engine: string | null; model: string | null };
  now(): string;
}

export type LaunchSettlement =
  /** The launch durably produced a conversation; the intent can activate on it. */
  | {
      kind: "settled";
      conversationId: string;
      path: string | null;
      launchId: string | null;
      engine?: string | null;
      model?: string | null;
    }
  /** The launch terminally failed; the intent can record the error. */
  | { kind: "failed"; error: string }
  /** No settled receipt to reconcile against — leave the intent alone. */
  | { kind: "unknown" };

export type ExistingConversationTarget =
  | {
      kind: "eligible";
      conversationId: string;
      path: string;
      cwd: string;
      project: string;
      /* The handoff summarizer parses the predecessor's transcript tail, and
         the two engines write different row shapes, so the engine is narrow
         and always present here. */
      engine: "claude" | "codex";
      model?: string | null;
    }
  | { kind: "ineligible"; code: "conversation_ineligible" | "invalid_cwd" | "missing_transcript" | "missing_project"; error: string };

/** Issue #903: the spawn fallback must never be this server process's own
    working directory — in the deployed container that is `/app`, a path
    outside every scanner root, so the successor's transcript lands where the
    Viewer cannot see it and the seat holds its authority while permanently
    inert. With no explicit cwd and no operator override, the project's own
    newest existing checkout is the only honest default; failing the call
    beats minting a dead seat. */
function resolveOrchestratorCwd(project: string, requested: unknown): string | null {
  if (typeof requested === "string" && requested.trim()) return requested.trim();
  const override = process.env.LLV_ORCHESTRATOR_CWD?.trim();
  if (override) return override;
  const usable = (candidate: string | undefined | null): candidate is string => {
    if (!candidate) return false;
    try { return fs.statSync(candidate).isDirectory(); } catch { return false; }
  };
  const conversations = Object.values(agentRegistry().readOnlySnapshot().conversations)
    .filter((conversation) => conversation.projectOwnership?.project === project
      || conversation.generations.some((generation) => generation.launchProfile?.project === project))
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  for (const conversation of conversations) {
    for (let index = conversation.generations.length - 1; index >= 0; index -= 1) {
      const candidate = conversation.generations[index]?.launchProfile?.cwd;
      if (usable(candidate)) return candidate;
    }
  }
  return null;
}

async function postSpawnInProcess(body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const { executeSpawnRequest } = await import("@/lib/agent/spawnCommand");
  /* An in-process call the VIEWER makes, on its own authority: the designation
     surfaces have already made their authority decision — the seat route by
     refusing an agent, the rotation route by naming one (#1402) — so this
     presents the operator spawn capability either way, the same lane the MCP
     server's spawn_agent uses. Who triggered the designation travels on the
     seat record; this spawn carries none of it. Only `headers` and `json` are
     read by the spawn command. */
  const request = {
    headers: new Headers({
      host: "127.0.0.1",
      ...internalServiceHeaders("orchestrator"),
      [VIEWER_SPAWN_CAPABILITY_HEADER]: ensureOperatorSpawnCapability(),
    }),
    json: async () => body,
  } as unknown as NextRequest;
  const response = await executeSpawnRequest(request);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function deliverMandateInProcess(input: { conversationId: string; path: string | null; clientMessageId: string; text: string }): Promise<{ ok: boolean; error?: string; outcome?: string }> {
  if (structuredHostsEnabled()) {
    const { enqueueStructuredMessage } = await import("@/lib/runtime/structuredMessageDelivery");
    const structured = await enqueueStructuredMessage({
      path: input.path ?? "",
      conversationId: input.conversationId,
      clientMessageId: input.clientMessageId,
      text: input.text,
      images: [],
    });
    if (structured) {
      return structured.ok
        ? { ok: true, outcome: "outcome" in structured && typeof structured.outcome === "string" ? structured.outcome : "delivered" }
        : { ok: false, error: structured.error };
    }
  }
  const outcome = await deliverConversationMessage({
    pid: null,
    path: input.path ?? "",
    conversationId: input.conversationId,
    clientMessageId: input.clientMessageId,
    text: input.text,
    images: [],
  });
  return outcome.ok
    ? { ok: true, outcome: outcome.outcome ?? "delivered" }
    : { ok: false, error: outcome.error };
}

export const productionSeatCommandDependencies: SeatCommandDependencies = {
  spawn: postSpawnInProcess,
  deliver: deliverMandateInProcess,
  conversationTarget: (conversationId) => {
    const conversation = agentRegistry().conversation(conversationId as `conversation_${string}`);
    if (!conversation) return null;
    if (conversation.supersededBy) {
      return { kind: "ineligible", code: "conversation_ineligible", error: "conversation is superseded" };
    }
    const generation = conversation.generations.at(-1);
    const transcriptPath = generation?.path?.trim();
    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      return { kind: "ineligible", code: "missing_transcript", error: "conversation transcript is unavailable" };
    }
    const cwd = generation?.launchProfile?.cwd?.trim();
    if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      return { kind: "ineligible", code: "invalid_cwd", error: "conversation cwd is unavailable" };
    }
    const ownedProject = conversation.projectOwnership?.project ?? projectForCwd(cwd);
    if (!ownedProject) {
      return { kind: "ineligible", code: "missing_project", error: "conversation project is unavailable" };
    }
    return {
      kind: "eligible",
      conversationId: conversation.id,
      path: transcriptPath,
      cwd,
      project: canonicalOrchestratorProject(ownedProject),
      engine: conversation.engine,
      model: generation?.launchProfile.model?.trim() || defaultModelFor(conversation.engine),
    };
  },
  projectTasks: (project) => loadTasks()
    .filter((task) => task.project === project && task.status !== "done")
    .map((task) => ({ id: task.id, status: task.status, text: task.text })),
  summarizeHandoffs: (request) => summarizeHandoffsHeadless(request),
  launchSettlement: ({ launchId, clientRequestId }) => {
    /* The seat spawn path always sends the intent's clientRequestId as the
       spawn clientAttemptId, so the durable receipt is found by it even when
       the intent never recorded a launchId before its request died. */
    const registry = agentRegistry();
    const receipt = registry.spawnReceiptForClientAttempt(clientRequestId);
    if (!receipt || (launchId && receipt.launchId !== launchId)) return { kind: "unknown" };
    if (receipt.rejection || receipt.state === "failed" || receipt.state === "conflicted") {
      return { kind: "failed", error: receipt.error ?? receipt.rejection?.guidance ?? `spawn receipt is terminally ${receipt.state}` };
    }
    /* An admitted receipt reserved its conversation at birth — the same
       durably-accepted evidence the synchronous 202 path activates on. */
    return {
      kind: "settled",
      conversationId: receipt.conversationId,
      path: identityMaterializationFence(registry.readOnlySnapshot()).allowsReceipt(receipt)
        ? receipt.artifactPath
        : null,
      launchId: receipt.launchId,
      engine: receipt.engine,
      model: receipt.launchProfile.model,
    };
  },
  runtimeIdentity: (conversationId) => {
    const conversation = agentRegistry().conversation(conversationId as `conversation_${string}`);
    const conversationModel = conversation
      ? conversation.generations.at(-1)?.launchProfile.model?.trim() || defaultModelFor(conversation.engine)
      : null;
    return {
      engine: conversation?.engine ?? null,
      model: conversationModel,
    };
  },
  stampRegistryIdentity: (seat) => {
    agentRegistry().stampOrchestratorSeatIdentity(seat);
  },
  now: () => new Date().toISOString(),
};

const CLIENT_REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;

/** The seat a caller composed against is no longer the seated one, so its
    replacement would revoke an orchestrator it never read. */
function incumbentChangedResult(
  project: string,
  expectedSeatEpoch: number,
  current: OrchestratorSeat | null,
): SeatCommandResult {
  return {
    status: 409,
    body: {
      error: `the orchestrator seat for ${project} changed while this rotation composed its handoff (designation epoch ${expectedSeatEpoch} is no longer current); rotate again to hand off from the seated orchestrator`,
      code: "incumbent_changed",
      currentSeatEpoch: current?.seatEpoch ?? null,
      currentConversationId: current?.conversationId ?? null,
    },
  };
}

export interface SeatCommandResult {
  status: number;
  body: Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function replayedSeatResponse(seat: OrchestratorSeat): SeatCommandResult {
  const accepted = seat.path === null && seat.intent.launchId !== null;
  return {
    status: 200,
    body: {
      ok: true,
      replayed: true,
      state: seat.path ? "settled" : accepted ? "accepted" : "starting",
      accepted,
      conversationId: seat.conversationId,
      path: seat.path,
      launchId: seat.intent.launchId,
      seat,
    },
  };
}

function inProgressSeatResponse(seat: OrchestratorSeat): SeatCommandResult {
  return {
    status: 409,
    body: {
      error: "an orchestrator seat transition is already in progress for this project",
      code: "seat_intent_in_progress",
      seat,
    },
  };
}

/**
 * Activation epilogue shared by both modes: seat the conversation, revoke a
 * differing predecessor, and stamp the registry identity.
 *
 * AXIS SEPARATION (two-axis contract): revocation removes MANAGER-LEVEL
 * authority — manager voice and confirmation minting — and nothing else. The
 * predecessor's session, host and ordinary Viewer access are untouched; its
 * card stays on the board, linked to its successor by the durable lineage the
 * seat store records. Ordinary permissions are axis 1 and no seat operation
 * may reach them.
 */
async function activate(
  input: {
    project: string;
    clientRequestId: string;
    conversationId: string;
    path: string | null;
    launchId?: string | null;
    engine?: string | null;
    model?: string | null;
  },
  dependencies: SeatCommandDependencies,
): Promise<{ seat: OrchestratorSeat } | null> {
  let projectedSeat: OrchestratorSeat | null = null;
  const completed = withAccountMutationLock(() => {
    const result = completeOrchestratorSeatIntent({
      project: input.project,
      clientRequestId: input.clientRequestId,
      conversationId: input.conversationId,
      path: input.path,
      launchId: input.launchId,
      engine: input.engine,
      model: input.model,
      now: dependencies.now(),
    });
    if (result.kind !== "missing") projectedSeat = reconcileAuthorityProjections(result.seat, dependencies);
    return result;
  });
  if (completed.kind === "missing") return null;
  return { seat: projectedSeat ?? completed.seat };
}

function reconcileAuthorityProjections(
  seat: OrchestratorSeat,
  dependencies: SeatCommandDependencies,
): OrchestratorSeat {
  if (!seat.conversationId) throw new Error("active orchestrator seat is missing its conversation identity");
  const durableRuntime = seat.engine && seat.model
    ? { engine: null, model: null }
    : dependencies.runtimeIdentity(seat.conversationId);
  const repaired = repairOrchestratorSeatRuntimeIdentity({
    project: seat.project,
    conversationId: seat.conversationId,
    engine: durableRuntime.engine,
    model: durableRuntime.model,
  }) ?? seat;
  dependencies.stampRegistryIdentity(repaired);
  return repaired;
}

function reconcileCompletedSeatReplay(
  project: string,
  clientRequestId: string,
  dependencies: SeatCommandDependencies,
): OrchestratorSeat | null {
  return withAccountMutationLock(() => {
    const seat = orchestratorSeatFor(project).active;
    if (!seat || seat.intent.clientRequestId !== clientRequestId) return null;
    return reconcileAuthorityProjections(seat, dependencies);
  });
}

/**
 * Reconcile a pending spawn intent against the durable settlement of the launch
 * its request attempted, so a 202 Accepted spawn converges to exactly one seat
 * whether or not the accepting request survived. A settled launch activates the
 * intent on its conversation (the same atomic write the surviving request would
 * have made — revoking a differing predecessor, so no interleaving yields two
 * seats or an accepted launch with no seat); a terminally failed one records
 * the error, making the intent terminalizable by the next begin. An unsettled
 * launch is left pending — the genuinely in-flight guard stays intact.
 *
 * Returns null — synchronously, with no await point — whenever there is
 * nothing to activate, so a request with no reconcilable intent still
 * progresses synchronously to its durable begin before yielding, which is what
 * keeps two concurrent requests serialized by the pending-intent write.
 */
function reconcilePendingSeatIntent(project: string, dependencies: SeatCommandDependencies): Promise<unknown> | null {
  const pending = orchestratorSeatFor(project).pending;
  if (!pending || pending.intent.mode !== "spawn" || pending.intent.error !== null) return null;
  const settlement = dependencies.launchSettlement({
    launchId: pending.intent.launchId,
    clientRequestId: pending.intent.clientRequestId,
  });
  if (settlement.kind === "settled") {
    return activate({
      project,
      clientRequestId: pending.intent.clientRequestId,
      conversationId: settlement.conversationId,
      path: settlement.path,
      launchId: settlement.launchId ?? pending.intent.launchId,
      ...(settlement.engine ? { engine: settlement.engine } : {}),
      ...(settlement.model ? { model: settlement.model } : {}),
    }, dependencies);
  }
  if (settlement.kind === "failed") {
    failOrchestratorSeatIntent(project, pending.intent.clientRequestId, settlement.error);
  }
  return null;
}

export async function executeOrchestratorSeatRequest(
  rawBody: Record<string, unknown>,
  dependencies: SeatCommandDependencies = productionSeatCommandDependencies,
  /* Who triggered this designation, resolved from the REQUEST by the caller.
     Deliberately not a `rawBody` field: the body is caller-supplied JSON, and
     attribution that a caller can write is not attribution. */
  triggeredBy: OrchestratorSeatTrigger | null = null,
): Promise<SeatCommandResult> {
  const namedProject = typeof rawBody.project === "string" ? validExplicitProject(rawBody.project) : null;
  if (!namedProject) return { status: 400, body: { error: "project must be a valid project key" } };
  const project = canonicalOrchestratorProject(namedProject);
  const mandate = typeof rawBody.mandate === "string" ? rawBody.mandate : "";
  if (!mandate.trim()) return { status: 400, body: { error: "mandate is required" } };
  const clientRequestId = text(rawBody.clientRequestId);
  if (!CLIENT_REQUEST_ID.test(clientRequestId)) {
    return { status: 400, body: { error: "clientRequestId must be 8-128 URL-safe characters" } };
  }
  const existingConversationId = text(rawBody.conversationId);
  if (existingConversationId && !existingConversationId.startsWith("conversation_")) {
    return { status: 400, body: { error: "conversationId is invalid" } };
  }
  const promptVersion = typeof rawBody.promptVersion === "number" && Number.isInteger(rawBody.promptVersion)
    ? rawBody.promptVersion
    : null;

  /* Issue #1067: the ONE size bound is the delivery bound. An oversized
     mandate used to pass a 64 KB API check, become a pending intent, and then
     die at the 32000-byte structured envelope — leaving a designation that
     could never be delivered and never stopped being pending. Measured here,
     before either begin, so no durable intent can exist for a mandate that
     cannot be delivered. */
  const preflight = mandatePreflight(mandate, existingConversationId ? "existing" : "spawn", rawBody.roleParams);
  if (!preflight.ok) return { status: 413, body: mandateTooLargeBody(preflight) };

  const reconciliation = reconcilePendingSeatIntent(project, dependencies);
  if (reconciliation) await reconciliation;

  const completedReplay = reconcileCompletedSeatReplay(project, clientRequestId, dependencies);
  if (completedReplay) return replayedSeatResponse(completedReplay);

  /* Issue #1067: rotation reads its incumbent, then awaits the summarizer, and
     the reconciliation directly above can seat a launch that settled during
     that wait — an intent that was still `unknown` when the rotation read the
     project. Checked HERE, after reconciliation and with no await point left
     before the durable begin, so a rotation can never replace a seat it never
     read. It sits below the completed-replay short-circuit on purpose: a
     rotation replaying its OWN finished intent is idempotent, not stale.
     Callers that composed against no particular seat omit the field. */
  const expectedIncumbentSeatEpoch = typeof rawBody.expectedIncumbentSeatEpoch === "number"
    ? rawBody.expectedIncumbentSeatEpoch
    : null;
  if (expectedIncumbentSeatEpoch !== null) {
    const seated = orchestratorSeatFor(project).active;
    if (!seated || seated.seatEpoch !== expectedIncumbentSeatEpoch) {
      return incumbentChangedResult(project, expectedIncumbentSeatEpoch, seated);
    }
  }

  if (existingConversationId) {
    const target = dependencies.conversationTarget(existingConversationId);
    if (!target) return { status: 404, body: { error: "conversation is unknown to the registry" } };
    if (target.kind === "ineligible") {
      return { status: 409, body: { error: target.error, code: target.code } };
    }
    if (target.project !== project) {
      return {
        status: 409,
        body: { error: "conversation belongs to a different project", code: "project_mismatch" },
      };
    }

    const begun = beginOrchestratorSeatIntent({
      project,
      mandate,
      clientRequestId,
      mode: "existing",
      conversationId: target.conversationId,
      engine: target.engine ?? null,
      model: target.model ?? null,
      promptVersion,
      triggeredBy,
      now: dependencies.now(),
    });
    if (begun.kind === "completed") {
      const repaired = reconcileCompletedSeatReplay(project, clientRequestId, dependencies);
      if (!repaired) return { status: 409, body: { error: "seat intent was superseded by a newer designation" } };
      return replayedSeatResponse(repaired);
    }
    if (begun.kind === "in_progress") return inProgressSeatResponse(begun.seat);

    /* The durable intent owns the target on replay. A retried request may carry
       a different conversation id after a caller restart; following it would
       let one idempotency key designate a different conversation. */
    const deliveryTarget = begun.kind === "replay"
      ? dependencies.conversationTarget(begun.seat.conversationId ?? "")
      : target;
    if (!deliveryTarget || deliveryTarget.kind === "ineligible" || deliveryTarget.project !== project) {
      const error = "the pending adoption target is no longer eligible";
      failOrchestratorSeatIntent(project, clientRequestId, error);
      return { status: 409, body: { error, code: "adoption_target_unavailable", seat: orchestratorSeatFor(project).pending } };
    }

    const delivery = await dependencies.deliver({
      conversationId: deliveryTarget.conversationId,
      path: deliveryTarget.path,
      /* Derived, never minted: a retry after a lost response reuses the same
         id and the delivery receipts answer it instead of delivering twice. */
      clientMessageId: `orchmandate_${clientRequestId}`,
      /* On a pending replay the ORIGINAL intent's mandate is what completes:
         a retry that recomposed its text must not deliver a second variant. */
      text: orchestratorMandateForDelivery(begun.kind === "replay" ? begun.seat.mandate : mandate),
    });
    if (!delivery.ok) {
      const error = delivery.error ?? "mandate delivery failed";
      failOrchestratorSeatIntent(project, clientRequestId, error);
      return {
        status: 502,
        body: {
          error,
          code: "mandate_delivery_failed",
          /* Recoverable, not a dead end: the incumbent (if any) still holds the
             seat, and the selected conversation can be resumed from the board
             before retrying. The intent this returns is TERMINAL (issue #1067)
             — the next call to begin clears it, even under this same request
             id, and delivers the mandate composed then rather than this one. */
          seat: orchestratorSeatFor(project).pending,
        },
      };
    }
    const activated = await activate({ project, clientRequestId, conversationId: deliveryTarget.conversationId, path: deliveryTarget.path }, dependencies);
    if (!activated) return { status: 409, body: { error: "seat intent was superseded by a newer designation" } };
    return {
      status: 200,
      body: {
        ok: true,
        state: "settled",
        conversationId: deliveryTarget.conversationId,
        path: deliveryTarget.path,
        delivery: delivery.outcome ?? "delivered",
        seat: activated.seat,
      },
    };
  }

  /* Spawn mode: a fresh orchestrator whose FIRST PROMPT is the mandate, so the
     durable launch receipt is the exactly-once delivery mechanism. */
  const incumbent = orchestratorSeatFor(project).active;
  if (incumbent && incumbent.intent.clientRequestId !== clientRequestId && rawBody.replaceIncumbent !== true) {
    /* HIGH 5 (#758 review): a fresh spawn-mode designation over a live seat is
       an ACCIDENTAL rotation — no handoff, no lineage notes, no stated intent —
       and an agent regenerating its idempotency key on retry would trigger it.
       Refused; rotation is the explicit way through, and callers that really
       mean "replace" (the rotation command, a deliberate board replace) say so
       with `replaceIncumbent: true`. */
    return {
      status: 409,
      body: {
        error: `an orchestrator is already designated for ${project}; use rotate_orchestrator for an explicit handoff, or pass replaceIncumbent: true to replace deliberately`,
        code: "already_designated",
        incumbentSeatEpoch: incumbent.seatEpoch,
      },
    };
  }
  const resolvedRuntime = resolveSpawnRole({
    role: "orchestrator",
    roleParams: rawBody.roleParams,
    engine: rawBody.engine,
    model: rawBody.model,
    effort: rawBody.effort,
  });
  if (!resolvedRuntime.ok || !resolvedRuntime.value) {
    return { status: 400, body: { error: resolvedRuntime.ok ? "orchestrator runtime is unavailable" : resolvedRuntime.error } };
  }
  const begun = beginOrchestratorSeatIntent({
    project,
    mandate,
    clientRequestId,
    mode: "spawn",
    engine: resolvedRuntime.value.config.engine,
    model: resolvedRuntime.value.config.model,
    promptVersion,
    triggeredBy,
    now: dependencies.now(),
  });
  if (begun.kind === "completed") {
    const repaired = reconcileCompletedSeatReplay(project, clientRequestId, dependencies);
    if (!repaired) return { status: 409, body: { error: "seat intent was superseded by a newer designation" } };
    return replayedSeatResponse(repaired);
  }
  if (begun.kind === "in_progress") return inProgressSeatResponse(begun.seat);
  if (begun.kind === "replay" && begun.seat.runtimeIdentityFrozen !== true) {
    const error = "legacy pending orchestrator runtime identity is unavailable; retry the designation with a new clientRequestId";
    failOrchestratorSeatIntent(project, clientRequestId, error);
    return {
      status: 409,
      body: {
        error,
        code: "legacy_runtime_identity_unavailable",
        seat: orchestratorSeatFor(project).pending,
      },
    };
  }
  /* A pending replay spawns the ORIGINAL intent's mandate: the spawn receipt is
     matched by clientAttemptId AND request digest, so a recomposed retry would
     otherwise conflict with its own first attempt. */
  const spawnMandate = orchestratorMandateForDelivery(begun.kind === "replay" ? begun.seat.mandate : mandate);

  const spawnFields = ["cwd", "effort", "fast", "accountId", "images", "roleParams", "allowSubagents"] as const;
  const spawnRuntime = begun.kind === "replay"
    ? {
        ...(begun.seat.engine ? { engine: begun.seat.engine } : {}),
        ...(begun.seat.model ? { model: begun.seat.model } : {}),
      }
    : {
        engine: resolvedRuntime.value.config.engine,
        model: resolvedRuntime.value.config.model,
      };
  const cwd = resolveOrchestratorCwd(project, rawBody.cwd);
  if (!cwd) {
    failOrchestratorSeatIntent(project, clientRequestId, "orchestrator cwd could not be resolved");
    return {
      status: 400,
      body: {
        error: "orchestrator cwd could not be resolved — pass cwd explicitly or set LLV_ORCHESTRATOR_CWD",
        code: "cwd_unresolved",
        seat: orchestratorSeatFor(project).pending,
      },
    };
  }
  const spawnBody: Record<string, unknown> = {
    ...Object.fromEntries(spawnFields.flatMap((field) => (rawBody[field] === undefined ? [] : [[field, rawBody[field]]]))),
    ...spawnRuntime,
    role: "orchestrator",
    roleParams: rawBody.roleParams ?? { mode: "standard" },
    project,
    cwd,
    ["prompt"]: spawnMandate,
    title: derivedSpawnTitle("orchestrator", spawnMandate, project),
    clientAttemptId: clientRequestId,
  };
  const spawned = await dependencies.spawn(spawnBody);
  const spawnedConversationId = text(spawned.body.conversationId);
  const admitted = spawned.status >= 200 && spawned.status < 300 && spawned.body.ok !== false;
  const launchId = text(spawned.body.launchId);
  const acceptedPending = admitted
    && spawned.status === 202
    && Boolean(spawnedConversationId)
    && Boolean(launchId);
  const launched = admitted && spawned.body.launched !== false && Boolean(spawnedConversationId);
  if (!launched && !acceptedPending) {
    const error = text(spawned.body.error)
      || (!admitted
        ? `spawn was rejected with HTTP status ${spawned.status}`
        : !spawnedConversationId
          ? "spawn response omitted conversationId"
          : "spawn did not report an accepted launch");
    failOrchestratorSeatIntent(project, clientRequestId, error);
    return { status: spawned.status, body: { ...spawned.body, seat: orchestratorSeatFor(project).pending } };
  }
  const activated = await activate({
    project,
    clientRequestId,
    conversationId: spawnedConversationId,
    path: typeof spawned.body.path === "string" ? spawned.body.path : null,
    launchId: launchId || null,
    engine: resolvedRuntime.value.config.engine,
    model: resolvedRuntime.value.config.model,
  }, dependencies);
  if (!activated) return { status: 409, body: { error: "seat intent was superseded by a newer designation" } };
  return {
    status: spawned.status,
    body: {
      ...spawned.body,
      ...(acceptedPending ? { accepted: true, state: "accepted" } : {}),
      seat: activated.seat,
    },
  };
}

const HANDOFF_TASK_CAP = 12;
const HANDOFF_TASK_TEXT_CAP = 140;
const HANDOFF_NOTES_CAP = 2_000;

/**
 * THE shared entry point for `POST /api/orchestrator/rotate` (#1402).
 *
 * The route is a Next module and may export only route fields, so the two steps
 * that decide a rotation live here instead: resolve WHO is asking with the one
 * rotation authority contract, and rotate. The `rotate_orchestrator` MCP tool
 * posts to that route and holds no copy of either step, so the tool's answer is
 * the route's answer by construction — for the actor it accepts and for every
 * refusal the rotation itself makes.
 *
 * Cross-origin rejection stays in the route, ahead of this: it is the perimeter,
 * and it is the only thing here that turns a caller away.
 */
export function handleOrchestratorRotationRequest(
  request: Pick<NextRequest, "headers">,
  rawBody: Record<string, unknown>,
  dependencies: SeatCommandDependencies = activeSeatCommandDependencies(),
): Promise<SeatCommandResult> {
  return executeOrchestratorRotation(rawBody, dependencies, rotationActor(request));
}

let seatCommandDependenciesForTests: SeatCommandDependencies | null = null;

/**
 * Tests only; `null` restores the production seams. Seamed here rather than in
 * the route, because a route module may export only route fields.
 *
 * `POST /api/orchestrator/rotate` is the surface the rotation contract is about
 * (#1402), so the regression drives the exported route itself over loopback —
 * and a route takes no dependency argument. This is how that run reaches a
 * rotation without spawning a process or delivering to a live host.
 */
export function setSeatCommandDependenciesForTests(dependencies: SeatCommandDependencies | null): void {
  seatCommandDependenciesForTests = dependencies;
}

function activeSeatCommandDependencies(): SeatCommandDependencies {
  return seatCommandDependenciesForTests ?? productionSeatCommandDependencies;
}

/** The caller's own seat epoch, when the caller IS a designated seat — which is
    what tells a self-rotation apart from a rotation ordered from elsewhere. */
function rotationTrigger(actor: ViewerActor): OrchestratorSeatTrigger {
  const seat = actor.conversationId
    ? activeOrchestratorSeats().find((candidate) => candidate.conversationId === actor.conversationId)
    : undefined;
  return { kind: actor.kind, conversationId: actor.conversationId, seatEpoch: seat?.seatEpoch ?? null };
}

/**
 * Rotation (two-axis contract): hand the seat to a fresh successor.
 *
 * The handoff is BOUNDED and durable-state-based: the successor's launch
 * prompt carries the incumbent's core mandate, the predecessor's identity and
 * exact bounded message-read call (available whether the incumbent is alive or
 * dead, which matters because a dead incumbent is a common reason to rotate),
 * the project's open board tasks, and any caller notes. Designation switches
 * atomically with the successor's activation; the predecessor loses
 * MANAGER-LEVEL authority only — its session, host, card and
 * ordinary Viewer access are untouched (axis 1) — and both cards stay linked
 * by the bidirectional lineage the seat store records.
 *
 * The handoff is also COMPACTED (issue #1067): the successor's mandate carries
 * the core mandate, one bounded "Rotation history" section standing in for
 * every earlier handoff, and this rotation's fresh handoff — so a seat that has
 * rotated a dozen times designates exactly as cheaply as one that never has.
 *
 * Never automatic: context pressure only ever produces a recommendation
 * (`./health`), and this function runs solely when explicitly called.
 */
export async function executeOrchestratorRotation(
  rawBody: Record<string, unknown>,
  dependencies: SeatCommandDependencies = productionSeatCommandDependencies,
  /* WHO ordered this rotation. Never a refusal — rotation bans nobody — and
     never read off `rawBody`, so nothing a caller writes can claim to be
     someone else. Null is an in-process caller that named nobody, and records
     unknown provenance; the operator is never credited by default. */
  actor: ViewerActor | null = null,
): Promise<SeatCommandResult> {
  const triggeredBy = actor ? rotationTrigger(actor) : null;
  const namedProject = typeof rawBody.project === "string" ? validExplicitProject(rawBody.project) : null;
  if (!namedProject) return { status: 400, body: { error: "project must be a valid project key" } };
  const project = canonicalOrchestratorProject(namedProject);
  const clientRequestId = text(rawBody.clientRequestId);
  if (!CLIENT_REQUEST_ID.test(clientRequestId)) {
    return { status: 400, body: { error: "clientRequestId must be 8-128 URL-safe characters" } };
  }
  /* An accepted launch whose request died may hold the seat this rotation must
     replace; converge it first so the rotation sees its real incumbent. */
  const reconciliation = reconcilePendingSeatIntent(project, dependencies);
  if (reconciliation) await reconciliation;
  const incumbent = orchestratorSeatFor(project).active;
  if (!incumbent?.conversationId) {
    return {
      status: 409,
      body: { error: "no orchestrator is designated for this project — use create_orchestrator instead of rotating", code: "no_incumbent" },
    };
  }

  const predecessorTarget = dependencies.conversationTarget(incumbent.conversationId);
  const predecessor = predecessorTarget?.kind === "eligible" ? predecessorTarget : null;
  const tasks = dependencies.projectTasks(project).slice(0, HANDOFF_TASK_CAP);
  const notes = text(rawBody.handoffNotes).slice(0, HANDOFF_NOTES_CAP);
  const handoff: HandoffParts = {
    header: [
      `You are replacing orchestrator conversation ${incumbent.conversationId} for project ${project}. Its manager authority is revoked; its session and card remain on the board, linked to yours.`,
      `Your predecessor's recent turns — decisions, blockers, in-flight work — are one call away: conversation_messages({"clientRequestId":"rotation-predecessor-recent-turns-${incumbent.conversationId}","conversationId":"${incumbent.conversationId}","roles":["user","assistant"],"limit":40}). Records are newest first; pass the returned cursor with a fresh clientRequestId for each older page. Read them before acting, and never open the transcript file. If the call reports that the conversation has no transcript, reconstruct state from the board.`,
    ],
    tasks: tasks.length
      ? `Open board tasks for this project:\n${tasks.map((task) => `- [${task.status}] ${task.text.slice(0, HANDOFF_TASK_TEXT_CAP)} (${task.id})`).join("\n")}`
      : "No open board tasks are recorded for this project.",
    notes: notes || null,
  };

  /* The successor's core mandate is whatever the caller sent, else the
     incumbent's. The recorded version follows the TEXT (#1452): a rotation
     onto the built-in default is the current version whatever the incumbent
     ran on — otherwise a v3 seat rotated onto v13 text would still read v3.
     Text that is neither the default nor the incumbent's own is the caller's
     edit; over a STALE incumbent it records no version, the spawn rule for an
     edited mandate — inheriting v3 would flag a seat running edited v13 rules
     as stale and hand the next rotation's default prefill its edit to drop.
     A seat on the current version keeps its version on an override. */
  const base = text(rawBody.mandate) || incumbent.mandate;
  const promptVersion = base === ORCHESTRATOR_SYSTEM_PROMPT
    ? ORCHESTRATOR_PROMPT_VERSION
    : base !== incumbent.mandate && orchestratorMandateStale(incumbent.promptVersion)
      ? null
      : incumbent.promptVersion;
  /* Awaited ONLY when there is something to summarize. A rotation with nothing
     to compact must reach its durable `begin` with no await point, which is
     what serializes it against a concurrent designation for the same project. */
  const composition = composeRotationMandate({
    project,
    clientRequestId,
    base,
    handoff,
    predecessor: predecessor ? { path: predecessor.path, engine: predecessor.engine } : null,
    roleParams: rawBody.roleParams,
  }, dependencies);
  const composed = composition instanceof Promise ? await composition : composition;
  const rotatedFrom = {
    conversationId: incumbent.conversationId,
    path: predecessor?.path ?? incumbent.path,
    seatEpoch: incumbent.seatEpoch,
  };
  /* The summarizer is an await point of up to HANDOFF_DIGEST_TIMEOUT_MS, and
     everything above — the incumbent, its mandate, the handoff header — was
     read BEFORE it. A designation that settled during that wait owns the seat
     now, and `replaceIncumbent: true` would revoke it on the strength of a
     stale read: the newer orchestrator would lose its authority to a successor
     carrying the superseded mandate, with the newer one's own handoff never
     written. Rotation replaces only the incumbent it actually read; anything
     else is a conflict the caller resolves by rotating again, which recomposes
     from the current seat. */
  const current = orchestratorSeatFor(project).active;
  if (!current || current.conversationId !== incumbent.conversationId || current.seatEpoch !== incumbent.seatEpoch) {
    const conflict = incumbentChangedResult(project, incumbent.seatEpoch, current);
    return { status: conflict.status, body: { ...conflict.body, rotatedFrom, triggeredBy } };
  }
  if (composed.kind === "too_large") return { status: 413, body: { ...composed.body, rotatedFrom, triggeredBy } };

  const outcome = await executeOrchestratorSeatRequest({
    project,
    mandate: composed.mandate,
    clientRequestId,
    /* Rotation IS the explicit replacement, so it carries the opt-in the plain
       spawn-mode guard requires. */
    replaceIncumbent: true,
    /* ...but only of the seat this rotation actually read. The check above ran
       BEFORE the seat request's own reconciliation; this is what that request
       re-checks after it, which is the last read before the durable begin. */
    expectedIncumbentSeatEpoch: incumbent.seatEpoch,
    promptVersion,
    // Omitted runtime settings continue the incumbent. An explicit engine
    // switch uses the role validator to resolve its model.
    ...(rawBody.engine !== undefined ? { engine: rawBody.engine } : incumbent.engine ? { engine: incumbent.engine } : {}),
    ...(rawBody.model !== undefined ? { model: rawBody.model }
      : (rawBody.engine === undefined || rawBody.engine === incumbent.engine) && incumbent.model
        ? { model: incumbent.model } : {}),
    ...(rawBody.effort !== undefined ? { effort: rawBody.effort } : {}),
    ...(rawBody.fast !== undefined ? { fast: rawBody.fast } : {}),
    /* Issue #903: a rotation without an explicit cwd continues in the
       predecessor's checkout rather than falling through to the generic
       resolver — the successor inherits the incumbent's mandate, so it
       inherits its working directory too. */
    ...(rawBody.cwd !== undefined
      ? { cwd: rawBody.cwd }
      : predecessor
        ? { cwd: predecessor.cwd }
        : {}),
    ...(rawBody.accountId !== undefined ? { accountId: rawBody.accountId } : {}),
  }, dependencies, triggeredBy);
  return {
    status: outcome.status,
    body: {
      ...outcome.body,
      rotatedFrom,
      /* Who ordered it, on the answer as well as on the durable record, so the
         caller reads back the attribution its rotation was recorded under. */
      triggeredBy: attributedTrigger(outcome.body, triggeredBy),
      ...(composed.handoff ? { handoff: composed.handoff } : {}),
    },
  };
}

/**
 * THE ANSWER REPORTS WHAT THE RECORD HOLDS (#1402).
 *
 * Every outcome that reached a seat carries that seat, and the seat's own
 * `triggeredBy` was written by the request that created the intent. So an
 * idempotent replay — a lost response retried, whichever actor holds the key —
 * answers with the actor that ORDERED the rotation. The replaying caller's own
 * identity is a fact about the retry, and writing it over the attribution would
 * make the answer contradict the durable record it is reporting.
 *
 * When no seat was reached, the request was refused before anything was
 * recorded; there the answer names the actor that asked, and there is no record
 * for it to disagree with.
 */
function attributedTrigger(
  body: Record<string, unknown>,
  requested: OrchestratorSeatTrigger | null,
): OrchestratorSeatTrigger | null {
  const seat = body.seat;
  if (!seat || typeof seat !== "object" || Array.isArray(seat)) return requested;
  return (seat as OrchestratorSeat).triggeredBy ?? null;
}

type RotationMandate =
  | { kind: "composed"; mandate: string; handoff: Record<string, unknown> | null }
  | { kind: "too_large"; body: Record<string, unknown> };

/**
 * Issue #1067: the successor mandate is CORE + ONE history section + the fresh
 * handoff, never the incumbent's full text with another handoff appended.
 * Prior handoffs — however many stacked up before this change — are compacted
 * into the single history section, so the mandate's size is a function of the
 * core and the caps, not of how many rotations preceded it.
 *
 * Rotation never blocks on the summarizer: it gets one bounded try, and every
 * other outcome renders the deterministic verbatim tail instead. When even the
 * trimmed composition cannot be delivered, this refuses BEFORE the seat request
 * creates an intent, so the incumbent keeps its seat and nothing goes pending.
 */
interface RotationComposition {
  project: string;
  clientRequestId: string;
  base: string;
  handoff: HandoffParts;
  predecessor: { path: string; engine: "claude" | "codex" } | null;
  roleParams: unknown;
}

function composeRotationMandate(
  input: RotationComposition,
  dependencies: SeatCommandDependencies,
): RotationMandate | Promise<RotationMandate> {
  /* A retry of an in-flight intent delivers the stored mandate verbatim
     (`executeOrchestratorSeatRequest` replays it), so recomposing here would
     only spend another summarizer run on text nobody reads. */
  const pending = orchestratorSeatFor(input.project).pending;
  if (pending && pending.intent.clientRequestId === input.clientRequestId && pending.intent.error === null) {
    return { kind: "composed", mandate: pending.mandate, handoff: null };
  }
  const split = splitMandate(input.base);
  /* First rotation: no prior handoffs to compact, so no summarizer run — the
     fresh handoff already names the predecessor and its bounded message read. */
  if (split.history === null && split.handoffs.length === 0) {
    return renderRotationMandate(input, split.core, null, "none", null);
  }
  return (async (): Promise<RotationMandate> => {
    let outcome: HandoffDigestOutcome;
    try {
      outcome = await dependencies.summarizeHandoffs({
        project: input.project,
        clientRequestId: input.clientRequestId,
        priorHistory: split.history,
        priorHandoffs: split.handoffs,
        predecessor: input.predecessor,
      });
    } catch {
      outcome = { kind: "fallback", reason: "error" };
    }
    if (outcome.kind === "digest") {
      return renderRotationMandate(input, split.core, boundHistoryBody(outcome.text), "digest", null);
    }
    console.warn(`orchestrator rotation for ${input.project} used the verbatim handoff fallback: ${outcome.reason}`);
    return renderRotationMandate(input, split.core, fallbackHistory(split.history, split.handoffs, outcome.reason), "fallback", outcome.reason);
  })();
}

/** Core + history + fresh handoff, measured as delivered and trimmed to the
    envelope, or refused when even the trimmed composition cannot fit. */
function renderRotationMandate(
  input: RotationComposition,
  core: string,
  history: string | null,
  source: "digest" | "fallback" | "none",
  reason: string | null,
): RotationMandate {
  const overhead = launchOverheadBytes("spawn", input.roleParams);
  const composed = composeSuccessorMandate({
    core,
    history,
    handoff: input.handoff,
    budgetBytes: MAX_STRUCTURED_TEXT_BYTES - overhead,
    deliver: orchestratorMandateForDelivery,
  });
  if (composed.kind === "too_large") {
    return {
      kind: "too_large",
      body: mandateTooLargeBody({
        ok: false,
        bytes: composed.bytes,
        overhead,
        bound: MAX_STRUCTURED_TEXT_BYTES,
        excess: composed.bytes - composed.budgetBytes,
      }),
    };
  }
  return {
    kind: "composed",
    mandate: composed.mandate,
    handoff: {
      history: source,
      reason,
      historyDropped: composed.historyDropped,
      notesTruncatedTo: composed.notesTruncatedTo,
      mandateBytes: composed.bytes,
    },
  };
}
