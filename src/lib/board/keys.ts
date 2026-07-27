import type { BoardMutationV1 } from "@/lib/board/mutations";
import type { BoardProjectStateV1 } from "@/lib/view/types";

/**
 * The board's key vocabulary — one string per independently-writable unit of
 * durable state, shared by the server (which stamps a causal revision onto every
 * key a write changes) and by every client (which fences its queued intent
 * against those revisions). Both sides must name keys identically or the fence
 * silently stops matching, so the vocabulary lives here and nowhere else.
 *
 * A key is deliberately coarser than a field and finer than the board: a
 * transcript path's placement is one key, a favourite identity is one key, and
 * each presentation field is its own key. Two devices editing different keys
 * never contend; two devices editing the same key are resolved by causality.
 */

export const VIEW_MODE_KEY = "viewMode";
export const TASK_PANEL_KEY = "taskPanelOpen";

/** Per-key causal revisions: key → the board revision at which it last changed.
    Monotonic, which is the whole point — a key driven A → B → A carries a higher
    revision than the A a stale view remembers, even though the value matches. */
export type BoardKeyRevisions = Record<string, number>;

export const pathKey = (pathname: string) => `path:${pathname}`;
export const favoriteKey = (id: string) => `favorite:${id}`;
export const foldKey = (id: string) => `fold:${id}`;
export const trayKey = (parentId: string) => `tray:${parentId}`;

function resolveThrough(pathname: string, aliases: Record<string, string>): string {
  const seen = new Set<string>();
  let resolved = pathname;
  while (aliases[resolved] !== undefined) {
    if (seen.has(resolved)) return resolved;
    seen.add(resolved);
    resolved = aliases[resolved]!;
  }
  return resolved;
}

/** A path's full placement, including whether the manual slot is a genuine user
    pin — re-pinning a reconcile-seeded root is a real write on that key. */
function placementOf(board: BoardProjectStateV1, pathname: string): string {
  if (board.prefs.hidden.includes(pathname)) return "hidden";
  if (board.prefs.expanded.includes(pathname)) return "expanded";
  if (board.prefs.manual.includes(pathname)) return (board.explicitManual ?? []).includes(pathname) ? "pinned" : "manual";
  return "absent";
}

function symmetricDifference(before: readonly string[] | undefined, after: readonly string[] | undefined): string[] {
  const left = new Set(before ?? []);
  const right = new Set(after ?? []);
  return [...new Set([...left, ...right])].filter((item) => left.has(item) !== right.has(item));
}

/**
 * The keys one write changed. The server calls this across a single reduction to
 * decide which keys to stamp with the new revision.
 *
 * Paths are compared through the resulting board's aliases, so a succession
 * remap that carried a placement to a new transcript path is not counted as a
 * change to the old path's key: bookkeeping must not read as a competing
 * operator decision and must not burn a causal revision.
 */
export function boardKeysChanged(before: BoardProjectStateV1, after: BoardProjectStateV1): Set<string> {
  const keys = new Set<string>();
  const aliases = after.pathAliases ?? {};
  const paths = new Set<string>([
    ...before.prefs.manual, ...before.prefs.hidden, ...before.prefs.expanded,
    ...after.prefs.manual, ...after.prefs.hidden, ...after.prefs.expanded,
  ]);
  for (const pathname of paths) {
    if (placementOf(before, pathname) !== placementOf(after, resolveThrough(pathname, aliases))) keys.add(pathKey(pathname));
  }
  for (const id of symmetricDifference(before.prefs.favorites, after.prefs.favorites)) keys.add(favoriteKey(id));
  for (const id of symmetricDifference(before.prefs.foldedEngineChildIds, after.prefs.foldedEngineChildIds)) keys.add(foldKey(id));
  for (const id of symmetricDifference(before.prefs.expandedEngineTrayParentIds, after.prefs.expandedEngineTrayParentIds)) keys.add(trayKey(id));
  if (before.prefs.viewMode !== after.prefs.viewMode) keys.add(VIEW_MODE_KEY);
  if (before.prefs.taskPanelOpen !== after.prefs.taskPanelOpen) keys.add(TASK_PANEL_KEY);
  return keys;
}

