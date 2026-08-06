import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { runtimeHostClient, type RuntimeHostClient } from "@/lib/runtime/client";
import { enqueueStructuredMessage } from "@/lib/runtime/structuredMessageDelivery";
import type { RuntimeOperationReceipt } from "@/lib/runtime/contracts";

export type PipelineDecisionDeliveryRequest = {
  pipelineId: string;
  stageId: string;
  sourceAttempt: number;
  targetAttempt: number;
  conversationId: string;
  path: string;
  input: string;
  clientMessageId: string;
  operationId: string;
};

export type PipelineDecisionDeliveryResult = {
  state: "held" | "queued" | "delivering" | "delivered" | "failed";
  operationId: string;
  deliveryId: string | null;
  at?: string | null;
  error?: string | null;
};

type PipelineDecisionDeliveryDependencies = {
  registry?: () => AgentRegistry;
  client?: () => RuntimeHostClient | null;
  enqueue?: typeof enqueueStructuredMessage;
};

function terminalizationOutcomeIsUncertain(delivery: { attempts: number; error: string | null }): boolean {
  return delivery.attempts > 0 && Boolean(delivery.error?.includes("journal outcome is unknown"));
}

function resultFromReceipt(
  receipt: RuntimeOperationReceipt,
  deliveryId: string | null,
): PipelineDecisionDeliveryResult {
  const state = ["turn-started", "steered", "delivered"].includes(receipt.status)
    ? "delivered"
    : ["failed", "rejected"].includes(receipt.status)
      ? "failed"
      : ["delivering", "applying", "uncertain"].includes(receipt.status)
        ? "delivering"
        : "queued";
  return {
    state,
    operationId: receipt.operationId,
    deliveryId,
    at: receipt.at,
    error: state === "failed"
      ? receipt.reason ?? "decision delivery failed"
      : receipt.status === "uncertain"
        ? receipt.reason ?? "decision delivery outcome is unknown"
        : null,
  };
}

/**
 * Admits a pipeline decision through the same durable structured-message seam
 * as the composer. The caller owns the attempt/revision transaction; this
 * adapter owns transport reservation and preserves the supplied identities.
 */
export async function deliverPipelineDecision(
  request: PipelineDecisionDeliveryRequest,
  dependencies: PipelineDecisionDeliveryDependencies = {},
): Promise<PipelineDecisionDeliveryResult> {
  const result = await (dependencies.enqueue ?? enqueueStructuredMessage)({
    path: request.path,
    conversationId: request.conversationId,
    clientMessageId: request.clientMessageId,
    operationId: request.operationId,
    kind: "send",
    policy: "queue",
    text: request.input,
  });
  const snapshot = (dependencies.registry ?? agentRegistry)().readOnlySnapshot();
  const owner = snapshot.deliveryOperationOwners[request.operationId];
  const deliveryId = result?.ok && result.outcome === "held"
    ? result.deliveryId
    : owner?.deliveryId ?? null;
  if (!result) {
    return {
      state: "failed",
      operationId: request.operationId,
      deliveryId,
      error: "structured decision delivery is unavailable",
    };
  }
  if (!result.ok) {
    if (result.receipt) return resultFromReceipt(result.receipt, deliveryId);
    if (result.transportUncertain) {
      return {
        state: "delivering",
        operationId: request.operationId,
        deliveryId,
        at: null,
        error: result.error,
      };
    }
    return {
      state: "failed",
      operationId: result.operationId ?? request.operationId,
      deliveryId,
      at: null,
      error: result.error,
    };
  }
  if ("receipt" in result) return resultFromReceipt(result.receipt, deliveryId);
  return {
    state: result.outcome,
    operationId: result.operationId,
    deliveryId,
    at: null,
    error: null,
  };
}

