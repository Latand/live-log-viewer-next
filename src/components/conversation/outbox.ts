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

import { receiptIsAdmitted, receiptIsTerminal, type ReceiptStatus } from "@/components/runtime/runtimeModel";

export type OutboxState = "queued" | "delivering" | "delivered" | "failed";

/** Exact server-projected launch ownership. A canonical conversation can span
    several native generations, so both coordinates are required. */
export interface OutboxOwner {
  readonly conversationId: string;
  readonly generation: number;
}

export interface OutboxEntry {
  /** Idempotency key of this submission — also the bubble's stable identity. */
  id: string;
  text: string;
  /** How many images rode with this submission (previews stay local). */
  images: number;
  /** How many non-image attachments rode with it (#1224). Counted apart from
      the images so the bubble can name what was actually carried, and counted
      at all because the refresh fence below holds back any entry whose bytes
      were memory-only — a document's are, exactly like an image's. */
  files?: number;
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
      text-only, and says so, so no attachment is ever silently dropped. */
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
  /** Exact canonical conversation + native generation that owns this launch
      bubble (issue #922). Ordinary composer sends omit it because their queue is
      already scoped to the pane. Legacy launch rows with a missing/string owner
      fail closed on production render until the server projection upgrades them. */
  owner?: OutboxOwner;
  /** The server admitted this submission and journaled it, but the agent is
      inside a turn so it has not been handed over (issue #1213). A structured
      send only crosses at a turn boundary, so this is a genuinely different
      fact from "on the wire" — the bubble says which wait it is in. Cleared
      whenever a receipt proves the entry moved. */
  awaitingTurn?: true;
  /** The server admitted this submission but HELD it (the account-switch
      delivery fence) instead of delivering: the entry is parked `delivering`
      with nothing on the wire. Its release is level-triggered — see
      {@link releaseHeldOutbox} — because the event-shaped signals (a successor
      receipt, the delivered text's transcript echo) can simply never arrive
      once the server-side hold record is gone. Cleared on requeue. */
  heldForSwitch?: true;
}

function isOutboxOwner(value: unknown): value is OutboxOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.conversationId === "string"
    && Number.isInteger(raw.generation)
    && (raw.generation as number) > 0;
}

function sameOutboxOwner(left: unknown, right: OutboxOwner): boolean {
  return isOutboxOwner(left)
    && left.conversationId === right.conversationId
    && left.generation === right.generation;
}

function normalizeOutboxOwner(entry: OutboxEntry): OutboxEntry {
  const owner = (entry as { owner?: unknown }).owner;
  if (owner === undefined || isOutboxOwner(owner)) return entry;
  const normalized = { ...entry };
  delete normalized.owner;
  return normalized;
}

function reconciledLaunchState(
  current: OutboxState,
  projected: Extract<OutboxState, "delivering" | "delivered" | "failed">,
): OutboxState {
  if (projected === "delivered") return "delivered";
  if (projected === "failed" && (current === "queued" || current === "delivering")) return "failed";
  return current;
}

/**
 * Map a durable receipt status to the outbox bubble state it PROVES (round-1
 * P1#4). `queued`/`delivering` are admitted-but-not-delivered — the server holds
 * the message but it has not reached the agent — so the bubble stays
 * `delivering`, never prematurely `delivered`. Only a status that proves the
 * message is in the turn/transcript settles the bubble to `delivered`;
 * `rejected`/`failed` settle it to `failed`.
 */
/**
 * Whether a receipt status means "admitted and parked at a turn boundary"
 * rather than "on the wire" (issue #1213). Both map to the same
 * {@link OutboxState}; only the bubble's wording differs.
 *
 * `queued` and nothing else: it is the state the delivery queue parks a send in
 * while the host is inside a turn. `uncertain` is the opposite fact — the
 * admission itself was never confirmed — and claiming a turn boundary for it
 * would assert the very thing that could not be established.
 */
export function outboxAwaitsTurnBoundary(status: ReceiptStatus): true | undefined {
  return status === "queued" ? true : undefined;
}

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

/**
 * The bubble patch a durable receipt implies for an entry, or `null` when it
 * implies nothing.
 *
 * The state alone cannot decide this (issue #1213): `pending`, `queued`,
 * `delivering`, `applying` and `uncertain` all project to ONE `delivering`
 * bubble, so a send being parked at a turn boundary — and a parked send being
 * taken off the park and put on the wire — are invisible to a state comparison,
 * and those are precisely the two transitions whose WORDING has to change. The
 * turn-boundary flag is therefore part of the comparison, not just the patch.
 *
 * A failed bubble still only advances on PROVEN admission: never on another
 * failure, and never to `delivering` off an unproven receipt.
 */
export function outboxReceiptPatch(
  entry: Pick<OutboxEntry, "state" | "awaitingTurn">,
  status: ReceiptStatus,
): { state: OutboxState; awaitingTurn?: true } | null {
  /* Only a receipt that PROVES admission or settlement says anything about a
     bubble. `pending`, `applying` and `uncertain` are the request path still
     working, or an admission nobody confirmed: the bubble already reads
     `delivering`, and letting them move a `failed` one would claim exactly the
     admission that was never established. */
  if (!receiptIsAdmitted(status) && !receiptIsTerminal(status)) return null;
  const state = outboxStateForReceiptStatus(status);
  const awaitingTurn = outboxAwaitsTurnBoundary(status);
  if (state === entry.state && awaitingTurn === entry.awaitingTurn) return null;
  /* A failed bubble is never re-churned by another failure; it only advances on
     the proven admission or delivery above. */
  if (entry.state === "failed" && state === "failed") return null;
  return { state, awaitingTurn };
}

