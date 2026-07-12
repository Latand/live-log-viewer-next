/** Node shape the expanded-overlay resolver needs — just the identity fields. */
export interface ExpandedCandidate {
  file: { path: string; predecessorPath?: string | null };
}

/**
 * Resolves the board's expanded node from the stored `expanded` transcript path,
 * tolerating an account/compaction succession. After succession the predecessor
 * entry is dropped from the layout and the successor appears under a new path
 * carrying `predecessorPath = <old path>`. Matching the successor by that link
 * keeps the overlay (and its rename draft in SessionTitle) mounted instead of
 * unmounting when the old path vanishes. The board then syncs `expanded` to the
 * successor's current path so further successions chain.
 */
export function resolveExpandedNode<T extends ExpandedCandidate>(nodes: readonly T[], expanded: string | null): T | null {
  if (!expanded) return null;
  return nodes.find((node) => node.file.path === expanded)
    ?? nodes.find((node) => node.file.predecessorPath === expanded)
    ?? null;
}
