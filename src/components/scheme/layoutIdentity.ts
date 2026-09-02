/**
 * Identity reconciliation for the board layout (#1432).
 *
 * `buildSchemeLayout` is pure: every call returns fresh node objects even when
 * nothing moved. Cards are memoised on their node, so a relayout that changed
 * nothing about a card — a poll that touched another row, a board-prefs write,
 * the 30 s clock — still re-rendered every pane on the board through the fresh
 * identities alone. Reusing the previous layout's node object wherever the
 * node is equal field for field keeps those cards' props identical, and the
 * memo does the rest.
 */
import type { SchemeLayout, SchemeNode } from "./layout";

function sameEntries<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function sameAncestry(a: SchemeNode["ancestry"], b: SchemeNode["ancestry"]): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.hostPath === b.hostPath
    && a.unresolvedParentId === b.unresolvedParentId
    && a.depth === b.depth
    && sameEntries(a.elided, b.elided);
}

/** Two nodes that would render identically: same scanned entry (by identity,
    which the files feed already keeps stable for unchanged rows), same
    geometry, same docked tasks and history, same lineage standing. */
export function sameSchemeNode(a: SchemeNode, b: SchemeNode): boolean {
  return a.file === b.file
    && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
    && a.isRoot === b.isRoot
    && a.lineageOrderKey === b.lineageOrderKey
    && sameEntries(a.tasks, b.tasks)
    && sameEntries(a.under, b.under)
    && sameAncestry(a.ancestry, b.ancestry);
}

/** The next layout with every unchanged node carried over from `previous` by
    identity; the node array itself is carried over too when nothing changed. */
export function reconcileLayoutNodes(previous: SchemeLayout | null, next: SchemeLayout): SchemeLayout {
  if (!previous) return next;
  const before = new Map(previous.nodes.map((node) => [node.file.path, node] as const));
  let reused = 0;
  const nodes = next.nodes.map((node) => {
    const prior = before.get(node.file.path);
    if (!prior || !sameSchemeNode(prior, node)) return node;
    reused += 1;
    return prior;
  });
  if (reused === 0) return next;
  const unchanged = reused === next.nodes.length && sameEntries(previous.nodes, nodes);
  return { ...next, nodes: unchanged ? previous.nodes : nodes };
}
