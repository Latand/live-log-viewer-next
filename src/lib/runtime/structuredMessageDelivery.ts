import crypto from "node:crypto";

import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { requestAccountMigrationTick } from "@/lib/accounts/migration/controllerSignal";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";

import { runtimeHostClient, type RuntimeHostClient } from "./client";
import type { RuntimeOperationReceipt } from "./contracts";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";

export interface StructuredMessageRequest {
  path: string;
  conversationId?: string | null;
  clientMessageId?: string | null;
  text: string;
  hasImages: boolean;
}

export type StructuredMessageResult =
  | { ok: true; structured: true; target: string; outcome: "queued" | "delivering" | "delivered"; operationId: string; receipt: RuntimeOperationReceipt }
  | { ok: true; structured: true; target: string; outcome: "held" }
  | { ok: false; structured: true; outcome: "failed"; error: string; status: number; operationId?: string; receipt?: RuntimeOperationReceipt };

export interface StructuredMessageDependencies {
  enabled?: () => boolean;
  client?: () => RuntimeHostClient | null;
  registry?: () => AgentRegistry;
  kick?: () => void;
  requestMigrationTick?: () => void;
}

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

function requestMigrationProgress(
  registry: AgentRegistry,
  conversationId: ViewerConversationId,
  requestTick: () => void,
): void {
  const phase = registry.conversation(conversationId)?.migration?.phase;
  if (phase && !["committed", "rolled-back"].includes(phase)) requestTick();
}

export async function enqueueStructuredMessage(
  request: StructuredMessageRequest,
  dependencies: StructuredMessageDependencies = {},
): Promise<StructuredMessageResult | null> {
  if (!(dependencies.enabled ?? structuredHostsEnabled)()) return null;
  const client = (dependencies.client ?? runtimeHostClient)();
  if (!client) return ownershipUnavailable();
  try {
    const snapshot = await client.snapshot();
    const session = (request.conversationId
      ? snapshot.sessions.find((candidate) => candidate.conversationId === request.conversationId)
      : undefined)
      ?? snapshot.sessions.find((candidate) => candidate.artifactPath === request.path);
    if (!session) return ownershipUnavailable();
    if (session.hostKind === "tmux-legacy") return null;
    if (session.hostKind !== "codex-app-server" && session.hostKind !== "claude-broker") {
      return ownershipUnavailable();
    }
    if (request.hasImages) {
      return { ok: false, structured: true, outcome: "failed", error: "structured host image delivery is unavailable", status: 409 };
    }
    if (!session.conversationId.startsWith("conversation_")) return ownershipUnavailable();
    const registry = (dependencies.registry ?? agentRegistry)();
    const conversation = registry.conversation(session.conversationId as ViewerConversationId);
    if (!conversation) return ownershipUnavailable();
    const idempotencyKey = request.clientMessageId?.trim() || `queue_${crypto.randomUUID()}`;
    let reservation = registry.holdDelivery(conversation.id, request.text, idempotencyKey);
    let claimedReservationId: string | null = null;
    if (reservation.state === "delivery-uncertain") {
      reservation = registry.retryUncertainDelivery(reservation.id);
    }
    if (reservation.state === "held") {
      (dependencies.requestMigrationTick ?? requestAccountMigrationTick)();
      return { ok: true, structured: true, target: conversation.id, outcome: "held" };
    }
    if (reservation.state === "assigned" && reservation.generationId) {
      const claimed = registry.beginDeliveryAttempt(reservation.id, reservation.generationId);
      if (!claimed) {
        registry.requeueHeldDelivery(reservation.id);
        (dependencies.requestMigrationTick ?? requestAccountMigrationTick)();
        return { ok: true, structured: true, target: conversation.id, outcome: "held" };
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
      kind: "send",
      conversationId: conversation.id,
      idempotencyKey,
      text: request.text,
      policy: "queue",
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
    if (claimedReservationId) {
      registry.recordDeliveryOutcome(claimedReservationId, "delivered");
      requestMigrationProgress(registry, conversation.id, dependencies.requestMigrationTick ?? requestAccountMigrationTick);
    }
    (dependencies.kick ?? kickStructuredDeliveryQueue)();
    const outcome = receipt.status === "delivering" || receipt.status === "delivered" ? receipt.status : "queued";
    return { ok: true, structured: true, target: conversation.id, outcome, operationId: result.operationId, receipt };
  } catch (error) {
    return {
      ok: false,
      structured: true,
      outcome: "failed",
      error: error instanceof Error ? error.message : "structured host delivery failed",
      status: 503,
    };
  }
}
