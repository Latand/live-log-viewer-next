import {
  selectedConversationResolver,
  type BoundedTranscriptTail,
  type SelectedConversationRecord,
  type SelectedConversationResolver,
} from "@/lib/selection/resolve";
import {
  decodeSelectedContextRef,
  parseSelectedContextRef,
  type SelectedContextRef,
  type SelectedContextSelected,
} from "@/lib/selection/selectedContext";
import { pathAllowed } from "@/lib/scanner/roots";

import { McpToolRefusal, type McpToolArgs, type McpToolPayload } from "./server";

/**
 * The agent-facing half of #844 (§6/§7): accept the selected-card reference an
 * operator turn carried, and answer from it WITHOUT an `operator_snapshot`.
 *
 * The reference reaches the agent as one attribute on the structured-user
 * marker (`ctx=<token>`), so the token an agent can literally copy off its own
 * turn is the token these tools take. A decoded object is accepted too, for a
 * caller that parsed the marker itself.
 *
 * Every answer here is bounded by construction:
 *
 * - IDENTITY is one keyed registry lookup through {@link SelectedConversationResolver},
 *   never a scan. That is the whole point of persisting a `conversationId` on
 *   the turn: the operator says "look at that one" while the corpus scan is
 *   degraded, and the agent still resolves the card for free.
 * - CONTENT is an explicit bounded tail, requested by line count, clamped by
 *   the resolver's own ceilings, and gated on the transcript still living under
 *   a registered scanner root. A caller cannot widen either bound.
 *
 * Refusals are typed and distinct, because the three ways a reference fails
 * mean different things to the agent holding it: an EXPLICIT empty selection
 * ("I asked with nothing selected") is an operator fact to relay, a stale
 * identity is a card that has since left the registry, and a reference that
 * disagrees with an explicitly passed conversation id is a caller bug that must
 * never be silently resolved in either direction.
 */

/**
 * The state of the caller's own live voice call, as its ledger reports it
 * (#1629). Mirrors `VoiceUtteranceContext` structurally so nothing here has to
 * import the runtime, and so a lookup that cannot reach the Viewer at all is a
 * distinguishable answer rather than a silent "no card".
 */
export type VoiceUtteranceLookup =
  | { state: "no-call" }
  | { state: "no-reference" }
  | { state: "awaiting-handoff" }
  | { state: "unavailable"; reason: string }
  | { state: "joined"; reference: SelectedContextRef; handoff: Record<string, string | null> };

export interface SelectedContextTargetDependencies {
  /** Bounded identity + tail resolver. Injected so a test can hand in a lookup
      whose scan-shaped methods throw and still see an answer come back. */
  selectedConversation(): SelectedConversationResolver;
  /** Scanner-root membership gate for the tail read. */
  pathAllowed(candidate: string): boolean;
  /**
   * What the caller's own live voice call points at, when it has one.
   *
   * Optional, and absent means "no call" — the truthful answer for every caller
   * that is not on one, and the only safe reading for a dependency set assembled
   * before this existed. A missing lookup must never be able to fail a tool that
   * named its target perfectly well.
   *
   * The production implementation is wired where the Viewer control hop already
   * lives, because the ledger describes a live transport held by the Viewer
   * process and this one runs beside the agent.
   */
  voiceUtteranceContext?(): Promise<VoiceUtteranceLookup>;
}

export const productionSelectedContextDependencies: SelectedContextTargetDependencies = {
  selectedConversation: () => selectedConversationResolver(),
  pathAllowed,
  voiceUtteranceContext: async () => ({ state: "no-call" }),
};

export interface SelectedContextTarget {
  /** Always the `selected` variant: an explicit empty selection never becomes a
      target, it refuses. */
  ref: SelectedContextSelected;
  record: SelectedConversationRecord;
}

/**
 * Read the `selectedContext` argument in either accepted form.
 *
 * A string is the wire token, with the marker's `ctx=` prefix tolerated so the
 * copied attribute works verbatim. Returns null when the argument is absent;
 * refuses when it is present and unreadable — a caller that meant to name a
 * card must never be answered as though it named none.
 */
