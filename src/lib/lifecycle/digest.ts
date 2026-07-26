import fs from "node:fs";

import { statePath } from "@/lib/configDir";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";

import { pageFromEvents, readLifecycleJournal, type LifecycleEvent, type LifecycleJournalFile } from "./journal";
import { isTerminalHighSignalEvent, type LifecycleEventType, type LifecycleState } from "./vocabulary";

/**
 * #686 — the bounded relay digest policy on top of the journal.
 *
 * Terminal, high-signal events reach the waiting agent at once; routine
 * progress is batched, coalesced and rate-limited to one digest per five
 * minutes per subscriber. The cursor is durable, so a reconnect or a Viewer
 * restart resumes where the last relay ended instead of replaying it.
 *
 * This is a poll, not a push: nothing here is a notification service, and no
 * raw transcript text is ever carried — items hold only the bounded, redacted
 * summary the journal already stored.
 */

/** At most one routine digest per subscriber per this window. */
export const ROUTINE_DIGEST_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MAX_ITEMS = 10;
const MAX_ITEMS_CAP = 25;
const DIGEST_STATE_VERSION = 1;

export interface DigestSubscriberState {
  cursorSeq: number;
  lastRelayAt: string | null;
  updatedAt: string;
}

export interface DigestStateFile {
  version: number;
  subscribers: Record<string, DigestSubscriberState>;
}

/** One coalesced change: when, where, which transition, one bounded line. */
export interface LifecycleDigestItem {
  at: string;
  type: LifecycleEventType;
  state: LifecycleState;
  project: string | null;
  pipelineId: string | null;
  stageId: string | null;
  conversationId: string | null;
  role: string | null;
  summary: string;
  /** How many identical-shape events collapsed into this item (>= 1). */
  count: number;
}

export interface LifecycleDigestRequest {
  /** Usually the active conversation id awaiting the work. */
  subscriberId: string;
  project?: string;
  pipelineId?: string;
  conversationId?: string;
  maxItems?: number;
  now?: number;
  /** false polls without advancing the cursor (a dry run for diagnostics). */
  acknowledge?: boolean;
}

export interface LifecycleDigestResult {
  subscriberId: string;
  /** Null when nothing is due: no pending events, or a routine batch still
      inside its rate-limit window. */
  relay: {
    reason: "terminal" | "batched";
    items: LifecycleDigestItem[];
    /** Journal seq this relay covers through. */
    through: number;
    /** Coalesced events that did not fit the bounded payload. The agent can
        query the journal for them; automatic relays stay bounded. */
    omitted: number;
  } | null;
  /** Cursor after this call — durable, so reconnect does not replay. */
  cursor: number;
  /** Events matching the subscription that are still unrelayed. */
  pending: number;
  /** When a held routine batch becomes eligible, else null. */
  heldUntil: string | null;
}

function digestStatePath(): string {
  return statePath("lifecycle-digests.json");
}

export function digestScopeKey(request: Pick<LifecycleDigestRequest, "subscriberId" | "project" | "pipelineId" | "conversationId">): string {
  const parts = [request.subscriberId, request.project ?? "", request.pipelineId ?? "", request.conversationId ?? ""];
  return parts.join("\0");
}

function emptyState(): DigestStateFile {
  return { version: DIGEST_STATE_VERSION, subscribers: {} };
}

function normalizeState(value: unknown): DigestStateFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyState();
  const file = value as Partial<DigestStateFile>;
  const subscribers: Record<string, DigestSubscriberState> = {};
  for (const [id, raw] of Object.entries(file.subscribers ?? {})) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as Partial<DigestSubscriberState>;
    subscribers[id] = {
      cursorSeq: Number.isInteger(entry.cursorSeq) && (entry.cursorSeq as number) >= 0 ? entry.cursorSeq as number : 0,
      lastRelayAt: typeof entry.lastRelayAt === "string" ? entry.lastRelayAt : null,
      updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : new Date(0).toISOString(),
    };
  }
  return { version: DIGEST_STATE_VERSION, subscribers };
}

/**
 * Unlike the journal, a lost cursor file degrades in the safe direction: a
 * subscriber that restarts at seq 0 is relayed events it has already seen, and
 * a duplicate digest is recoverable where a dropped one is not. So this one
 * really does fall back to "no subscribers yet" rather than refusing to serve.
 */
function readState(): DigestStateFile {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(digestStatePath(), "utf8")) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    return emptyState();
  }
}

function writeState(file: DigestStateFile): void {
  writeJsonDurably(digestStatePath(), file);
}

export function readDigestSubscriber(subscriberId: string): DigestSubscriberState | null {
  const scopedId = digestScopeKey({ subscriberId });
  return readState().subscribers[scopedId] ?? null;
}

