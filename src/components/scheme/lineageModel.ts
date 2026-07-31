import type { FileEntry } from "@/lib/types";

import { conversationIdentity, isArchivedPredecessor } from "@/lib/accounts/identity";

/*
 * The board's ONE lineage read model (issue #828).
 *
 * Parentage arrives on a scanned entry through several non-agreeing signals:
 * the durable edge recorded at spawn (`durableLineage.parentConversationId`),
 * the durable tombstone of a deleted parent (`parentRemoved`), and the
 * scanner's transcript pointer (`file.parent`, itself derived from native
 * thread headers, provider fork sources, /proc ancestry and handoff receipts).
 * When the board re-derived the hierarchy from whichever of those happened to
 * be populated, the rendered graph changed with transient process state: a
 * stalled ancestor dropped out, an inferred pointer reattached a grandparent as
 * a CHILD, and a builder read as the spawner of its own coordinator.
 *
 * So parentage is resolved exactly once, here, from a fixed precedence, and
 * every board surface (nodes, edges, layout hosting, badges, tray membership,
 * DOM order) consumes the result instead of re-inferring:
 *
 *   1. A durable edge that NAMES a parent wins outright. The transcript pointer
 *      is then never consulted — a record that knows its own parent can only be
 *      misplaced by a competing guess. When that parent is outside the scanned
 *      window the node keeps an explicit unresolved-ancestor state; it is never
 *      re-attached to some other visible node.
 *   2. A `parentRemoved` tombstone is the same statement about a parent whose
 *      transcript is gone (a deleted worktree), so it resolves the same way.
 *   3. Only a record with NO durable parent statement falls back to the
 *      scanner's transcript pointer — engine-native subagents, compaction
 *      chains and handoffs, which is where that pointer is authoritative.
 *
 * The result is a forest: cycles (which two disagreeing signals can close) are
 * broken deterministically, so direction is a property of the model rather than
 * of the order the files happened to arrive in.
 */

/* Sorts below every character a transcript path can hold, so a parent's order
   key is an exact prefix of each child's and a codepoint comparison lists a
   generation before the one it spawned. */
const LINEAGE_ORDER_SEPARATOR = "\u0001";

export type LineageSource = "durable" | "transcript";

/** One resolved parent statement about a scanned conversation. */
export interface LineageLink {
  /** Stable identity of the parent conversation, when the record names one. */
  parentConversationId: string | null;
  /** Scanned transcript of that parent, or null when it is outside the window. */
  parentPath: string | null;
  source: LineageSource;
}

/** Where a conversation attaches on a board that renders only `visible`. */
export interface HostResolution {
  /** Nearest canonical ancestor that the board actually renders, else null. */
  host: string | null;
  /** Scanned ancestors skipped on the way to `host`, nearest first. Non-empty
      means the drawn edge spans an elided generation and must say so. */
  elided: string[];
  /** Set when the chain ends at a parent that is not in the scan at all: the
      node continues a lineage the board cannot show, and must render that
      instead of borrowing someone else's parent. */
  unresolvedParentId: string | null;
}

export interface SchemeLineage {
  /** Canonical parent statement for a scanned path, or null for a root. */
  linkOf(path: string): LineageLink | null;
  /** Canonical parent transcript, or null for a root / an off-window parent. */
  parentPathOf(path: string): string | null;
  /** Scanned ancestors, nearest first. Stops at the first off-window parent. */
  ancestorsOf(path: string): readonly string[];
  /** Generations above this node, counting an off-window parent as one. */
  depthOf(path: string): number;
  isAncestorOf(candidate: string, path: string): boolean;
  resolveHost(path: string, visible: ReadonlySet<string>): HostResolution;
  /** Sort key placing ancestors before descendants, independent of activity —
      the board's DOM order, which must not reshuffle when a node goes quiet. */
  orderKey(path: string): string;
}

/** The durable parent this record NAMES, or null when it names none. Exported
    for the surfaces that only need the per-record statement (tray membership,
    badge children) and must apply the same precedence as the graph. */
export function durableParentConversationId(file: FileEntry): string | null {
  const named = file.durableLineage?.parentConversationId ?? null;
  if (named) return named;
  return file.parentRemoved?.conversationId ?? null;
}

/** Current-generation transcript per stable conversation identity: a migrated
    card is addressed by its successor, so a durable edge recorded against the
    conversation still resolves after the account move (#40 identity contract). */
