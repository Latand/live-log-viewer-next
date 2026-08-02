import { structuredHostsEnabled } from "./flags";
import { agentRegistry, type AgentRegistry, type ProcessIdentity } from "@/lib/agent/registry";
import { reconfigurationFromBody, type AgentReconfiguration } from "@/lib/agent/reconfigure";
import { listClaudeAccounts } from "@/lib/accounts/claude";
import { listCodexAccounts } from "@/lib/accounts/codex";
import { sessionKeyId } from "@/lib/agent/sessionKey";

import { isRuntimeHostTransportFailure, runtimeHostClient, type RuntimeHostClient } from "./client";
import { newOperationId, runtimeCompactCapability, type RuntimeControlCapability, type RuntimeOperationCommand } from "./contracts";
import { republishStructuredDeliveryHost } from "./structuredDeliveryController";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { recoverDeadStructuredConversation, structuredHostProcessAlive } from "./structuredRecovery";

export type StructuredControlResult =
  | { status: 200; body: { ok: true; structured: true; target: string; outcome: "delivered" } }
  | { status: 200; body: { ok: true; structured: true; target: string; outcome: "resumed"; spawned: boolean } }
  | { status: 200 | 202; body: { ok: true; structured: true; target: string; operationId: string; receipt: { operationId: string; status: string } } }
  /** A control this engine genuinely does not expose (#862). It is typed, so a
      caller can tell "this engine cannot" from "this attempt failed", and no
      prompt-based fallback is ever offered in its place. */
  | { status: 409; body: { error: string; code: "unsupported-capability"; capability: RuntimeControlCapability } }
  | { status: 400 | 409 | 503; body: { error: string } };

const STRUCTURED_CONTROL_ACTIONS = new Set(["interrupt", "kill", "reconfigure", "compact"]);

export interface StructuredControlRequest {
  path: string;
  conversationId: string;
  action: string;
  operationId?: string;
  reconfiguration?: Partial<AgentReconfiguration>;
}

export async function dispatchStructuredControl(
  request: StructuredControlRequest,
  dependencies: {
    registry?: AgentRegistry;
    client?: RuntimeHostClient | null;
    operationId?: () => string;
    kick?: () => void;
    enabled?: () => boolean;
    accountExists?: (engine: "claude" | "codex", accountId: string) => boolean;
    recover?: typeof recoverDeadStructuredConversation;
    republish?: typeof republishStructuredDeliveryHost;
    hostProcessAlive?: (identity: ProcessIdentity | null) => boolean;
  } = {},
): Promise<StructuredControlResult | null> {
  if (!request.action) return null;
  if (!(dependencies.enabled ?? (() => structuredHostsEnabled()))()) return null;
  const registry = dependencies.registry ?? agentRegistry();
  const conversation = request.path
    ? registry.conversationForPath(request.path)
    : request.conversationId.startsWith("conversation_")
      ? registry.conversation(request.conversationId as `conversation_${string}`)
      : null;
  const generation = conversation?.generations.at(-1);
  if (!conversation || !generation) return null;
  const snapshot = registry.readOnlySnapshot();
  const entry = snapshot.entries[sessionKeyId({ engine: conversation.engine, sessionId: generation.id })];
  if (!entry) return null;
  /* Host teardown clears the structuredHost column before terminal kill
     projection or reconfigure recovery finishes. Durable conversation state
     keeps those controls on the structured channel throughout that gap. */
  const structuredKill = request.action === "kill" && !entry.host;
  const completedStructuredOwnership = request.action === "reconfigure"
    && !entry.host
    && Object.values(snapshot.receipts).some((receipt) =>
      receipt.transport === "structured"
        && receipt.state === "completed"
        && registry.canonicalConversationId(receipt.conversationId) === conversation.id);
  const structuredReconfigureRestart = request.action === "reconfigure"
    && !entry.host
    && (conversation.reconfigure?.status === "applying" || completedStructuredOwnership);
  if (!entry.structuredHost && !structuredKill && !structuredReconfigureRestart) return null;

  if (!STRUCTURED_CONTROL_ACTIONS.has(request.action)) {
    if (request.action === "resume") {
      if (entry.status === "dead" || entry.status === "unhosted") return null;
      try {
        if ((dependencies.hostProcessAlive ?? structuredHostProcessAlive)(entry.structuredHost?.process ?? null)) {
          const republished = await (dependencies.republish ?? republishStructuredDeliveryHost)({
            engine: conversation.engine,
            sessionId: generation.id,
          });
          if (!republished) {
            return { status: 503, body: { error: "structured recovery ownership is unavailable" } };
          }
          return {
            status: 200,
            body: {
              ok: true,
              structured: true,
              target: conversation.id,
              outcome: "resumed",
              spawned: false,
            },
          };
        }
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
    const label = ["dialog-key", "kill", "reconfigure"].includes(request.action)
      ? request.action
      : "requested";
    return { status: 409, body: { error: `structured host does not support the ${label} control` } };
  }

  if (request.action === "compact") {
    const capability = runtimeCompactCapability(conversation.engine);
    if (!capability.supported || entry.structuredHost?.kind !== "codex-app-server") {
      return {
        status: 409,
        body: {
          error: capability.reason
            ?? `the ${conversation.engine} structured host does not expose a compact control`,
          code: "unsupported-capability",
          capability,
        },
      };
    }
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
  const operationId = request.operationId ?? (dependencies.operationId ?? newOperationId)();
  try {
    const reconfiguration = request.action === "reconfigure"
      ? reconfigurationFromBody(conversation.engine, request.reconfiguration ?? {})
      : null;
    if (reconfiguration && !reconfiguration.value) {
      return { status: 400, body: { error: reconfiguration.error ?? "invalid configuration" } };
    }
    if (reconfiguration?.value?.accountId) {
      const accountExists = dependencies.accountExists ?? ((engine: "claude" | "codex", accountId: string) =>
        (engine === "claude" ? listClaudeAccounts() : listCodexAccounts()).some((account) => account.id === accountId));
      if (!accountExists(conversation.engine, reconfiguration.value.accountId)) {
        return { status: 400, body: { error: `account is not available for ${conversation.engine}` } };
      }
    }
    const sessionKey = { engine: conversation.engine, sessionId: generation.id };
    const command: RuntimeOperationCommand = request.action === "kill"
      ? { kind: "kill", operationId, idempotencyKey: operationId, conversationId: conversation.id, sessionKey }
      /* #862: a compact command carries a generation fence and nothing else.
         There is no text field to fill, so this control cannot degrade into a
         `/compact` user turn on any path. */
      : request.action === "compact"
        ? { kind: "compact", operationId, idempotencyKey: operationId, conversationId: conversation.id, sessionKey }
        : request.action === "reconfigure"
          ? {
              kind: "reconfigure",
              operationId,
              idempotencyKey: operationId,
              conversationId: conversation.id,
              sessionKey,
              ...reconfiguration!.value!,
              previousProfile: {
                model: generation.launchProfile.model,
                effort: generation.launchProfile.effort,
                fast: generation.launchProfile.fast,
              },
            }
          : {
              kind: "interrupt",
              operationId,
              idempotencyKey: operationId,
              conversationId: conversation.id,
              turnId: entry.structuredHost?.activeTurnRef ?? null,
            };
    const result = await client.command(command);
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
    if ((request.action === "kill" || request.action === "reconfigure" || request.action === "compact")
      && isRuntimeHostTransportFailure(error)) {
      /* The socket failed after the command may have reached the journal. The
         durable receipt decides whether structured control owns the response. */
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
