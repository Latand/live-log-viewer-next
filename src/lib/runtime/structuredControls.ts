import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { sessionKeyId } from "@/lib/agent/sessionKey";

import { runtimeHostClient, type RuntimeHostClient } from "./client";
import { newOperationId } from "./contracts";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";

export type StructuredControlResult =
  | { status: 202; body: { ok: true; structured: true; target: string; operationId: string; receipt: { operationId: string; status: string } } }
  | { status: 409 | 503; body: { error: string } };

export interface StructuredControlRequest {
  path: string;
  conversationId: string;
  action: string;
}

export async function dispatchStructuredControl(
  request: StructuredControlRequest,
  dependencies: {
    registry?: AgentRegistry;
    client?: RuntimeHostClient | null;
    operationId?: () => string;
    kick?: () => void;
  } = {},
): Promise<StructuredControlResult | null> {
  if (!request.action) return null;
  const registry = dependencies.registry ?? agentRegistry();
  const conversation = request.path
    ? registry.conversationForPath(request.path)
    : request.conversationId.startsWith("conversation_")
      ? registry.conversation(request.conversationId as `conversation_${string}`)
      : null;
  const generation = conversation?.generations.at(-1);
  if (!conversation || !generation) return null;
  const entry = registry.snapshot().entries[sessionKeyId({ engine: conversation.engine, sessionId: generation.id })];
  if (!entry?.structuredHost) return null;

  if (request.action !== "interrupt") {
    const label = ["compact", "dialog-key", "kill", "reconfigure", "resume"].includes(request.action)
      ? request.action
      : "requested";
    return { status: 409, body: { error: `structured host does not support the ${label} control` } };
  }

  const client = dependencies.client === undefined ? runtimeHostClient() : dependencies.client;
  if (!client) return { status: 503, body: { error: "structured runtime host is unavailable" } };
  try {
    const operationId = (dependencies.operationId ?? newOperationId)();
    const result = await client.command({
      kind: "interrupt",
      operationId,
      idempotencyKey: operationId,
      conversationId: conversation.id,
      turnId: entry.structuredHost.activeTurnRef,
    });
    (dependencies.kick ?? kickStructuredDeliveryQueue)();
    return {
      status: 202,
      body: {
        ok: true,
        structured: true,
        target: conversation.id,
        operationId,
        receipt: result.receipt,
      },
    };
  } catch (error) {
    return { status: 503, body: { error: error instanceof Error ? error.message : String(error) } };
  }
}