export function selectedContextArg(value: unknown): SelectedContextRef | null {
  if (value === undefined || value === null) return null;
  const ref = typeof value === "string"
    ? decodeSelectedContextRef(value.trim().replace(/^ctx=/, ""))
    : parseSelectedContextRef(value);
  if (!ref) {
    throw new McpToolRefusal(
      "selectedContext is not a readable selected-card reference. Pass the `ctx=` token from the structured-user marker on the operator turn, or the decoded object.",
      { code: "selected_context_invalid" },
    );
  }
  return ref;
}

export interface SelectedContextResolution {
  /** Present only when the caller passed a reference that names a card. */
  target: SelectedContextTarget | null;
  /** The identity the tool should act on: explicit argument, else the resolved
      reference, else empty (the caller named the conversation another way). */
  conversationId: string;
  /** Set when the identity came from the caller's own live voice call rather
      than from an argument, so the answer can say where it got the card. */
  voice?: { handoff: Record<string, string | null> };
}

export interface ResolveSelectedContextOptions {
  /**
   * Consult the caller's own live voice call when it named nothing (#1629).
   *
   * Opt-in per call site, because a spoken turn carries no `ctx=` marker for the
   * agent to pass on: the operator's audio goes straight to the model, so the
   * only place their card is recorded is the voice ledger. A tool that reached
   * its target another way — a transcript path, an explicit id — must be left
   * alone, which is what the flag being false says.
   */
  voiceUtterance?: boolean;
}

/**
 * Resolve the reference into a canonical identity, reconciled with whatever the
 * caller named explicitly.
 */
export async function resolveSelectedContext(
  args: McpToolArgs,
  explicitConversationId: string,
  dependencies: SelectedContextTargetDependencies,
  options: ResolveSelectedContextOptions = {},
): Promise<SelectedContextResolution> {
  const ref = selectedContextArg(args.selectedContext);
  if (!ref) {
    return explicitConversationId || !options.voiceUtterance
      ? { target: null, conversationId: explicitConversationId }
      : resolveSpokenSelectedContext(dependencies);
  }
  if (ref.state === "none") {
    throw new McpToolRefusal(
      "the operator submitted that turn with NO card selected, so the reference names no conversation. Ask which conversation they meant, or pass conversationId explicitly.",
      { code: "selected_context_empty", capturedAt: ref.capturedAt },
    );
  }
  const record = dependencies.selectedConversation().resolve(ref.conversationId);
  if (!record) {
    throw new McpToolRefusal(
      "the selected card's conversation is not in the Viewer registry — the reference is stale or names a conversation this Viewer never owned.",
      { code: "selected_context_unresolved", conversationId: ref.conversationId, capturedAt: ref.capturedAt },
    );
  }
  if (explicitConversationId && explicitConversationId !== record.conversationId) {
    throw new McpToolRefusal(
      "conversationId and selectedContext name different conversations. Pass one of them, not both.",
      {
        code: "selected_context_conflict",
        conversationId: explicitConversationId,
        selectedConversationId: record.conversationId,
      },
    );
  }
  return { target: { ref, record }, conversationId: record.conversationId };
}

/**
 * The card the operator was looking at when they spoke, or a refusal that says
 * why there is none (#1629).
 *
 * NOTHING HERE EVER REACHES FOR AN EARLIER CARD. The ledger publishes a
 * reference only while it is joined to the handoff that produced the work in
 * hand; the moment the operator speaks again the join is gone and this refuses,
 * so an agent asking a second question about a screen the operator has moved on
 * from is told to ask rather than answered about the wrong card. Each refusal
 * names its own condition, because "they have not selected anything", "they have
 * spoken since" and "there is no call" are three different next moves.
 */
