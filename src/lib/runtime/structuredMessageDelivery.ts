import crypto from "node:crypto";

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
  | { ok: false; structured: true; outcome: "failed"; error: string; status: number; operationId?: string; receipt?: RuntimeOperationReceipt };

export interface StructuredMessageDependencies {
  enabled?: () => boolean;
  client?: () => RuntimeHostClient | null;
  kick?: () => void;
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
    const result = await client.command({
      kind: "send",
      conversationId: session.conversationId,
      idempotencyKey: request.clientMessageId?.trim() || `queue_${crypto.randomUUID()}`,
      text: request.text,
      policy: "queue",
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
    return { ok: true, structured: true, target: session.conversationId, outcome, operationId: result.operationId, receipt };
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
