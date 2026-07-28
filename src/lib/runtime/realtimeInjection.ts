import type { NextRequest } from "next/server";

import { agentRegistry } from "@/lib/agent/registry";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";
import { readOrchestratorRecord } from "@/lib/orchestrator/store";

import crypto from "node:crypto";

/**
 * Who may put words into the voice session (#691 §6).
 *
 * `appendSpeech` and `deliverWorkerResponse` write into the conversation the
 * operator is listening to, in a voice they will read as the assistant's. Every
 * Viewer-spawned agent can reach this endpoint — `rejectCrossOrigin` stops other
 * websites, not other processes — so without a gate any worker could speak to the
 * operator as the assistant. That is the same class of hole
 * `attentionCallerAuthority` was written to close for `request_attention`, and the
 * blast radius here is larger: attention moves a view, this puts sentences in the
 * operator's ear.
 *
 * The other two actions are deliberately NOT gated. `start` and `stop` establish and
 * tear down the operator's own WebRTC leg from their own browser, and `status`
 * reports why a transport died; none writes into the conversation.
 *
 * FAILS CLOSED, and narrowly. Two earlier shapes of this gate were both too wide:
 *
 * - Presenting NOTHING once read as "the operator's browser", so a worker could
 *   inject by omitting a header — the cheapest possible attack.
 * - Then the designated MANAGER was allowed, which moved the hole up a level rather
 *   than closing it: manager authority is a designation, and whatever can obtain
 *   that designation inherits the right to speak in the assistant's voice.
 *
 * What remains is the narrowest thing that still works: the call's
 * `realtimeSessionId`, minted by the backend during the SDP exchange and held only
 * by the peer that ran it. The manager does not need this and never did — its
 * channel to the operator is `bridge_report`, read and voiced by the gateway, which
 * is the architecture's own rule that the manager never speaks to the user directly.
 */

/** Actions that write into the user-facing session. */
export const REALTIME_INJECTION_ACTIONS: readonly string[] = ["appendSpeech", "deliverWorkerResponse"];

/**
 * Actions that mutate the transport itself.
 *
 * Not injection — they put no words in the operator's ear — but an agent that can
 * `stop` can hang up the operator's call, and one that can `start` can hold the
 * host's single realtime slot so the operator cannot. Both are the operator's own,
 * and `start` cannot be authorized by a session id because it is what mints one.
 */
export const REALTIME_TRANSPORT_ACTIONS: readonly string[] = ["start", "stop"];

const INJECTION_ACTION_SET: ReadonlySet<string> = new Set(REALTIME_INJECTION_ACTIONS);
const TRANSPORT_ACTION_SET: ReadonlySet<string> = new Set(REALTIME_TRANSPORT_ACTIONS);

export type RealtimeCaller =
  /**
   * The peer that established the call, proven by presenting the realtime session id
   * the backend minted for it. Only the browser that ran the SDP exchange holds it.
   */
  | { kind: "session"; realtimeSessionId: string }
  /** An agent the registry can name from the capability it presented. */
  | { kind: "conversation"; conversationId: string }
  /** Nothing was presented. Never an authority. */
  | { kind: "anonymous" };

export type RealtimeInjectionVerdict =
  | { allowed: true }
  | { allowed: false; status: number; error: string };

/**
 * Whether this caller may perform this action.
 *
 * Pure over a resolved caller and a resolved manager, so the decision is testable
 * without a registry, a socket or a process tree.
 */
export function permitRealtimeAction(
  action: unknown,
  caller: RealtimeCaller,
  managerConversationId: string | null,
  /** The session id the host currently holds for this conversation, if any. */
  liveRealtimeSessionId: string | null = null,
  /** Whether the request carries the operator's own authority (§ transport). */
  operator = false,
): RealtimeInjectionVerdict {
  if (typeof action !== "string") return { allowed: true };

  if (TRANSPORT_ACTION_SET.has(action)) {
    /* The operator opens and closes their own call. `stop` additionally accepts the
       peer that owns the session — hanging up your own call is not an escalation —
       but `start` has no session to present yet, so it is the operator's alone. */
    if (operator) return { allowed: true };
    if (action === "stop"
      && caller.kind === "session"
      && liveRealtimeSessionId
      && caller.realtimeSessionId === liveRealtimeSessionId) {
      return { allowed: true };
    }
    return {
      allowed: false,
      status: 403,
      error: `${action} controls the operator's voice transport; an agent may not open or close their call.`,
    };
  }

  if (!INJECTION_ACTION_SET.has(action)) return { allowed: true };

  /* FAILS CLOSED. Presenting nothing is not evidence of being the operator — it is
     the cheapest thing an impostor can do, and treating it as authority was the same
     fail-open shape the MCP grant lane was corrected for. Authority is a credential
     the caller HAS: the live session id, or the manager's capability. */
  /* THE LIVE PEER, AND NOBODY ELSE — not even the manager.
     Granting injection to the manager ROLE reopened the hole one level up: manager
     authority is a designation, and anything that can obtain that designation
     inherits the right to speak in the assistant's voice. It is also unnecessary.
     The manager's channel to the user is `bridge_report`, which the gateway reads
     and voices in its own words; the architecture's own sentence is that the manager
     never speaks to the user directly. So the only thing that may write into a call
     is the peer that established it. */
  if (caller.kind !== "session") return refuse(action);
  return liveRealtimeSessionId && caller.realtimeSessionId === liveRealtimeSessionId
    ? { allowed: true }
    : refuse(action);
}

function refuse(action: string): RealtimeInjectionVerdict {
  return {
    allowed: false,
    status: 403,
    error: `${action} writes into the operator's voice session. Only the peer that established this call may do that. If you have something for the operator, append it with bridge_report and let the gateway decide what to say.`,
  };
}

/**
 * Resolve the caller from what it presented, never from what it claims to be.
 *
 * A capability the registry maps names that conversation; one it cannot map resolves
 * to a conversation id matching nothing, because a wrong or stale token is what an
 * impostor presents. A bare session id is checked against the live session later.
 * Presenting neither is `anonymous`, which authorizes nothing at all.
 */
export function realtimeCallerFromRequest(
  request: Pick<NextRequest, "headers">,
  body: Record<string, unknown>,
): RealtimeCaller {
  const capability = request.headers.get(VIEWER_SPAWN_CAPABILITY_HEADER)?.trim() ?? "";
  if (capability) {
    /* A capability the registry cannot map is NOT downgraded to anonymous-but-
       trusted: a wrong or stale token is what an impostor presents, so it resolves
       to a conversation that matches nothing and is refused. */
    const digest = /^[A-Za-z0-9_-]{43}$/.test(capability)
      ? crypto.createHash("sha256").update(capability).digest("hex")
      : "";
    const conversationId = digest ? agentRegistry().conversationIdForSpawnCapabilityDigest(digest) : null;
    return { kind: "conversation", conversationId: conversationId ?? "" };
  }
  const realtimeSessionId = typeof body.realtimeSessionId === "string" ? body.realtimeSessionId.trim() : "";
  if (realtimeSessionId) return { kind: "session", realtimeSessionId };
  return { kind: "anonymous" };
}

/** The manager's conversation, or null when none is designated. */
export function designatedManagerConversationId(): string | null {
  return readOrchestratorRecord()?.conversationId ?? null;
}
