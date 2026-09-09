import { agentRegistry } from "@/lib/agent/registry";
import { conversationRole, type RootConversationSlice } from "@/lib/root/adopt";

import type { VoicePersonaVariant } from "./voicePersona";

/**
 * Whether a starting call is a new voice coordinator or an existing agent that
 * has just been given a microphone (#1600).
 *
 * Voice is a MODALITY. Enabling it changes how a conversation hears and answers
 * and nothing else — the role, the system authority, the seat, the pending work
 * and the ability to run other agents all survive the call untouched. That was
 * not true before this resolver existed: every call start injected the
 * coordinator mandate into whatever thread it was opened on, so the operator's
 * own orchestrator read that it was now a relay with no board tools, relayed its
 * work to "the manager" — itself, since `bridge_directive` resolves the
 * recipient from the designation record — and declined the work it was holding.
 *
 * Only ONE kind of session gets the coordinator role, and it is the kind that
 * was deliberately created to be it: the root session. That is a durable
 * launch-time fact, not a capability and not a guess — `LLV_ROOT_CONVERSATION_ID`
 * names it, or the launch profile carries the `root` role. Both are exactly what
 * {@link liveRootSession} and the bridge inbox already key on, so this adds no
 * second scheme for "which conversation is the voice front".
 *
 * FAILS SAFE TOWARD THE EXISTING ROLE. Every uncertainty — a conversation the
 * registry cannot name, a registry that cannot be read, a call that never asked
 * — resolves to `modality`. The asymmetry is the whole design: guessing
 * `modality` for a coordinator costs it a role it can be given explicitly,
 * while guessing `coordinator` for anyone else overwrites a live one.
 */

/** The launch-time facts the decision is made from. Structural, so a registry
    conversation satisfies it as-is and the decision stays a pure function. */
export interface VoicePersonaMandateSource {
  /** The conversation the call is starting on, or null when it cannot be named. */
  conversation: RootConversationSlice | null;
  /** `LLV_ROOT_CONVERSATION_ID`, the same env every other root resolution reads. */
  configuredRootId: string | null;
}

/**
 * Pure: which persona this conversation is entitled to.
 *
 * Deliberately NOT `liveRootSession`, which answers a different question —
 * "which of all conversations is the newest root" — by materialising and sorting
 * the whole registry. This asks only about the one conversation in front of it,
 * which is O(1) and cannot drift onto a different session between the check and
 * the call.
 */
export function voicePersonaVariantFor(
  conversationId: string,
  source: VoicePersonaMandateSource,
): VoicePersonaVariant {
  const id = conversationId.trim();
  if (!id) return "modality";
  if (source.configuredRootId?.trim() === id) return "coordinator";
  const conversation = source.conversation;
  if (!conversation || conversation.id !== id) return "modality";
  return conversationRole(conversation) === "root" ? "coordinator" : "modality";
}

/**
 * Registry-backed resolution for a live call.
 *
 * Every failure path here is a `modality` answer rather than a throw: a call
 * whose persona cannot be resolved must still connect, and connecting with the
 * variant that changes nothing is the safe half of that.
 */
export function voicePersonaVariantForConversation(conversationId: unknown): VoicePersonaVariant {
  if (typeof conversationId !== "string" || !conversationId.startsWith("conversation_")) return "modality";
  try {
    const conversation = agentRegistry().conversation(conversationId as `conversation_${string}`);
    return voicePersonaVariantFor(conversationId, {
      conversation: conversation
        ? { id: conversation.id, updatedAt: conversation.updatedAt, generations: conversation.generations }
        : null,
      configuredRootId: process.env.LLV_ROOT_CONVERSATION_ID?.trim() || null,
    });
  } catch {
    /* An unreadable registry is not evidence that this conversation is the voice
       front, and treating it as such is what overwrites a role. */
    return "modality";
  }
}
