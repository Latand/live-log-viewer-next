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
  /** Moment the entry left `queued`/`delivering` (ms), for echo retirement. */
  settledAt?: number;
  error?: string;
  /** The attachment bytes of this submission did not survive a page refresh
      (previews are memory-only). The entry is held back rather than delivered
      text-only, and says so, so no image is ever silently dropped. */
  needsReattach?: true;
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

/**
 * The entries that still render as optimistic bubbles: everything not yet
 * settled, plus a delivered entry whose real transcript bubble has not landed
 * yet. Pure, so the retirement rule is directly testable.
 */
export function visibleOutbox(
  queue: readonly OutboxEntry[],
  fileMtimeMs: number,
  nowMs: number,
): OutboxEntry[] {
  return queue.filter((entry) => {
    if (entry.state !== "delivered") return true;
    const settledAt = entry.settledAt ?? entry.at;
    if (fileMtimeMs >= settledAt + OUTBOX_MTIME_GRACE_MS) return false;
    return nowMs - settledAt < OUTBOX_DELIVERED_TTL_MS;
  });
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

/** The next entry the serial dispatcher may send: nothing while one is already
    on the wire, otherwise the oldest queued submission. */
export function nextDispatch(queue: readonly OutboxEntry[]): OutboxEntry | null {
  if (queue.some((entry) => entry.state === "delivering")) return null;
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
}
