"use client";

import { useEffect, useRef, useState } from "react";

import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import type { BoardProjectStateV1 } from "@/lib/view/types";

export type BoardPrefs = BoardProjectStateV1["prefs"];
export type BoardViewMode = BoardPrefs["viewMode"];
export type BoardSync = "current" | "pending" | "stale" | "unavailable";

const POLL_MS = 10_000;
/* Bounded PATCH retry after a network error. Re-draining synchronously spins
   thousands of failed requests in a single microtask turn and starves every
   timer (#11 review), so a failed flush waits a growing, capped, cancellable
   backoff and recovery cancels it. */
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;
/* Immediate re-sends after a revision conflict before falling back to the
   backoff timer. Each conflict means another writer landed first; we adopt the
   server board, replay the outbox on top, and retry the same prefix. A real
   consecutive conflict requires a fresh concurrent write each round, so this
   cap only guards against a pathological writer that never yields. */
const MAX_CONFLICT_RETRIES = 8;
/* Mirrors the server's per-PATCH mutation cap (`validateBoardPatchRequest`):
   an outbox that grew past it during an outage drains in accepted chunks;
   a single batch past the cap would draw the server's validation error. */
const MAX_MUTATIONS_PER_PATCH = 128;
/* Serialized-bytes target per PATCH, purely a batching-efficiency budget.
   Validity lives in the server's MAX_BOARD_BODY_BYTES, which admits every
   single validator-legal mutation — `patchPrefix` letting its first mutation
   through regardless of size stays safe. */
const MAX_PATCH_BYTES = 192 * 1024;

/** Exact serialized footprint: JSON escaping (backslashes, quotes, control
    characters) can multiply a pathname's raw UTF-8 size, and byte budgets
    must match the serialized form the server measures. */
function serializedBytes(value: unknown): number {
  const json = JSON.stringify(value);
  return typeof TextEncoder === "undefined" ? json.length : new TextEncoder().encode(json).length;
}

/** The longest outbox prefix that fits both per-PATCH batching caps
    (`maxCount` can tighten the count cap while isolating a rejected batch).
    Always at least one mutation — safe, because the server body cap admits
    any single validator-legal mutation regardless of this batching budget. */
export function patchPrefix(outbox: readonly BoardMutationV1[], maxCount = MAX_MUTATIONS_PER_PATCH): BoardMutationV1[] {
  const cap = Math.max(1, Math.min(maxCount, MAX_MUTATIONS_PER_PATCH));
  const prefix: BoardMutationV1[] = [];
  let bytes = 0;
  for (const mutation of outbox) {
    const size = serializedBytes(mutation);
    if (prefix.length > 0 && (prefix.length >= cap || bytes + size > MAX_PATCH_BYTES)) break;
    prefix.push(mutation);
    bytes += size;
  }
  return prefix;
}

export const EMPTY_BOARD_PREFS: BoardPrefs = { manual: [], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [], viewMode: null, taskPanelOpen: false };

/* Legacy per-browser keys #38 migrates off of. `llvTaskPanel` is global today;
   it seeds every project's per-project panel state and is left intact so a
   rollback keeps working. */
const legacyColumnsKey = (project: string) => `llvCols:${project}`;
const legacyViewKey = (project: string) => `llvEmptyView:${project}`;
const LEGACY_TASK_PANEL_KEY = "llvTaskPanel";

export interface BoardSnapshot {
  prefs: BoardPrefs;
  /* Genuine user placements only — the subset of `prefs.manual` the owner
     actually pinned, kept apart from the roots `reconcile-roots` auto-seeds so
     consumers can tell an intentional pin from board bookkeeping (issue #112). */
  explicitManual: string[];
  revision: number;
  sync: BoardSync;
  loaded: boolean;
}

export function isEmptyPrefs(prefs: BoardPrefs): boolean {
  return prefs.manual.length === 0 && prefs.hidden.length === 0 && prefs.expanded.length === 0 && prefs.favorites.length === 0
    && (prefs.foldedEngineChildIds?.length ?? 0) === 0 && (prefs.expandedEngineTrayParentIds?.length ?? 0) === 0
    && prefs.viewMode === null && !prefs.taskPanelOpen;
}

/** Worth seeding the server with: anything a user actually arranged. Empty
    defaults leave the server uninitialized so the first real device wins. */
export function isMeaningfulPrefs(prefs: BoardPrefs): boolean {
  return !isEmptyPrefs(prefs);
}

function readStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

/** Reconstruct a project's arrangement from the old localStorage tiers, for the
    one-time migration seed. Returns null when nothing legacy exists. */