async function resolveSpokenSelectedContext(
  dependencies: SelectedContextTargetDependencies,
): Promise<SelectedContextResolution> {
  const lookup = await (dependencies.voiceUtteranceContext?.() ?? Promise.resolve({ state: "no-call" as const }));
  if (lookup.state === "no-call") return { target: null, conversationId: "" };
  if (lookup.state === "unavailable") {
    throw new McpToolRefusal(
      `the operator's voice call could not be read, so the card they were looking at is unknown: ${lookup.reason}. Ask which conversation they meant, or pass conversationId explicitly.`,
      { code: "voice_selected_context_unavailable" },
    );
  }
  if (lookup.state === "no-reference") {
    throw new McpToolRefusal(
      "the operator is on a voice call that has reported no selected card, so this turn names no conversation. Ask which one they meant, or pass conversationId explicitly.",
      { code: "voice_selected_context_absent" },
    );
  }
  if (lookup.state === "awaiting-handoff") {
    throw new McpToolRefusal(
      "the operator has spoken again since the card that started this work, so no selected card belongs to the turn in hand. Ask which conversation they mean rather than acting on the previous one.",
      { code: "voice_selected_context_superseded" },
    );
  }
  if (lookup.reference.state === "none") {
    throw new McpToolRefusal(
      "the operator spoke that turn with NO card selected, so the reference names no conversation. Ask which conversation they meant, or pass conversationId explicitly.",
      { code: "selected_context_empty", capturedAt: lookup.reference.capturedAt },
    );
  }
  const record = dependencies.selectedConversation().resolve(lookup.reference.conversationId);
  if (!record) {
    throw new McpToolRefusal(
      "the card the operator was looking at is not in the Viewer registry — the reference is stale or names a conversation this Viewer never owned.",
      {
        code: "selected_context_unresolved",
        conversationId: lookup.reference.conversationId,
        capturedAt: lookup.reference.capturedAt,
      },
    );
  }
  return {
    target: { ref: lookup.reference, record },
    conversationId: record.conversationId,
    voice: { handoff: lookup.handoff },
  };
}

/** What the tool echoes back, so the caller can see which card it acted on.
    Identity and evidence only — never transcript content. */
export function selectedContextEcho(target: SelectedContextTarget | null): McpToolPayload {
  if (!target) return {};
  return {
    selectedContext: {
      state: "selected",
      conversationId: target.record.conversationId,
      project: target.record.project,
      capturedAt: target.ref.capturedAt,
      ...(target.ref.label ? { label: target.ref.label } : {}),
      ...(target.ref.viewSessionId ? { viewSessionId: target.ref.viewSessionId } : {}),
      ...(target.ref.deviceId ? { deviceId: target.ref.deviceId } : {}),
    },
  };
}

export interface SelectedTailRequest {
  conversationId: string;
  maxLines: number;
}

export interface SelectedTailAnswer {
  record: SelectedConversationRecord;
  tail: BoundedTranscriptTail;
}

export interface SelectedConversationTargetRequest {
  conversationId: string;
}

function selectedConversationTargetFromResolver(
  request: SelectedConversationTargetRequest,
  dependencies: SelectedContextTargetDependencies,
  resolver: SelectedConversationResolver,
): SelectedConversationRecord {
  const record = resolver.resolve(request.conversationId);
  if (!record) {
    throw new McpToolRefusal(
      "no Viewer conversation has that id.",
      { code: "selected_context_unresolved", conversationId: request.conversationId },
    );
  }
  if (!record.path) {
    throw new McpToolRefusal(
      "that conversation has no transcript generation to read.",
      { code: "selected_conversation_has_no_transcript", conversationId: record.conversationId },
    );
  }
  if (!dependencies.pathAllowed(record.path)) {
    throw new McpToolRefusal(
      "that conversation's transcript is outside the Viewer's scanner roots.",
      { code: "selected_conversation_outside_roots", conversationId: record.conversationId },
    );
  }
  return record;
}

/** Resolve and root-gate one registry identity without reading its transcript. */
export function selectedConversationTarget(
  request: SelectedConversationTargetRequest,
  dependencies: SelectedContextTargetDependencies,
): SelectedConversationRecord {
  return selectedConversationTargetFromResolver(request, dependencies, dependencies.selectedConversation());
}

/**
 * The bounded read: keyed identity, then a tail of the named transcript.
 *
 * Touches no scan of any kind — not the completed generation, not a pinned
 * walk, not `observeFiles()` — so it keeps answering while the corpus scan is
 * hung or failing, which is the degraded case #844 §6 is about.
 */
export function selectedConversationTail(
  request: SelectedTailRequest,
  dependencies: SelectedContextTargetDependencies,
): SelectedTailAnswer {
  const resolver = dependencies.selectedConversation();
  const record = selectedConversationTargetFromResolver(request, dependencies, resolver);
  const tail = resolver.readTail(record.conversationId, { maxLines: request.maxLines });
  if (!tail) {
    throw new McpToolRefusal(
      "that conversation's transcript could not be read.",
      { code: "selected_conversation_unreadable", conversationId: record.conversationId },
    );
  }
  return { record, tail };
}
