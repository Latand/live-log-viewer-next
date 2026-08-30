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

export interface SelectedContextTargetDependencies {
  /** Bounded identity + tail resolver. Injected so a test can hand in a lookup
      whose scan-shaped methods throw and still see an answer come back. */
  selectedConversation(): SelectedConversationResolver;
  /** Scanner-root membership gate for the tail read. */
  pathAllowed(candidate: string): boolean;
}

export const productionSelectedContextDependencies: SelectedContextTargetDependencies = {
  selectedConversation: () => selectedConversationResolver(),
  pathAllowed,
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
}

/**
 * Resolve the reference into a canonical identity, reconciled with whatever the
 * caller named explicitly.
 */
export function resolveSelectedContext(
  args: McpToolArgs,
  explicitConversationId: string,
  dependencies: SelectedContextTargetDependencies,
): SelectedContextResolution {
  const ref = selectedContextArg(args.selectedContext);
  if (!ref) return { target: null, conversationId: explicitConversationId };
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

/** Resolve and root-gate one registry identity without reading its transcript. */
export function selectedConversationTarget(
  request: SelectedConversationTargetRequest,
  dependencies: SelectedContextTargetDependencies,
): SelectedConversationRecord {
  const record = dependencies.selectedConversation().resolve(request.conversationId);
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
  const record = selectedConversationTarget(request, dependencies);
  const tail = resolver.readTail(record.conversationId, { maxLines: request.maxLines });
  if (!tail) {
    throw new McpToolRefusal(
      "that conversation's transcript could not be read.",
      { code: "selected_conversation_unreadable", conversationId: record.conversationId },
    );
  }
  return { record, tail };
}
