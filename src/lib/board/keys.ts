import type { BoardMutationV1 } from "@/lib/board/mutations";
import type { BoardProjectStateV1 } from "@/lib/view/types";

/**
 * The board's key vocabulary — one string per independently-writable unit of
 * durable state, shared by the server (which stamps a causal revision onto every
 * key a write changes) and by every client (which fences its queued intent
 * against those revisions). Both sides must name keys identically or the fence
 * silently stops matching, so the vocabulary lives here and nowhere else.
 *
 * A key names a LOGICAL thing, not a spelling of it. A conversation that resumes
 * mints a new transcript path and the board aliases the old onto the new; both
 * names must resolve to one key carrying one clock, or a stale writer holding the
 * old name looks unopposed against an informed write under the new name — ABA
 * across an alias boundary. Every read and write of a key therefore goes through
 * {@link canonicalKey} against the board's alias graph.
 */

export const VIEW_MODE_KEY = "viewMode";
export const TASK_PANEL_KEY = "taskPanelOpen";
const PATH_PREFIX = "path:";

/** Per-key causal revisions: key → the board revision at which it last changed.
    Monotonic, which is the whole point — a key driven A → B → A carries a higher
    revision than the A a stale view remembers, even though the value matches. */
export type BoardKeyRevisions = Record<string, number>;

export const pathKey = (pathname: string) => `${PATH_PREFIX}${pathname}`;
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

/**
 * The one key an alias class answers to. Path keys collapse onto the alias
 * target; identity keys (favourite, fold, tray) and presentation keys are
 * already canonical because they are keyed by durable identity rather than by
 * transcript path. Safe to apply repeatedly and to a key that is already
 * canonical.
 */
export function canonicalKey(key: string, aliases: Record<string, string>): string {
  if (!key.startsWith(PATH_PREFIX)) return key;
  return pathKey(resolveThrough(key.slice(PATH_PREFIX.length), aliases));
}

/* A path holds exactly one role on a normalized board. Two names can still
   collapse into one class mid-remap, so a class takes its most restrictive
   member: over-stating a change costs a fenced mutation, under-stating one lets
   a stale writer through, and only one of those is a correctness bug. */
const ROLE_RANK: Record<string, number> = { absent: 0, manual: 1, pinned: 2, expanded: 3, hidden: 4 };

/** Every alias class the board places, and the role it holds — keyed
    canonically, so the same logical node reads the same before and after a
    succession remap. */
function canonicalPlacements(board: BoardProjectStateV1, aliases: Record<string, string>): Map<string, string> {
  const placements = new Map<string, string>();
  const put = (pathname: string, role: string) => {
    const canonical = resolveThrough(pathname, aliases);
    const existing = placements.get(canonical);
    if (existing === undefined || (ROLE_RANK[role] ?? 0) > (ROLE_RANK[existing] ?? 0)) placements.set(canonical, role);
  };
  for (const pathname of board.prefs.hidden) put(pathname, "hidden");
  for (const pathname of board.prefs.expanded) put(pathname, "expanded");
  for (const pathname of board.prefs.manual) {
    put(pathname, (board.explicitManual ?? []).includes(pathname) ? "pinned" : "manual");
  }
  return placements;
}

function symmetricDifference(before: readonly string[] | undefined, after: readonly string[] | undefined): string[] {
  const left = new Set(before ?? []);
  const right = new Set(after ?? []);
  return [...new Set([...left, ...right])].filter((item) => left.has(item) !== right.has(item));
}

/**
 * The keys one write changed, named canonically. The server calls this across a
 * single reduction to decide which keys to stamp with the new revision.
 *
 * Both sides are read through the RESULTING board's aliases, so a succession
 * remap that carried a placement to a new transcript path is not a change at
 * all: the class held the same role before and after, only its spelling moved.
 * Bookkeeping must not read as a competing operator decision and must not burn a
 * causal revision.
 */
