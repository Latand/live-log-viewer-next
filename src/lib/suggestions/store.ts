import crypto from "node:crypto";
import fs from "node:fs";

import { statePath } from "@/lib/configDir";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";
import { hardenedRedact } from "@/lib/view/compactText";

import {
  MAX_REPLY_LABEL_CHARS,
  MAX_REPLY_SUGGESTIONS,
  MAX_REPLY_TEXT_BYTES,
  MIN_REPLY_SUGGESTIONS,
  REPLY_SUGGESTION_CONVERSATION_CAPACITY,
  REPLY_SUGGESTIONS_SCHEMA_VERSION,
  ReplySuggestionValidationError,
  type ReplySuggestion,
  type ReplySuggestionOrigin,
  type ReplySuggestionSetV1,
  type ReplySuggestionsFileV1,
} from "./types";

/**
 * The durable home of reply-draft sets (#1202) — one per conversation.
 *
 * Written the way every other viewer-side record is: revisioned, atomic
 * temp-and-rename, serialized by the shared file transaction, so a set
 * survives a page reload, a viewer restart and two callers racing.
 *
 * Two deliberate differences from the attention record it is modelled on:
 *
 *  - REPLACEMENT, not history. A conversation holds exactly one set — the
 *    newest — because a stale draft under a newer question is worse than no
 *    draft at all.
 *  - A damaged file reads as "no suggestions" instead of raising. These are
 *    disposable drafts; a corrupt record must cost a tap, never the composer
 *    the operator is trying to answer in.
 */

const BUSY = "reply suggestions are busy";

export function replySuggestionsFile(): string {
  return statePath("reply-suggestions.json");
}

function emptyFile(now: Date): ReplySuggestionsFileV1 {
  return { schemaVersion: REPLY_SUGGESTIONS_SCHEMA_VERSION, revision: 0, updatedAt: now.toISOString(), sets: [] };
}

function parseReply(value: unknown): ReplySuggestion | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { label, text } = value as Record<string, unknown>;
  if (typeof label !== "string" || !label.trim()) return null;
  if (typeof text !== "string" || !text.trim()) return null;
  return { label, text };
}

function parseOrigin(value: unknown): ReplySuggestionOrigin {
  const origin = (value ?? {}) as Record<string, unknown>;
  const kind = origin.kind;
  return {
    kind: kind === "manager" || kind === "gateway" || kind === "agent" ? kind : "unidentified",
    conversationId: typeof origin.conversationId === "string" ? origin.conversationId : null,
    role: typeof origin.role === "string" ? origin.role : null,
  };
}

function parseSet(value: unknown): ReplySuggestionSetV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const set = value as Record<string, unknown>;
  if (typeof set.conversationId !== "string" || !set.conversationId) return null;
  if (typeof set.setId !== "string" || !set.setId) return null;
  if (typeof set.at !== "string" || !Number.isFinite(Date.parse(set.at))) return null;
  if (!Array.isArray(set.replies)) return null;
  const replies = set.replies.map(parseReply).filter((reply): reply is ReplySuggestion => reply !== null);
  if (replies.length === 0) return null;
  return {
    conversationId: set.conversationId,
    setId: set.setId,
    at: set.at,
    origin: parseOrigin(set.origin),
    replies: replies.slice(0, MAX_REPLY_SUGGESTIONS),
  };
}

/** The persisted file, oldest set first. Anything unreadable — a missing file,
    a truncated write, an entry from a schema this build does not know — yields
    an empty record, which the next write replaces wholesale. */
