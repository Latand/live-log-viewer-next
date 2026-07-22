import crypto from "node:crypto";

import {
  agentRegistry,
  DeliveryReservationConflictError,
  type AgentRegistry,
  type RegistryConversation,
} from "@/lib/agent/registry";
import { withAccountMutationLockAsync } from "@/lib/accounts/accountMutation";
import { deliveryFence } from "@/lib/accounts/migration/coordinator";
import { requestAccountMigrationTick } from "@/lib/accounts/migration/controllerSignal";
import type { HeldDelivery, HeldDeliveryCommand, ViewerConversationId } from "@/lib/accounts/migration/contracts";

import { isRuntimeHostTransportFailure, runtimeHostClient, type RuntimeHostClient } from "./client";
import type { RuntimeOperationReceipt, RuntimeSendSettings, RuntimeSession } from "./contracts";
import { republishStructuredDeliveryHost } from "./structuredDeliveryController";
import { recoverDeadStructuredConversation } from "./structuredRecovery";
import { runtimeImageCapability, runtimeImageRefsForUploads, runtimeImageStore, type RuntimeImageUpload } from "./runtimeImageStore";
import { admitRuntimeImagePayload } from "./runtimeImageAdmission";
import {
  assertStructuredTextEnvelope,
  structuredContent,
  StructuredEnvelopeTooLargeError,
  type StructuredImageRef,
} from "./structuredContent";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { markStructuredHostStartupReady } from "./startupStatus";

export interface StructuredMessageRequest {
  path: string;
  conversationId?: string | null;
  clientMessageId?: string | null;
  operationId?: string;
  kind?: "send" | "steer";
  policy?: "queue" | "steer-if-active" | "interrupt-active";
  turnId?: string | null;
  text: string;
  images?: RuntimeImageUpload[];
  imageRefs?: StructuredImageRef[];
  hasImages?: boolean;
  /** Per-turn runtime settings snapshot (issue #390 §10): rides the durable
      send effect so a replayed key re-delivers with identical settings. A
      migration hold drops the override (absent = today's behavior) — the held
      command format predates it and stays untouched. */
  runtime?: RuntimeSendSettings;
}

export type StructuredMessageResult =
  | { ok: true; structured: true; target: string | null; outcome: "queued" | "delivering" | "delivered"; operationId: string; receipt: RuntimeOperationReceipt; spawned?: boolean }
  | { ok: true; structured: true; target: string | null; outcome: "held"; spawned?: boolean }
  | { ok: false; structured: true; outcome: "failed"; error: string; status: number; operationId?: string; receipt?: RuntimeOperationReceipt; successorConversationId?: string; transportUncertain?: true };

export interface StructuredMessageDependencies {
  enabled?: () => boolean;
  client?: () => RuntimeHostClient | null;
  registry?: () => AgentRegistry;
  kick?: () => void;
  requestMigrationTick?: () => void;
  startupFailed?: () => boolean;
  startupRecovered?: () => void;
  recover?: typeof recoverDeadStructuredConversation;
  republish?: (key: RuntimeSession["sessionKey"]) => Promise<boolean>;
  storeImages?: (images: readonly RuntimeImageUpload[]) => StructuredImageRef[];
  /** The refs `storeImages` would publish, computed without writing — used by
      the same-key conflict preflight so a changed payload rejects blob-free. */
  previewImageRefs?: (images: readonly RuntimeImageUpload[]) => StructuredImageRef[];
  /** Cross-process fence spanning image publication and durable reservation. */
  withImageAdmissionLock?: <T>(operation: () => Promise<T>) => Promise<T>;
}

/** Serializes preflight → publication → reservation per (conversation,
    client message id) within this process. Two racing changed payloads see a
    durable winner before the losing request publishes anything. */
const admissionSections = new Map<string, Promise<unknown>>();

async function withAdmissionSection<T>(key: string | null, run: () => T | Promise<T>): Promise<T> {
  if (!key) return run();
  const queued = (admissionSections.get(key) ?? Promise.resolve()).catch(() => {}).then(run);
  admissionSections.set(key, queued);
  try {
    return await queued;
  } finally {
    if (admissionSections.get(key) === queued) admissionSections.delete(key);
  }
}

