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
 *
 * ## What #845 changed, and why
 *
 * The check was right and its COST was wrong. `rootConversationId` materialised the
 * whole registry and walked every conversation on every call, and the relay above
 * called it every ten seconds per open call — including, before the relay was
 * bounded, every ten seconds forever for a session the gateway was refusing. At
 * production shape that is a full registry projection and an O(n log n) sort per
 * poll to answer a question whose answer changes when a root session rolls over,
 * which is to say almost never.
 *
 * So the poll path no longer rebuilds anything. The root identity is a
 * process-scoped projection, and the steady-state check is two O(1) lookups: which
 * conversation is root, and what realtime session its structured host currently
 * holds. A rebuild happens only when that check does NOT match — the rollover
 * signal — and even then no more than once per window, so a client hammering a
 * refused credential cannot turn its own refusals into registry reads.
 *
 * The trade-off, stated plainly: between a rollover and the next rebuild, the
 * projection can still name the previous root. That cannot grant authority to an
 * arbitrary caller — the presented id must still equal the realtime session id that
 * conversation's own live host holds right now, which nobody but that call's peer
 * has. And a rollover ends the previous root's call, so the projected root stops
 * having a live session at all, which is the one condition that spends the rebuild
 * budget. A wrong credential presented against a HEALTHY root spends nothing, at any
 * request rate, because there is nothing about it a rebuild would change. Every step
 * still fails closed.
 */

export type BridgeGatewayAuthority =
  | { ok: true; conversationId: string }
  | { ok: false; error: string };

const REFUSED: BridgeGatewayAuthority = {
  ok: false,
  error: "the bridge inbox is readable only by the live voice gateway; present the realtimeSessionId of the root's current call",
};

export interface BridgeGatewaySources {
  /** The expensive one: a whole-registry projection. Never called on the steady
      state poll path — only to build or correct the process-scoped projection. */
  rootConversationId(): string | null;
  /** O(1): the realtime session this conversation's structured host holds now. */
  liveRealtimeSessionId(conversationId: string): string | null;
  now?(): number;
}

/**
 * Minimum spacing between whole-registry projections.
 *
 * One bridge batch window. A refused caller polling in a loop, or a hostile one
 * polling as fast as it can, therefore costs at most one registry read per window
 * no matter how many requests it makes — the bound has to hold against request
 * RATE, not against a well-behaved client.
 */
export const BRIDGE_ROOT_PROJECTION_REBUILD_MS = 30_000;

interface RootProjection {
  conversationId: string | null;
  builtAt: number;
}

/* Next.js can instantiate a module more than once per process (dev hot reload,
   duplicate bundles); the projection hangs off globalThis so every copy shares one
   rebuild budget rather than one budget each. */
const projectionHost = globalThis as typeof globalThis & {
  __llvBridgeRootProjection?: RootProjection;
};

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
  /* A projection built from one set of sources says nothing about another. */
  projectionHost.__llvBridgeRootProjection = undefined;
}

/** Tests only. */
export function resetBridgeRootProjectionForTests(): void {
  projectionHost.__llvBridgeRootProjection = undefined;
}

/**
 * The projected root, rebuilt only when the budget allows it.
 *
 * Returns the projection either way, so a caller that arrives inside a closed window
 * with nothing projected is refused rather than served a guess.
 */
function projectedRoot(sources: BridgeGatewaySources, now: number): string | null {
  const current = projectionHost.__llvBridgeRootProjection;
  if (current && now - current.builtAt < BRIDGE_ROOT_PROJECTION_REBUILD_MS) return current.conversationId;
  const conversationId = sources.rootConversationId();
  projectionHost.__llvBridgeRootProjection = { conversationId, builtAt: now };
  return conversationId;
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
  /* Before anything is read. A caller with no credential cannot be the live gateway
     whatever the registry says, and answering it should not cost a lookup. */
  if (!claimed) return REFUSED;

  const now = sources.now?.() ?? Date.now();

  /* The steady state, and the only path a healthy poll takes: one O(1) lookup and no
     registry work at all. */
  const projected = projectionHost.__llvBridgeRootProjection?.conversationId ?? null;
  if (projected) {
    const live = sources.liveRealtimeSessionId(projected);
    if (live === claimed) return { ok: true, conversationId: projected };
    /* The projected root is UP and holding a different session, so the projection is
       not what is wrong here — the credential is. Rebuilding would cost a whole
       registry read to re-derive the same answer, which is precisely how a client
       looping on a refusal turned its own retries into registry load. Refuse, free. */
    if (live) return REFUSED;
  }

  /* Either nothing is projected, or the projected root no longer has a live call —
     which is exactly what a rollover looks like. That is worth a rebuild, and the
     window keeps even this bounded when the root is simply down and something keeps
     asking. */
  const conversationId = projectedRoot(sources, now);
  if (!conversationId) return REFUSED;
  const live = sources.liveRealtimeSessionId(conversationId);
  if (!live || live !== claimed) return REFUSED;
  return { ok: true, conversationId };
}