export function readLegacyPrefs(project: string, storage: Pick<Storage, "getItem"> | null): BoardPrefs | null {
  if (!storage) return null;
  let columns: { manual: string[]; hidden: string[]; expanded: string[] } = { manual: [], hidden: [], expanded: [] };
  let hadColumns = false;
  try {
    const raw = storage.getItem(legacyColumnsKey(project));
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      columns = { manual: readStringArray(parsed.manual), hidden: readStringArray(parsed.hidden), expanded: readStringArray(parsed.expanded) };
      hadColumns = true;
    }
  } catch {
    /* corrupt legacy blob — treat as absent */
  }
  const savedView = storage.getItem(legacyViewKey(project));
  const viewMode: BoardViewMode = savedView === "scheme" || savedView === "list" ? savedView : null;
  const taskPanelOpen = storage.getItem(LEGACY_TASK_PANEL_KEY) === "1";
  if (!hadColumns && viewMode === null && !taskPanelOpen) return null;
  /* Favorites and tray pins are server-only (issues #185/#142) — no legacy
     per-browser tier feeds them, so the migration seed carries empty lists. */
  return { ...columns, favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [], viewMode, taskPanelOpen };
}

/** Coalesce two partial patches: later keys win, so a burst of edits collapses
    into a single PATCH carrying the net intent. */
export function mergePatch(base: Partial<BoardPrefs> | null, next: Partial<BoardPrefs>): Partial<BoardPrefs> {
  return { ...(base ?? {}), ...next };
}

interface PendingOpen {
  manual: string[];
  expanded: string[];
}
/* Cross-project opens: a conversation added to a project's board before that
   project mounts. The intent is recorded here and flushed by that project's
   store on its next load (or at once if the store is already mounted), so the
   opened window survives the GET/PATCH race and reaches other devices. */
const pendingOpens = new Map<string, PendingOpen>();
const activeStores = new Map<string, () => void>();

/* Session cache of the last server-confirmed board per project (#172). A store
   for a project already loaded this session primes from here — it renders the
   settled arrangement on its first frame and only background-revalidates,
   instead of starting empty and culling to the pruned set. Only confirmed
   (non-optimistic, non-unavailable) boards are cached, so a stale entry can
   never widen the board beyond what the server last acknowledged. */
const confirmedBoards = new Map<string, BoardProjectStateV1>();

/**
 * Pre-add a conversation to a project's board. A child conversation (`connected`
 * = isChildConversation, what the tree can nest) goes into the expand set so it
 * renders wired below its parent; anything else becomes a standalone manual
 * node. Records the intent and, if that project's board is mounted, flushes it.
 */
export function queueColumnOpen(project: string, path: string, connected = false): void {
  const entry = pendingOpens.get(project) ?? { manual: [], expanded: [] };
  if (connected) {
    if (!entry.expanded.includes(path)) entry.expanded.push(path);
  } else if (!entry.manual.includes(path)) {
    entry.manual.push(path);
  }
  pendingOpens.set(project, entry);
  activeStores.get(project)?.();
}

/** Test seam: clears queued cross-project opens, the session board cache and any
    shared project store, so a board confirmed in one test never primes the next. */
export function resetPendingOpensForTest(): void {
  pendingOpens.clear();
  activeStores.clear();
  confirmedBoards.clear();
  for (const entry of sharedStores.values()) entry.store.dispose();
  sharedStores.clear();
}

type WriteAttempt =
  | { status: "ok"; board: BoardProjectStateV1 }
  | { status: "conflict"; board: BoardProjectStateV1 }
  /* The server's validator refused the batch content itself, identified by a
     structured permanent error code. Resending the same bytes can never
     succeed, so the batch must be dropped — retrying it forever wedges every
     later mutation queued behind it (the /api/board 413 storm). Access
     failures (401/403) and other transient 4xx keep the queued intent and
     take the backoff path. */
  | { status: "rejected" }
  /* The request envelope is refused (client/server schema skew): every
     bisected prefix would draw the same verdict, so shedding is wrong — the
     outbox survives and the board reports unavailable until versions align. */
  | { status: "envelope" }
  | { status: "error" };

/* Mutation-content verdicts that no retry can change; bisection isolates the
   offending mutation. Envelope-level failures (schema-version skew) apply to
   every request equally, so they keep the outbox and surface as unavailable. */
const PERMANENT_REJECTION_CODES = new Set(["INVALID_REQUEST", "PAYLOAD_TOO_LARGE"]);
const ENVELOPE_REJECTION_CODES = new Set(["UNSUPPORTED_SCHEMA_VERSION"]);