export interface HeldStructuredMessageRequest {
  conversationId: string;
  runtimeConversationId?: string;
  path: string;
  deliveryId: string;
  clientMessageId: string;
  text: string;
  imageRefs?: StructuredImageRef[];
  command?: HeldDeliveryCommand;
}

export interface HeldStructuredMessageDependencies {
  enabled?: () => boolean;
  client?: () => RuntimeHostClient | null;
  registry?: () => AgentRegistry;
  kick?: () => void | Promise<void>;
  startupFailed?: () => boolean;
  startupRecovered?: () => void;
  republish?: (key: RuntimeSession["sessionKey"]) => Promise<boolean>;
}

export type HeldStructuredMessageOutcome = "delivered" | "failed" | "delivery-uncertain" | null;

function structuredHostsEnabled(): boolean {
  return process.env.LLV_STRUCTURED_HOSTS === "1";
}

function ownershipUnavailable(): StructuredMessageResult {
  return {
    ok: false,
    structured: true,
    outcome: "failed",
    error: "structured host ownership is unavailable; retry after runtime synchronization",
    status: 503,
  };
}

function legacyCommandUnavailable(): StructuredMessageResult {
  return {
    ok: false,
    structured: true,
    outcome: "failed",
    error: "legacy delivery cannot preserve structured command semantics",
    status: 409,
  };
}

/** A send addressed to a terminally superseded round (issue #383) never forks
    it through implicit recovery — it answers with the live chain end. */
function supersededRejection(
  registry: AgentRegistry,
  conversation: Pick<RegistryConversation, "id" | "supersededBy"> | null,
): StructuredMessageResult | null {
  if (!conversation?.supersededBy) return null;
  return {
    ok: false,
    structured: true,
    outcome: "failed",
    error: "superseded",
    status: 409,
    successorConversationId: registry.supersedenceChainTail(conversation.id),
  };
}

function requiresStructuredCommand(request: StructuredMessageRequest): boolean {
  return request.operationId !== undefined
    || (request.kind ?? "send") !== "send"
    || (request.policy ?? "interrupt-active") !== "interrupt-active"
    || request.turnId !== undefined;
}

function requiresStructuredHeldCommand(request: HeldStructuredMessageRequest): boolean {
  const command = request.command;
  return command !== undefined
    && (command.operationId !== request.deliveryId
      || command.kind !== "send"
      || command.policy !== "interrupt-active"
      || command.turnId !== undefined);
}

function deliveryFailure(error: unknown): StructuredMessageResult {
  return {
    ok: false,
    structured: true,
    outcome: "failed",
    error: error instanceof Error ? error.message : "structured host delivery failed",
    status: error instanceof DeliveryReservationConflictError
      ? 409
      : error instanceof StructuredEnvelopeTooLargeError
        ? 413
        : 503,
    ...(isRuntimeHostTransportFailure(error) ? { transportUncertain: true } : {}),
  };
}

function commandInput(request: StructuredMessageRequest) {
  return {
    ...(request.operationId ? { operationId: request.operationId } : {}),
    ...(request.kind ? { kind: request.kind } : {}),
    ...(request.policy ? { policy: request.policy } : {}),
    ...(request.turnId !== undefined ? { turnId: request.turnId } : {}),
  };
}

type PersistedMessageOwner = {
  kind: "structured" | "legacy";
  conversation: RegistryConversation;
};

function persistedCurrentOwner(
  request: Pick<StructuredMessageRequest, "conversationId" | "path">,
  registry: AgentRegistry,
): PersistedMessageOwner | null {
  const conversation = request.conversationId?.startsWith("conversation_")
    ? registry.conversation(request.conversationId as ViewerConversationId)
    : registry.conversationForPath(request.path);
  const generation = conversation?.generations.at(-1);
  if (!conversation || !generation) return null;
  const entry = registry.snapshot().entries[`${conversation.engine}:${generation.id}`];
  if (!entry || entry.artifactPath !== generation.path) return null;
  const structured = entry.structuredHost !== null && entry.structuredHost !== undefined;
  const legacy = entry.host !== null;
  if (structured === legacy) return null;
  return { kind: structured ? "structured" : "legacy", conversation };
}

function heldOutcomeDuringRuntimeSynchronization(
  request: HeldStructuredMessageRequest,
  registry: AgentRegistry,
): HeldStructuredMessageOutcome {
  if (persistedCurrentOwner(request, registry)?.kind !== "legacy") return "delivery-uncertain";
  return requiresStructuredHeldCommand(request) ? "failed" : null;
}

