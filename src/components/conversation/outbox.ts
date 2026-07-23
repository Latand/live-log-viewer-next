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
  /** Assistant output began for the turn created by this submission. This is
      causal delivery proof and permanently retires the optimistic bubble. */
  responseStartedAt?: number;
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
  /** The canonical text this bubble's transcript echo will carry (issue #615),
      when it differs from the displayed {@link text}. A role launch DISPLAYS the
      operator's raw draft but the transcript echoes the delivered scaffold-plus-
      draft, so retirement matches THIS text while the bubble still shows the raw
      draft. Absent ⇒ the display text is its own echo identity (plain launches
      and ordinary composer sends). */
  echoText?: string;
  /** Submission watermark (round-2 finding 2): how many transcript echoes of THIS
      exact text already existed when the entry was submitted. Retirement consumes
      only echoes BEYOND this baseline, so a freshly queued bubble survives a
      pre-existing identical user message and retires when its OWN later echo
      lands. Absent (legacy/reloaded entries) ⇒ baseline 0, preserving the prior
      "retire once the text is present" reload behaviour. */
  echoBaseline?: number;
  /** Stable transcript-row anchors present when this entry was submitted. They
      are the durable occurrence watermark across capped tails and filters. */
  echoBaselineIds?: string[];
  /** Stable anchor of the canonical user row that retired this entry. Once set,
      retirement is monotonic across tail eviction, adoption, and refresh. */
  retiredEchoId?: string;
  retiredAt?: number;
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
const echoStorageKey = (cardId: string) => "llvOutboxEchoes:" + cardId;

const queues = new Map<string, readonly OutboxEntry[]>();
const listeners = new Set<() => void>();
const EMPTY: readonly OutboxEntry[] = [];

export interface TranscriptEchoObservation {
  /** Stable absolute feed anchor, e.g. `row:<source line>:<ordinal>`. */
  id: string;
  text: string;
}

interface PersistedEchoObservation {
  id: string;
  key: string;
}

const ECHO_LEDGER_LIMIT = 512;
const echoLedgers = new Map<string, readonly PersistedEchoObservation[]>();
const EMPTY_ECHO_LEDGER: readonly PersistedEchoObservation[] = [];

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

function isPersistedEcho(value: unknown): value is PersistedEchoObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.id === "string" && typeof raw.key === "string";
}

function readEchoLedger(cardId: string): readonly PersistedEchoObservation[] {
  const cached = echoLedgers.get(cardId);
  if (cached) return cached;
  if (typeof window === "undefined") return EMPTY_ECHO_LEDGER;
  try {
    const raw = JSON.parse(sessionStorage.getItem(echoStorageKey(cardId)) ?? "[]") as unknown;
    const restored = Array.isArray(raw)
      ? raw.filter(isPersistedEcho).slice(-ECHO_LEDGER_LIMIT)
      : EMPTY_ECHO_LEDGER;
    echoLedgers.set(cardId, restored);
    return restored;
  } catch {
    echoLedgers.set(cardId, EMPTY_ECHO_LEDGER);
    return EMPTY_ECHO_LEDGER;
  }
}

function persistEchoLedger(cardId: string, ledger: readonly PersistedEchoObservation[]): void {
  echoLedgers.set(cardId, ledger);
  try {
    if (ledger.length) sessionStorage.setItem(echoStorageKey(cardId), JSON.stringify(ledger));
    else sessionStorage.removeItem(echoStorageKey(cardId));
  } catch {
    /* quota / opaque origin: the in-memory ledger still protects this mount */
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
  const key = echoKey(entry.echoText ?? entry.text);
  const baselineIds = entry.echoBaselineIds
    ?? readEchoLedger(cardId).filter((echo) => echo.key === key).map((echo) => echo.id);
  const queued: OutboxEntry = {
    ...entry,
    echoBaseline: entry.echoBaseline ?? baselineIds.length,
    ...(baselineIds.length ? { echoBaselineIds: baselineIds } : {}),
    state: "queued",
  };
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
export function seedLaunchOutbox(
  cardId: string,
  entry: { id: string; text: string; images: number; at: number; echoText?: string },
): void {
  if (!entry.text.trim() && !entry.images) return;
  const queue = readOutbox(cardId);
  const existing = queue.find((item) => item.id === entry.id);
  if (existing) {
    /* Reconcile the canonical echo identity onto an already-seeded bubble (issue
       #615): the composer seeds the RAW draft first, without an echo identity (it
       never composes the role scaffold); the later server projection supplies it.
       Attach it while preserving the user-facing raw text and the bubble's current
       state — one bubble, never a second. Idempotent once attached. */
    if (entry.echoText && entry.echoText !== existing.echoText) {
      write(cardId, queue.map((item) => (item.id === entry.id ? { ...item, echoText: entry.echoText } : item)));
      reconcileEchoRetirements(cardId, readEchoLedger(cardId));
    }
    return;
  }
  const seeded: OutboxEntry = { ...entry, state: "delivering", launchOwned: true };
  write(cardId, [...queue, seeded].slice(-OUTBOX_LIMIT));
  /* A refreshed surface can see the canonical transcript row before the launch
     projection effect seeds its optimistic bubble. Reconcile the persisted row
     immediately so retirement becomes durable during that same mount. */
  reconcileEchoRetirements(cardId, readEchoLedger(cardId));
}

export function updateOutbox(cardId: string, id: string, patch: Partial<Omit<OutboxEntry, "id">>): void {
  const queue = readOutbox(cardId);
  if (!queue.some((entry) => entry.id === id)) return;
  write(cardId, queue.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry)));
}