/** Two boards carry the same durable arrangement when their prefs and aliases
    match — the same comparison the server uses to treat a mutation as a no-op. */
function sameArrangement(left: BoardProjectStateV1, right: BoardProjectStateV1): boolean {
  return (
    JSON.stringify({ prefs: left.prefs, pathAliases: left.pathAliases ?? {}, explicitManual: left.explicitManual ?? [] }) ===
    JSON.stringify({ prefs: right.prefs, pathAliases: right.pathAliases ?? {}, explicitManual: right.explicitManual ?? [] })
  );
}

/* ── Convergence: per-key last-writer-wins, fenced by observation (#38).
 *
 * The writer is the device whose PATCH the server serializes last at a matching
 * `baseRevision`; the server rejects any writer whose base is behind (409). That
 * alone does not stop a stale device from winning, because the client adopts the
 * newer board and replays its outbox on top — intent formed against a picture the
 * operator has since superseded then overwrites the informed device's work.
 *
 * So when a view adopts a board it did not author, it diffs the board it held
 * against the one it adopted to learn which KEYS another writer changed, and
 * drops its own queued mutations naming those keys. Queued mutations naming
 * untouched keys replay on top and still land. The last writer is therefore
 * always one that acted with knowledge of the current value of the key it wrote;
 * a view that has fallen behind loses exactly the keys it is behind on.
 *
 * A key is one independently-writable unit of the board: a transcript path's
 * placement, a favourite/tray identity, or one presentation field. */

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
 * The keys another writer changed between the board this view held and the one
 * it adopted. Paths are compared through the adopted board's aliases, so a
 * succession remap that carried a placement to a new transcript path reads as no
 * change — bookkeeping must not look like a competing operator decision.
 */
export function foreignKeys(before: BoardProjectStateV1, after: BoardProjectStateV1): Set<string> {
  const keys = new Set<string>();
  const aliases = after.pathAliases ?? {};
  const paths = new Set<string>([
    ...before.prefs.manual, ...before.prefs.hidden, ...before.prefs.expanded,
    ...after.prefs.manual, ...after.prefs.hidden, ...after.prefs.expanded,
  ]);
  for (const pathname of paths) {
    if (placementOf(before, pathname) !== placementOf(after, resolveThrough(pathname, aliases))) keys.add(`path:${pathname}`);
  }
  for (const id of symmetricDifference(before.prefs.favorites, after.prefs.favorites)) keys.add(`favorite:${id}`);
  for (const id of symmetricDifference(before.prefs.foldedEngineChildIds, after.prefs.foldedEngineChildIds)) keys.add(`fold:${id}`);
  for (const id of symmetricDifference(before.prefs.expandedEngineTrayParentIds, after.prefs.expandedEngineTrayParentIds)) keys.add(`tray:${id}`);
  if (before.prefs.viewMode !== after.prefs.viewMode) keys.add("viewMode");
  if (before.prefs.taskPanelOpen !== after.prefs.taskPanelOpen) keys.add("taskPanelOpen");
  return keys;
}

/** Every key a queued mutation would write. A mutation naming several paths
    (a reconciliation, a remap graph) travels whole, so one superseded path
    supersedes the batch — it was computed against the picture that moved. */
export function mutationKeys(mutation: BoardMutationV1): string[] {
  switch (mutation.kind) {
    case "close":
    case "restore":
      return [`path:${mutation.path}`];
    case "reconcile-roots":
      return [...mutation.roots, ...mutation.removeManual].map((pathname) => `path:${pathname}`);
    case "remap-paths":
      return mutation.pairs.flatMap(({ from, to }) => [`path:${from}`, `path:${to}`]);
    case "set-favorite":
      return [`favorite:${mutation.id}`];
    case "set-engine-child-fold":
      return [`fold:${mutation.id}`, `path:${mutation.path}`];
    case "set-engine-tray-expanded":
      return [`tray:${mutation.parentId}`];
    case "set-presentation":
      return [
        ...(mutation.viewMode === undefined ? [] : ["viewMode"]),
        ...(mutation.taskPanelOpen === undefined ? [] : ["taskPanelOpen"]),
      ];
  }
}

/** Drop the queued intent a better-informed writer has already superseded. */
export function fenceOutbox(outbox: readonly BoardMutationV1[], foreign: ReadonlySet<string>): BoardMutationV1[] {
  if (foreign.size === 0) return [...outbox];
  return outbox.filter((mutation) => !mutationKeys(mutation).some((key) => foreign.has(key)));
}

