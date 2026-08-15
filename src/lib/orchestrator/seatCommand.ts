import type { NextRequest } from "next/server";
import fs from "node:fs";

import { validExplicitProject } from "@/lib/accounts/migration/contracts";
import { agentRegistry } from "@/lib/agent/registry";
import { validateLaunchModel } from "@/lib/agent/models";
import { ensureOperatorSpawnCapability } from "@/lib/agent/operatorCapability";
import { internalServiceHeaders } from "@/lib/agent/operatorAuthority";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { deliverConversationMessage } from "@/lib/delivery";
import { structuredHostsEnabled } from "@/lib/runtime/flags";
import { projectForCwd } from "@/lib/scanner/describe";
import { resolveSpawnRole } from "@/lib/roles/registry";

import { loadTasks } from "@/lib/tasks/store";
import { orchestratorMandateForDelivery } from "./prompt";
import {
  beginOrchestratorSeatIntent,
  completeOrchestratorSeatIntent,
  failOrchestratorSeatIntent,
  canonicalOrchestratorProject,
  orchestratorSeatFor,
  type OrchestratorSeat,
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
  /** Durable outcome of the spawn a pending intent's request attempted, read
      from the launch receipt, for reconciling an accepted launch whose
      accepting request died before activation. */
  launchSettlement(input: { launchId: string | null; clientRequestId: string }): LaunchSettlement;
  now(): string;
}

export type LaunchSettlement =
  /** The launch durably produced a conversation; the intent can activate on it. */
  | { kind: "settled"; conversationId: string; path: string | null; launchId: string | null }
  /** The launch terminally failed; the intent can record the error. */
  | { kind: "failed"; error: string }
  /** No settled receipt to reconcile against — leave the intent alone. */
  | { kind: "unknown" };

export type ExistingConversationTarget =
  | { kind: "eligible"; conversationId: string; path: string; cwd: string; project: string }
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
  /* An in-process call on the operator's behalf: the seat route has already
     verified same-origin operator authority, so this presents the operator
     spawn capability — the same lane the MCP server's spawn_agent uses. Only
     `headers` and `json` are read by the spawn command. */
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
    };
  },
  projectTasks: (project) => loadTasks()
    .filter((task) => task.project === project && task.status !== "done")
    .map((task) => ({ id: task.id, status: task.status, text: task.text })),
  launchSettlement: ({ launchId, clientRequestId }) => {
    /* The seat spawn path always sends the intent's clientRequestId as the
       spawn clientAttemptId, so the durable receipt is found by it even when
       the intent never recorded a launchId before its request died. */
    const receipt = agentRegistry().spawnReceiptForClientAttempt(clientRequestId);
    if (!receipt || (launchId && receipt.launchId !== launchId)) return { kind: "unknown" };
    if (receipt.rejection || receipt.state === "failed" || receipt.state === "conflicted") {
      return { kind: "failed", error: receipt.error ?? receipt.rejection?.guidance ?? `spawn receipt is terminally ${receipt.state}` };
    }
    /* An admitted receipt reserved its conversation at birth — the same
       durably-accepted evidence the synchronous 202 path activates on. */
    return {
      kind: "settled",
      conversationId: receipt.conversationId,
      path: receipt.artifactLifecycle === "materialized" ? receipt.artifactPath : null,
      launchId: receipt.launchId,
    };
  },
  now: () => new Date().toISOString(),
};

const CLIENT_REQUEST_ID = /^[A-Za-z0-9_-]{8,128}$/;
const MANDATE_MAX_BYTES = 64_000;

