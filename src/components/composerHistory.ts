/**
 * Empty-composer history recall (issue #561 item 2).
 *
 * ArrowUp/ArrowDown walk the operator's previously queued and sent messages
 * when the composer is empty — the shell convention. This is the pure decision
 * behind the textarea's key handler, extracted so the navigation math (index
 * clamping, the "-1 is my own draft" sentinel, and the release-on-edit rule)
 * is directly testable without a DOM event round-trip.
 *
 * `index` is the current recall position: -1 means "the operator's own draft"
 * (nothing recalled), 0 the newest history entry, up to `history.length - 1`.
 */
export interface HistoryRecall {
  index: number;
  /** The text to place in the composer — "" when returning to the own draft. */
  text: string;
}

export function recallHistory(
  index: number,
  key: "ArrowUp" | "ArrowDown",
  history: readonly string[],
  composerEmpty: boolean,
): HistoryRecall | null {
  if (!history.length) return null;
  /* The arrows only take over navigation while nothing is being edited: either
     recall is already active, or the composer is empty. Otherwise ArrowUp/Down
     stay ordinary caret movement. */
  if (index < 0 && !composerEmpty) return null;
  const next = key === "ArrowUp"
    ? Math.min(index + 1, history.length - 1)
    : Math.max(index - 1, -1);
  if (next === index) return null;
  return { index: next, text: next < 0 ? "" : history[next] ?? "" };
}
