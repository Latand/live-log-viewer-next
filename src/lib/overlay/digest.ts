/**
 * Lifecycle digest chips in the overlay timeline (#691 D9).
 *
 * The overlay renders what the #686 journal relays and **implements no rate
 * limiting of its own**. That is deliberate and load-bearing: #686's policy is
 * the single flood control, for the same reason #688 routes journal events
 * through the root agent instead of giving them their own claim on the screen.
 * Coalescing ordinary churn into "3 stages advanced" happens upstream; what
 * happens here is classification, bounded display, and seen-ness.
 *
 * #686 has not landed in this repository yet, so nothing feeds this today — the
 * shape below is the contract the overlay will consume, and it is driven by
 * fixtures rather than a live journal.
 */

/**
 * Two classes, two treatments.
 *
 * `prompt` — a review verdict, a stage completed/failed/blocked, a deploy
 * result, a delivery held or expired. Appears immediately, state-coloured, and
 * is eligible for the assistant to speak.
 *
 * `routine` — a stage started, resumed, progressing. Silent, and already
 * coalesced upstream into at most one digest per five minutes.
 */
export type DigestClass = "prompt" | "routine";

const PROMPT_KINDS = new Set([
  "review-verdict",
  "stage-completed",
  "stage-failed",
  "stage-blocked",
  "deploy-succeeded",
  "deploy-failed",
  "delivery-held",
  "delivery-expired",
]);

export function classifyDigestEvent(kind: string): DigestClass {
  return PROMPT_KINDS.has(kind) ? "prompt" : "routine";
}

/** One journal event as the overlay consumes it. */
export interface DigestEvent {
  eventId: string;
  kind: string;
  /** The journal's operator-safe one-liner. Nothing else is ever rendered: no
      transcript text, no raw output, nothing beyond what #686 already bounds
      and redacts. */
  summary: string;
  at: string;
  /** What "show me that" resolves to when the operator taps the chip. */
  focus?: { conversationPath?: string; pipelineId?: string; taskId?: string };
}

export interface DigestChip extends DigestEvent {
  digestClass: DigestClass;
  seen: boolean;
}

/** Newest last, matching the timeline's own order. */
function byTime(left: DigestEvent, right: DigestEvent): number {
  return Date.parse(left.at) - Date.parse(right.at) || left.eventId.localeCompare(right.eventId);
}

export function digestChips(events: readonly DigestEvent[], seenIds: ReadonlySet<string> = new Set()): DigestChip[] {
  return [...events].sort(byTime).map((event) => ({
    ...event,
    digestClass: classifyDigestEvent(event.kind),
    seen: seenIds.has(event.eventId),
  }));
}

export interface CompactDigest {
  /** Compact holds at most one chip: 108px of timeline cannot afford to be a
      feed. The most recent unacknowledged one wins. */
  chip: DigestChip | null;
  /** Everything else, as "+N updates" — which expands by growing the window
      rather than by pushing the conversation out of a short timeline. */
  foldedCount: number;
}

export function compactDigest(chips: readonly DigestChip[]): CompactDigest {
  const unseen = chips.filter((chip) => !chip.seen);
  const pool = unseen.length > 0 ? unseen : chips;
  return {
    chip: pool.at(-1) ?? null,
    foldedCount: Math.max(0, pool.length - 1),
  };
}

/**
 * A chip counts as seen when the surface is visible AND the timeline is at its
 * tail. Anything else leaves it in the counter, so a buried window never
 * silently consumes its own notifications.
 */
export function seenAfterRender(
  chips: readonly DigestChip[],
  surface: { visible: boolean; atTail: boolean },
): Set<string> {
  if (!surface.visible || !surface.atTail) return new Set(chips.filter((chip) => chip.seen).map((chip) => chip.eventId));
  return new Set(chips.map((chip) => chip.eventId));
}

/**
 * What tapping a chip means.
 *
 * It is the OPERATOR's command — "show me that" — so it enters the attention
 * flow at `accepted`, exactly like any other thing the operator asked for. This
 * gives digests navigational value while keeping D4 whole: the journal still
 * cannot move anyone's view, and only the operator or the root agent can.
 */
export function chipCommandOrigin(): "operator" {
  return "operator";
}
