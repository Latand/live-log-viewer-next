"use client";

/**
 * The conversation outbox (issues #561 / #569): the durable, queue-first record
 * of what the operator submitted into ONE conversation window.
 *
 * Sending is queue-first. A submitted draft is not a request the composer waits
 * on — it is an entry in this queue. The entry exists before any network call,
 * so the message renders immediately as an optimistic user bubble in the feed,
 * the composer clears and stays typable, and the operator can inspect the queue
 * and cancel anything that has not left for the wire yet.
 *
 * The queue is serial: exactly one entry is `delivering` at a time, so the
 * existing idempotent delivery/receipt machinery in `TmuxComposer` keeps its
 * one-attempt-at-a-time contract and never double-sends.
 *
 * Pure module state + sessionStorage, keyed on the stable conversation identity
 * (never the transcript path), so a launch placeholder, its materialized
 * transcript, and an account-migration successor all share ONE queue.
 */

import { useSyncExternalStore } from "react";

import type { ReceiptStatus } from "@/components/runtime/runtimeModel";

export type OutboxState = "queued" | "delivering" | "delivered" | "failed";

export interface OutboxEntry {
  /** Idempotency key of this submission — also the bubble's stable identity. */
  id: string;
  text: string;
  /** How many attachments rode with this submission (previews stay local). */
  images: number;
  /** Submission moment (ms). Ordering and history navigation read this. */
  at: number;
  state: OutboxState;
  /** Moment the entry left `queued`/`delivering` (ms), for the hard-cap TTL. */
  settledAt?: number;
  error?: string;
  /** The attachment bytes of this submission did not survive a page refresh
      (previews are memory-only). The entry is held back rather than delivered
      text-only, and says so, so no image is ever silently dropped. */
  needsReattach?: true;
  /** The initial launch prompt (issue #561/#569): the SPAWN delivers it, not the
      composer. It renders as the conversation's first optimistic user bubble but
      is never dispatched by the composer's queue and never blocks the serial
      drain of the operator's follow-up messages. It retires on its transcript
      echo like any other bubble. */
  launchOwned?: true;
  /** Submission watermark (round-2 finding 2): how many transcript echoes of THIS
      exact text already existed when the entry was submitted. Retirement consumes
      only echoes BEYOND this baseline, so a pre-existing identical user message
      never retires a freshly queued bubble — its own echo, which lands later,
      does. Absent (legacy/reloaded entries) ⇒ baseline 0, preserving the prior
      "retire once the text is present" reload behaviour. */
  echoBaseline?: number;
}

/**
 * Map a durable receipt status to the outbox bubble state it PROVES (round-1
 * P1#4). `queued`/`delivering` are admitted-but-not-delivered — the server holds
 * the message but it has not reached the agent — so the bubble stays
 * `delivering`, never prematurely `delivered`. Only a status that proves the
 * message is in the turn/transcript settles the bubble to `delivered`;
 * `rejected`/`failed` settle it to `failed`.
 */
export function outboxStateForReceiptStatus(status: ReceiptStatus): OutboxState {
  switch (status) {
    case "queued":
    case "delivering":
    case "applying":
    case "pending":
    case "uncertain":
      // Admitted-but-not-delivered, or genuinely unknown: still in flight.
      return "delivering";
    case "rejected":
    case "failed":
      return "failed";
    default:
      // delivered, applied, answered, steered, turn-started, interrupted
      return "delivered";
  }
}

/** Bounded per conversation: the queue is working state plus recent history for
    ArrowUp/ArrowDown, never an archive (the transcript is the archive). */
export const OUTBOX_LIMIT = 32;
/** A delivered entry stops rendering once the transcript grew past it — the
    real bubble has landed. Mirrors DELIVERY_ECHO_MTIME_GRACE_MS. */
export const OUTBOX_MTIME_GRACE_MS = 2_000;
/** Hard cap so a conversation whose transcript never grows again cannot keep
    optimistic bubbles on screen forever. */
export const OUTBOX_DELIVERED_TTL_MS = 10 * 60_000;

const storageKey = (cardId: string) => "llvOutbox:" + cardId;

const queues = new Map<string, readonly OutboxEntry[]>();
const listeners = new Set<() => void>();
const EMPTY: readonly OutboxEntry[] = [];

function isEntry(value: unknown): value is OutboxEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.id === "string" && typeof raw.text === "string" && typeof raw.at === "number";
}