/** Replay the unacknowledged outbox over the last server-confirmed board to get
    the optimistic arrangement the UI renders. The reducer normalizes and could
    in principle throw on a malformed batch; fall back to the confirmed board so a
    bad optimistic replay never blanks the arrangement. */
function optimisticBoard(confirmed: BoardProjectStateV1, outbox: readonly BoardMutationV1[]): BoardProjectStateV1 {
  if (outbox.length === 0) return confirmed;
  try {
    return applyBoardMutations(confirmed, outbox);
  } catch {
    return confirmed;
  }
}

export interface BoardStoreOptions {
  project: string;
  fetcher: (input: string, init?: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  storage: Pick<Storage, "getItem"> | null;
  scheduler?: {
    setInterval(fn: () => void, ms: number): ReturnType<typeof setInterval>;
    clearInterval(handle: ReturnType<typeof setInterval>): void;
    setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
    clearTimeout(handle: ReturnType<typeof setTimeout>): void;
  };
}

export interface BoardStore {
  getSnapshot(): BoardSnapshot;
  subscribe(listener: () => void): () => void;
  mutate(mutations: readonly BoardMutationV1[]): void;
  dispose(): void;
}

/**
 * The per-project durable board arrangement, moved off per-browser storage into
 * the shared server store. It holds the last server-confirmed board plus an
 * outbox of unacknowledged semantic mutations (close/restore/reconcile/remap/
 * presentation); the UI renders the outbox replayed over the confirmed board
 * (optimistic), and a background drain flushes the outbox as a stable prefix. A
 * revision conflict adopts the server board, replays the whole outbox on top, and
 * retries, preserving a close, restore or remap intent across an interleaved
 * write by another device. The one-time legacy seed still writes
 * whole prefs; localStorage serves as read-only migration input.
 */
export function createBoardStore(options: BoardStoreOptions): BoardStore {
  const { project, fetcher, storage } = options;
  const scheduler = options.scheduler ?? {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  };
  const getUrl = "/api/board?project=" + encodeURIComponent(project);

  const emptyBoard = (): BoardProjectStateV1 => ({
    schemaVersion: 1,
    revision: 0,
    updatedAt: new Date(0).toISOString(),
    pathAliases: {},
    explicitManual: [],
    prefs: EMPTY_BOARD_PREFS,
  });

  /* Last board the server acknowledged, and the semantic mutations not yet
     acknowledged. The optimistic arrangement is the outbox replayed over the
     confirmed board. A project loaded earlier this session primes both the
     confirmed board and `loaded` from the cache, so the first snapshot already
     carries the settled arrangement (#172) while a background GET revalidates. */
  const cachedConfirmed = confirmedBoards.get(project);
  let confirmed: BoardProjectStateV1 = cachedConfirmed ?? emptyBoard();
  let outbox: BoardMutationV1[] = [];
  let inflight = false;
  let loaded = cachedConfirmed !== undefined;
  let unavailable = false;
  let snapshot: BoardSnapshot = loaded
    ? { prefs: confirmed.prefs, explicitManual: confirmed.explicitManual ?? [], revision: confirmed.revision, sync: "current", loaded: true }
    : { prefs: EMPTY_BOARD_PREFS, explicitManual: [], revision: 0, sync: "unavailable", loaded: false };
  let disposed = false;
  /* Consecutive revision conflicts: each means a fresh concurrent write, so we
     retry immediately up to a cap before falling back to the backoff timer. */
  let conflictStreak = 0;
  /* Bisection cap while isolating a rejected batch: a refused multi-mutation
     PATCH drops nothing and halves the next attempt, until the offender
     stands alone and only it is shed. Reset on any accepted write. */
  let rejectCap: number | null = null;
  let retryHandle: ReturnType<typeof scheduler.setTimeout> | null = null;
  let retryDelay = RETRY_BASE_MS;
  /* This view has fallen behind: it adopted a board another writer moved while
     holding intent of its own, so what it renders is a picture no other device
     has. Published as `sync: "stale"` (and through presence to agents) until the
     outbox is fully acknowledged — a lagging view must never be silently
     trusted as current. */
  let rebased = false;
  /* Bumped whenever a PATCH is issued. A GET that started before a write must
     not install its (now superseded) board over the write's response, which is
     the authoritative post-write state. */
  let writeEpoch = 0;
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) listener();
  };
  const syncFor = (): BoardSync => {
    if (unavailable) return "unavailable";
    if (outbox.length === 0) return inflight ? "pending" : "current";
    return rebased ? "stale" : "pending";
  };
  /* Recompute the published snapshot from the confirmed board + outbox. The
     revision stays the confirmed one — optimistic mutations do not invent a
     revision the server has not assigned. */
  const refresh = () => {
    /* Every queued intent is acknowledged: this view is no longer behind. */
    if (outbox.length === 0) rebased = false;
    const board = optimisticBoard(confirmed, outbox);
    snapshot = { prefs: board.prefs, explicitManual: board.explicitManual ?? [], revision: confirmed.revision, sync: syncFor(), loaded };
    /* Cache only a genuinely loaded, available board — never the pre-load empty
       board or an unavailable one — so a later mount primes from the settled
       arrangement and not from a placeholder that would paint an unpruned set. */
    if (loaded && !unavailable) confirmedBoards.set(project, confirmed);
    emit();
  };

  /**
   * Install a board this view did not author (a poll, or the 409 response to a
   * rejected write). Whatever another writer changed in the meantime supersedes
   * this view's queued intent on those keys, so that intent is dropped rather
   * than replayed on top; the rest replays and still lands. Surviving intent
   * marks the view stale, because it now renders something no other device has.
   */
  const adoptForeign = (board: BoardProjectStateV1) => {
    const previous = confirmed;
    confirmed = board;
    unavailable = false;
    if (outbox.length > 0) {
      outbox = fenceOutbox(outbox, foreignKeys(previous, board));
      if (outbox.length > 0) rebased = true;
      else cancelRetry();
    }
    refresh();
  };

  const attemptMutations = async (mutations: readonly BoardMutationV1[], baseRevision: number): Promise<WriteAttempt> => {
    writeEpoch += 1;
    try {
      const res = await fetcher("/api/board", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, project, baseRevision, mutations }),
      });
      if (res.ok) return { status: "ok", board: ((await res.json()) as { board: BoardProjectStateV1 }).board };
      if (res.status === 409) return { status: "conflict", board: ((await res.json()) as { board: BoardProjectStateV1 }).board };
      if (res.status >= 400 && res.status < 500) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        if (body?.error !== undefined && PERMANENT_REJECTION_CODES.has(body.error)) return { status: "rejected" };
        if (body?.error !== undefined && ENVELOPE_REJECTION_CODES.has(body.error)) return { status: "envelope" };
        /* Expired auth (403 from the proxy), rate limiting, unknown codes:
           the queued intent survives and drains once access heals. */
        return { status: "error" };
      }
      return { status: "error" };
    } catch {
      return { status: "error" };
    }
  };

  /* The legacy seed writes whole prefs (the patch form) onto the empty
     revision-0 board — the mutation protocol only carries membership deltas. */
  const attemptSeed = async (patch: BoardPrefs, baseRevision: number): Promise<WriteAttempt> => {
    writeEpoch += 1;
    try {
      const res = await fetcher("/api/board", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, project, baseRevision, patch }),
      });
      if (res.ok) return { status: "ok", board: ((await res.json()) as { board: BoardProjectStateV1 }).board };
      if (res.status === 409) return { status: "conflict", board: ((await res.json()) as { board: BoardProjectStateV1 }).board };
      return { status: "error" };
    } catch {
      return { status: "error" };
    }
  };

  const mutate = (mutations: readonly BoardMutationV1[]) => {
    if (mutations.length === 0) return;
    /* Semantics-coupled mutations (reconcile-roots, remap-paths) always travel
       whole: the server body cap admits the worst validator-legal mutation, so
       transport never needs to split one — splitting a remap graph or a
       reconcile provably cannot preserve reducer atomicity in general. Lists
       past the item-level validator caps draw the server's atomic rejection
       and the bisection sheds only that mutation. */
    /* Drop a batch that changes nothing optimistically — an idempotent
       reconcile/remap, or a close of an already-hidden path — so it never
       reaches transport and never bumps a revision. A batch whose replay
       throws (a cyclic remap) is enqueued regardless: the optimistic
       fallback would render it indistinguishable from a no-op, and the
       server verdict plus bisection must isolate the invalid mutation while
       the valid ones sharing the batch land. */
    const before = optimisticBoard(confirmed, outbox);
    const nextOutbox = [...outbox, ...mutations];
    let after: BoardProjectStateV1 | null;
    try {
      after = applyBoardMutations(confirmed, nextOutbox);
    } catch {
      after = null;
    }
    if (after !== null && sameArrangement(before, after)) return;
    outbox = nextOutbox;
    refresh();
    void drain();
  };

  /* Flush any cross-project opens queued for this project. A queued open is an
     explicit user restore: it selects the scheme, lifts the tombstone and
     places the node — a standalone conversation as a manual node, a connected
     child expanded below its parent. Runs after load so it replays onto the
     server's arrangement. */
  const drainOpens = () => {
    if (!loaded || disposed) return;
    const open = pendingOpens.get(project);
    if (!open || (open.manual.length === 0 && open.expanded.length === 0)) return;
    pendingOpens.delete(project);
    const restores: BoardMutationV1[] = [
      { kind: "set-presentation", viewMode: "scheme" },
      ...open.manual.map((path) => ({ kind: "restore", path, placement: "manual" }) as const),
      ...open.expanded.map((path) => ({ kind: "restore", path, placement: "expanded" }) as const),
    ];
    mutate(restores);
  };

  /* Cancel a scheduled backoff and reset the delay — called on any accepted
     write and on disposal, so a healed network starts the next failure fresh. */
  const cancelRetry = () => {
    if (retryHandle !== null) {
      scheduler.clearTimeout(retryHandle);
      retryHandle = null;
    }
    retryDelay = RETRY_BASE_MS;
  };
  /* Arm the bounded backoff after repeated conflicts or a network error: one
     timer at a time, delay doubling up to the cap. The outbox drains when it
     fires, with a fresh immediate-retry budget. */
  const scheduleRetry = () => {
    if (retryHandle !== null || disposed) return;
    const delay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    retryHandle = scheduler.setTimeout(() => {
      retryHandle = null;
      conflictStreak = 0;
      void drain();
    }, delay);
  };

  const drain = async () => {
    if (inflight || disposed || outbox.length === 0) return;
    inflight = true;
    refresh();
    /* Send the outbox as a stable prefix: mutations appended while this request
       is inflight stay queued and flush on the next drain, so an earlier response
       never drops a later optimistic action. Bounded to the server's per-PATCH
       mutation and body-size caps (tightened while bisecting a rejection); a
       longer outbox drains over consecutive requests. */
    const prefix = patchPrefix(outbox, rejectCap ?? MAX_MUTATIONS_PER_PATCH);
    const result = await attemptMutations(prefix, confirmed.revision);
    inflight = false;
    if (disposed) return;
    if (result.status === "ok") {
      cancelRetry();
      conflictStreak = 0;
      rejectCap = null;
      unavailable = false;
      /* The board this write should have produced. The server accepts a batch
         that reduces to nothing from ANY base revision, so an accepted response
         can hand back a board another writer has moved — with no 409 to mark
         this view as behind. Diffing expected against returned names exactly the
         keys that writer changed, and the outbox still queued behind this prefix
         is fenced against them just as it would be after a conflict. */
      const expected = optimisticBoard(confirmed, prefix);
      confirmed = result.board;
      outbox = outbox.slice(prefix.length);
      if (outbox.length > 0) {
        outbox = fenceOutbox(outbox, foreignKeys(expected, result.board));
        if (outbox.length > 0) rebased = true;
      }
      refresh();
      if (outbox.length) void drain();
      return;
    }
    if (result.status === "rejected") {
      /* The server refused the batch as a unit without naming the offender.
         Bisect: a refused multi-mutation batch drops nothing and retries its
         first half, halving until the offender stands alone; only
         a single rejected mutation is shed. Valid mutations on either side of
         the poison all land on later attempts, and the loop terminates because
         every round either halves the attempt or shrinks the outbox. The
         dropped intent reverts optimistically on the next refresh. */
      cancelRetry();
      conflictStreak = 0;
      if (prefix.length === 1) {
        rejectCap = null;
        outbox = outbox.slice(1);
      } else {
        rejectCap = Math.max(1, Math.floor(prefix.length / 2));
      }
      refresh();
      if (outbox.length) void drain();
      return;
    }
    if (result.status === "envelope") {
      /* Schema skew: hold every queued mutation, tell the UI the board is
         unavailable, and probe again on the backoff timer — a redeploy plus
         tab reload resolves the skew and the intent then drains. */
      rejectCap = null;
      unavailable = true;
      refresh();
      scheduleRetry();
      return;
    }
    if (result.status === "conflict") {
      /* Another writer landed first, so this attempt was stale and the server
         refused it. Adopt the server board; intent this view formed against keys
         that writer changed is superseded and dropped, and the rest replays on
         top and retries at the returned revision. A satisfied mutation then
         reduces to a server no-op that leaves the revision untouched. */
      adoptForeign(result.board);
      conflictStreak += 1;
      if (outbox.length === 0) {
        conflictStreak = 0;
        return;
      }
      if (conflictStreak <= MAX_CONFLICT_RETRIES) void drain();
      else scheduleRetry();
      return;
    }
    /* Network error: keep the outbox and back off on a cancellable timer. This
       prevents failed-request spinning inside one microtask turn (#11). */
    refresh();
    scheduleRetry();
  };

  const load = async () => {
    let board: BoardProjectStateV1 | null = null;
    try {
      const res = await fetcher(getUrl);
      if (res.ok) board = ((await res.json()) as { board: BoardProjectStateV1 }).board;
    } catch {
      board = null;
    }
    if (disposed) return;
    if (!board) {
      unavailable = true;
      loaded = true;
      refresh();
      return;
    }
    if (board.revision === 0 && isEmptyPrefs(board.prefs)) {
      const seed = readLegacyPrefs(project, storage);
      if (seed && isMeaningfulPrefs(seed)) {
        /* Show the seed optimistically while its PATCH is inflight. */
        confirmed = { ...board, prefs: seed };
        loaded = true;
        inflight = true;
        refresh();
        const result = await attemptSeed(seed, 0);
        inflight = false;
        if (disposed) return;
        confirmed = result.status === "ok" || result.status === "conflict" ? result.board : board;
        refresh();
        /* A mutation queued while the seed was inflight parked in the outbox
           because drain returns early during inflight. Flush it now so the
           queued action proceeds without another edit. */
        if (outbox.length) void drain();
        return;
      }
    }
    confirmed = board;
    loaded = true;
    refresh();
  };

  /* Read where the board actually is. Deliberately NOT gated on a pending
     outbox: a read is not a write, and the old outbox gate meant a device that
     could not flush its intent — an uplink that dropped mid-drag, a laptop lid
     closed — also stopped learning that the board had moved, and rendered a
     frozen picture until a reload (#38). Unflushed intent survives adoption
     through the same fence the 409 path uses. */
  const poll = () => {
    if (inflight || disposed) return;
    const epoch = writeEpoch;
    void (async () => {
      try {
        const res = await fetcher(getUrl);
        if (!res.ok) return;
        const board = ((await res.json()) as { board: BoardProjectStateV1 }).board;
        /* A write that started or finished during this read owns the outcome:
           its response is the authoritative post-write board. */
        if (inflight || disposed || writeEpoch !== epoch) return;
        if (board.revision !== confirmed.revision) {
          adoptForeign(board);
          return;
        }
        /* Same revision, but the read itself proves the board is reachable again
           — otherwise a project still at revision 0 whose first load failed would
           stay unavailable forever, holding the dashboard skeleton. A held
           outbox means writes are still being refused (schema skew), so the
           unavailable signal stands until that intent can drain. */
        if (unavailable && outbox.length === 0) {
          unavailable = false;
          refresh();
        }
      } catch {
        /* transient — next tick retries */
      }
    })();
  };

  activeStores.set(project, drainOpens);
  void load().then(drainOpens);
  const interval = scheduler.setInterval(poll, POLL_MS);

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    mutate(mutations) {
      mutate(mutations);
    },
    dispose() {
      disposed = true;
      cancelRetry();
      if (activeStores.get(project) === drainOpens) activeStores.delete(project);
      scheduler.clearInterval(interval);
      listeners.clear();
    },
  };
}