/** Shape a digest item collapses on: same lineage, same transition. NUL is the
    separator because no project or lineage id can contain one, so two distinct
    lineages can never build the same key by concatenation. It is written as an
    escape: a raw NUL byte marks the whole file binary, and the relay policy
    then renders as an unreviewable binary diff. */
const SHAPE_KEY_SEPARATOR = "\u0000";

function digestShapeKey(event: LifecycleEvent): string {
  return [event.type, event.project, event.pipelineId, event.stageId, event.conversationId].join(SHAPE_KEY_SEPARATOR);
}

function itemFromEvents(events: LifecycleEvent[]): LifecycleDigestItem {
  const first = events[0]!;
  const last = events.at(-1)!;
  return {
    at: last.at,
    type: first.type,
    state: last.state,
    project: first.project,
    pipelineId: first.pipelineId,
    stageId: first.stageId,
    conversationId: first.conversationId,
    role: first.role,
    /* The newest non-empty line wins, so a coalesced item never regresses to an
       older summary just because the latest event carried none. */
    summary: [...events].reverse().find((event) => event.summary)?.summary ?? "",
    count: events.length,
  };
}

/**
 * Collapses duplicates: repeated transitions of the same shape (same lineage
 * and event type) become one item carrying the newest timestamp and summary
 * plus how many were folded in.
 */
export function coalesceDigestItems(events: LifecycleEvent[]): LifecycleDigestItem[] {
  const grouped = new Map<string, LifecycleEvent[]>();
  for (const event of events) {
    const key = digestShapeKey(event);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(event);
    else grouped.set(key, [event]);
  }
  return [...grouped.values()].map(itemFromEvents);
}

interface DigestPayload {
  items: LifecycleDigestItem[];
  /** Highest seq every pending event up to which is carried by `items`. The
      cursor may never move past this. */
  through: number;
  /** Coalesced items the bound left out of this payload. They stay pending. */
  omitted: number;
  /** Whether the payload itself carries a terminal high-signal event. */
  carriesTerminal: boolean;
}

/**
 * The bound, applied so that neither guarantee can be traded away.
 *
 * Two rules fight over a payload that does not fit. Terminal high-signal events
 * must reach the agent — they are the ones it cannot decide without. And the
 * durable cursor may only advance across events that were actually relayed,
 * because anything it skips is never offered again. Trimming the payload from
 * the old end while advancing the cursor to the newest pending seq breaks the
 * second rule, and that is how a terminal event gets silently dropped.
 *
 * So: terminal items are selected first and are never trimmed away, the item
 * owning the OLDEST pending event is always carried (that is what guarantees
 * forward progress — without it a full payload of newer terminal items would
 * hold the cursor at the same place forever), and `through` is only the
 * contiguous prefix that was genuinely carried. A terminal item ahead of that
 * prefix is relayed now and stays pending until the cursor reaches it: relayed
 * twice at worst, never zero times.
 */
function selectDigestPayload(events: LifecycleEvent[], maxItems: number, cursorSeq: number): DigestPayload {
  const order: string[] = [];
  const grouped = new Map<string, LifecycleEvent[]>();
  for (const event of events) {
    const key = digestShapeKey(event);
    const bucket = grouped.get(key);
    if (bucket) bucket.push(event);
    else {
      grouped.set(key, [event]);
      order.push(key);
    }
  }
  const terminalKeys = order.filter((key) => grouped.get(key)!.some((event) => isTerminalHighSignalEvent(event.type)));
  const selected = new Set<string>(terminalKeys.slice(0, maxItems));
  const oldestKey = order[0];
  if (oldestKey !== undefined && !selected.has(oldestKey)) {
    /* No room left: give the oldest item the slot of the newest terminal one.
       That terminal item sits beyond the prefix the cursor will reach, so the
       next poll still relays it. */
    if (selected.size >= maxItems) selected.delete(terminalKeys[selected.size - 1]!);
    selected.add(oldestKey);
  }
  for (const key of order) {
    if (selected.size >= maxItems) break;
    selected.add(key);
  }

  let through = cursorSeq;
  for (const event of events) {
    if (!selected.has(digestShapeKey(event))) break;
    through = event.seq;
  }
  const items = order.filter((key) => selected.has(key)).map((key) => itemFromEvents(grouped.get(key)!));
  return {
    items,
    through,
    omitted: order.length - selected.size,
    carriesTerminal: items.some((item) => isTerminalHighSignalEvent(item.type)),
  };
}

