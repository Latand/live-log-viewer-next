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
 * Identity comes from the spawn capability the registry issued per conversation —
 * the same evidence `authenticatedAgentSpawnCaller` trusts for spawns — matched
 * against the manager's designation record. A role string would not do: it is
 * stamped on a launch profile and anything launched with it could claim it.
 */

/** Actions that write into the user-facing session. */
export const REALTIME_INJECTION_ACTIONS: readonly string[] = ["appendSpeech", "deliverWorkerResponse"];

const INJECTION_ACTION_SET: ReadonlySet<string> = new Set(REALTIME_INJECTION_ACTIONS);

export type RealtimeCaller =
  /** The operator's own browser: it presented no agent capability at all. */
  | { kind: "operator" }
  /** An agent the registry can name from the capability it presented. */
  | { kind: "conversation"; conversationId: string };

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
): RealtimeInjectionVerdict {
  if (typeof action !== "string" || !INJECTION_ACTION_SET.has(action)) return { allowed: true };
  if (caller.kind === "operator") return { allowed: true };
  if (managerConversationId && caller.conversationId === managerConversationId) return { allowed: true };
  return {
    allowed: false,
    status: 403,
    error: `${action} writes into the operator's voice session, which only the designated manager may do. Report through bridge_report and let the gateway decide what to say.`,
  };
}

/**
 * Resolve the caller from evidence it cannot restate.
 *
 * A capability that the registry maps to a conversation names that conversation. A
 * capability it cannot map is NOT promoted to the operator — a wrong or stale token
 * is exactly what an impostor presents — so it resolves to a conversation id that
 * matches nothing and is refused. Only the absence of any capability reads as the
 * operator's own browser, which is the same discrimination `spawn/admission.ts`
 * already makes.
 */
export function realtimeCallerFromRequest(request: Pick<NextRequest, "headers">): RealtimeCaller {
  const capability = request.headers.get(VIEWER_SPAWN_CAPABILITY_HEADER)?.trim() ?? "";
  if (!capability) return { kind: "operator" };
  const digest = /^[A-Za-z0-9_-]{43}$/.test(capability)
    ? crypto.createHash("sha256").update(capability).digest("hex")
    : "";
  const conversationId = digest
    ? agentRegistry().conversationIdForSpawnCapabilityDigest(digest)
    : null;
  return { kind: "conversation", conversationId: conversationId ?? "" };
}

/** The manager's conversation, or null when none is designated. */
export function designatedManagerConversationId(): string | null {
  return readOrchestratorRecord()?.conversationId ?? null;
}