const UNAVAILABLE_SNAPSHOT: BoardSnapshot = { prefs: EMPTY_BOARD_PREFS, explicitManual: [], revision: 0, sync: "unavailable", loaded: false };

/** The first snapshot a project's binding renders. A project already loaded this
    session starts settled from the session cache (#172) so its board paints the
    pruned arrangement immediately; everything else starts unavailable and holds
    the dashboard skeleton until the store's first load lands. Empty on the
    server (the cache is per-request), so hydration matches the first client
    render. */
function initialBoardSnapshot(project: string | null): BoardSnapshot {
  if (typeof window === "undefined" || project === null) return UNAVAILABLE_SNAPSHOT;
  const cached = confirmedBoards.get(project);
  if (!cached) return UNAVAILABLE_SNAPSHOT;
  return { prefs: cached.prefs, explicitManual: cached.explicitManual ?? [], revision: cached.revision, sync: "current", loaded: true };
}

/* One store per project per tab, refcounted across bindings. A project board is
   bound more than once in the same tab — the shell rail and the dashboard both
   mount `useBoardState(project)` — and a private store per binding gave each its
   own confirmed board, outbox and poll clock, so one tab could render two
   different window sets for one project and only a reload settled them (#38).
   Sharing makes a mutation dispatched through one binding state the other is
   already showing, and leaves exactly one writer per project per tab. */
