import type { NextRequest } from "next/server";

import { validExplicitProject } from "@/lib/accounts/migration/contracts";
import { agentRegistry } from "@/lib/agent/registry";
import { ensureOperatorSpawnCapability } from "@/lib/agent/operatorCapability";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { deliverConversationMessage } from "@/lib/delivery";
import { structuredHostsEnabled } from "@/lib/runtime/flags";

import { loadTasks } from "@/lib/tasks/store";
import {
  beginOrchestratorSeatIntent,
  completeOrchestratorSeatIntent,
  failOrchestratorSeatIntent,
  orchestratorSeatFor,
  type OrchestratorSeat,
} from "./seats";
import { replaceOrchestratorIncumbent } from "./store";

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
  /** Canonical id + latest transcript path, or null when unknown. */
  conversationTarget(conversationId: string): { conversationId: string; path: string | null } | null;
  /** Keep the legacy single-instance manager record pointing at the newest
      operator-selected seat, so the bridge follows the selection. */
  syncLegacyRecord(input: { conversationId: string; path: string | null; engine?: string; model?: string }): void;
  /** Bounded open work for a rotation handoff; empty when unknown. */
  projectTasks(project: string): { id: string; status: string; text: string }[];
  now(): string;
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
    return conversation
      ? { conversationId: conversation.id, path: conversation.generations.at(-1)?.path ?? null }
      : null;
  },
  syncLegacyRecord: (input) => {
    replaceOrchestratorIncumbent({
      conversationId: input.conversationId,
      path: input.path,
      createdAt: new Date().toISOString(),
      ...(input.engine ? { engine: input.engine } : {}),
      ...(input.model ? { model: input.model } : {}),
    });
  },
  projectTasks: (project) => loadTasks()
    .filter((task) => task.project === project && task.status !== "done")
    .map((task) => ({ id: task.id, status: task.status, text: task.text })),
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