/** Bounded per conversation: the queue is working state plus recent history for
    ArrowUp/ArrowDown, never an archive (the transcript is the archive). */
export const OUTBOX_LIMIT = 32;
/** A delivered entry stops rendering once the transcript grew past its
    delivery moment: newer transcript records prove the agent has moved on, so
    keeping the bubble in the window tail would paint the operator's message
    BELOW output that came after it. The grace absorbs the echo's own write and
    small clock skew. Mirrors DELIVERY_ECHO_MTIME_GRACE_MS. */
export const OUTBOX_MTIME_GRACE_MS = 2_000;
/** Hard cap so a conversation whose transcript never grows again cannot keep
    optimistic bubbles on screen forever. */
export const OUTBOX_DELIVERED_TTL_MS = 10 * 60_000;

const storageKey = (cardId: string) => "llvOutbox:" + cardId;
const echoStorageKey = (cardId: string) => "llvOutboxEchoes:" + cardId;
const occurrenceStorageKey = (cardId: string) => "llvOutboxOccurrences:" + cardId;
const currentLaunchStorageKey = (cardId: string) => "llvOutboxCurrentLaunch:" + cardId;

const queues = new Map<string, readonly OutboxEntry[]>();
const listeners = new Set<() => void>();
const EMPTY: readonly OutboxEntry[] = [];