/** Read-only reconstruction of a decision operation after controller restart. */
export async function pipelineDecisionDeliveryStatus(
  operationId: string,
  dependencies: PipelineDecisionDeliveryDependencies = {},
): Promise<PipelineDecisionDeliveryResult | null> {
  const registry = (dependencies.registry ?? agentRegistry)();
  const snapshot = registry.readOnlySnapshot();
  const owner = snapshot.deliveryOperationOwners[operationId];
  const delivery = owner ? snapshot.heldDeliveries[owner.deliveryId] ?? null : null;
  const uncertainTerminalization = Boolean(delivery && terminalizationOutcomeIsUncertain(delivery));
  if (owner?.terminalState === "delivered") {
    return {
      state: "delivered",
      operationId,
      deliveryId: owner.deliveryId,
      at: delivery?.deliveredAt ?? delivery?.createdAt ?? owner.createdAt,
      error: null,
    };
  }
  if (owner?.terminalState === "failed" && !uncertainTerminalization) {
    return {
      state: "failed",
      operationId,
      deliveryId: owner.deliveryId,
      at: delivery?.createdAt ?? owner.createdAt,
      error: delivery?.error ?? "decision delivery failed",
    };
  }
  if (delivery?.state === "held") {
    return { state: "held", operationId, deliveryId: delivery.id, at: delivery.createdAt, error: null };
  }

  const client = (dependencies.client ?? runtimeHostClient)();
  const runtime = client ? await client.operationStatus(operationId).catch(() => null) : null;
  if (runtime) return resultFromReceipt(runtime.receipt, owner?.deliveryId ?? null);
  if (uncertainTerminalization && delivery) {
    return {
      state: "delivering",
      operationId,
      deliveryId: delivery.id,
      at: delivery.assignedAt ?? delivery.createdAt,
      error: delivery.error,
    };
  }
  if (!delivery) return null;
  if (delivery.state === "failed") {
    return {
      state: "failed",
      operationId,
      deliveryId: delivery.id,
      at: delivery.createdAt,
      error: delivery.error ?? "decision delivery failed",
    };
  }
  return {
    state: delivery.state === "assigned" ? "queued" : "delivering",
    operationId,
    deliveryId: delivery.id,
    at: delivery.assignedAt ?? delivery.createdAt,
    error: delivery.error,
  };
}

/**
 * Safely terminalizes an unactuated reservation. Once the runtime has claimed
 * an operation, its eventual turn receipt remains authoritative and callers
 * must wait instead of overwriting an uncertain in-flight outcome.
 */
export async function terminalizePipelineDecisionDelivery(
  operationId: string,
  reason: string,
  dependencies: PipelineDecisionDeliveryDependencies = {},
): Promise<PipelineDecisionDeliveryResult | null> {
  const registry = (dependencies.registry ?? agentRegistry)();
  const snapshot = registry.readOnlySnapshot();
  const owner = snapshot.deliveryOperationOwners[operationId];
  if (!owner) return pipelineDecisionDeliveryStatus(operationId, dependencies);
  const delivery = snapshot.heldDeliveries[owner.deliveryId] ?? null;
  if (owner.terminalState || !delivery) return pipelineDecisionDeliveryStatus(operationId, dependencies);
  if (delivery.state === "delivery-uncertain" || delivery.attempts > 0) {
    return pipelineDecisionDeliveryStatus(operationId, dependencies);
  }
  const terminal = registry.terminalizeHeldDelivery(delivery.id, reason);
  if (terminalizationOutcomeIsUncertain(terminal)) {
    return {
      state: "delivering",
      operationId,
      deliveryId: terminal.id,
      at: terminal.assignedAt ?? terminal.createdAt,
      error: terminal.error,
    };
  }
  return {
    state: terminal.state === "delivered" ? "delivered" : "failed",
    operationId,
    deliveryId: terminal.id,
    at: terminal.deliveredAt ?? new Date().toISOString(),
    error: terminal.state === "delivered" ? null : terminal.error ?? reason,
  };
}