function holdDuringRuntimeSynchronization(
  request: StructuredMessageRequest,
  registry: AgentRegistry,
  requestTick: () => void,
): StructuredMessageResult | null {
  const owner = persistedCurrentOwner(request, registry);
  if (!owner) return ownershipUnavailable();
  const rejectedHold = supersededRejection(registry, owner.conversation);
  if (rejectedHold) return rejectedHold;
  if (owner.kind === "legacy") return requiresStructuredCommand(request) ? legacyCommandUnavailable() : null;
  let { conversation } = owner;
  if (request.hasImages || request.images?.length) {
    return { ok: false, structured: true, outcome: "failed", error: "structured host image delivery is unavailable", status: 409 };
  }
  try {
    assertStructuredTextEnvelope(request.text);
    const idempotencyKey = request.clientMessageId?.trim() || `queue_${crypto.randomUUID()}`;
    const refs = request.imageRefs ?? [];
    if (!request.text && refs.length === 0) throw new Error("held delivery must contain at most 32000 characters");
    const content = refs.length ? structuredContent(request.text, refs) : null;
    const deliveryText = content?.content.text ?? request.text;
    const contentDigest = content?.contentDigest ?? null;
    const payloadKind = refs.length ? "runtime-images" : "text";
    /* Conflict and terminal replay outcomes remain side-effect free. Accepted
       sends establish the durable account fence before reservation placement. */
    const replay = registry.preflightDeliveryReservation(
      conversation.id,
      deliveryText,
      idempotencyKey,
      payloadKind,
      refs,
      contentDigest,
      commandInput(request),
    );
    if (replay?.state === "delivered") {
      return deliveredReservationReplay(replay, idempotencyKey, conversation.id, false);
    }
    if (replay?.state === "failed") {
      return {
        ok: false,
        structured: true,
        outcome: "failed",
        error: replay.error || "delivery target is unavailable",
        status: 409,
      };
    }
    const generation = conversation.generations.at(-1);
    const activeAccountId = registry.engineRouting(conversation.engine).activeAccountId;
    if (activeAccountId && generation?.accountId && generation.accountId !== activeAccountId) {
      conversation = registry.requestConversationMigrationToActiveAccount(conversation.id);
    }
    const reservation = registry.holdDelivery(
      conversation.id,
      deliveryText,
      idempotencyKey,
      payloadKind,
      refs,
      contentDigest,
      commandInput(request),
    );
    if (reservation.state === "delivered") {
      return deliveredReservationReplay(reservation, idempotencyKey, conversation.id, false);
    }
    if (reservation.state === "failed") {
      return {
        ok: false,
        structured: true,
        outcome: "failed",
        error: reservation.error || "delivery target is unavailable",
        status: 409,
      };
    }
    requestTick();
    return {
      ok: true,
      structured: true,
      target: conversation.id,
      outcome: "held",
    };
  } catch (error) {
    return deliveryFailure(error);
  }
}

function recordStructuredRuntimeRecovery(
  snapshot: Awaited<ReturnType<RuntimeHostClient["snapshot"]>>,
  recovered: () => void,
): void {
  if (snapshot.sessions.some((session) => session.hostKind === "codex-app-server" || session.hostKind === "claude-broker")) {
    recovered();
  }
}

async function refreshRepublishedSession(
  session: RuntimeSession,
  client: RuntimeHostClient,
  republish: (key: RuntimeSession["sessionKey"]) => Promise<boolean>,
): Promise<{ session: RuntimeSession; republished: boolean }> {
  if (session.host !== "dead" && session.host !== "unhosted") return { session, republished: false };
  if (!await republish(session.sessionKey)) return { session, republished: false };
  const refreshed = await client.snapshot();
  return {
    session: refreshed.sessions.find((candidate) => candidate.conversationId === session.conversationId)
      ?? refreshed.sessions.find((candidate) => candidate.artifactPath === session.artifactPath)
      ?? session,
    republished: true,
  };
}