/** Every key a mutation would write. A mutation naming several paths (a
    reconciliation, a remap graph) travels whole, so it observes and contends on
    every path it names. */
export function mutationKeys(mutation: BoardMutationV1): string[] {
  switch (mutation.kind) {
    case "close":
    case "restore":
      return [pathKey(mutation.path)];
    case "reconcile-roots":
      return [...mutation.roots, ...mutation.removeManual].map(pathKey);
    case "remap-paths":
      return mutation.pairs.flatMap(({ from, to }) => [pathKey(from), pathKey(to)]);
    case "set-favorite":
      return [favoriteKey(mutation.id)];
    case "set-engine-child-fold":
      return [foldKey(mutation.id), pathKey(mutation.path)];
    case "set-engine-tray-expanded":
      return [trayKey(mutation.parentId)];
    case "set-presentation":
      return [
        ...(mutation.viewMode === undefined ? [] : [VIEW_MODE_KEY]),
        ...(mutation.taskPanelOpen === undefined ? [] : [TASK_PANEL_KEY]),
      ];
  }
}

/* Retired keys kept beyond the board's own content. "Off" is a real value that
   leaves no trace: un-favouriting drops the id from `favorites` entirely, yet a
   stale writer that favourited beforehand must still lose. Those keys therefore
   cannot be pruned the moment they go quiet — they are kept, most-recently-
   written first, up to this bound, so the map stays proportional to the board
   instead of growing with every transcript ever opened. A view would have to be
   behind by more than this many writes ON KEYS THAT HAVE SINCE LEFT THE BOARD
   before its intent stops being fenced. */
export const MAX_RETIRED_KEY_REVISIONS = 512;

/** The keys the board still carries in its own content: everything currently
    placed, aliased, favourited or pinned, plus the two presentation fields. */
export function liveBoardKeys(board: BoardProjectStateV1): Set<string> {
  const aliases = board.pathAliases ?? {};
  const keys = new Set<string>([VIEW_MODE_KEY, TASK_PANEL_KEY]);
  for (const pathname of [
    ...board.prefs.manual, ...board.prefs.hidden, ...board.prefs.expanded,
    ...Object.keys(aliases), ...Object.values(aliases),
  ]) keys.add(pathKey(pathname));
  for (const id of board.prefs.favorites ?? []) keys.add(favoriteKey(id));
  for (const id of board.prefs.foldedEngineChildIds ?? []) keys.add(foldKey(id));
  for (const id of board.prefs.expandedEngineTrayParentIds ?? []) keys.add(trayKey(id));
  return keys;
}

/**
 * Stamp every key this write changed with the new revision and carry the rest
 * forward. Keys the resulting board still carries are always kept; keys whose
 * subject has left the board are kept most-recently-written first, bounded by
 * {@link MAX_RETIRED_KEY_REVISIONS}.
 */
export function stampKeyRevisions(before: BoardProjectStateV1, after: BoardProjectStateV1, revision: number): BoardKeyRevisions {
  const merged: BoardKeyRevisions = { ...(before.keyRevisions ?? {}) };
  for (const key of boardKeysChanged(before, after)) merged[key] = revision;

  const live = liveBoardKeys(after);
  const stamped: BoardKeyRevisions = {};
  const retired: Array<[string, number]> = [];
  for (const [key, at] of Object.entries(merged)) {
    if (live.has(key)) stamped[key] = at;
    else retired.push([key, at]);
  }
  retired.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  for (const [key, at] of retired.slice(0, MAX_RETIRED_KEY_REVISIONS)) stamped[key] = at;
  return stamped;
}
