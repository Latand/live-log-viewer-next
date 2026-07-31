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
 * So the SUCCESSFUL poll path rebuilds nothing. The root identity is a
 * process-scoped projection, and a matching credential costs one O(1) lookup: what
 * realtime session the projected root's structured host currently holds.
 *
 * A MISMATCH re-derives, bounded to at most one whole-registry read per window. That
 * bound has to hold against request RATE rather than against a well-behaved client,
 * which is what makes a refused caller looping forever cost one read per window
 * instead of one per request.
 *
 * The trade-off, stated plainly: for up to one window after a handover the projection
 * can still name the predecessor, so a predecessor whose call is still up keeps
 * access for at most that long, and a successor is adopted within at most that long —
 * in practice on its first request, because a healthy root never spends the budget
 * and the window is long expired when a handover happens. The projection can never
 * grant authority to an arbitrary caller: the presented id must equal the realtime
 * session id the projected root's own live host holds right now, which nobody but
 * that call's peer has. Every step still fails closed.
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
  if (projected && sources.liveRealtimeSessionId(projected) === claimed) {
    return { ok: true, conversationId: projected };
  }

  /*
   * A MISMATCH IS A REASON TO RE-DERIVE, not a reason to refuse from the memo.
   *
   * The first version of this refused for free whenever the projected root still had
   * a live call, reasoning that a rollover ends the predecessor's call. It does not
   * have to. A handover can promote B while A's call is still up, and then the memo
   * pinned A forever: A kept reading the deploy nonces it was no longer entitled to,
   * and B — the actual root — was refused for as long as A stayed on the line. That
   * is the wrong half of a fail-closed design failing open.
   *
   * So every mismatch consults the projection, and the WINDOW is what keeps it
   * bounded: `projectedRoot` re-derives at most once per window and serves the memo
   * otherwise. A caller looping on a refusal therefore costs at most one registry
   * read per window no matter its rate, and a genuine successor is adopted within one
   * window — usually on its first request, since a healthy root never spends the
   * budget and the window is long expired by the time a handover happens.
   */
  const conversationId = projectedRoot(sources, now);
  if (!conversationId) return REFUSED;
  /* Already checked above against this exact id, and the memo did not move. */
  if (conversationId === projected) return REFUSED;
  const live = sources.liveRealtimeSessionId(conversationId);
  if (!live || live !== claimed) return REFUSED;
  return { ok: true, conversationId };
}