function requiresDeadConversationRecovery(
  session: RuntimeSession,
  registry: AgentRegistry,
  conversation: RegistryConversation,
): boolean {
  if (session.host === "dead" || session.host === "unhosted") return true;
  if (session.host !== "registering" || session.artifactPath !== null) return false;
  const generation = conversation.generations.at(-1);
  if (!generation) return false;
  const entry = registry.snapshot().entries[`${conversation.engine}:${generation.id}`];
  /* Production #389 retained a pre-artifact runtime placeholder after the
     durable current generation had already lost its host and process. */
  return entry?.status === "dead"
    && entry.host === null
    && entry.pendingAction === null
    && entry.structuredHost?.process === null;
}

function requestMigrationProgress(
  registry: AgentRegistry,
  conversationId: ViewerConversationId,
  requestTick: () => void,
): void {
  const phase = registry.conversation(conversationId)?.migration?.phase;
  if (phase && !["committed", "rolled-back"].includes(phase)) requestTick();
}

function deliveredReservationReplay(
  reservation: HeldDelivery,
  idempotencyKey: string,
  target: ViewerConversationId | null,
  spawned: boolean,
): StructuredMessageResult {
  const receipt: RuntimeOperationReceipt = {
    operationId: reservation.command.operationId,
    idempotencyKey,
    conversationId: reservation.runtimeConversationId,
    kind: reservation.command.kind,
    status: "delivered",
    ...(reservation.command.turnId !== undefined ? { turnId: reservation.command.turnId } : {}),
    reason: null,
    at: reservation.deliveredAt ?? reservation.createdAt,
    revision: 1,
  };
  return {
    ok: true,
    structured: true,
    target,
    outcome: "delivered",
    operationId: reservation.command.operationId,
    receipt,
    ...(spawned ? { spawned: true } : {}),
  };
}

export async function deliverHeldStructuredMessage(
  request: HeldStructuredMessageRequest,
  dependencies: HeldStructuredMessageDependencies = {},
): Promise<HeldStructuredMessageOutcome> {
  if (!(dependencies.enabled ?? structuredHostsEnabled)()) return null;
  const client = (dependencies.client ?? runtimeHostClient)();
  if (!client) {
    return heldOutcomeDuringRuntimeSynchronization(request, (dependencies.registry ?? agentRegistry)());
  }
  let snapshot: Awaited<ReturnType<RuntimeHostClient["snapshot"]>>;
  try {
    snapshot = await client.snapshot();
  } catch (error) {
    console.error("[structured delivery] runtime snapshot failed", error);
    return heldOutcomeDuringRuntimeSynchronization(request, (dependencies.registry ?? agentRegistry)());
  }
  recordStructuredRuntimeRecovery(snapshot, dependencies.startupRecovered ?? markStructuredHostStartupReady);
  let session = snapshot.sessions.find((candidate) => candidate.conversationId === request.conversationId)
    ?? snapshot.sessions.find((candidate) => candidate.artifactPath === request.path);
  if (!session) return heldOutcomeDuringRuntimeSynchronization(request, (dependencies.registry ?? agentRegistry)());
  try {
    const refreshed = await refreshRepublishedSession(
      session,
      client,
      dependencies.republish ?? republishStructuredDeliveryHost,
    );
    session = refreshed.session;
    if (refreshed.republished && (session.host === "dead" || session.host === "unhosted")) return "delivery-uncertain";
  } catch {
    return "delivery-uncertain";
  }
  if (session.hostKind === "tmux-legacy") return requiresStructuredHeldCommand(request) ? "failed" : null;
  if (session.hostKind !== "codex-app-server" && session.hostKind !== "claude-broker") return "delivery-uncertain";
  try {
    const refs = request.imageRefs ?? [];
    const imageCapability = session.capabilities.imageInput
      ?? runtimeImageCapability(session.sessionKey.engine, false);
    if (refs.length > 0 && !imageCapability.supported && session.sessionKey.engine !== "codex") return "failed";
    const content = structuredContent(request.text, refs);
    const command = request.command ?? {
      operationId: request.deliveryId,
      kind: "send" as const,
      policy: "interrupt-active" as const,
    };
    const result = await client.command({
      kind: command.kind,
      operationId: command.operationId,
      conversationId: request.runtimeConversationId ?? request.conversationId,
      idempotencyKey: request.clientMessageId,
      text: content.content.text,
      ...(refs.length ? { images: refs } : {}),
      contentDigest: content.contentDigest,
      policy: command.policy,
      ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
    });
    try {
      await (dependencies.kick ?? kickStructuredDeliveryQueue)();
    } catch {
      // The journal receipt below remains authoritative after a drain failure.
    }
    const latest = await client.operationStatus(result.operationId) ?? result;
    if (["delivered", "turn-started", "steered"].includes(latest.receipt.status)) return "delivered";
    if (latest.receipt.status === "failed" || latest.receipt.status === "rejected") return "failed";
    return "delivery-uncertain";
  } catch {
    return "delivery-uncertain";
  }
}

