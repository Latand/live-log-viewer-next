import crypto from "node:crypto";

import {
  agentRegistry,
  DeliveryReservationConflictError,
  type AgentRegistry,
  type RegistryConversation,
} from "@/lib/agent/registry";
import { requestAccountMigrationTick } from "@/lib/accounts/migration/controllerSignal";
import type { HeldDeliveryCommand, ViewerConversationId } from "@/lib/accounts/migration/contracts";

import { runtimeHostClient, type RuntimeHostClient } from "./client";
import type { RuntimeOperationReceipt } from "./contracts";
import { recoverDeadStructuredConversation } from "./structuredRecovery";
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
  hasImages: boolean;
  images?: string[];
}

export type StructuredMessageResult =
  | { ok: true; structured: true; target: string | null; outcome: "queued" | "delivering" | "delivered"; operationId: string; receipt: RuntimeOperationReceipt; spawned?: boolean }
  | { ok: true; structured: true; target: string | null; outcome: "held"; spawned?: boolean }
  | { ok: false; structured: true; outcome: "failed"; error: string; status: number; operationId?: string; receipt?: RuntimeOperationReceipt };

export interface StructuredMessageDependencies {
  enabled?: () => boolean;
  client?: () => RuntimeHostClient | null;
  registry?: () => AgentRegistry;
  kick?: () => void;
  requestMigrationTick?: () => void;
  startupFailed?: () => boolean;
  startupRecovered?: () => void;
  recover?: typeof recoverDeadStructuredConversation;
}

export interface HeldStructuredMessageRequest {
  conversationId: string;
  path: string;
  deliveryId: string;
  clientMessageId: string;
  text: string;
  command?: HeldDeliveryCommand;
}

export interface HeldStructuredMessageDependencies {
  enabled?: () => boolean;
  client?: () => RuntimeHostClient | null;
  registry?: () => AgentRegistry;
  kick?: () => void | Promise<void>;
  startupFailed?: () => boolean;
  startupRecovered?: () => void;
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
    status: error instanceof DeliveryReservationConflictError ? 409 : 503,
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
  if (owner.kind === "legacy") return requiresStructuredCommand(request) ? legacyCommandUnavailable() : null;
  const { conversation } = owner;
  if (request.hasImages || request.images?.length) {
    return { ok: false, structured: true, outcome: "failed", error: "structured host image delivery is unavailable", status: 409 };
  }
  try {
    const idempotencyKey = request.clientMessageId?.trim() || `queue_${crypto.randomUUID()}`;
    registry.holdDelivery(conversation.id, request.text, idempotencyKey, "text", commandInput(request));
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

function requestMigrationProgress(
  registry: AgentRegistry,
  conversationId: ViewerConversationId,
  requestTick: () => void,
): void {
  const phase = registry.conversation(conversationId)?.migration?.phase;
  if (phase && !["committed", "rolled-back"].includes(phase)) requestTick();
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
  const session = snapshot.sessions.find((candidate) => candidate.conversationId === request.conversationId)
    ?? snapshot.sessions.find((candidate) => candidate.artifactPath === request.path);
  if (!session) return heldOutcomeDuringRuntimeSynchronization(request, (dependencies.registry ?? agentRegistry)());
  if (session.hostKind === "tmux-legacy") return requiresStructuredHeldCommand(request) ? "failed" : null;
  if (session.hostKind !== "codex-app-server" && session.hostKind !== "claude-broker") return "delivery-uncertain";
  try {
    const command = request.command ?? {
      operationId: request.deliveryId,
      kind: "send" as const,
      policy: "interrupt-active" as const,
    };
    const result = await client.command({
      kind: command.kind,
      operationId: command.operationId,
      conversationId: request.conversationId,
      idempotencyKey: request.clientMessageId,
      text: request.text,
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
  const session = (request.conversationId
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
  if (session.hostKind === "tmux-legacy") return requiresStructuredCommand(request) ? legacyCommandUnavailable() : null;
  if (session.hostKind !== "codex-app-server" && session.hostKind !== "claude-broker") return ownershipUnavailable();
  if (request.hasImages || request.images?.length) {
    if (session.sessionKey.engine !== "claude") {
      return { ok: false, structured: true, outcome: "failed", error: "structured image delivery requires Claude", status: 409 };
    }
    if (!request.images?.length) {
      return { ok: false, structured: true, outcome: "failed", error: "structured image payload is unavailable", status: 409 };
    }
  }
  if (request.images && request.images.length > 16) {
    return { ok: false, structured: true, outcome: "failed", error: "structured host image delivery is unavailable", status: 409 };
  }
  if (!session.conversationId.startsWith("conversation_")) return ownershipUnavailable();
  const registry = (dependencies.registry ?? agentRegistry)();
  const idempotencyKey = request.clientMessageId?.trim() || `queue_${crypto.randomUUID()}`;
  const recoveryConversation = registry.conversation(session.conversationId as ViewerConversationId);
  let reservedBeforeRecovery: ReturnType<AgentRegistry["holdDelivery"]> | null = null;
  if (!request.images?.length && recoveryConversation) {
    try {
      reservedBeforeRecovery = registry.holdDelivery(
        recoveryConversation.id,
        request.text,
        idempotencyKey,
        "text",
        commandInput(request),
      );
    } catch (error) {
      return deliveryFailure(error);
    }
  }
  let recoveredHost = false;
  if (session.host === "dead" || session.host === "unhosted") {
    const preferredAccountId = recoveryConversation
      ? registry.engineRouting(recoveryConversation.engine).activeAccountId
      : null;
    let recovered;
    try {
      recovered = await (dependencies.recover ?? recoverDeadStructuredConversation)({
        path: request.path || session.artifactPath || "",
        conversationId: session.conversationId as ViewerConversationId,
        preferredAccountId,
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
  }
  const conversation = registry.conversation(session.conversationId as ViewerConversationId);
  if (!conversation) return ownershipUnavailable();
  try {
    if (request.images?.length) {
      if (conversation.migration && !["committed", "rolled-back"].includes(conversation.migration.phase)) {
        return { ok: false, structured: true, outcome: "failed", error: "image delivery is waiting for account migration to settle", status: 409 };
      }
      const result = await client.command({
        kind: request.kind ?? "send",
        ...(request.operationId ? { operationId: request.operationId } : {}),
        conversationId: conversation.id,
        idempotencyKey,
        text: request.text,
        images: request.images,
        policy: request.policy ?? "interrupt-active",
        ...(request.turnId !== undefined ? { turnId: request.turnId } : {}),
      });
      const receipt = result.receipt;
      if (receipt.status === "rejected" || receipt.status === "failed" || receipt.status === "uncertain") {
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
    }
    let reservation = reservedBeforeRecovery
      ?? registry.holdDelivery(conversation.id, request.text, idempotencyKey, "text", commandInput(request));
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
    } else if (reservation.state !== "delivered") {
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
      conversationId: conversation.id,
      idempotencyKey,
      text: request.text,
      policy: reservation.command.policy,
      ...(reservation.command.turnId !== undefined ? { turnId: reservation.command.turnId } : {}),
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
