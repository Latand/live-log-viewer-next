import crypto from "node:crypto";
import fs from "node:fs";

import { statePath } from "@/lib/configDir";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";
import { hardenedRedact } from "@/lib/view/compactText";

import {
  MAX_OPERATOR_MESSAGE_KEY_CHARS,
  MAX_REPLY_LABEL_CHARS,
  MAX_REPLY_SUGGESTIONS,
  MAX_REPLY_TEXT_BYTES,
  MIN_REPLY_SUGGESTIONS,
  REPLY_SUGGESTION_ADMISSION_CAPACITY,
  REPLY_SUGGESTION_CONVERSATION_CAPACITY,
  REPLY_SUGGESTIONS_SCHEMA_VERSION,
  ReplySuggestionValidationError,
  type ReplySuggestion,
  type ReplySuggestionAdmissionV1,
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
  return {
    schemaVersion: REPLY_SUGGESTIONS_SCHEMA_VERSION,
    revision: 0,
    updatedAt: now.toISOString(),
    sets: [],
    admissions: [],
  };
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

function parseAdmission(value: unknown): ReplySuggestionAdmissionV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const admission = value as Record<string, unknown>;
  if (typeof admission.conversationId !== "string" || !admission.conversationId) return null;
  if (typeof admission.key !== "string" || !admission.key) return null;
  if (typeof admission.at !== "string" || !Number.isFinite(Date.parse(admission.at))) return null;
  return { conversationId: admission.conversationId, key: admission.key, at: admission.at };
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
    /* Absent in a record written before admissions existed, and absent again
       the moment one is unreadable: forgetting a message's admission costs a
       replay window, never the read. */
    admissions: Array.isArray(parsed.admissions)
      ? parsed.admissions.map(parseAdmission).filter((entry): entry is ReplySuggestionAdmissionV1 => entry !== null)
      : [],
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

interface ReplySuggestionsMutation<R> {
  sets?: ReplySuggestionSetV1[];
  admissions?: ReplySuggestionAdmissionV1[];
  result: R;
}

/** One serialized read-modify-write over the record. A mutation that names
    neither half changed nothing, and writes nothing. */
function mutate<R>(mutation: (file: ReplySuggestionsFileV1, now: Date) => ReplySuggestionsMutation<R>, now: Date): R {
  const filePath = replySuggestionsFile();
  return withFileTransactionSync(filePath, BUSY, () => {
    const current = readReplySuggestionsFile(filePath, now);
    const outcome = mutation(current, now);
    if (outcome.sets || outcome.admissions) {
      writeJsonDurably(filePath, {
        schemaVersion: REPLY_SUGGESTIONS_SCHEMA_VERSION,
        revision: current.revision + 1,
        updatedAt: now.toISOString(),
        sets: (outcome.sets ?? current.sets).slice(-REPLY_SUGGESTION_CONVERSATION_CAPACITY),
        admissions: (outcome.admissions ?? current.admissions).slice(-REPLY_SUGGESTION_ADMISSION_CAPACITY),
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
  /* A retirement whose durable write failed is retried before the new set is
     filed, so the answered one leaves ahead of it instead of lingering behind
     a newer offer. */
  flushPendingRetirement(conversationId);
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

/**
 * The conversation's current set, or null when it has none.
 *
 * This is the whole read side — the surfaces reach it through
 * `/api/log/suggestions` — so it is also where a retirement that could not be
 * written is retried and, until it lands, honoured: a set the operator has
 * already answered never reaches a pill, whether or not the write that should
 * have retired it succeeded.
 */
export function readReplySuggestions(conversationId: string, filePath = replySuggestionsFile()): ReplySuggestionSetV1 | null {
  const held = flushPendingRetirement(conversationId);
  const set = readReplySuggestionsFile(filePath).sets.find((entry) => entry.conversationId === conversationId) ?? null;
  if (!set || !held) return set;
  const offeredAt = Date.parse(set.at);
  return Number.isFinite(offeredAt) && offeredAt > held.at ? set : null;
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
 * A retirement this process owes the record: the operator's message was
 * admitted, the durable clear that should have followed it could not be
 * written, and the set it answers is still on disk.
 *
 * Held in memory ON PURPOSE — the thing that failed IS the write, so a
 * tombstone on the same file would fail with it. Every read of the
 * conversation retries the clear and, until one lands, hides the answered set,
 * so a busy lock or a full disk costs the record a moment of lag rather than
 * costing the operator a row of drafts under a question they have answered.
 * The viewer serves the read seam and both send paths in one process, so the
 * surface that would show the stale set is the surface that suppresses it.
 */
interface PendingRetirement {
  /** The moment the answering message was admitted. */
  at: number;
  /** That message's own key, so its replays reuse this moment rather than
      minting a later one while the durable admission is still unwritten. */
  key: string;
}

const pendingRetirements = new Map<string, PendingRetirement>();

/**
 * Retry the retirement this conversation is owed, if any. Answers what is
 * STILL owed afterwards: null once the record has caught up.
 */
function flushPendingRetirement(conversationId: string): PendingRetirement | null {
  const held = pendingRetirements.get(conversationId);
  if (!held) return null;
  try {
    clearReplySuggestions(conversationId, { offeredAtOrBefore: new Date(held.at) });
    pendingRetirements.delete(conversationId);
    return null;
  } catch {
    /* Still owed. The caller hides the answered set meanwhile. */
    return held;
  }
}

export interface ReplySuggestionRetirement {
  /** A set was retired durably by this message. */
  cleared: boolean;
  /** The durable write failed. The retirement is held in this process, hides
      the answered set from every read, and is retried on the next one. */
  pending: boolean;
}

/**
 * The operator answered in this conversation, so its drafts are over (#1202).
 *
 * Called from the send paths themselves rather than from a rendered pane: the
 * record is retired by the message that answers it, whether or not a feed
 * happened to be mounted to notice — and it is retired only for the set that
 * was standing when that message was ADMITTED, so a fresh offer racing the
 * send survives it.
 *
 * `messageKey` is the send path's idempotency key. A client re-delivering the
 * same message under it is not a second answer: the first admission is what
 * that message answers, and it is remembered (durably, and in this process
 * while the record cannot be written) so every replay clears against the same
 * moment instead of its own — otherwise a retry that arrives a minute late
 * takes down whatever the manager offered in between.
 *
 * Never throws: a message the operator sent must land even when the drafts
 * record cannot be written.
 */
export function retireReplySuggestionsOnOperatorMessage(
  conversationId: string,
  at: Date,
  messageKey = "",
): ReplySuggestionRetirement {
  if (!conversationId) return { cleared: false, pending: false };
  const key = messageKey.trim().slice(0, MAX_OPERATOR_MESSAGE_KEY_CHARS);
  const held = flushPendingRetirement(conversationId);
  /* This message's admission, as far as anything still knows it: the pending
     retirement covers exactly the window in which the durable admission could
     not be written. */
  const admittedAt = held && key && held.key === key ? new Date(held.at) : at;
  try {
    const cleared = mutate((file) => {
      const admission = key
        ? file.admissions.find((entry) => entry.conversationId === conversationId && entry.key === key) ?? null
        : null;
      const recordedAt = admission ? Date.parse(admission.at) : Number.NaN;
      const cutoff = Number.isFinite(recordedAt) ? recordedAt : admittedAt.getTime();
      const current = file.sets.find((set) => set.conversationId === conversationId) ?? null;
      const offeredAt = current ? Date.parse(current.at) : Number.NaN;
      const retire = current !== null && Number.isFinite(offeredAt) && offeredAt <= cutoff;
      return {
        ...(retire ? { sets: file.sets.filter((set) => set.conversationId !== conversationId) } : {}),
        /* Remembered for every conversation the operator speaks in, not only
           the ones holding drafts: the replay that must not clear a newer set
           is just as likely to follow a message that had none to clear. */
        ...(key && !admission
          ? { admissions: [...file.admissions, { conversationId, key, at: new Date(cutoff).toISOString() }] }
          : {}),
        result: retire,
      };
      /* The record's own write clock, not the message's: a replay clears
         against a moment minutes old, and `updatedAt` must still say when the
         file was last written. */
    }, new Date());
    return { cleared, pending: false };
  } catch {
    pendingRetirements.set(conversationId, {
      at: Math.max(admittedAt.getTime(), held?.at ?? Number.NEGATIVE_INFINITY),
      key,
    });
    /* Bounded like the record itself: a state dir that stays unwritable must
       cost a fixed amount of memory, and the conversation nobody has read in
       longest is the one whose retirement is least likely to still matter. */
    for (const conversation of pendingRetirements.keys()) {
      if (pendingRetirements.size <= REPLY_SUGGESTION_CONVERSATION_CAPACITY) break;
      pendingRetirements.delete(conversation);
    }
    return { cleared: false, pending: true };
  }
}
