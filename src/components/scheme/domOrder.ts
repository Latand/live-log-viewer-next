import type { SchemeNode } from "./layout";

/** Keep keyed hosts attached while layout activity changes visual positions. */
export function stableDomOrder<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  return [...items].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

/**
 * Reading order of the board's conversation panes: the canonical lineage
 * (issue #828), so an assistive reader walks a generation before the one it
 * spawned instead of an alphabetical shuffle of the same cards. The key is a
 * function of identity alone — never of activity or geometry — so a node going
 * quiet, or an ancestor leaving the board, still keeps every stateful host
 * attached where React left it.
 */
export function stableNodeDomOrder(nodes: readonly SchemeNode[]): SchemeNode[] {
  const keyOf = (node: SchemeNode) => node.lineageOrderKey ?? node.file.path;
  return [...nodes].sort((a, b) => {
    const left = keyOf(a);
    const right = keyOf(b);
    if (left === right) return a.file.path.localeCompare(b.file.path);
    return left < right ? -1 : 1;
  });
}