export function boardKeysChanged(before: BoardProjectStateV1, after: BoardProjectStateV1): Set<string> {
  const keys = new Set<string>();
  const aliases = after.pathAliases ?? {};
  const wasPlaced = canonicalPlacements(before, aliases);
  const isPlaced = canonicalPlacements(after, aliases);
  for (const canonical of new Set([...wasPlaced.keys(), ...isPlaced.keys()])) {
    if ((wasPlaced.get(canonical) ?? "absent") !== (isPlaced.get(canonical) ?? "absent")) keys.add(pathKey(canonical));
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
    every path it names. Names are canonicalized against the board the mutation
    is formed on, so intent recorded before a remap still finds its class. */
export function mutationKeys(mutation: BoardMutationV1, aliases: Record<string, string> = {}): string[] {
  const forPath = (pathname: string) => pathKey(resolveThrough(pathname, aliases));
  switch (mutation.kind) {
    case "close":
    case "restore":
      return [forPath(mutation.path)];
    case "reconcile-roots":
      return [...mutation.roots, ...mutation.removeManual].map(forPath);
    case "remap-paths":
      return mutation.pairs.flatMap(({ from, to }) => [forPath(from), forPath(to)]);
    case "set-favorite":
      return [favoriteKey(mutation.id)];
    case "set-engine-child-fold":
      return [foldKey(mutation.id), forPath(mutation.path)];
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
   instead of growing with every transcript ever opened. */
export const MAX_RETIRED_KEY_REVISIONS = 512;

/** The keys the board still carries in its own content, named canonically:
    everything currently placed, favourited or pinned, plus the two presentation
    fields. Alias sources are absent by construction — they resolve onto their
    target's key rather than holding one of their own. */
export function liveBoardKeys(board: BoardProjectStateV1): Set<string> {
  const aliases = board.pathAliases ?? {};
  const keys = new Set<string>([VIEW_MODE_KEY, TASK_PANEL_KEY]);
  for (const canonical of canonicalPlacements(board, aliases).keys()) keys.add(pathKey(canonical));
  for (const id of board.prefs.favorites ?? []) keys.add(favoriteKey(id));
  for (const id of board.prefs.foldedEngineChildIds ?? []) keys.add(foldKey(id));
  for (const id of board.prefs.expandedEngineTrayParentIds ?? []) keys.add(trayKey(id));
  return keys;
}

/**
 * Collapse a stored map onto canonical keys, merging an alias class by maximum.
 * Applied on read, so a board written before keys were unified — where an alias
 * source could still hold a clock of its own — normalizes the moment it loads
 * instead of leaving that clock unreachable behind a canonicalized lookup.
 */
export function canonicalizeKeyRevisions(revisions: BoardKeyRevisions, aliases: Record<string, string>): BoardKeyRevisions {
  const canonical: BoardKeyRevisions = {};
  for (const [key, at] of Object.entries(revisions)) {
    const name = canonicalKey(key, aliases);
    canonical[name] = Math.max(canonical[name] ?? 0, at);
  }
  return canonical;
}

/** The causal revision a board reports for a key. An absent key reads the FLOOR,
    not zero — see {@link stampKeyRevisions}. Callers pass raw key names; the
    alias graph canonicalizes them. */
export function keyRevisionAt(board: BoardProjectStateV1, key: string): number {
  const canonical = canonicalKey(key, board.pathAliases ?? {});
  return board.keyRevisions?.[canonical] ?? board.keyRevisionFloor ?? 0;
}

/**
 * Stamp every key this write changed with the new revision, carry the rest
 * forward, and compact — CAUSALLY SAFELY.
 *
 * Three things happen here, and each exists because dropping it lets a stale
 * writer win:
 *
 * 1. **Alias and provenance merge.** Keys carried forward are canonicalized
 *    first, and two names that now resolve to one class keep the MAXIMUM of
 *    their clocks. `inherited` carries the same treatment across a document
 *    boundary: when a project-key migration folds other boards into this one,
 *    their histories merge in rather than being dropped, because a migrated key
 *    is the SAME logical key and restarting its clock rewinds the class past
 *    writes that really happened. Merging by maximum means neither a rename nor
 *    a migration can ever move a clock backward.
 * 2. **Stamping.** Keys this write changed take the new revision.
 * 3. **Bounded compaction with a floor.** Keys the board still carries are kept
 *    exactly. Retired keys are kept most-recently-written first up to
 *    {@link MAX_RETIRED_KEY_REVISIONS}; whatever is dropped raises
 *    `keyRevisionFloor` to the highest revision evicted, and every absent key
 *    reads that floor. Forgetting a key without raising the floor would make it
 *    read as never-written, so a client holding intent older than the evicted
 *    history would stop being fenced and could land it — a failure that gets
 *    MORE likely the longer a board lives. The floor is monotonic and errs
 *    high: it can fence intent whose own key was never actually written, which
 *    costs a dropped mutation rather than a lost write.
 */
export type BoardCausalHistory = Pick<BoardProjectStateV1, "keyRevisions" | "keyRevisionFloor">;

export function stampKeyRevisions(
  before: BoardProjectStateV1,
  after: BoardProjectStateV1,
  revision: number,
  inherited: readonly BoardCausalHistory[] = [],
): { keyRevisions: BoardKeyRevisions; keyRevisionFloor: number } {
  const aliases = after.pathAliases ?? {};
  const merged: BoardKeyRevisions = {};
  for (const source of [before as BoardCausalHistory, ...inherited]) {
    for (const [key, at] of Object.entries(source.keyRevisions ?? {})) {
      const canonical = canonicalKey(key, aliases);
      merged[canonical] = Math.max(merged[canonical] ?? 0, at);
    }
  }
  for (const key of boardKeysChanged(before, after)) merged[key] = revision;

  const live = liveBoardKeys(after);
  const keyRevisions: BoardKeyRevisions = {};
  const retired: Array<[string, number]> = [];
  for (const [key, at] of Object.entries(merged)) {
    if (live.has(key)) keyRevisions[key] = at;
    else retired.push([key, at]);
  }
  retired.sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));

  /* A floor is a claim about history that has been forgotten, so folding
     documents together has to take the highest of them — the lowest would
     under-report what every absent key has already seen. */
  let keyRevisionFloor = Math.max(
    before.keyRevisionFloor ?? 0,
    ...inherited.map((source) => source.keyRevisionFloor ?? 0),
  );
  for (const [key, at] of retired.slice(0, MAX_RETIRED_KEY_REVISIONS)) keyRevisions[key] = at;
  for (const [, at] of retired.slice(MAX_RETIRED_KEY_REVISIONS)) keyRevisionFloor = Math.max(keyRevisionFloor, at);
  /* A retained entry at or below the floor carries nothing the floor does not
     already say, so it can go too — compaction that keeps the map small without
     ever lowering what an absent key reports. */
  for (const [key, at] of Object.entries(keyRevisions)) {
    if (!live.has(key) && at <= keyRevisionFloor) delete keyRevisions[key];
  }
  return { keyRevisions, keyRevisionFloor };
}
