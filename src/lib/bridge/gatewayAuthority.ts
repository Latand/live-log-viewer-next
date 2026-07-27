import { liveRootSession, type RootSessionSource } from "@/lib/root/adopt";
import { agentRegistry } from "@/lib/agent/registry";
import { structuredDeliveryHostForConversation } from "@/lib/runtime/structuredDeliveryController";

/**
 * Who may read the gateway's inbox (#691 §4).
 *
 * The drain is not merely private. It carries the single-use nonces that authorize
 * deploys, so an unauthenticated loopback reader could harvest one and then approve
 * a deploy in the operator's name — the confirmation design assumes the nonce
 * reaches the gateway and nobody else. Reading it therefore needs the same proof
 * writing into the call does: the realtime session id the backend minted during the
 * root's SDP exchange, held only by the peer that ran it.
 *
 * Deliberately NOT a new secret. Adding another token would mean another file,
 * another rotation and another thing to leak; the session id already exists, is
 * already per-call, and already dies with the call it belongs to.
 */

export type BridgeGatewayAuthority =
  | { ok: true; conversationId: string }
  | { ok: false; error: string };

const REFUSED: BridgeGatewayAuthority = {
  ok: false,
  error: "the bridge inbox is readable only by the live voice gateway; present the realtimeSessionId of the root's current call",
};

export interface BridgeGatewaySources {
  rootConversationId(): string | null;
  liveRealtimeSessionId(conversationId: string): string | null;
}

function productionSources(): BridgeGatewaySources {
  return {
    rootConversationId: () => {
      const snapshot = agentRegistry().readOnlySnapshot();
      const source: RootSessionSource = {
        conversations: Object.values(snapshot.conversations),
        configuredRootId: process.env.LLV_ROOT_CONVERSATION_ID?.trim() || null,
      };
      return liveRootSession(source)?.conversationId ?? null;
    },
    liveRealtimeSessionId: (conversationId) => {
      const host = structuredDeliveryHostForConversation(conversationId) as
        { currentRealtimeSessionId?: () => string | null } | null;
      return host?.currentRealtimeSessionId?.() ?? null;
    },
  };
}

let overriddenSources: BridgeGatewaySources | null = null;

/** Tests only; `null` restores the production resolution. Lives here rather than in
    the route because a route module may export only route fields. */
export function setBridgeGatewaySourcesForTests(sources: BridgeGatewaySources | null): void {
  overriddenSources = sources;
}

/**
 * Whether this caller is the root's live gateway surface.
 *
 * Fails closed at every step: no root, no live call, no session id presented, or a
 * mismatch — all refuse. There is no "probably the browser" branch, because that is
 * exactly the assumption the injection gate was corrected for.
 */
export function authenticateBridgeGateway(
  presented: string | null | undefined,
  sources: BridgeGatewaySources = overriddenSources ?? productionSources(),
): BridgeGatewayAuthority {
  const claimed = typeof presented === "string" ? presented.trim() : "";
  if (!claimed) return REFUSED;
  const conversationId = sources.rootConversationId();
  if (!conversationId) return REFUSED;
  const live = sources.liveRealtimeSessionId(conversationId);
  if (!live || live !== claimed) return REFUSED;
  return { ok: true, conversationId };
}