/** Settle one submission when the assistant starts its matching runtime turn.
    The entry remains in recent history while its optimistic bubble retires. */
export function markOutboxResponded(cardId: string, id: string, at: number): void {
  const queue = readOutbox(cardId);
  const entry = queue.find((item) => item.id === id);
  if (!entry || entry.responseStartedAt !== undefined) return;
  write(cardId, queue.map((item) => (item.id === id ? {
    ...item,
    state: "delivered",
    settledAt: item.settledAt ?? at,
    responseStartedAt: at,
  } : item)));
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
  const sourceEchoes = readEchoLedger(from);
  if (sourceEchoes.length) {
    const targetEchoes = readEchoLedger(to);
    const merged = new Map(sourceEchoes.map((echo) => [echo.id, echo]));
    for (const echo of targetEchoes) {
      merged.delete(echo.id);
      merged.set(echo.id, echo);
    }
    persistEchoLedger(to, [...merged.values()].slice(-ECHO_LEDGER_LIMIT));
    persistEchoLedger(from, EMPTY_ECHO_LEDGER);
  }
  const source = readOutbox(from);
  if (source.length) {
    const target = readOutbox(to);
    const merged = new Map(target.map((entry) => [entry.id, entry]));
    for (const entry of source) {
      const existing = merged.get(entry.id);
      if (!existing) {
        merged.set(entry.id, entry);
        continue;
      }
      if (entry.retiredEchoId && !existing.retiredEchoId) {
        merged.set(entry.id, {
          ...existing,
          retiredEchoId: entry.retiredEchoId,
          retiredAt: entry.retiredAt,
        });
      }
    }
    write(
      to,
      [...merged.values()]
        .sort((left, right) => left.at - right.at)
        .slice(-OUTBOX_LIMIT),
    );
    write(from, EMPTY);
  }
  reconcileEchoRetirements(to, readEchoLedger(to));
}

/** The trimmed text of a bubble, used to match its transcript echo. */
function echoKey(text: string): string {
  return text.trim();
}

/** Occurrence counts of the trimmed user-message texts in a rendered transcript,
    keyed by {@link echoKey}. Causal retirement needs the counts: two identical
    user messages are two echoes that retire two bubbles. */
export type TranscriptEchoCounts = ReadonlyMap<string, number>;

/**
 * Per-conversation snapshot of the transcript's user-echo counts, published by
 * the feed (LogFeed) and read by the composer at submit time so a new entry can
 * record how many identical echoes already existed — its {@link
 * OutboxEntry.echoBaseline} watermark (round-2 finding 2). Module state keyed on
 * the same stable conversation identity as the queue itself.
 */
const echoSnapshots = new Map<string, TranscriptEchoCounts>();
const echoListeners = new Set<() => void>();
const EMPTY_ECHO_COUNTS: TranscriptEchoCounts = new Map();

function countsFromLedger(ledger: readonly PersistedEchoObservation[]): TranscriptEchoCounts {
  const counts = new Map<string, number>();
  for (const echo of ledger) counts.set(echo.key, (counts.get(echo.key) ?? 0) + 1);
  return counts;
}

function sameCounts(left: TranscriptEchoCounts | undefined, right: TranscriptEchoCounts): boolean {
  if (!left || left.size !== right.size) return false;
  for (const [key, count] of right) if (left.get(key) !== count) return false;
  return true;
}

