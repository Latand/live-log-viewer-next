import { agentRegistry, type AgentRegistry, type ProcessIdentity } from "@/lib/agent/registry";
import { sessionKeyId } from "@/lib/agent/sessionKey";

import { isRuntimeHostTransportFailure, runtimeHostClient, type RuntimeHostClient } from "./client";
import { newOperationId } from "./contracts";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { recoverDeadStructuredConversation, structuredHostProcessAlive } from "./structuredRecovery";

export type StructuredControlResult =
  | { status: 200; body: { ok: true; structured: true; target: string; outcome: "delivered" } }
  | { status: 200; body: { ok: true; structured: true; target: string; outcome: "resumed"; spawned: boolean } }
  | { status: 200 | 202; body: { ok: true; structured: true; target: string; operationId: string; receipt: { operationId: string; status: string } } }
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
    enabled?: () => boolean;
    recover?: typeof recoverDeadStructuredConversation;
    hostProcessAlive?: (identity: ProcessIdentity | null) => boolean;
  } = {},
): Promise<StructuredControlResult | null> {
  if (!request.action) return null;
  if (!(dependencies.enabled ?? (() => process.env.LLV_STRUCTURED_HOSTS === "1"))()) return null;
  const registry = dependencies.registry ?? agentRegistry();
  const conversation = request.path
    ? registry.conversationForPath(request.path)
    : request.conversationId.startsWith("conversation_")
      ? registry.conversation(request.conversationId as `conversation_${string}`)
      : null;
  const generation = conversation?.generations.at(-1);
  if (!conversation || !generation) return null;
  const entry = registry.snapshot().entries[sessionKeyId({ engine: conversation.engine, sessionId: generation.id })];
  if (!entry) return null;
  /* A delivered kill tears the structuredHost column down, so kill ownership
     must outlive it: once a conversation has no legacy tmux pane, its kill
     stays on the structured channel. Falling through to the legacy pane-close
     ladder here is what turned a durably delivered kill into path-required
     and branch/root failures (#372). */
  const structuredKill = request.action === "kill" && !entry.host;
  if (!entry.structuredHost && !structuredKill) return null;

  if (request.action !== "interrupt" && request.action !== "kill") {
    if (request.action === "resume" && (entry.status === "dead" || entry.status === "unhosted")) {
      return null;
    }
    if (request.action === "resume"
      && !(dependencies.hostProcessAlive ?? structuredHostProcessAlive)(entry.structuredHost?.process ?? null)) {
      try {
        const recovered = await (dependencies.recover ?? recoverDeadStructuredConversation)({
          path: request.path || generation.path,
          conversationId: conversation.id,
        }, { registry });
        if (!recovered) {
          return { status: 503, body: { error: "structured recovery ownership is unavailable" } };
        }
        return {
          status: 200,
          body: {
            ok: true,
            structured: true,
            target: conversation.id,
            outcome: "resumed",
            spawned: recovered.spawned,
          },
        };
      } catch (error) {
        return { status: 503, body: { error: error instanceof Error ? error.message : String(error) } };
      }
    }
    const label = ["compact", "dialog-key", "kill", "reconfigure", "resume"].includes(request.action)
      ? request.action
      : "requested";
    return { status: 409, body: { error: `structured host does not support the ${label} control` } };
  }

  if (structuredKill
    && !entry.structuredHost?.process
    && (entry.status === "dead" || entry.status === "unhosted")) {
    /* The durable projection already records this session as torn down, so a
       repeated kill replays the terminal outcome instead of re-entering the
       command channel or the legacy pane-close ladder. */
    return { status: 200, body: { ok: true, structured: true, target: conversation.id, outcome: "delivered" } };
  }

  const client = dependencies.client === undefined ? runtimeHostClient() : dependencies.client;
  if (!client) return { status: 503, body: { error: "structured runtime host is unavailable" } };
  const operationId = (dependencies.operationId ?? newOperationId)();
  try {
    const result = await client.command(request.action === "kill"
      ? {
          kind: "kill",
          operationId,
          idempotencyKey: operationId,
          conversationId: conversation.id,
          sessionKey: { engine: conversation.engine, sessionId: generation.id },
        }
      : {
          kind: "interrupt",
          operationId,
          idempotencyKey: operationId,
          conversationId: conversation.id,
          turnId: entry.structuredHost?.activeTurnRef ?? null,
        });
    (dependencies.kick ?? kickStructuredDeliveryQueue)();
    return {
      status: result.receipt.status === "delivered" ? 200 : 202,
      body: {
        ok: true,
        structured: true,
        target: conversation.id,
        operationId,
        receipt: result.receipt,
      },
    };
  } catch (error) {
    if (request.action === "kill" && isRuntimeHostTransportFailure(error)) {
      /* The socket failed after the command may have reached the journal. The
         durable receipt, not the transport, decides the outcome of a kill:
         once admitted or delivered, structured control owns the response. */
      const durable = await client.operationStatus(operationId).catch(() => null);
      if (durable) {
        (dependencies.kick ?? kickStructuredDeliveryQueue)();
        return {
          status: durable.receipt.status === "delivered" ? 200 : 202,
          body: {
            ok: true,
            structured: true,
            target: conversation.id,
            operationId: durable.operationId,
            receipt: durable.receipt,
          },
        };
      }
    }
    return { status: 503, body: { error: error instanceof Error ? error.message : String(error) } };
  }
}