interface SharedBoardStore {
  store: BoardStore;
  refs: number;
}
const sharedStores = new Map<string, SharedBoardStore>();

function acquireBoardStore(project: string): BoardStore {
  const existing = sharedStores.get(project);
  if (existing) {
    existing.refs += 1;
    return existing.store;
  }
  let storage: Pick<Storage, "getItem"> | null = null;
  try {
    storage = window.localStorage;
  } catch {
    storage = null;
  }
  const store = createBoardStore({ project, fetcher: (input, init) => fetch(input, init), storage });
  sharedStores.set(project, { store, refs: 1 });
  return store;
}

function releaseBoardStore(project: string): void {
  const entry = sharedStores.get(project);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  sharedStores.delete(project);
  entry.store.dispose();
}

export interface BoardState extends BoardSnapshot {
  /** Dispatch a semantic mutation batch (close/restore/reconcile/remap/
      presentation). The store replays it optimistically and flushes durably. */
  mutate(mutations: readonly BoardMutationV1[]): void;
  close(path: string): void;
  restore(path: string, placement: "auto" | "manual" | "expanded"): void;
  setViewMode(viewMode: BoardViewMode): void;
  setTaskPanelOpen(open: boolean): void;
  /** Toggle a durable conversation id in the per-project favorites set (#185). */
  setFavorite(id: string, favorite: boolean): void;
  /** Durably hand-fold / unfold an engine-native child into its parent tray
      (#142). `path` is the child's current transcript path — folding clears it
      from manual/expanded placement so it re-docks into the tray. */
  setEngineChildFold(id: string, path: string, folded: boolean): void;
  /** Durably expand / collapse a parent's engine-native subagent tray (#142). */
  setEngineTrayExpanded(parentId: string, expanded: boolean): void;
}

