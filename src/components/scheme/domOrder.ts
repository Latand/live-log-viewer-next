import type { SchemeNode } from "./layout";

/** Keep keyed hosts attached while layout activity changes visual positions. */
export function stableDomOrder<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  return [...items].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

export function stableNodeDomOrder(nodes: readonly SchemeNode[]): SchemeNode[] {
  return stableDomOrder(nodes, (node) => node.file.path);
}