export interface TranscriptEchoObservation {
  /** Active transcript path. Production feeds always provide it; legacy fixtures may omit it. */
  generation?: string;
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

interface PersistedOccurrenceTombstone {
  /** Submission identity retained after the recent-history entry is compacted. */
  id: string;
  key: string;
  at: number;
  echoBaseline?: number;
  echoBaselineIds?: string[];
  retiredEchoId?: string;
  retiredAt?: number;
  launchOwned?: true;
}

/** Unresolved owners consume future echoes oldest-first. Preserve the oldest
    supported set so completed churn cannot displace active chronology. */
const OCCURRENCE_ACTIVE_LIMIT = ECHO_LEDGER_LIMIT;
/** Consumed owners are replay protection history. Keep the newest bounded set. */
const OCCURRENCE_COMPLETED_LIMIT = ECHO_LEDGER_LIMIT;
const occurrenceTombstones = new Map<string, readonly PersistedOccurrenceTombstone[]>();
const EMPTY_OCCURRENCE_TOMBSTONES: readonly PersistedOccurrenceTombstone[] = [];

type CurrentLaunchTerminalReason = "response-started" | "delivered-ttl";

interface PersistedCurrentLaunch {
  id: string;
  at: number;
  settledAt?: number;
  retiredEchoId?: string;
  retiredAt?: number;
  terminalReason?: CurrentLaunchTerminalReason;
}

/** One stable conversation has one current launch identity. */
const currentLaunches = new Map<string, PersistedCurrentLaunch | null>();

function compareOccurrenceOrder(
  left: PersistedOccurrenceTombstone,
  right: PersistedOccurrenceTombstone,
): number {
  if (left.at !== right.at) return left.at - right.at;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function compareCompletedAge(
  left: PersistedOccurrenceTombstone,
  right: PersistedOccurrenceTombstone,
): number {
  const age = (left.retiredAt ?? left.at) - (right.retiredAt ?? right.at);
  return age || compareOccurrenceOrder(left, right);
}

/**
 * Retention has two independent priority tiers. Active occurrence owners keep
 * the oldest 512 submissions because reconciliation consumes echoes in that
 * order. Completed reservations keep the newest 512 by retirement age. At a
 * tier cap, those ordering rules choose the retained set deterministically.
 */
function boundOccurrenceTombstones(
  tombstones: readonly PersistedOccurrenceTombstone[],
): readonly PersistedOccurrenceTombstone[] {
  const active = tombstones
    .filter((tombstone) => !tombstone.retiredEchoId)
    .sort(compareOccurrenceOrder)
    .slice(0, OCCURRENCE_ACTIVE_LIMIT);
  const completed = tombstones
    .filter((tombstone) => Boolean(tombstone.retiredEchoId))
    .sort(compareCompletedAge)
    .slice(-OCCURRENCE_COMPLETED_LIMIT);
  return [...active, ...completed].sort(compareOccurrenceOrder);
}

function isEntry(value: unknown): value is OutboxEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.id === "string" && typeof raw.text === "string" && typeof raw.at === "number";
}

function persistedQueue(cardId: string): readonly OutboxEntry[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(storageKey(cardId)) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return EMPTY;
    return raw.filter(isEntry).slice(-OUTBOX_LIMIT).map((rawEntry) => {
      const entry = normalizeOutboxOwner(rawEntry);
      const images = typeof entry.images === "number" ? entry.images : 0;
      const files = typeof entry.files === "number" ? entry.files : 0;
      /* Both counts are what a stored row SAYS it carried, so both are read
         defensively before anything adds them up or renders them. */
      const counted: OutboxEntry = { ...entry, images };
      if (files) counted.files = files;
      else delete counted.files;
      /* The initial launch prompt is owned by the spawn, not the composer: it
         survives a refresh exactly as it was (never re-dispatched, never
         re-queued) and retires on its transcript echo. */
      if (entry.launchOwned) return counted;
      const unsettled = entry.state === "delivering" || entry.state === "queued";
      /* A `delivering` entry recorded before a refresh has no owner in this
         mount: it returns to the queue so the serial dispatcher replays it
         under its original idempotency key rather than stranding it. An entry
         that carried ATTACHMENTS cannot be replayed — image or document, the
         bytes were memory-only — so it is held for the operator instead of
         being delivered without them (#1224). */
      if (unsettled && images + files > 0) {
        return { ...counted, state: "failed" as const, needsReattach: true as const };
      }
      return { ...counted, state: unsettled ? ("queued" as const) : entry.state };
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

function isPersistedCurrentLaunch(value: unknown): value is PersistedCurrentLaunch {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.id === "string"
    && typeof raw.at === "number"
    && (raw.settledAt === undefined || typeof raw.settledAt === "number")
    && (raw.retiredEchoId === undefined || typeof raw.retiredEchoId === "string")
    && (raw.retiredAt === undefined || typeof raw.retiredAt === "number")
    && (raw.terminalReason === undefined
      || raw.terminalReason === "response-started"
      || raw.terminalReason === "delivered-ttl");
}

function readCurrentLaunch(cardId: string): PersistedCurrentLaunch | null {
  if (currentLaunches.has(cardId)) return currentLaunches.get(cardId) ?? null;
  if (typeof window === "undefined") return null;
  try {
    const raw = JSON.parse(sessionStorage.getItem(currentLaunchStorageKey(cardId)) ?? "null") as unknown;
    const restored = isPersistedCurrentLaunch(raw) ? raw : null;
    currentLaunches.set(cardId, restored);
    return restored;
  } catch {
    currentLaunches.set(cardId, null);
    return null;
  }
}

function persistCurrentLaunch(cardId: string, launch: PersistedCurrentLaunch | null): void {
  currentLaunches.set(cardId, launch);
  try {
    if (launch) sessionStorage.setItem(currentLaunchStorageKey(cardId), JSON.stringify(launch));
    else sessionStorage.removeItem(currentLaunchStorageKey(cardId));
  } catch {
    /* quota / opaque origin: the in-memory slot still protects this mount */
  }
}

function selectCurrentLaunch(
  current: PersistedCurrentLaunch | null,
  candidate: PersistedCurrentLaunch,
): PersistedCurrentLaunch {
  if (!current) return candidate;
  if (current.id === candidate.id) {
    const latest = candidate.at > current.at ? candidate : current;
    const settledAt = Math.max(current.settledAt ?? -Infinity, candidate.settledAt ?? -Infinity);
    const terminal = [current, candidate]
      .filter((launch) => launch.retiredEchoId || launch.terminalReason)
      .sort((left, right) => (left.retiredAt ?? left.at) - (right.retiredAt ?? right.at))
      .at(-1);
    return {
      ...latest,
      ...(Number.isFinite(settledAt) ? { settledAt } : {}),
      ...(terminal
        ? {
          ...(terminal.retiredEchoId ? { retiredEchoId: terminal.retiredEchoId } : {}),
          ...(terminal.retiredAt !== undefined ? { retiredAt: terminal.retiredAt } : {}),
          ...(terminal.terminalReason ? { terminalReason: terminal.terminalReason } : {}),
        }
        : {}),
    };
  }
  if (candidate.at !== current.at) return candidate.at > current.at ? candidate : current;
  return candidate.id > current.id ? candidate : current;
}

function recordCurrentLaunch(cardId: string, candidate: PersistedCurrentLaunch): void {
  persistCurrentLaunch(cardId, selectCurrentLaunch(readCurrentLaunch(cardId), candidate));
}

function recordCurrentLaunchRetirement(
  cardId: string,
  candidate: PersistedCurrentLaunch & (
    { retiredEchoId: string }
    | { terminalReason: CurrentLaunchTerminalReason }
  ),
): void {
  const current = readCurrentLaunch(cardId);
  if (current && current.id !== candidate.id) return;
  recordCurrentLaunch(cardId, candidate);
}

function terminalReasonForLaunch(
  launch: Pick<PersistedCurrentLaunch, "settledAt" | "terminalReason">,
  nowMs: number,
): CurrentLaunchTerminalReason | undefined {
  if (launch.terminalReason) return launch.terminalReason;
  if (
    launch.settledAt !== undefined
    && nowMs - launch.settledAt >= OUTBOX_DELIVERED_TTL_MS
  ) return "delivered-ttl";
  return undefined;
}

function recordCurrentLaunchEntry(cardId: string, entry: OutboxEntry, nowMs = Date.now()): void {
  if (!entry.launchOwned) return;
  const settledAt = entry.settledAt ?? (entry.state === "delivered" ? entry.at : undefined);
  const terminalReason = entry.responseStartedAt !== undefined
    ? "response-started"
    : terminalReasonForLaunch({ settledAt }, nowMs);
  const candidate = {
    id: entry.id,
    at: entry.at,
    ...(settledAt !== undefined ? { settledAt } : {}),
  };
  if (terminalReason) {
    recordCurrentLaunchRetirement(cardId, {
      ...candidate,
      terminalReason,
      retiredAt: terminalReason === "response-started"
        ? entry.responseStartedAt
        : (settledAt ?? entry.at) + OUTBOX_DELIVERED_TTL_MS,
    });
    return;
  }
  recordCurrentLaunch(cardId, candidate);
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

function isOccurrenceTombstone(value: unknown): value is PersistedOccurrenceTombstone {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return typeof raw.id === "string"
    && typeof raw.key === "string"
    && typeof raw.at === "number"
    && (raw.echoBaseline === undefined || typeof raw.echoBaseline === "number")
    && (raw.echoBaselineIds === undefined
      || (Array.isArray(raw.echoBaselineIds) && raw.echoBaselineIds.every((id) => typeof id === "string")))
    && (raw.retiredEchoId === undefined || typeof raw.retiredEchoId === "string")
    && (raw.retiredAt === undefined || typeof raw.retiredAt === "number")
    && (raw.launchOwned === undefined || raw.launchOwned === true);
}

function readOccurrenceTombstones(cardId: string): readonly PersistedOccurrenceTombstone[] {
  const cached = occurrenceTombstones.get(cardId);
  if (cached) return cached;
  if (typeof window === "undefined") return EMPTY_OCCURRENCE_TOMBSTONES;
  try {
    const raw = JSON.parse(sessionStorage.getItem(occurrenceStorageKey(cardId)) ?? "[]") as unknown;
    const restored = Array.isArray(raw)
      ? boundOccurrenceTombstones(raw.filter(isOccurrenceTombstone))
      : EMPTY_OCCURRENCE_TOMBSTONES;
    occurrenceTombstones.set(cardId, restored);
    return restored;
  } catch {
    occurrenceTombstones.set(cardId, EMPTY_OCCURRENCE_TOMBSTONES);
    return EMPTY_OCCURRENCE_TOMBSTONES;
  }
}

function persistOccurrenceTombstones(
  cardId: string,
  tombstones: readonly PersistedOccurrenceTombstone[],
): void {
  const retained = boundOccurrenceTombstones(tombstones);
  occurrenceTombstones.set(cardId, retained);
  try {
    if (retained.length) {
      sessionStorage.setItem(occurrenceStorageKey(cardId), JSON.stringify(retained));
    } else {
      sessionStorage.removeItem(occurrenceStorageKey(cardId));
    }
  } catch {
    /* quota / opaque origin: the in-memory reservations still protect this mount */
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

function mergeOccurrenceTombstones(
  current: readonly PersistedOccurrenceTombstone[],
  additions: readonly PersistedOccurrenceTombstone[],
): readonly PersistedOccurrenceTombstone[] {
  const merged = new Map(current.map((tombstone) => [tombstone.id, tombstone]));
  for (const addition of additions) {
    const existing = merged.get(addition.id);
    if (existing?.retiredEchoId && !addition.retiredEchoId) continue;
    merged.set(addition.id, addition);
  }
  return boundOccurrenceTombstones([...merged.values()]);
}

function occurrenceTombstone(entry: OutboxEntry): PersistedOccurrenceTombstone | null {
  if (entry.state !== "delivered" && entry.responseStartedAt === undefined && !entry.retiredEchoId) return null;
  const key = echoKey(entry.echoText ?? entry.text);
  if (!key) return null;
  return {
    id: entry.id,
    key,
    at: entry.at,
    ...(entry.echoBaseline !== undefined ? { echoBaseline: entry.echoBaseline } : {}),
    ...(entry.echoBaselineIds?.length ? { echoBaselineIds: entry.echoBaselineIds } : {}),
    ...(entry.retiredEchoId ? { retiredEchoId: entry.retiredEchoId } : {}),
    ...(entry.retiredAt !== undefined ? { retiredAt: entry.retiredAt } : {}),
    ...(entry.launchOwned ? { launchOwned: true as const } : {}),
  };
}

/** Compact recent queue/history while preserving older terminal occurrence owners. */
function writeBounded(cardId: string, queue: readonly OutboxEntry[]): void {
  const overflow = Math.max(0, queue.length - OUTBOX_LIMIT);
  if (overflow > 0) {
    for (const entry of queue.slice(0, overflow)) recordCurrentLaunchEntry(cardId, entry);
    const additions = queue
      .slice(0, overflow)
      .map(occurrenceTombstone)
      .filter((entry): entry is PersistedOccurrenceTombstone => entry !== null);
    if (additions.length) {
      persistOccurrenceTombstones(
        cardId,
        mergeOccurrenceTombstones(readOccurrenceTombstones(cardId), additions),
      );
    }
  }
  write(cardId, queue.slice(-OUTBOX_LIMIT));
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
  writeBounded(cardId, [...readOutbox(cardId).filter((item) => item.id !== entry.id), queued]);
  return queued;
}

/**
 * Seed the initial launch prompt as the conversation's first optimistic user
 * bubble (round-1 P1#2). Idempotent: a re-render or reload-replay that seeds the
 * same launch id updates that row with authoritative echo, owner, and receipt
 * state while preserving stronger delivery/response evidence. The entry is
 * `launchOwned` — delivered by the spawn, so it is never dispatched and never
 * blocks the operator's follow-up messages.
 */
export function seedLaunchOutbox(
  cardId: string,
  entry: {
    id: string;
    text: string;
    images: number;
    at: number;
    echoText?: string;
    owner?: OutboxOwner;
    state?: Extract<OutboxState, "delivering" | "delivered" | "failed">;
    settledAt?: number;
    error?: string;
  },
): void {
  if (!entry.text.trim() && !entry.images) return;
  const currentLaunch = readCurrentLaunch(cardId);
  if (currentLaunch?.id === entry.id) {
    const terminalReason = terminalReasonForLaunch(currentLaunch, Date.now());
    if (terminalReason && !currentLaunch.terminalReason) {
      recordCurrentLaunchRetirement(cardId, {
        ...currentLaunch,
        terminalReason,
        retiredAt: (currentLaunch.settledAt ?? currentLaunch.at) + OUTBOX_DELIVERED_TTL_MS,
      });
    }
    if (currentLaunch.retiredEchoId || terminalReason) return;
  }
  const queue = readOutbox(cardId);
  const existing = queue.find((item) => item.id === entry.id);
  if (existing) {
    const projectedState = entry.state ?? "delivering";
    const nextState = reconciledLaunchState(existing.state, projectedState);
    const updated: OutboxEntry = {
      ...existing,
      ...(entry.echoText && entry.echoText !== existing.echoText ? { echoText: entry.echoText } : {}),
      ...(entry.owner && !sameOutboxOwner(existing.owner, entry.owner) ? { owner: entry.owner } : {}),
      ...(nextState !== existing.state ? { state: nextState } : {}),
      ...(nextState === "delivered" && existing.settledAt === undefined
        ? { settledAt: entry.settledAt ?? entry.at }
        : {}),
      ...(nextState === "failed" && entry.error && entry.error !== existing.error ? { error: entry.error } : {}),
    };
    const changed = updated.echoText !== existing.echoText
      || updated.owner !== existing.owner
      || updated.state !== existing.state
      || updated.settledAt !== existing.settledAt
      || updated.error !== existing.error;
    if (changed) write(cardId, queue.map((item) => (item.id === entry.id ? updated : item)));
    recordCurrentLaunchEntry(cardId, updated);
    if (updated.retiredEchoId) {
      recordCurrentLaunchRetirement(cardId, {
        id: entry.id,
        at: entry.at,
        retiredEchoId: updated.retiredEchoId,
        ...(updated.retiredAt !== undefined ? { retiredAt: updated.retiredAt } : {}),
      });
    }
    /* The browser seeds before the server knows canonical ownership, echo text,
       or terminal receipt state. The projection upgrades that same row in one
       join, so an ownerless stale copy cannot survive and a settled launch can
       never be repainted as delivering. */
    if (updated.echoText !== existing.echoText) {
      reconcileEchoRetirements(cardId, readEchoLedger(cardId));
    }
    return;
  }
  /* Recurring LogFeed projections can outlive the recent queue entry. Durable
     retirement under this submission id keeps the compacted launch terminal
     across refresh and identity adoption. */
  const terminalTombstone = readOccurrenceTombstones(cardId).find(
    (tombstone) => tombstone.id === entry.id && tombstone.retiredEchoId,
  );
  if (terminalTombstone?.retiredEchoId) {
    recordCurrentLaunch(cardId, {
      id: entry.id,
      at: terminalTombstone.at,
      retiredEchoId: terminalTombstone.retiredEchoId,
      retiredAt: terminalTombstone.retiredAt,
    });
    return;
  }
  const projectedState = entry.state ?? "delivering";
  /* A delivered launch compacted out of the recent queue keeps its settlement
     only in the current-launch slot. A reseed inside the TTL window restores
     that delivered state so the bubble stays visibly delivered and still
     retires at the TTL — never a fresh `delivering` entry that no echo or TTL
     could ever retire. */
  const settledAt = currentLaunch?.id === entry.id
    ? currentLaunch.settledAt ?? entry.settledAt
    : entry.settledAt;
  const state: OutboxEntry["state"] = settledAt !== undefined ? "delivered" : projectedState;
  recordCurrentLaunch(cardId, {
    id: entry.id,
    at: entry.at,
    ...(state === "delivered" ? { settledAt: settledAt ?? entry.at } : {}),
  });
  const seeded: OutboxEntry = {
    ...entry,
    state,
    ...(state === "delivered" ? { settledAt: settledAt ?? entry.at } : {}),
    launchOwned: true,
  };
  writeBounded(cardId, [...queue, seeded]);
  /* A refreshed surface can see the canonical transcript row before the launch
     projection effect seeds its optimistic bubble. Reconcile the persisted row
     immediately so retirement becomes durable during that same mount. */
  reconcileEchoRetirements(cardId, readEchoLedger(cardId));
}

export function updateOutbox(cardId: string, id: string, patch: Partial<Omit<OutboxEntry, "id">>): void {
  const queue = readOutbox(cardId);
  if (!queue.some((entry) => entry.id === id)) return;
  const next = queue.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
  const updated = next.find((entry) => entry.id === id);
  if (updated) recordCurrentLaunchEntry(cardId, updated);
  write(cardId, next);
}

/** Settle one submission when the assistant starts its matching runtime turn.
    The entry remains in recent history while its optimistic bubble retires. */
export function markOutboxResponded(cardId: string, id: string, at: number): void {
  const queue = readOutbox(cardId);
  const entry = queue.find((item) => item.id === id);
  if (!entry || entry.responseStartedAt !== undefined) return;
  const next = queue.map((item) => (item.id === id ? {
    ...item,
    state: "delivered" as const,
    settledAt: item.settledAt ?? at,
    responseStartedAt: at,
  } : item));
  const updated = next.find((item) => item.id === id);
  if (updated) recordCurrentLaunchEntry(cardId, updated, at);
  write(cardId, next);
}

/**
 * Settle a launch-owned bubble from the server-projected delivery receipt
 * (issue #648). A structured / MCP spawn delivers its first message through the
 * runtime, and the agent journals that user record with SDK / agent provenance —
 * so the transcript renders it as a system row, never a `user` echo, and the
 * echo-text retirement path can never fire. The delivered receipt is the
 * independent proof the prompt reached the agent: it settles the bubble to
 * `delivered` with the receipt time as `settledAt`, so it renders delivered and
 * retires on the delivered TTL exactly like a composer-delivered bubble, whether
 * or not any echo ever matches.
 *
 * Idempotent and monotonic. The settlement is also recorded into the durable
 * current-launch slot, so a compaction reseed inside the TTL restores the
 * `delivered` state (issue #644) and the slot still retires at the delivered TTL
 * even after the recent entry is evicted. A launch already responded, retired,
 * or settled keeps its earlier settlement; a newer launch owning the slot is
 * left untouched.
 */
export function settleLaunchOutboxDelivered(
  cardId: string,
  launch: { id: string; at: number; settledAt: number; owner?: OutboxOwner },
): void {
  const current = readCurrentLaunch(cardId);
  if (current && current.id !== launch.id) return;
  /* Fold the receipt settlement into the durable slot first: this is the only
     carrier once the recent entry is compacted out, and it is what a within-TTL
     reseed reads to restore `delivered` rather than a fresh `delivering` entry. */
  recordCurrentLaunch(cardId, {
    id: launch.id,
    at: current?.at ?? launch.at,
    settledAt: launch.settledAt,
  });
  const queue = readOutbox(cardId);
  const existing = queue.find((item) => item.id === launch.id);
  if (!existing || !existing.launchOwned) return;
  const owned = launch.owner && !sameOutboxOwner(existing.owner, launch.owner)
    ? { ...existing, owner: launch.owner }
    : existing;
  if (
    owned.retiredEchoId
    || owned.responseStartedAt !== undefined
    || owned.state === "delivered"
  ) {
    if (owned !== existing) write(cardId, queue.map((item) => (item.id === launch.id ? owned : item)));
    recordCurrentLaunchEntry(cardId, owned);
    return;
  }
  const next = queue.map((item) => (item.id === launch.id
    ? {
        ...owned,
        state: "delivered" as const,
        settledAt: owned.settledAt ?? launch.settledAt,
        error: undefined,
      }
    : item));
  const updated = next.find((item) => item.id === launch.id);
  if (updated) recordCurrentLaunchEntry(cardId, updated);
  write(cardId, next);
}

/** Settle a launch that died before its first message could start. This covers
    pathless promote-race failures as well as a terminalized attempts-zero held
    delivery. Delivered/response evidence remains monotonic and wins. */
export function settleLaunchOutboxFailed(
  cardId: string,
  launch: { id: string; at: number; error?: string; owner?: OutboxOwner },
): void {
  const current = readCurrentLaunch(cardId);
  if (current && current.id !== launch.id) return;
  recordCurrentLaunch(cardId, { id: launch.id, at: current?.at ?? launch.at });
  const queue = readOutbox(cardId);
  const existing = queue.find((item) => item.id === launch.id);
  if (!existing || !existing.launchOwned) return;
  const owned = launch.owner && !sameOutboxOwner(existing.owner, launch.owner)
    ? { ...existing, owner: launch.owner }
    : existing;
  if (owned.retiredEchoId || owned.responseStartedAt !== undefined || owned.state === "delivered") {
    if (owned !== existing) write(cardId, queue.map((item) => (item.id === launch.id ? owned : item)));
    recordCurrentLaunchEntry(cardId, owned);
    return;
  }
  const updated: OutboxEntry = {
    ...owned,
    state: "failed",
    ...(launch.error ? { error: launch.error } : {}),
  };
  recordCurrentLaunchEntry(cardId, updated);
  write(cardId, queue.map((item) => (item.id === launch.id ? updated : item)));
}

/**
 * Level-triggered release of switch-held submissions (P1: held messages never
 * released after the switch completed). Whenever the card's account state no
 * longer holds deliveries — the migration annotation vanished, or its target
 * already IS the active account — every entry still parked as held returns to
 * `queued` under its ORIGINAL id, which is its idempotency key, so the serial
 * dispatcher replays it: the server dedupes a message that WAS delivered to
 * the successor and delivers one that never was. Entries with delivery proof
 * of their own (a transcript echo, a started response) are left to their
 * normal retirement, and the requeued entry keeps its cancel affordance.
 * `except` lets the caller damp the level to one replay per hold transition,
 * so a fence that outlives the annotation cannot start a replay loop.
 * Returns the ids it requeued.
 */
export function releaseHeldOutbox(cardId: string, except?: ReadonlySet<string>): string[] {
  const queue = readOutbox(cardId);
  const released: string[] = [];
  const next = queue.map((entry) => {
    if (!entry.heldForSwitch || entry.state !== "delivering") return entry;
    if (entry.retiredEchoId || entry.responseStartedAt !== undefined) return entry;
    if (except?.has(entry.id)) return entry;
    released.push(entry.id);
    const requeued: OutboxEntry = { ...entry, state: "queued" };
    delete requeued.heldForSwitch;
    return requeued;
  });
  if (released.length) write(cardId, next);
  return released;
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

/**
 * Re-bind a queued submission's echo identity to the text the dispatcher will
 * actually deliver. The composer composes the wire payload at dispatch time —
 * a viewer-context prelude or a drained bridge turn can scaffold the operator's
 * draft — and the transcript echoes THAT text, not the raw draft the bubble
 * displays. Without the re-bind the echo can never match and the delivered
 * bubble lingers in the tail until the TTL. The submission watermark is
 * recomputed against the composed key: every current ledger occurrence of the
 * composed text predates this delivery, so only a LATER echo may retire it.
 */
export function rebindOutboxEchoText(cardId: string, id: string, echoText: string): void {
  const queue = readOutbox(cardId);
  const entry = queue.find((item) => item.id === id);
  if (!entry || entry.retiredEchoId) return;
  const key = echoKey(echoText);
  if (!key || echoKey(entry.echoText ?? entry.text) === key) return;
  const baselineIds = readEchoLedger(cardId)
    .filter((echo) => echo.key === key)
    .map((echo) => echo.id);
  write(cardId, queue.map((item) => {
    if (item.id !== id) return item;
    const rebound = { ...item, echoText, echoBaseline: baselineIds.length };
    if (baselineIds.length) rebound.echoBaselineIds = baselineIds;
    else delete rebound.echoBaselineIds;
    return rebound;
  }));
}

/** Move a whole queue onto a new conversation identity (provisional-id adoption,
    a materialized launch, a migration successor). Records already filed under
    the new identity win, so an adoption is idempotent. */
export function adoptOutbox(from: string, to: string): void {
  if (from === to) return;
  const sourceLaunch = readCurrentLaunch(from);
  if (sourceLaunch) {
    persistCurrentLaunch(to, selectCurrentLaunch(readCurrentLaunch(to), sourceLaunch));
    persistCurrentLaunch(from, null);
  }
  const sourceTombstones = readOccurrenceTombstones(from);
  if (sourceTombstones.length) {
    persistOccurrenceTombstones(
      to,
      mergeOccurrenceTombstones(readOccurrenceTombstones(to), sourceTombstones),
    );
    persistOccurrenceTombstones(from, EMPTY_OCCURRENCE_TOMBSTONES);
  }
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
    writeBounded(
      to,
      [...merged.values()]
        .sort((left, right) => left.at - right.at),
    );
    write(from, EMPTY);
  }
  reconcileEchoRetirements(to, readEchoLedger(to));
}

/** The trimmed text of a bubble, used to match its transcript echo. */
function echoKey(text: string): string {
  return text.trim();
}

/** Collision-free durable identity for one row inside one transcript generation. */
function echoObservationId(observation: TranscriptEchoObservation): string {
  const anchor = observation.id.trim();
  if (!anchor) return "";
  return observation.generation
    ? JSON.stringify([observation.generation, anchor])
    : anchor;
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
  const tombstones = readOccurrenceTombstones(cardId);
  if (!queue.length && !tombstones.length) return;
  const claimed = new Set([
    ...tombstones.flatMap((entry) => entry.retiredEchoId ? [entry.retiredEchoId] : []),
    ...queue.flatMap((entry) => entry.retiredEchoId ? [entry.retiredEchoId] : []),
  ]);
  const owners = [
    ...tombstones.map((entry) => ({
      type: "tombstone" as const,
      id: entry.id,
      at: entry.at,
      key: entry.key,
      echoBaseline: entry.echoBaseline,
      echoBaselineIds: entry.echoBaselineIds,
      retiredEchoId: entry.retiredEchoId,
      launchOwned: entry.launchOwned,
    })),
    ...queue.map((entry) => ({
      type: "queue" as const,
      id: entry.id,
      at: entry.at,
      key: echoKey(entry.echoText ?? entry.text),
      echoBaseline: entry.echoBaseline,
      echoBaselineIds: entry.echoBaselineIds,
      retiredEchoId: entry.retiredEchoId,
      launchOwned: entry.launchOwned,
    })),
  ].sort((left, right) => left.at - right.at);
  const retirements = new Map<string, { echoId: string; retiredAt: number }>();
  for (const entry of owners) {
    if (entry.retiredEchoId) continue;
    const baseline = new Set(entry.echoBaselineIds ?? []);
    let remainingBaseline = baseline.size ? 0 : (entry.echoBaseline ?? 0);
    const owner = ledger.find((echo) => {
      if (echo.key !== entry.key || baseline.has(echo.id)) return false;
      if (remainingBaseline > 0) {
        remainingBaseline -= 1;
        return false;
      }
      return !claimed.has(echo.id);
    });
    if (!owner) continue;
    claimed.add(owner.id);
    retirements.set(`${entry.type}:${entry.id}`, {
      echoId: owner.id,
      retiredAt: Date.now(),
    });
  }

  let tombstonesChanged = false;
  const nextTombstones = tombstones.map((entry) => {
    const retirement = retirements.get(`tombstone:${entry.id}`);
    if (!retirement) return entry;
    tombstonesChanged = true;
    return {
      ...entry,
      retiredEchoId: retirement.echoId,
      retiredAt: retirement.retiredAt,
    };
  });
  if (tombstonesChanged) persistOccurrenceTombstones(cardId, nextTombstones);

  const reservedByKey = new Map<string, { at: number; echoId: string }[]>();
  /* A newly consumed active owner can age out of an already-full completed tier
     in this same turn. Its claimed echo still advances every live successor
     before that completed history is discarded. */
  for (const tombstone of nextTombstones) {
    if (!tombstone.retiredEchoId) continue;
    const reservations = reservedByKey.get(tombstone.key) ?? [];
    reservations.push({ at: tombstone.at, echoId: tombstone.retiredEchoId });
    reservedByKey.set(tombstone.key, reservations);
  }

  let queueChanged = false;
  const nextQueue = queue.map((entry) => {
    const retirement = retirements.get(`queue:${entry.id}`);
    if (retirement) {
      queueChanged = true;
      return {
        ...entry,
        retiredEchoId: retirement.echoId,
        retiredAt: retirement.retiredAt,
      };
    }
    if (entry.retiredEchoId) return entry;
    const key = echoKey(entry.echoText ?? entry.text);
    const baselineIds = new Set(entry.echoBaselineIds ?? []);
    for (const reservation of reservedByKey.get(key) ?? []) {
      if (reservation.at <= entry.at) baselineIds.add(reservation.echoId);
    }
    if (baselineIds.size === (entry.echoBaselineIds?.length ?? 0)) return entry;
    queueChanged = true;
    return {
      ...entry,
      echoBaseline: Math.max(entry.echoBaseline ?? 0, baselineIds.size),
      echoBaselineIds: [...baselineIds],
    };
  });
  for (const entry of nextTombstones) {
    if (!entry.launchOwned || !entry.retiredEchoId) continue;
    recordCurrentLaunchRetirement(cardId, {
      id: entry.id,
      at: entry.at,
      retiredEchoId: entry.retiredEchoId,
      retiredAt: entry.retiredAt,
    });
  }
  for (const entry of nextQueue) {
    if (!entry.launchOwned || !entry.retiredEchoId) continue;
    recordCurrentLaunchRetirement(cardId, {
      id: entry.id,
      at: entry.at,
      retiredEchoId: entry.retiredEchoId,
      retiredAt: entry.retiredAt,
    });
  }
  if (queueChanged) write(cardId, nextQueue);
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
    const id = echoObservationId(observation);
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
 * A `delivered` bubble also retires the moment the rendered transcript holds a
 * record NEWER than its delivery (`newestTranscriptAtMs` past `settledAt` plus
 * {@link OUTBOX_MTIME_GRACE_MS}). The window tail renders outbox bubbles after
 * every flushed transcript row, so a delivered bubble whose echo was missed —
 * a scaffolded payload, a tail window attached after the echo, a capped tail —
 * would otherwise pin the operator's message BELOW the agent's newer tool
 * calls and reply until the TTL. Delivery is already proven; once the
 * transcript grew past it the bubble must leave the tail. Pending and failed
 * entries are untouched: they carry state the transcript cannot show.
 *
 * `transcriptEchoCounts` maps each trimmed transcript user-text to its occurrence
 * count in the rendered transcript.
 */
export function visibleOutbox(
  queue: readonly OutboxEntry[],
  transcriptEchoCounts: TranscriptEchoCounts,
  nowMs: number,
  paneOwner?: OutboxOwner | null,
  newestTranscriptAtMs?: number,
): OutboxEntry[] {
  const consumed = new Map<string, number>();
  const visible: OutboxEntry[] = [];
  for (const entry of queue) {
    /* Production passes an exact canonical conversation+generation owner. A
       launch row with a foreign, legacy string, or missing owner fails closed;
       the server projection upgrades a legitimate ownerless optimistic seed on
       its own pane. Ordinary composer rows remain scoped by their queue. */
    if (paneOwner !== undefined && entry.launchOwned) {
      if (!paneOwner || !sameOutboxOwner(entry.owner, paneOwner)) continue;
    }
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
      if (
        newestTranscriptAtMs !== undefined
        && newestTranscriptAtMs >= settledAt + OUTBOX_MTIME_GRACE_MS
      ) continue;
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
  occurrenceTombstones.clear();
  currentLaunches.clear();
}
