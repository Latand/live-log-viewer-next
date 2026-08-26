/**
 * Reply drafts the manager offers the operator under its own message (#1202).
 *
 * The operator answers the orchestrator in prose, and a turn that asks
 * something ("shall I merge, or hold for the second review?") costs them a
 * typed sentence before anything can move. `suggest_replies` lets the turn
 * hand them the sentences it expects: short drafts that land in the composer
 * on a tap, editable, never sent by the viewer itself.
 *
 * These are DRAFTS, not decisions. Nothing in the viewer acts on a set, the
 * operator's own send is still the only thing that speaks, and a set that is
 * lost costs a tap — which is why the store below reads a damaged record as
 * "no suggestions" rather than as an error.
 */

export const REPLY_SUGGESTIONS_SCHEMA_VERSION = 1;

/** A set is 1–6 drafts: fewer than one says nothing, and a row past six stops
    being a glance and starts being a menu. */
export const MIN_REPLY_SUGGESTIONS = 1;
export const MAX_REPLY_SUGGESTIONS = 6;

/** The pill carries the label; anything longer wraps into an unreadable row,
    so it is refused rather than truncated into a half-sentence. */
export const MAX_REPLY_LABEL_CHARS = 64;

/** The draft itself is a message the operator may send, bounded like a bridge
    report body for the same reason: it is prose, not a payload. */
export const MAX_REPLY_TEXT_BYTES = 2_000;

/** Conversations retained. A set is worthless the moment the operator answers,
    so the record only ever holds the recent, still-unanswered ones. */
export const REPLY_SUGGESTION_CONVERSATION_CAPACITY = 64;

export interface ReplySuggestion {
  /** What the pill says — a few words the operator reads at a glance. */
  label: string;
  /** What lands in the composer when the pill is tapped. */
  text: string;
}

/** Server-derived attribution of the caller that offered the set. Never
    accepted from a tool caller — the same rule the bridge log's origin keeps. */
export interface ReplySuggestionOrigin {
  kind: "manager" | "gateway" | "agent" | "unidentified";
  conversationId: string | null;
  role: string | null;
}

export interface ReplySuggestionSetV1 {
  /** Durable conversation id whose composer these drafts belong under. */
  conversationId: string;
  setId: string;
  /** When the set was offered. The feed hides (and clears) a set the operator
      has already answered, so this timestamp is what "already answered" means. */
  at: string;
  origin: ReplySuggestionOrigin;
  replies: ReplySuggestion[];
}

export interface ReplySuggestionsFileV1 {
  schemaVersion: number;
  revision: number;
  updatedAt: string;
  sets: ReplySuggestionSetV1[];
}

/** A set the store refused. `code` names the violated rule so the MCP failure
    envelope can carry it verbatim to the caller that has to fix its call. */
export class ReplySuggestionValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ReplySuggestionValidationError";
  }
}
