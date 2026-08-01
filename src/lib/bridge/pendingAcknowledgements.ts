"use client";

/**
 * Bridge acknowledgements that have not landed yet (#691 round 8).
 *
 * An acknowledgement token is the only thing that can settle a delivered batch, and
 * two paths were losing it in the same way — by holding it somewhere with a shorter
 * life than the thing it was waiting for:
 *
 * - the composer kept turn-start tokens in a component ref, so an unmount dropped
 *   them and the reports repeated on the next turn;
 * - the relay kept its delivery→token map in an effect closure, so a call-phase
 *   transition tore it down before the host confirmed, and the confirmation arrived
 *   with nothing left to spend.
 *
 * So the tokens live here instead: module-scoped, keyed by the thing they are waiting
 * on, and mirrored into `sessionStorage` so a remount — or a reload mid-call — finds
 * them again. A token is removed only after the server has actually accepted it, which
 * is what makes a failed POST a retry rather than a loss.
 *
 * Bounded, because an unspendable token would otherwise accumulate forever: the oldest
 * entries fall off, and a dropped one costs a repeated report, never a lost one.
 */

const STORAGE_KEY = "llv.bridge.pendingAcks";
const CAPACITY = 32;

/** `waitingOn` is a delivery id for the live path, or a composer delivery key for the
    turn-start path. The two never collide, and neither needs to know about the other.

    `sessionId` records WHICH call drained the batch (#845). Without it the relay's
    retry sweep replayed every parked token under whatever credential happened to be
    live, so a token from a previous call was spent against a session that never
    received its batch — and, on a refused credential, thirty-two of them were
    attempted per poll. `null` means the token predates the stamp or survived a
    reload; those are still swept, because a token nobody claims is still the only
    thing that can settle its batch. */
type Pending = { waitingOn: string; ackToken: string; at: number; sessionId: string | null };

let pending: Pending[] = [];
let hydrated = false;

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    if (!Array.isArray(parsed)) return;
    pending = parsed.flatMap((entry) => {
      const candidate = entry as Partial<Pending>;
      return typeof candidate?.waitingOn === "string" && typeof candidate.ackToken === "string"
        ? [{
          waitingOn: candidate.waitingOn,
          ackToken: candidate.ackToken,
          at: Number(candidate.at) || 0,
          sessionId: typeof candidate.sessionId === "string" ? candidate.sessionId : null,
        }]
        : [];
    });
  } catch {
    /* No storage, or unreadable: the in-memory list still covers this page. */
  }
}

function persist(): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
  } catch {
    /* see hydrate */
  }
}

/** Park a token until whatever it is waiting on is confirmed. */
export function rememberBridgeAcknowledgement(
  waitingOn: string,
  ackToken: string,
  options: { now?: number; sessionId?: string | null } = {},
): void {
  if (!waitingOn || !ackToken) return;
  hydrate();
  const entry: Pending = {
    waitingOn,
    ackToken,
    at: options.now ?? Date.now(),
    sessionId: options.sessionId ?? null,
  };
  pending = [...pending.filter((candidate) => candidate.waitingOn !== waitingOn), entry].slice(-CAPACITY);
  persist();
}

/** The token waiting on this, if any. Does NOT remove it: removal is for success. */
export function bridgeAcknowledgementFor(waitingOn: string): string | null {
  hydrate();
  return pending.find((entry) => entry.waitingOn === waitingOn)?.ackToken ?? null;
}

/** Everything still unspent — the replay set after a remount or a reload, oldest
    first so a bounded sweep drains the longest-waiting batch rather than the newest. */
export function pendingBridgeAcknowledgements(): { waitingOn: string; ackToken: string; sessionId: string | null }[] {
  hydrate();
  return pending.map(({ waitingOn, ackToken, sessionId }) => ({ waitingOn, ackToken, sessionId }));
}

/**
 * Drop a token, and ONLY after the server accepted it.
 *
 * Dropping on the way out was the original defect: a refused or dropped POST then left
 * the cursor parked with nothing able to settle it.
 */
export function forgetBridgeAcknowledgement(waitingOn: string): void {
  hydrate();
  const next = pending.filter((entry) => entry.waitingOn !== waitingOn);
  if (next.length === pending.length) return;
  pending = next;
  persist();
}

/** Tests only. */
export function resetBridgeAcknowledgementsForTests(): void {
  pending = [];
  hydrated = false;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing stored */
  }
}