/**
 * React binding over `createBoardStore`: one store per project, its snapshot
 * mirrored into component state. `project === null` (overview) has no board — it
 * returns the unavailable snapshot with inert setters.
 */
export function useBoardState(project: string | null): BoardState {
  const storeRef = useRef<BoardStore | null>(null);
  /* The snapshot is tagged with the project it describes. Selecting a new
     project re-runs the effect below, but the render that changed `project`
     happens first with the previous project's snapshot still in state.
     Reporting that stale (or, for a fresh project, empty) arrangement as
     `loaded` would paint it for one frame and then cull to the real board — the
     flash (#172). Until the effect rebinds the store, the tag mismatches and the
     board reports unavailable, so the dashboard keeps its skeleton. */
  const [bound, setBound] = useState<{ project: string | null; snapshot: BoardSnapshot }>(
    () => ({ project, snapshot: initialBoardSnapshot(project) }),
  );

  useEffect(() => {
    if (typeof window === "undefined" || project === null) {
      storeRef.current = null;
      /* eslint-disable-next-line react-hooks/set-state-in-effect */
      setBound({ project, snapshot: UNAVAILABLE_SNAPSHOT });
      return;
    }
    const store = acquireBoardStore(project);
    storeRef.current = store;
    setBound({ project, snapshot: store.getSnapshot() });
    const unsubscribe = store.subscribe(() => setBound({ project, snapshot: store.getSnapshot() }));
    return () => {
      unsubscribe();
      releaseBoardStore(project);
      storeRef.current = null;
    };
  }, [project]);

  const current = bound.project === project ? bound.snapshot : UNAVAILABLE_SNAPSHOT;
  return {
    ...current,
    mutate(mutations) {
      storeRef.current?.mutate(mutations);
    },
    close(path) {
      storeRef.current?.mutate([{ kind: "close", path }]);
    },
    restore(path, placement) {
      storeRef.current?.mutate([{ kind: "restore", path, placement }]);
    },
    setViewMode(viewMode) {
      storeRef.current?.mutate([{ kind: "set-presentation", viewMode }]);
    },
    setTaskPanelOpen(open) {
      storeRef.current?.mutate([{ kind: "set-presentation", taskPanelOpen: open }]);
    },
    setFavorite(id, favorite) {
      storeRef.current?.mutate([{ kind: "set-favorite", id, favorite }]);
    },
    setEngineChildFold(id, path, folded) {
      storeRef.current?.mutate([{ kind: "set-engine-child-fold", id, path, folded }]);
    },
    setEngineTrayExpanded(parentId, expanded) {
      storeRef.current?.mutate([{ kind: "set-engine-tray-expanded", parentId, expanded }]);
    },
  };
}