export function readReplySuggestionsFile(filePath = replySuggestionsFile(), now = new Date()): ReplySuggestionsFileV1 {
  let contents: string;
  try {
    contents = fs.readFileSync(filePath, "utf8");
  } catch {
    return emptyFile(now);
  }
  let parsed: Partial<ReplySuggestionsFileV1>;
  try {
    parsed = JSON.parse(contents) as Partial<ReplySuggestionsFileV1>;
  } catch {
    return emptyFile(now);
  }
  if (parsed.schemaVersion !== REPLY_SUGGESTIONS_SCHEMA_VERSION || !Array.isArray(parsed.sets)) return emptyFile(now);
  return {
    schemaVersion: REPLY_SUGGESTIONS_SCHEMA_VERSION,
    revision: Number.isInteger(parsed.revision) ? parsed.revision! : 0,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : now.toISOString(),
    sets: parsed.sets.map(parseSet).filter((set): set is ReplySuggestionSetV1 => set !== null),
  };
}

/**
 * Bodies the operator will read and may send, so they are trimmed and
 * secret-redacted at the door — the same treatment a bridge report body gets,
 * for the same reason: whatever the caller wrote, what lands on the record is
 * what a person can safely be shown.
 */
function normalizeReplies(value: unknown): ReplySuggestion[] {
  if (!Array.isArray(value)) {
    throw new ReplySuggestionValidationError("INVALID_REPLIES", "replies must be an array of {label, text} drafts");
  }
  if (value.length < MIN_REPLY_SUGGESTIONS || value.length > MAX_REPLY_SUGGESTIONS) {
    throw new ReplySuggestionValidationError(
      "INVALID_REPLIES",
      `replies must hold between ${MIN_REPLY_SUGGESTIONS} and ${MAX_REPLY_SUGGESTIONS} drafts`,
    );
  }
  return value.map((entry, index) => {
    const reply = parseReply(entry);
    if (!reply) {
      throw new ReplySuggestionValidationError("INVALID_REPLIES", `reply ${index + 1} needs a non-empty label and text`);
    }
    const label = hardenedRedact(reply.label).trim();
    const text = hardenedRedact(reply.text).trim();
    if (!label || !text) {
      throw new ReplySuggestionValidationError("INVALID_REPLIES", `reply ${index + 1} needs a non-empty label and text`);
    }
    if (label.length > MAX_REPLY_LABEL_CHARS) {
      throw new ReplySuggestionValidationError(
        "LABEL_TOO_LONG",
        `reply ${index + 1}'s label is longer than ${MAX_REPLY_LABEL_CHARS} characters; a pill carries a few words`,
      );
    }
    if (Buffer.byteLength(text, "utf8") > MAX_REPLY_TEXT_BYTES) {
      throw new ReplySuggestionValidationError(
        "TEXT_TOO_LONG",
        `reply ${index + 1}'s text is longer than ${MAX_REPLY_TEXT_BYTES} bytes; a draft is a message, not a document`,
      );
    }
    return { label, text };
  });
}

export interface RecordReplySuggestionsInput {
  conversationId: string;
  replies: unknown;
  /** Server-derived attribution of the caller (never a caller claim). */
  origin: ReplySuggestionOrigin;
  at?: Date;
  /** Durable operation identity, when the caller has one: the set id derives
      from it, so an interrupted call re-run under the same key rewrites the
      SAME set instead of minting a twin. */
  operationKey?: string;
}

export interface RecordedReplySuggestions {
  set: ReplySuggestionSetV1;
  /** setId of the set this one replaced, or null when there was none. */
  replaced: string | null;
}