function transcriptByIdentity(files: readonly FileEntry[]): Map<string, string> {
  const byIdentity = new Map<string, FileEntry>();
  for (const file of files) {
    const id = conversationIdentity(file);
    const current = byIdentity.get(id);
    if (!current) {
      byIdentity.set(id, file);
      continue;
    }
    /* An archived predecessor never wins over its successor; otherwise the
       newer generation, then the fresher transcript, then the stable path. */
    const rank = (entry: FileEntry): number => (isArchivedPredecessor(entry) ? -1 : entry.generation ?? 0);
    const better =
      rank(file) > rank(current) ||
      (rank(file) === rank(current) && file.mtime > current.mtime) ||
      (rank(file) === rank(current) && file.mtime === current.mtime && file.path < current.path);
    if (better) byIdentity.set(id, file);
  }
  return new Map([...byIdentity].map(([id, file]) => [id, file.path]));
}

/**
 * Break every cycle two disagreeing parent statements can close, dropping the
 * link of the lexicographically greatest path on the cycle. Which link is cut
 * matters less than that the cut is a function of the identities alone: the
 * same scan must always produce the same forest, whatever order it arrived in.
 */
function breakCycles(links: Map<string, LineageLink>): void {
  const state = new Map<string, "visiting" | "done">();
  for (const start of [...links.keys()].sort()) {
    if (state.get(start) === "done") continue;
    const stack: string[] = [];
    let cursor: string | null = start;
    while (cursor && state.get(cursor) !== "done") {
      if (state.get(cursor) === "visiting") {
        const cycle = stack.slice(stack.indexOf(cursor));
        links.delete([...cycle].sort().at(-1)!);
        break;
      }
      state.set(cursor, "visiting");
      stack.push(cursor);
      cursor = links.get(cursor)?.parentPath ?? null;
    }
    for (const path of stack) state.set(path, "done");
  }
}

/**
 * Resolve the whole scan into one lineage forest. Pure: the same file set
 * always yields the same graph, so a board refresh, an activity transition, or
 * a visibility change can never reverse or flatten an edge.
 */
export function buildSchemeLineage(files: readonly FileEntry[]): SchemeLineage {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const pathByIdentity = transcriptByIdentity(files);
  const links = new Map<string, LineageLink>();
  const unresolved = new Map<string, string>();

  for (const file of files) {
    const durableParent = durableParentConversationId(file);
    if (durableParent) {
      const parentPath = pathByIdentity.get(durableParent) ?? null;
      if (parentPath === file.path) continue;
      if (parentPath === null) unresolved.set(file.path, durableParent);
      else links.set(file.path, { parentConversationId: durableParent, parentPath, source: "durable" });
      continue;
    }
    /* No durable statement: the scanner's transcript pointer is the only claim
       about this record, and it is the authoritative one for the layouts it
       covers (engine-native subagents, compaction chains, handoffs). */
    const pointer = file.parent;
    if (!pointer || pointer === file.path) continue;
    const parent = byPath.get(pointer);
    if (!parent) continue;
    links.set(file.path, {
      parentConversationId: conversationIdentity(parent),
      parentPath: parent.path,
      source: "transcript",
    });
  }
  breakCycles(links);

  const ancestorCache = new Map<string, string[]>();
  const ancestorsOf = (path: string): string[] => {
    const cached = ancestorCache.get(path);
    if (cached) return cached;
    const chain: string[] = [];
    const seen = new Set<string>([path]);
    let cursor = links.get(path)?.parentPath ?? null;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      chain.push(cursor);
      cursor = links.get(cursor)?.parentPath ?? null;
    }
    ancestorCache.set(path, chain);
    return chain;
  };
  /* The chain's far end names a parent the scan does not carry: every node
     below it continues a lineage the board cannot draw. */
  const unresolvedAt = (path: string): string | null => {
    const chain = ancestorsOf(path);
    return unresolved.get(chain.at(-1) ?? path) ?? null;
  };

  return {
    linkOf: (path) => links.get(path) ?? null,
    parentPathOf: (path) => links.get(path)?.parentPath ?? null,
    ancestorsOf,
    depthOf: (path) => ancestorsOf(path).length + (unresolvedAt(path) ? 1 : 0),
    isAncestorOf: (candidate, path) => ancestorsOf(path).includes(candidate),
    resolveHost: (path, visible) => {
      const elided: string[] = [];
      for (const ancestor of ancestorsOf(path)) {
        if (visible.has(ancestor)) return { host: ancestor, elided, unresolvedParentId: null };
        elided.push(ancestor);
      }
      return { host: null, elided, unresolvedParentId: unresolvedAt(path) };
    },
    orderKey: (path) => [...ancestorsOf(path)].reverse().concat(path).join(LINEAGE_ORDER_SEPARATOR),
  };
}
