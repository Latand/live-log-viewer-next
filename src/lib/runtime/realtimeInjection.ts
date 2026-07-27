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
 * FAILS CLOSED, and that is the point of this module's second revision. Presenting
 * nothing used to read as "the operator's browser", which meant a worker could inject
 * by simply omitting a header — the cheapest possible attack, and the same fail-open
 * shape the MCP grant lane was corrected for. Authority is now a credential the
 * caller HAS:
 *
 * - the call's `realtimeSessionId`, minted by the backend during the SDP exchange and
 *   held only by the peer that ran it; or
 * - the spawn capability the registry issued per conversation — the same evidence
 *   `authenticatedAgentSpawnCaller` trusts — matched against the manager's
 *   designation record.
 *
 * A role string would not do either: it is stamped on a launch profile and anything
 * launched with it could claim it.
 */

/** Actions that write into the user-facing session. */
export const REALTIME_INJECTION_ACTIONS: readonly string[] = ["appendSpeech", "deliverWorkerResponse"];

const INJECTION_ACTION_SET: ReadonlySet<string> = new Set(REALTIME_INJECTION_ACTIONS);

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
): RealtimeInjectionVerdict {
  if (typeof action !== "string" || !INJECTION_ACTION_SET.has(action)) return { allowed: true };

  /* FAILS CLOSED. Presenting nothing is not evidence of being the operator — it is
     the cheapest thing an impostor can do, and treating it as authority was the same
     fail-open shape the MCP grant lane was corrected for. Authority is a credential
     the caller HAS: the live session id, or the manager's capability. */
  if (caller.kind === "session") {
    return liveRealtimeSessionId && caller.realtimeSessionId === liveRealtimeSessionId
      ? { allowed: true }
      : refuse(action);
  }
  if (caller.kind === "conversation") {
    return managerConversationId && caller.conversationId === managerConversationId
      ? { allowed: true }
      : refuse(action);
  }
  return refuse(action);
}

function refuse(action: string): RealtimeInjectionVerdict {
  return {
    allowed: false,
    status: 403,
    error: `${action} writes into the operator's voice session. Only the peer holding this call's realtime session id, or the designated manager, may do that. Report through bridge_report and let the gateway decide what to say.`,
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