function parseMs(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The whole policy, pure over an already-read journal so it can be tested
 * without touching a live registry.
 *
 * Routine batches open at the OLDEST pending routine event and are released a
 * full interval later, which is what turns several events inside five minutes
 * into exactly one digest. The rate limit is applied on top of that window, so
 * a subscriber that just received a terminal relay still waits its interval
 * before the next routine one. A terminal high-signal event releases everything
 * pending immediately — the waiting agent cannot decide without it.
 */
export function evaluateDigest(
  file: LifecycleJournalFile,
  request: LifecycleDigestRequest,
  subscriber: DigestSubscriberState,
): LifecycleDigestResult {
  const now = Number.isFinite(request.now) ? request.now as number : Date.now();
  const maxItems = Math.max(1, Math.min(MAX_ITEMS_CAP, Number.isInteger(request.maxItems) ? request.maxItems as number : DEFAULT_MAX_ITEMS));
  const page = pageFromEvents(file, {
    project: request.project,
    pipelineId: request.pipelineId,
    conversationId: request.conversationId,
    afterSeq: subscriber.cursorSeq,
    limit: 200,
  });
  const pendingEvents = page.events;
  const base = {
    subscriberId: request.subscriberId,
    cursor: subscriber.cursorSeq,
    pending: pendingEvents.length + page.remaining,
  };
  if (pendingEvents.length === 0 && page.remaining === 0) return { ...base, relay: null, heldUntil: null };

  let terminal = pendingEvents.some((event) => isTerminalHighSignalEvent(event.type));
  if (!terminal && page.remaining > 0) {
    const overflow = pageFromEvents(file, {
      project: request.project,
      pipelineId: request.pipelineId,
      conversationId: request.conversationId,
      afterSeq: pendingEvents.at(-1)?.seq ?? subscriber.cursorSeq,
      limit: 200,
    });
    terminal = overflow.events.some((event) => isTerminalHighSignalEvent(event.type));
  }
  if (pendingEvents.length === 0) return { ...base, relay: null, heldUntil: null };
  if (!terminal) {
    const oldestRoutineAt = parseMs(pendingEvents[0]!.at) ?? now;
    const lastRelayMs = parseMs(subscriber.lastRelayAt);
    const releaseAt = Math.max(oldestRoutineAt, lastRelayMs ?? oldestRoutineAt) + ROUTINE_DIGEST_INTERVAL_MS;
    if (now < releaseAt) {
      return { ...base, relay: null, heldUntil: new Date(releaseAt).toISOString() };
    }
  }

  const payload = selectDigestPayload(pendingEvents, maxItems, subscriber.cursorSeq);
  /* Everything the bound left behind is still pending, so nothing the cursor
     stopped short of is lost — it is offered again on the next poll. */
  const unrelayed = pendingEvents.filter((event) => event.seq > payload.through).length;
  return {
    subscriberId: request.subscriberId,
    relay: {
      reason: payload.carriesTerminal ? "terminal" : "batched",
      items: payload.items,
      through: payload.through,
      omitted: payload.omitted,
    },
    cursor: payload.through,
    pending: page.remaining + unrelayed,
    heldUntil: null,
  };
}

/**
 * Reads the journal, applies the policy, and durably advances the cursor when a
 * relay is emitted. The cursor write is the only mutation, so a caller that
 * crashes before consuming the relay replays it once — and a caller that
 * consumed it never sees those events again.
 */
export function pollLifecycleDigest(request: LifecycleDigestRequest): LifecycleDigestResult {
  const journal = readLifecycleJournal();
  const now = Number.isFinite(request.now) ? request.now as number : Date.now();
  const scopedId = digestScopeKey(request);
  if (request.acknowledge === false) {
    const subscriber = readDigestSubscriber(scopedId) ?? { cursorSeq: 0, lastRelayAt: null, updatedAt: new Date(now).toISOString() };
    return evaluateDigest(journal, request, subscriber);
  }
  return withFileTransactionSync(digestStatePath(), "lifecycle digest state is busy", () => {
    const state = readState();
    const subscriber = state.subscribers[scopedId]
      ?? { cursorSeq: 0, lastRelayAt: null, updatedAt: new Date(now).toISOString() };
    const result = evaluateDigest(journal, request, subscriber);
    if (!result.relay) return result;
    state.subscribers[scopedId] = {
      cursorSeq: result.cursor,
      lastRelayAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
    writeState(state);
    return result;
  });
}

/**
 * Starts a subscriber at the journal head without relaying its history. An
 * orchestrator attaching to an existing project uses this so its first poll
 * reports what changed from now on rather than everything ever recorded.
 */
export function seedLifecycleDigestCursor(subscriberId: string, now = Date.now()): DigestSubscriberState {
  const head = readLifecycleJournal().lastSeq;
  const scopedId = digestScopeKey({ subscriberId });
  return withFileTransactionSync(digestStatePath(), "lifecycle digest state is busy", () => {
    const state = readState();
    const existing = state.subscribers[scopedId];
    if (existing) return existing;
    const seeded: DigestSubscriberState = { cursorSeq: head, lastRelayAt: null, updatedAt: new Date(now).toISOString() };
    state.subscribers[scopedId] = seeded;
    writeState(state);
    return seeded;
  });
}
