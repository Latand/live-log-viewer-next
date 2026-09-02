import type { FileEntry } from "@/lib/types";

import { BoundedLru } from "./feed/scrollMemory";
import { turnIsRunning } from "./turnDuration";

/**
 * The instant "working…" is measured from (issue #1397). The pinned footer
 * timer and the header WORKING badge both read it, so the two can never
 * disagree about the same conversation.
 *
 * The anchor is the earliest durable timestamp of the pending work:
 *
 *  - while the transcript has an open turn, that turn's start (the receipt the
 *    elapsed-time work of #1372 already counts from);
 *  - before any transcript turn exists — the starting window, where the first
 *    message is still queued or reconciling — the launch's own durable
 *    instants: its admission, or the delivery receipt when that is all an
 *    adopted window still carries.
 *
 * Switching from the launch anchor to the transcript's is a switch to a LATER
 * instant (the host journals the first record seconds after the admission), so
 * the counter would run backwards at the very moment the window comes alive.
 * It must not: a window remembers the anchor it already counted from, per
 * conversation, for as long as the same work is pending — through the record
 * landing, the board flipping the placeholder to the scanned row, and the
 * launch chips retiring on the first assistant message, which commonly all
 * arrive in the one poll — and the display only ever moves earlier. A finished
 * turn forgets it; the next turn is new work and counts from its own start. A
 * fresh window that never saw the starting window simply counts from the
 * transcript anchor.
 */
export type WorkingSinceFile = Pick<FileEntry, "lastTurn" | "activity">
  & Partial<Pick<FileEntry, "path" | "conversationId" | "spawn" | "launch">>;

interface RememberedAnchor {
  /** The open transcript turn the anchor was bound to, or null while none existed. */
  turnStartedAt: number | null;
  since: number;
}

/** Mirrors the scroll memory's bound: enough conversations for a whole board. */
const ANCHOR_MEMORY_CAP = 300;
const anchors = new BoundedLru<RememberedAnchor>(ANCHOR_MEMORY_CAP);

function earliest(values: readonly (number | null | undefined)[]): number | null {
  let result: number | null = null;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (result === null || value < result) result = value;
  }
  return result;
}

export function workingSince(file: WorkingSinceFile): number | null {
  const key = file.conversationId ?? file.path ?? null;
  if (!turnIsRunning(file)) {
    if (key) anchors.delete(key);
    return null;
  }
  const turnStartedAt = file.lastTurn && file.lastTurn.endedAt === null ? file.lastTurn.startedAt : null;
  const launch = file.spawn ?? file.launch ?? null;
  const observed = turnStartedAt ?? earliest([launch?.admittedAt, launch?.promptAt, launch?.deliveredAt]);
  const remembered = key ? anchors.get(key) : undefined;
  /* The same pending work: the same open transcript turn, or the first turn
     to open after a starting window this window was already timing. A memory
     bound to no turn can only have come from a launch anchor, so the turn that
     opens on it is that launch's own first turn — whether or not the launch
     facts still ride the row. They usually do not: the projection retires
     them the moment the agent's first visible reply lands, and in real
     rollouts that reply follows the first record inside the same board poll,
     so the first scanned row a window sees carries the transcript turn and no
     launch at all. A finished turn already forgot the memory, so a later turn
     never inherits it. */
  const samePendingWork = remembered !== undefined
    && (remembered.turnStartedAt === turnStartedAt || remembered.turnStartedAt === null);
  const since = samePendingWork ? earliest([observed, remembered.since]) : observed;
  if (since === null) {
    if (key) anchors.delete(key);
    return null;
  }
  if (key) anchors.set(key, { turnStartedAt, since });
  return since;
}

/** Test seam: forgets every remembered anchor. */
export function resetWorkingSinceForTests(): void {
  anchors.clear();
}