export interface SeatCommandResult {
  status: number;
  body: Record<string, unknown>;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function explicitSeatModelError(rawBody: Record<string, unknown>): string | null {
  const model = text(rawBody.model);
  if (!model) return null;
  const role = resolveSpawnRole({ role: "orchestrator", roleParams: rawBody.roleParams ?? { mode: "standard" } });
  let engine: "claude" | "codex" | null = null;
  if (rawBody.engine === "claude" || rawBody.engine === "codex") engine = rawBody.engine;
  else if (role.ok && role.value) engine = role.value.config.engine;
  if (!engine) return null;
  const validation = validateLaunchModel(engine, model);
  return "error" in validation ? validation.error : null;
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
 * differing predecessor, sync the legacy record.
 *
 * AXIS SEPARATION (two-axis contract): revocation removes MANAGER-LEVEL
 * authority — manager voice and confirmation minting — and nothing else. The
 * predecessor's session, host and ordinary Viewer access are untouched; its
 * card stays on the board, linked to its successor by the durable lineage the
 * seat store records. Ordinary permissions are axis 1 and no seat operation
 * may reach them.
 */
async function activate(
  input: { project: string; clientRequestId: string; conversationId: string; path: string | null; launchId?: string | null },
  dependencies: SeatCommandDependencies,
): Promise<{ seat: OrchestratorSeat } | null> {
  const completed = completeOrchestratorSeatIntent({
    project: input.project,
    clientRequestId: input.clientRequestId,
    conversationId: input.conversationId,
    path: input.path,
    launchId: input.launchId,
    now: dependencies.now(),
  });
  if (completed.kind === "missing") return null;
  return { seat: completed.seat };
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
): Promise<SeatCommandResult> {
  const namedProject = typeof rawBody.project === "string" ? validExplicitProject(rawBody.project) : null;
  if (!namedProject) return { status: 400, body: { error: "project must be a valid project key" } };
  const project = canonicalOrchestratorProject(namedProject);
  const mandate = typeof rawBody.mandate === "string" ? rawBody.mandate : "";
  if (!mandate.trim()) return { status: 400, body: { error: "mandate is required" } };
  if (Buffer.byteLength(mandate, "utf8") > MANDATE_MAX_BYTES) {
    return { status: 413, body: { error: "mandate is too large" } };
  }
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

  const reconciliation = reconcilePendingSeatIntent(project, dependencies);
  if (reconciliation) await reconciliation;

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
      promptVersion,
      now: dependencies.now(),
    });
    if (begun.kind === "completed") return replayedSeatResponse(begun.seat);
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
             seat, the intent is pending, and the selected conversation can be
             resumed from the board before retrying the same request id. */
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
  const modelError = explicitSeatModelError(rawBody);
  if (modelError) return { status: 400, body: { error: modelError } };
  const begun = beginOrchestratorSeatIntent({ project, mandate, clientRequestId, mode: "spawn", promptVersion, now: dependencies.now() });
  if (begun.kind === "completed") return replayedSeatResponse(begun.seat);
  if (begun.kind === "in_progress") return inProgressSeatResponse(begun.seat);
  /* A pending replay spawns the ORIGINAL intent's mandate: the spawn receipt is
     matched by clientAttemptId AND request digest, so a recomposed retry would
     otherwise conflict with its own first attempt. */
  const spawnMandate = orchestratorMandateForDelivery(begun.kind === "replay" ? begun.seat.mandate : mandate);

  const spawnFields = ["engine", "model", "cwd", "effort", "fast", "accountId", "images", "roleParams", "allowSubagents"] as const;
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
    role: "orchestrator",
    roleParams: rawBody.roleParams ?? { mode: "standard" },
    project,
    cwd,
    ["prompt"]: spawnMandate,
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
 * Rotation (two-axis contract): hand the seat to a fresh successor.
 *
 * The handoff is BOUNDED and durable-state-based: the successor's launch
 * prompt carries the incumbent's mandate, the predecessor's identity and
 * transcript path (the complete record of its decisions — reviewable whether
 * the incumbent is alive or dead, which matters because a dead incumbent is a
 * common reason to rotate), the project's open board tasks, and any caller
 * notes. Designation switches atomically with the successor's activation; the
 * predecessor loses MANAGER-LEVEL authority only — its session, host, card and
 * ordinary Viewer access are untouched (axis 1) — and both cards stay linked
 * by the bidirectional lineage the seat store records.
 *
 * Never automatic: context pressure only ever produces a recommendation
 * (`./health`), and this function runs solely when explicitly called.
 */
export async function executeOrchestratorRotation(
  rawBody: Record<string, unknown>,
  dependencies: SeatCommandDependencies = productionSeatCommandDependencies,
): Promise<SeatCommandResult> {
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
  const handoff = [
    "## Handoff from your predecessor (rotation)",
    `You are replacing orchestrator conversation ${incumbent.conversationId} for project ${project}. Its manager authority is revoked; its session and card remain on the board, linked to yours.`,
    predecessor?.path ?? incumbent.path
      ? `Your predecessor's full transcript — decisions, blockers, in-flight work — is at: ${predecessor?.path ?? incumbent.path}. Review its recent turns before acting.`
      : "Your predecessor's transcript path is not recorded; reconstruct state from the board before acting.",
    tasks.length
      ? `Open board tasks for this project:\n${tasks.map((task) => `- [${task.status}] ${task.text.slice(0, HANDOFF_TASK_TEXT_CAP)} (${task.id})`).join("\n")}`
      : "No open board tasks are recorded for this project.",
    ...(notes ? [`Notes from the caller:\n${notes}`] : []),
  ].join("\n\n");

  const baseMandate = text(rawBody.mandate) || incumbent.mandate;
  const outcome = await executeOrchestratorSeatRequest({
    project,
    mandate: `${baseMandate}\n\n${handoff}`,
    clientRequestId,
    /* Rotation IS the explicit replacement, so it carries the opt-in the plain
       spawn-mode guard requires. */
    replaceIncumbent: true,
    promptVersion: incumbent.promptVersion,
    ...(rawBody.engine !== undefined ? { engine: rawBody.engine } : {}),
    ...(rawBody.model !== undefined ? { model: rawBody.model } : {}),
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
  }, dependencies);
  return {
    status: outcome.status,
    body: {
      ...outcome.body,
      rotatedFrom: { conversationId: incumbent.conversationId, path: predecessor?.path ?? incumbent.path, seatEpoch: incumbent.seatEpoch },
    },
  };
}