function replayedSeatResponse(seat: OrchestratorSeat): SeatCommandResult {
  return {
    status: 200,
    body: {
      ok: true,
      replayed: true,
      state: seat.path ? "settled" : "starting",
      conversationId: seat.conversationId,
      path: seat.path,
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
  input: { project: string; clientRequestId: string; conversationId: string; path: string | null; engine?: string; model?: string },
  dependencies: SeatCommandDependencies,
): Promise<{ seat: OrchestratorSeat } | null> {
  const completed = completeOrchestratorSeatIntent({
    project: input.project,
    clientRequestId: input.clientRequestId,
    conversationId: input.conversationId,
    path: input.path,
    now: dependencies.now(),
  });
  if (completed.kind === "missing") return null;
  if (completed.kind === "activated") {
    dependencies.syncLegacyRecord({
      conversationId: input.conversationId,
      path: input.path,
      ...(input.engine ? { engine: input.engine } : {}),
      ...(input.model ? { model: input.model } : {}),
    });
  }
  return { seat: completed.seat };
}

export async function executeOrchestratorSeatRequest(
  rawBody: Record<string, unknown>,
  dependencies: SeatCommandDependencies = productionSeatCommandDependencies,
): Promise<SeatCommandResult> {
  const project = typeof rawBody.project === "string" ? validExplicitProject(rawBody.project) : null;
  if (!project) return { status: 400, body: { error: "project must be a valid project key" } };
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

  if (existingConversationId) {
    const target = dependencies.conversationTarget(existingConversationId);
    if (!target) return { status: 404, body: { error: "conversation is unknown to the registry" } };

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

    const delivery = await dependencies.deliver({
      conversationId: target.conversationId,
      path: target.path,
      /* Derived, never minted: a retry after a lost response reuses the same
         id and the delivery receipts answer it instead of delivering twice. */
      clientMessageId: `orchmandate_${clientRequestId}`,
      /* On a pending replay the ORIGINAL intent's mandate is what completes:
         a retry that recomposed its text must not deliver a second variant. */
      text: begun.kind === "replay" ? begun.seat.mandate : mandate,
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
    const activated = await activate({ project, clientRequestId, conversationId: target.conversationId, path: target.path }, dependencies);
    if (!activated) return { status: 409, body: { error: "seat intent was superseded by a newer designation" } };
    return {
      status: 200,
      body: {
        ok: true,
        state: "settled",
        conversationId: target.conversationId,
        path: target.path,
        delivery: delivery.outcome ?? "delivered",
        seat: activated.seat,
      },
    };
  }

  /* Spawn mode: a fresh orchestrator whose FIRST PROMPT is the mandate, so the
     durable launch receipt is the exactly-once delivery mechanism. */
  const begun = beginOrchestratorSeatIntent({ project, mandate, clientRequestId, mode: "spawn", promptVersion, now: dependencies.now() });
  if (begun.kind === "completed") return replayedSeatResponse(begun.seat);
  /* A pending replay spawns the ORIGINAL intent's mandate: the spawn receipt is
     matched by clientAttemptId AND request digest, so a recomposed retry would
     otherwise conflict with its own first attempt. */
  const spawnMandate = begun.kind === "replay" ? begun.seat.mandate : mandate;

  const spawnFields = ["engine", "model", "cwd", "effort", "fast", "accountId", "images", "roleParams", "allowSubagents"] as const;
  const spawnBody: Record<string, unknown> = {
    ...Object.fromEntries(spawnFields.flatMap((field) => (rawBody[field] === undefined ? [] : [[field, rawBody[field]]]))),
    role: "orchestrator",
    roleParams: rawBody.roleParams ?? { mode: "standard" },
    project,
    /* A fresh orchestrator spawns in the Viewer's own checkout unless the
       caller names a directory — same default the legacy chat-button flow uses. */
    cwd: typeof rawBody.cwd === "string" && rawBody.cwd.trim()
      ? rawBody.cwd
      : (process.env.LLV_ORCHESTRATOR_CWD?.trim() || process.cwd()),
    ["prompt"]: spawnMandate,
    clientAttemptId: clientRequestId,
  };
  const spawned = await dependencies.spawn(spawnBody);
  const spawnedConversationId = text(spawned.body.conversationId);
  const launched = spawned.body.ok === true && spawned.body.launched !== false && Boolean(spawnedConversationId);
  if (!launched) {
    const error = text(spawned.body.error) || `spawn failed with status ${spawned.status}`;
    failOrchestratorSeatIntent(project, clientRequestId, error);
    return { status: spawned.status, body: { ...spawned.body, seat: orchestratorSeatFor(project).pending } };
  }
  const activated = await activate({
    project,
    clientRequestId,
    conversationId: spawnedConversationId,
    path: typeof spawned.body.path === "string" ? spawned.body.path : null,
    ...(typeof rawBody.engine === "string" ? { engine: rawBody.engine } : {}),
    ...(typeof rawBody.model === "string" ? { model: rawBody.model } : {}),
  }, dependencies);
  if (!activated) return { status: 409, body: { error: "seat intent was superseded by a newer designation" } };
  return {
    status: spawned.status,
    body: {
      ...spawned.body,
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
  const project = typeof rawBody.project === "string" ? validExplicitProject(rawBody.project) : null;
  if (!project) return { status: 400, body: { error: "project must be a valid project key" } };
  const clientRequestId = text(rawBody.clientRequestId);
  if (!CLIENT_REQUEST_ID.test(clientRequestId)) {
    return { status: 400, body: { error: "clientRequestId must be 8-128 URL-safe characters" } };
  }
  const incumbent = orchestratorSeatFor(project).active;
  if (!incumbent?.conversationId) {
    return {
      status: 409,
      body: { error: "no orchestrator is designated for this project — use create_orchestrator instead of rotating", code: "no_incumbent" },
    };
  }

  const predecessor = dependencies.conversationTarget(incumbent.conversationId);
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
    promptVersion: rawBody.promptVersion ?? incumbent.promptVersion,
    ...(rawBody.engine !== undefined ? { engine: rawBody.engine } : {}),
    ...(rawBody.model !== undefined ? { model: rawBody.model } : {}),
    ...(rawBody.cwd !== undefined ? { cwd: rawBody.cwd } : {}),
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
