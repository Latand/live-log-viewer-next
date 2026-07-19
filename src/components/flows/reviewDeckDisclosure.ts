import type { Flow } from "@/lib/flows/types";

/*
 * Deck disclosure model (#289 + #325): whether a review-round deck renders
 * expanded or as its collapsed verdict chip.
 *
 * The automatic default follows the flow lifecycle — expanded while the group
 * is actionable, collapsed the moment its latest round carries a durable
 * terminal verdict. A manual click stores a tri-state override in
 * localStorage, keyed by the flow id (which embeds the durable group key for
 * direct groups, so the pin survives restart, generation remap and alias
 * repair). An override is stamped with the latest-round MARKER it was made
 * under and is ignored once that marker changes:
 *
 *   - expanding the ACTIVE deck does not survive the verdict — the verdict
 *     changes the marker, the stale override drops, auto-collapse wins
 *     ("collapse immediately after the final verdict");
 *   - expanding the TERMINAL group is durable until a new round starts — a
 *     fresh round changes the marker and live work always surfaces (the same
 *     principle RoundDeck's front-card selection already follows);
 *   - a legacy "1" pin (the pre-#289 boolean) reads as a collapsed override
 *     with no marker, which matches any state — exactly its old durability.
 */

export type DeckDisclosure = "expanded" | "collapsed";

export interface DeckDisclosureOverride {
  v: DeckDisclosure;
  /** Latest-round marker the override was recorded under; null = legacy pin. */
  at: string | null;
}

export function reviewDeckCollapseKey(flowId: string): string {
  return `llvReviewDeckCollapsed:${flowId}`;
}

/** A deck is terminal once its flow reached a durable outcome: the final
    verdict landed (`approved` / `done_comment`) or the flow was closed. */
export function deckDisclosureTerminal(flow: Pick<Flow, "state">): boolean {
  return flow.state === "approved" || flow.state === "done_comment" || flow.state === "closed";
}

/** The invalidation marker: the latest round's identity PLUS its terminal
    state. A verdict arriving on the same round changes the marker, so an
    override made while the round was open goes stale at that exact moment; a
    fresh round changes it too, so live work always surfaces. Derived from the
    flow's own rounds so every surface (deck, worker stack row) agrees. */
export function deckDisclosureMarker(flow: Pick<Flow, "rounds">): string {
  const last = flow.rounds[flow.rounds.length - 1];
  if (!last) return "empty";
  return `r${last.n}:${last.reviewerConversationId ?? last.reviewerPath ?? "pending"}:${last.verdict ?? (last.error ? "error" : "open")}`;
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readDeckDisclosureOverride(storage: StorageLike, flowId: string): DeckDisclosureOverride | null {
  const raw = storage.getItem(reviewDeckCollapseKey(flowId));
  if (raw === null) return null;
  /* Legacy boolean pin: collapsed, marker-less (durable across rounds). */
  if (raw === "1") return { v: "collapsed", at: null };
  try {
    const parsed = JSON.parse(raw) as { v?: unknown; at?: unknown };
    if (parsed.v !== "expanded" && parsed.v !== "collapsed") return null;
    return { v: parsed.v, at: typeof parsed.at === "string" ? parsed.at : null };
  } catch {
    return null;
  }
}

export function writeDeckDisclosureOverride(storage: StorageLike, flowId: string, v: DeckDisclosure, marker: string): void {
  storage.setItem(reviewDeckCollapseKey(flowId), JSON.stringify({ v, at: marker }));
}

/**
 * The rendered disclosure: a still-valid override wins, otherwise the
 * lifecycle default (expanded while actionable, collapsed once terminal).
 */
export function deckCollapsed(override: DeckDisclosureOverride | null, marker: string, terminal: boolean): boolean {
  if (override && (override.at === null || override.at === marker)) return override.v === "collapsed";
  return terminal;
}