function persistedQueue(cardId: string): readonly OutboxEntry[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(storageKey(cardId)) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return EMPTY;
    return raw.filter(isEntry).slice(-OUTBOX_LIMIT).map((entry) => {
      const images = typeof entry.images === "number" ? entry.images : 0;
      /* The initial launch prompt is owned by the spawn, not the composer: it
         survives a refresh exactly as it was (never re-dispatched, never
         re-queued) and retires on its transcript echo. */
      if (entry.launchOwned) return { ...entry, images };
      const unsettled = entry.state === "delivering" || entry.state === "queued";
      /* A `delivering` entry recorded before a refresh has no owner in this
         mount: it returns to the queue so the serial dispatcher replays it
         under its original idempotency key rather than stranding it. An entry
         that carried images cannot be replayed — the bytes were memory-only —
         so it is held for the operator instead of quietly losing them. */
      if (unsettled && images > 0) {
        return { ...entry, images, state: "failed" as const, needsReattach: true as const };
      }
      return { ...entry, images, state: unsettled ? ("queued" as const) : entry.state };
    });
  } catch {
    return EMPTY;
  }
}

function persist(cardId: string, queue: readonly OutboxEntry[]): void {
  try {
    if (queue.length) sessionStorage.setItem(storageKey(cardId), JSON.stringify(queue));
    else sessionStorage.removeItem(storageKey(cardId));
  } catch {
    /* quota / opaque origin: the in-memory queue still carries the turn */
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function write(cardId: string, queue: readonly OutboxEntry[]): void {
  queues.set(cardId, queue);
  persist(cardId, queue);
  emit();
}

/** The queue for a conversation, hydrating from sessionStorage on first read. */
export function readOutbox(cardId: string): readonly OutboxEntry[] {
  const cached = queues.get(cardId);
  if (cached) return cached;
  if (typeof window === "undefined") return EMPTY;
  const restored = persistedQueue(cardId);
  queues.set(cardId, restored);
  return restored;
}

/** Submit a draft into the queue. Returns the entry the dispatcher will send. */
export function enqueueOutbox(cardId: string, entry: Omit<OutboxEntry, "state">): OutboxEntry {
  const queued: OutboxEntry = { ...entry, state: "queued" };
  write(cardId, [...readOutbox(cardId).filter((item) => item.id !== entry.id), queued].slice(-OUTBOX_LIMIT));
  return queued;
}

/**
 * Seed the initial launch prompt as the conversation's first optimistic user
 * bubble (round-1 P1#2). Idempotent: a re-render or reload-replay that seeds the
 * same launch id is a no-op, preserving whatever state the entry already
 * reached. The entry is `launchOwned` — delivered by the spawn, so it is never
 * dispatched and never blocks the operator's follow-up messages.
 */
export function seedLaunchOutbox(cardId: string, entry: { id: string; text: string; images: number; at: number }): void {
  if (!entry.text.trim() && !entry.images) return;
  const queue = readOutbox(cardId);
  if (queue.some((item) => item.id === entry.id)) return;
  const seeded: OutboxEntry = { ...entry, state: "delivering", launchOwned: true };
  write(cardId, [...queue, seeded].slice(-OUTBOX_LIMIT));
}

export function updateOutbox(cardId: string, id: string, patch: Partial<Omit<OutboxEntry, "id">>): void {
  const queue = readOutbox(cardId);
  if (!queue.some((entry) => entry.id === id)) return;
  write(cardId, queue.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
}

/** Remove an entry outright — the operator cancelled a message that never left. */
export function cancelOutbox(cardId: string, id: string): void {
  const queue = readOutbox(cardId);
  const next = queue.filter((entry) => entry.id !== id);
  if (next.length !== queue.length) write(cardId, next);
}

/**
 * Retry a failed submission (round-1 P1#4). The entry returns to `queued` under
 * its ORIGINAL id — which is its idempotency key — so the serial dispatcher
 * re-sends it with the same key: an idempotent replay, never a second distinct
 * message. An entry whose payload cannot be replayed (`needsReattach` — its
 * images were memory-only) is left for the operator to re-attach instead.
 */
export function retryOutbox(cardId: string, id: string): void {
  const queue = readOutbox(cardId);
  const entry = queue.find((item) => item.id === id);
  if (!entry || entry.state !== "failed" || entry.needsReattach) return;
  write(cardId, queue.map((item) => (item.id === id ? { ...item, state: "queued", error: undefined } : item)));
}

/** Move a whole queue onto a new conversation identity (provisional-id adoption,
    a materialized launch, a migration successor). Records already filed under
    the new identity win, so an adoption is idempotent. */
export function adoptOutbox(from: string, to: string): void {
  if (from === to) return;
  const source = readOutbox(from);
  if (!source.length) return;
  const target = readOutbox(to);
  const seen = new Set(target.map((entry) => entry.id));
  write(to, [...target, ...source.filter((entry) => !seen.has(entry.id))].slice(-OUTBOX_LIMIT));
  write(from, EMPTY);
}

/** The trimmed text of a bubble, used to match its transcript echo. */
function echoKey(text: string): string {
  return text.trim();
}

/** Occurrence counts of the trimmed user-message texts in a rendered transcript,
    keyed by {@link echoKey}. A count (not a set) is what causal retirement needs:
    two identical user messages are two echoes that retire two bubbles. */
export type TranscriptEchoCounts = ReadonlyMap<string, number>;

/**
 * Per-conversation snapshot of the transcript's user-echo counts, published by
 * the feed (LogFeed) and read by the composer at submit time so a new entry can
 * record how many identical echoes already existed — its {@link
 * OutboxEntry.echoBaseline} watermark (round-2 finding 2). Module state keyed on
 * the same stable conversation identity as the queue itself.
 */
const echoSnapshots = new Map<string, TranscriptEchoCounts>();

/** Publish the transcript's current user-echo counts for a conversation. */
export function publishTranscriptEchoes(cardId: string, counts: TranscriptEchoCounts): void {
  echoSnapshots.set(cardId, counts);
}

/** How many transcript echoes of `text` the feed has published for a
    conversation — the submission watermark a new entry stamps onto itself. */
export function transcriptEchoCount(cardId: string, text: string): number {
  return echoSnapshots.get(cardId)?.get(echoKey(text)) ?? 0;
}

/**
 * The entries that still render as optimistic bubbles (round-1 P1#4, round-2
 * finding 2). A bubble retires the moment ITS OWN echo lands in the transcript —
 * resolved causally, by occurrence consumption, never by bare set membership.
 *
 * Each transcript echo of a text retires exactly ONE entry with that text,
 * oldest-first, and only echoes BEYOND an entry's submission watermark
 * (`echoBaseline` — the echoes that already existed when it was queued) can
 * retire it. So a pre-existing identical user message leaves a freshly queued
 * bubble (and its cancel affordance) visible; the entry's own later echo retires
 * it; and a second identical send waits for a second echo. An entry with no
 * watermark (legacy/reloaded) treats the baseline as 0, so it still retires once
 * its text is present — preserving reload retirement.
 *
 * A `delivered` bubble whose echo never arrives (a lost poll, a finished pane)
 * still retires at a hard TTL so nothing lingers forever.
 *
 * `transcriptEchoCounts` maps each trimmed transcript user-text to its occurrence
 * count in the rendered transcript.
 */
export function visibleOutbox(
  queue: readonly OutboxEntry[],
  transcriptEchoCounts: TranscriptEchoCounts,
  nowMs: number,
): OutboxEntry[] {
  const consumed = new Map<string, number>();
  const visible: OutboxEntry[] = [];
  for (const entry of queue) {
    const key = echoKey(entry.text);
    const total = transcriptEchoCounts.get(key) ?? 0;
    /* Echoes below this floor belong to messages submitted before this entry
       (its own baseline) or to earlier queued siblings that already consumed
       them — neither retires this bubble. */
    const floor = Math.max(entry.echoBaseline ?? 0, consumed.get(key) ?? 0);
    if (total > floor) {
      consumed.set(key, floor + 1);
      continue;
    }
    if (entry.state === "delivered") {
      const settledAt = entry.settledAt ?? entry.at;
      if (nowMs - settledAt >= OUTBOX_DELIVERED_TTL_MS) continue;
    }
    visible.push(entry);
  }
  return visible;
}

/** Submitted texts newest first, for empty-composer ArrowUp/ArrowDown recall:
    queued messages first (they have not been said yet), then what was sent.
    Consecutive duplicates collapse so repeated acknowledgements do not fill
    the history with the same string. */
export function outboxHistory(queue: readonly OutboxEntry[]): string[] {
  const pending = queue.filter((entry) => entry.state === "queued" || entry.state === "delivering");
  const settled = queue.filter((entry) => entry.state === "delivered" || entry.state === "failed");
  const ordered = [...pending, ...settled]
    .sort((left, right) => right.at - left.at)
    .map((entry) => entry.text)
    .filter((text) => text.trim().length > 0);
  return ordered.filter((text, index) => text !== ordered[index - 1]);
}

/** The next entry the serial dispatcher may send: nothing while one of the
    operator's OWN messages is already on the wire, otherwise the oldest queued
    submission. A `launchOwned` entry is delivered by the spawn, not the
    composer, so it neither dispatches nor blocks the drain (round-1 P1#2/#4). */
export function nextDispatch(queue: readonly OutboxEntry[]): OutboxEntry | null {
  if (queue.some((entry) => entry.state === "delivering" && !entry.launchOwned)) return null;
  return queue.find((entry) => entry.state === "queued") ?? null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React binding. Returns the stable array identity so an unchanged queue never
    re-renders the feed. */
export function useOutbox(cardId: string): readonly OutboxEntry[] {
  return useSyncExternalStore(
    subscribe,
    () => readOutbox(cardId),
    () => EMPTY,
  );
}

/** Test seam: drops in-memory state so each case starts from a clean queue. */
export function resetOutboxForTests(): void {
  queues.clear();
  listeners.clear();
  echoSnapshots.clear();
}