export async function enqueueStructuredMessage(
  request: StructuredMessageRequest,
  dependencies: StructuredMessageDependencies = {},
): Promise<StructuredMessageResult | null> {
  if (!(dependencies.enabled ?? structuredHostsEnabled)()) return null;
  const imageAdmission = admitRuntimeImagePayload({ images: request.images ?? [] });
  if (imageAdmission.error) {
    return { ok: false, structured: true, outcome: "failed", error: imageAdmission.error.error, status: imageAdmission.error.status };
  }
  const rawImages = imageAdmission.images;
  const client = (dependencies.client ?? runtimeHostClient)();
  if (!client) {
    return holdDuringRuntimeSynchronization(
      request,
      (dependencies.registry ?? agentRegistry)(),
      dependencies.requestMigrationTick ?? requestAccountMigrationTick,
    );
  }
  let snapshot: Awaited<ReturnType<RuntimeHostClient["snapshot"]>>;
  try {
    snapshot = await client.snapshot();
  } catch (error) {
    console.error("[structured delivery] runtime snapshot failed", error);
    return holdDuringRuntimeSynchronization(
      request,
      (dependencies.registry ?? agentRegistry)(),
      dependencies.requestMigrationTick ?? requestAccountMigrationTick,
    );
  }
  recordStructuredRuntimeRecovery(snapshot, dependencies.startupRecovered ?? markStructuredHostStartupReady);
  let session = (request.conversationId
    ? snapshot.sessions.find((candidate) => candidate.conversationId === request.conversationId)
    : undefined)
    ?? snapshot.sessions.find((candidate) => candidate.artifactPath === request.path);
  if (!session) {
    return holdDuringRuntimeSynchronization(
      request,
      (dependencies.registry ?? agentRegistry)(),
      dependencies.requestMigrationTick ?? requestAccountMigrationTick,
    );
  }
  const registry = (dependencies.registry ?? agentRegistry)();
  if (session.hostKind === "tmux-legacy") return requiresStructuredCommand(request) ? legacyCommandUnavailable() : null;
  if (session.hostKind !== "codex-app-server" && session.hostKind !== "claude-broker") return ownershipUnavailable();
  try {
    assertStructuredTextEnvelope(request.text);
  } catch (error) {
    return deliveryFailure(error);
  }
  const suppliedRefs = request.imageRefs ?? [];
  const wantsImages = request.hasImages === true || rawImages.length > 0 || suppliedRefs.length > 0;
  if (request.hasImages && rawImages.length === 0 && suppliedRefs.length === 0) {
    return { ok: false, structured: true, outcome: "failed", error: "structured image payload is unavailable", status: 409 };
  }
  if (rawImages.length > 0 && suppliedRefs.length > 0) {
    return deliveryFailure(new Error("structured image payload is ambiguous"));
  }
  if (!session.conversationId.startsWith("conversation_")) return ownershipUnavailable();
  /* The superseded guard runs BEFORE dead-host recovery below: an implicit
     recovery of a retired round would silently fork it (issue #383). */
  const rejected = supersededRejection(registry, registry.conversation(session.conversationId as ViewerConversationId));
  if (rejected) return rejected;
  let conversation = registry.conversation(session.conversationId as ViewerConversationId);
  if (!conversation) return ownershipUnavailable();
  const idempotencyKey = request.clientMessageId?.trim() || `queue_${crypto.randomUUID()}`;
  let refs: StructuredImageRef[];
  let content: ReturnType<typeof structuredContent>;
  let terminalReplay: HeldDelivery | null;
  try {
    refs = suppliedRefs.length > 0
      ? suppliedRefs
      : (dependencies.previewImageRefs ?? runtimeImageRefsForUploads)(rawImages);
    content = structuredContent(request.text, refs);
    terminalReplay = registry.preflightDeliveryReservation(
      conversation.id,
      content.content.text,
      idempotencyKey,
      refs.length ? "runtime-images" : "text",
      refs,
      content.contentDigest,
      commandInput(request),
    );
  } catch (error) {
    return deliveryFailure(error);
  }
  if (terminalReplay?.state === "delivered") {
    return deliveredReservationReplay(terminalReplay, idempotencyKey, conversation.id, false);
  }
  if (terminalReplay?.state === "failed") {
    return {
      ok: false,
      structured: true,
      outcome: "failed",
      error: terminalReplay.error || "delivery target is unavailable",
      status: 409,
    };
  }
  const generation = conversation.generations.at(-1);
  const activeAccountId = registry.engineRouting(conversation.engine).activeAccountId;
  /* Request an active-account reseat before any predecessor host republish or
     recovery. An accepted migration fence assigns this send to the successor. */
  if (activeAccountId && generation?.accountId && generation.accountId !== activeAccountId) {
    try {
      conversation = registry.requestConversationMigrationToActiveAccount(conversation.id);
    } catch (error) {
      return deliveryFailure(error);
    }
  }
  const migrationOwnsSend = deliveryFence(conversation) === "held";
  if (!migrationOwnsSend) {
    try {
      const refreshed = await refreshRepublishedSession(
        session,
        client,
        dependencies.republish ?? republishStructuredDeliveryHost,
      );
      session = refreshed.session;
      if (refreshed.republished && (session.host === "dead" || session.host === "unhosted")) return ownershipUnavailable();
    } catch (error) {
      return deliveryFailure(error);
    }
  }
  const recoveryRequired = !migrationOwnsSend && requiresDeadConversationRecovery(session, registry, conversation);
  if (recoveryRequired && !wantsImages) {
    try {
      registry.holdDelivery(
        conversation.id,
        content.content.text,
        idempotencyKey,
        "text",
        [],
        content.contentDigest,
        commandInput(request),
      );
    } catch (error) {
      return deliveryFailure(error);
    }
  }
  let recoveredHost = false;
  /* Ownership recovery comes BEFORE capability evaluation: a dead projection
     carries no image capability, and judging the payload against it would 409
     a session whose recovered host advertises image input. */
  let activeSession = session;
  if (recoveryRequired) {
    let recovered;
    try {
      recovered = await (dependencies.recover ?? recoverDeadStructuredConversation)({
        path: request.path || session.artifactPath || "",
        conversationId: session.conversationId as ViewerConversationId,
      }, { registry, client });
    } catch (error) {
      return {
        ok: false,
        structured: true,
        outcome: "failed",
        error: error instanceof Error ? error.message : "structured host recovery failed",
        status: 503,
      };
    }
    if (!recovered) return ownershipUnavailable();
    recoveredHost = recovered.spawned;
    try {
      const refreshed = await client.snapshot();
      activeSession = refreshed.sessions.find((candidate) => candidate.conversationId === session.conversationId)
        ?? refreshed.sessions.find((candidate) => candidate.artifactPath === session.artifactPath)
        ?? session;
    } catch {
      /* The pre-recovery projection remains the conservative capability source. */
    }
  }
  const imageCapability = migrationOwnsSend
    ? runtimeImageCapability(activeSession.sessionKey.engine, true)
    : activeSession.capabilities.imageInput
      ?? runtimeImageCapability(activeSession.sessionKey.engine, false);
  if (wantsImages && !imageCapability.supported && activeSession.sessionKey.engine !== "codex") {
    return { ok: false, structured: true, outcome: "failed", error: imageCapability.reason ?? "structured image delivery is unavailable", status: 409 };
  }
  const encodedImageBytes = rawImages.reduce((total, image) => total + Buffer.byteLength(image.base64), 0);
  if (encodedImageBytes > imageCapability.maxEncodedBytesPerRequest) {
    return { ok: false, structured: true, outcome: "failed", error: "runtime image request encoding is too large", status: 413 };
  }
  try {
    /* Conflict preflight computes candidate refs and digest before writing.
       A changed payload under an existing client message id rejects with zero
       blob publication, GC, or registry effects. First admissions publish
       before the reservation references them. */
    const admissionKey = request.clientMessageId?.trim()
      ? `${conversation.id} ${request.clientMessageId.trim()}`
      : null;
    let reservation = await withAdmissionSection(admissionKey, async () => {
      const admit = () => {
        const replay = registry.preflightDeliveryReservation(
          conversation.id,
          content.content.text,
          idempotencyKey,
          refs.length ? "runtime-images" : "text",
          refs,
          content.contentDigest,
          commandInput(request),
        );
        if (replay) return replay;
        if (rawImages.length > 0) {
          (dependencies.storeImages ?? ((images) => runtimeImageStore().putMany(images)))(rawImages);
        }
        /* A reservation race can follow publication when another process runs
           older code or when a structured spawn published the same digest.
           The grace-period collector owns orphan cleanup. Synchronous removal
           cannot distinguish this admission's blob from a deduplicated blob
           whose durable reservation is still pending. */
        return registry.holdDelivery(
          conversation.id,
          content.content.text,
          idempotencyKey,
          refs.length ? "runtime-images" : "text",
          refs,
          content.contentDigest,
          commandInput(request),
        );
      };
      if (rawImages.length === 0) return admit();
      return (dependencies.withImageAdmissionLock ?? withAccountMutationLockAsync)(async () => admit());
    });
    let claimedReservationId: string | null = null;
    if (reservation.state === "delivery-uncertain") {
      reservation = registry.retryUncertainDelivery(reservation.id);
    }
    if (reservation.state === "held") {
      (dependencies.requestMigrationTick ?? requestAccountMigrationTick)();
      return {
        ok: true,
        structured: true,
        target: recoveredHost ? null : conversation.id,
        outcome: "held",
        ...(recoveredHost ? { spawned: true } : {}),
      };
    }
    if (reservation.state === "delivered") {
      return deliveredReservationReplay(
        reservation,
        idempotencyKey,
        recoveredHost ? null : conversation.id,
        recoveredHost,
      );
    }
    if (reservation.state === "assigned" && reservation.generationId) {
      const claimed = registry.beginDeliveryAttempt(reservation.id, reservation.generationId);
      if (!claimed) {
        registry.requeueHeldDelivery(reservation.id);
        (dependencies.requestMigrationTick ?? requestAccountMigrationTick)();
        return {
          ok: true,
          structured: true,
          target: recoveredHost ? null : conversation.id,
          outcome: "held",
          ...(recoveredHost ? { spawned: true } : {}),
        };
      }
      claimedReservationId = claimed.id;
    } else {
      return {
        ok: false,
        structured: true,
        outcome: "failed",
        error: reservation.error || "delivery target is unavailable",
        status: 409,
      };
    }
    const result = await client.command({
      kind: reservation.command.kind,
      operationId: reservation.command.operationId,
      conversationId: reservation.runtimeConversationId,
      idempotencyKey,
      text: content.content.text,
      ...(refs.length ? { images: refs } : {}),
      contentDigest: content.contentDigest,
      policy: request.policy ?? "interrupt-active",
      ...(request.turnId !== undefined ? { turnId: request.turnId } : {}),
      ...(request.runtime ? { runtime: request.runtime } : {}),
    });
    const receipt = result.receipt;
    if (receipt.status === "rejected" || receipt.status === "failed" || receipt.status === "uncertain") {
      if (claimedReservationId && receipt.status !== "uncertain") {
        registry.recordDeliveryOutcome(claimedReservationId, "failed", receipt.reason || "structured host delivery failed");
        requestMigrationProgress(registry, conversation.id, dependencies.requestMigrationTick ?? requestAccountMigrationTick);
      }
      return {
        ok: false,
        structured: true,
        outcome: "failed",
        error: receipt.reason || "structured host delivery failed",
        status: 409,
        operationId: result.operationId,
        receipt,
      };
    }
    if (claimedReservationId && ["delivered", "turn-started", "steered"].includes(receipt.status)) {
      registry.recordDeliveryOutcome(claimedReservationId, "delivered");
      requestMigrationProgress(registry, conversation.id, dependencies.requestMigrationTick ?? requestAccountMigrationTick);
    }
    (dependencies.kick ?? kickStructuredDeliveryQueue)();
    const outcome = receipt.status === "delivering" || receipt.status === "delivered" ? receipt.status : "queued";
    return {
      ok: true,
      structured: true,
      target: recoveredHost ? null : conversation.id,
      outcome,
      operationId: result.operationId,
      receipt,
      ...(recoveredHost ? { spawned: true } : {}),
    };
  } catch (error) {
    return deliveryFailure(error);
  }
}