function reconcileEchoRetirements(
  cardId: string,
  ledger: readonly PersistedEchoObservation[],
): void {
  const queue = readOutbox(cardId);
  if (!queue.length) return;
  const claimed = new Set(queue.flatMap((entry) => entry.retiredEchoId ? [entry.retiredEchoId] : []));
  let changed = false;
  const next = queue.map((entry) => {
    if (entry.retiredEchoId) return entry;
    const baseline = new Set(entry.echoBaselineIds ?? []);
    const key = echoKey(entry.echoText ?? entry.text);
    const owner = ledger.find((echo) =>
      echo.key === key
      && !baseline.has(echo.id)
      && !claimed.has(echo.id));
    if (!owner) return entry;
    claimed.add(owner.id);
    changed = true;
    return { ...entry, retiredEchoId: owner.id, retiredAt: Date.now() };
  });
  if (changed) write(cardId, next);
}

/**
 * Publish stable transcript user-row observations. The absolute row anchors
 * form a bounded durable occurrence ledger; matching entries persist the exact
 * anchor that retired them. The count-map overload keeps older callers and
 * fixtures compatible while production feeds publish anchor observations.
 */
export function publishTranscriptEchoes(
  cardId: string,
  observations: TranscriptEchoCounts | readonly TranscriptEchoObservation[],
): void {
  if (!Array.isArray(observations)) {
    const counts = observations as TranscriptEchoCounts;
    if (sameCounts(echoSnapshots.get(cardId), counts)) return;
    echoSnapshots.set(cardId, counts);
    for (const listener of echoListeners) listener();
    return;
  }

  const merged = new Map(readEchoLedger(cardId).map((echo) => [echo.id, echo]));
  for (const observation of observations) {
    const id = observation.id.trim();
    const key = echoKey(observation.text);
    if (!id || !key) continue;
    merged.set(id, { id, key });
  }
  const ledger = [...merged.values()].slice(-ECHO_LEDGER_LIMIT);
  const previous = readEchoLedger(cardId);
  const ledgerChanged = previous.length !== ledger.length
    || previous.some((echo, index) => echo.id !== ledger[index]?.id || echo.key !== ledger[index]?.key);
  if (ledgerChanged) persistEchoLedger(cardId, ledger);
  const counts = countsFromLedger(ledger);
  const countsChanged = !sameCounts(echoSnapshots.get(cardId), counts);
  if (countsChanged) echoSnapshots.set(cardId, counts);
  reconcileEchoRetirements(cardId, ledger);
  if (countsChanged) for (const listener of echoListeners) listener();
}

/** How many transcript echoes of `text` the feed has published for a
    conversation — the submission watermark a new entry stamps onto itself. */
export function transcriptEchoCount(cardId: string, text: string): number {
  let counts = echoSnapshots.get(cardId);
  if (!counts) {
    counts = countsFromLedger(readEchoLedger(cardId));
    echoSnapshots.set(cardId, counts);
  }
  return counts.get(echoKey(text)) ?? 0;
}

/** Reactive transcript-echo snapshot for the composer. Delivery success can
    arrive after its user bubble was already written, so exact feed evidence
    retires the temporary receipt row immediately. */
export function useTranscriptEchoes(cardId: string): TranscriptEchoCounts {
  return useSyncExternalStore(
    (listener) => {
      echoListeners.add(listener);
      return () => echoListeners.delete(listener);
    },
    () => echoSnapshots.get(cardId) ?? EMPTY_ECHO_COUNTS,
    () => EMPTY_ECHO_COUNTS,
  );
}

/**
 * The entries that still render as optimistic bubbles (round-1 P1#4, round-2
 * finding 2). A bubble retires the moment ITS OWN echo lands in the transcript,
 * resolved causally through occurrence consumption of the echo counts.
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
    /* A bubble retires on ITS canonical transcript echo — the delivered text,
       which for a role launch is the scaffold-plus-draft carried on `echoText`,
       not the raw draft it displays (issue #615). */
    const key = echoKey(entry.echoText ?? entry.text);
    if (entry.retiredEchoId) {
      const floor = Math.max(entry.echoBaseline ?? 0, consumed.get(key) ?? 0);
      consumed.set(key, floor + 1);
      continue;
    }
    const total = transcriptEchoCounts.get(key) ?? 0;
    /* Echoes below this floor belong to messages submitted before this entry
       (its own baseline) or to earlier queued siblings that already consumed
       them — neither retires this bubble. */
    const floor = Math.max(entry.echoBaseline ?? 0, consumed.get(key) ?? 0);
    if (total > floor) {
      consumed.set(key, floor + 1);
      continue;
    }
    if (entry.responseStartedAt !== undefined) continue;
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
  echoListeners.clear();
  echoLedgers.clear();
}