function setIdFor(input: { operationKey?: string; conversationId: string; at: string; replies: ReplySuggestion[] }): string {
  const seed = input.operationKey ?? `${input.conversationId}\0${input.at}\0${JSON.stringify(input.replies)}`;
  return `rsg_${crypto.createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
}

/** One serialized read-modify-write over the record. */
function mutate<R>(mutation: (file: ReplySuggestionsFileV1, now: Date) => { sets?: ReplySuggestionSetV1[]; result: R }, now: Date): R {
  const filePath = replySuggestionsFile();
  return withFileTransactionSync(filePath, BUSY, () => {
    const current = readReplySuggestionsFile(filePath, now);
    const outcome = mutation(current, now);
    if (outcome.sets) {
      writeJsonDurably(filePath, {
        schemaVersion: REPLY_SUGGESTIONS_SCHEMA_VERSION,
        revision: current.revision + 1,
        updatedAt: now.toISOString(),
        sets: outcome.sets.slice(-REPLY_SUGGESTION_CONVERSATION_CAPACITY),
      } satisfies ReplySuggestionsFileV1);
    }
    return outcome.result;
  });
}

/**
 * Offer a set for one conversation. Validation runs BEFORE the transaction, so
 * a refused call leaves the previous set — and the file itself — untouched.
 */
export function recordReplySuggestions(input: RecordReplySuggestionsInput): RecordedReplySuggestions {
  const conversationId = input.conversationId.trim();
  if (!conversationId) {
    throw new ReplySuggestionValidationError("INVALID_CONVERSATION", "a set must name the conversation it belongs under");
  }
  const replies = normalizeReplies(input.replies);
  const now = input.at ?? new Date();
  const at = now.toISOString();
  const set: ReplySuggestionSetV1 = {
    conversationId,
    setId: setIdFor({ conversationId, at, replies, ...(input.operationKey ? { operationKey: input.operationKey } : {}) }),
    at,
    origin: input.origin,
    replies,
  };
  return mutate((file) => {
    const previous = file.sets.find((entry) => entry.conversationId === conversationId) ?? null;
    return {
      /* Newest last: the capacity trim above drops from the front, so the
         conversation nobody has offered anything to in longest is the one that
         falls away. */
      sets: [...file.sets.filter((entry) => entry.conversationId !== conversationId), set],
      result: { set, replaced: previous?.setId ?? null } satisfies RecordedReplySuggestions,
    };
  }, now);
}

/** The conversation's current set, or null when it has none. */
export function readReplySuggestions(conversationId: string, filePath = replySuggestionsFile()): ReplySuggestionSetV1 | null {
  return readReplySuggestionsFile(filePath).sets.find((set) => set.conversationId === conversationId) ?? null;
}

/**
 * Drop the conversation's set. Answers whether there was one to drop, so a
 * caller can stay quiet about a no-op.
 *
 * `offeredAtOrBefore` is the COMPARE half of compare-and-clear, and every
 * clear that answers a message carries it: a set offered after that moment
 * belongs to a question the message cannot have answered, so it survives.
 * Without it, an answer that arrives a beat late takes down the manager's
 * NEXT offer along with the one it was actually replying to.
 */
export interface ClearReplySuggestionsOptions {
  /** Clear only a set offered at or before this moment — the timestamp the
      answering message was accepted at, on the same clock the record's `at`
      is written on. */
  offeredAtOrBefore?: Date;
  now?: Date;
}

export function clearReplySuggestions(conversationId: string, options: ClearReplySuggestionsOptions = {}): boolean {
  const now = options.now ?? new Date();
  return mutate((file) => {
    const current = file.sets.find((set) => set.conversationId === conversationId) ?? null;
    if (!current) return { result: false };
    if (options.offeredAtOrBefore !== undefined) {
      const offeredAt = Date.parse(current.at);
      if (!Number.isFinite(offeredAt) || offeredAt > options.offeredAtOrBefore.getTime()) return { result: false };
    }
    return { sets: file.sets.filter((set) => set.conversationId !== conversationId), result: true };
  }, now);
}

/**
 * The operator answered in this conversation, so its drafts are over (#1202).
 *
 * Called from the send paths themselves rather than from a rendered pane: the
 * record is retired by the message that answers it, whether or not a feed
 * happened to be mounted to notice — and it is retired only for the set that
 * was standing when that message was accepted, so a fresh offer racing the
 * send survives it.
 *
 * Never throws: a message the operator sent must land even when the drafts
 * record cannot be written.
 */
export function retireReplySuggestionsOnOperatorMessage(conversationId: string, at: Date): boolean {
  if (!conversationId) return false;
  try {
    return clearReplySuggestions(conversationId, { offeredAtOrBefore: at });
  } catch {
    return false;
  }
}
