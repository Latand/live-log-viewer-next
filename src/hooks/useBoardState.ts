"use client";

import { useEffect, useRef, useState } from "react";

import { boardKeysChanged, type BoardKeyRevisions, canonicalKey, keyRevisionAt, mutationKeys } from "@/lib/board/keys";
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
  /* `applied` is the server's own verdict on whether this write committed or
     reduced to a no-op. A no-op is accepted from any base revision, so only that
     verdict reliably separates "my write produced this board" from "someone
     else's did and mine changed nothing" — the two are identical by content when
     both writers made the same change. Absent from a server older than this
     field; the arrangement comparison stands in for it there. */
  | { status: "ok"; applied?: boolean; board: BoardProjectStateV1 }
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

/* ── Convergence: per-key last-writer-wins, resolved by CAUSAL revision (#38).
 *
 * The writer is the device whose PATCH the server serializes last at a matching
 * `baseRevision`; the server rejects any writer whose base is behind (409). That
 * alone does not stop a stale device from winning, because the client adopts the
 * newer board and replays its outbox on top — intent formed against a picture the
 * operator has since superseded then overwrites the informed device's work.
 *
 * So every queued mutation records, per key it writes, the causal revision it
 * OBSERVED for that key when the operator formed it. Adopting a board another
 * writer moved drops any queued mutation whose key has since advanced past what
 * it observed; the rest replays on top and still lands. The last writer on a key
 * is therefore always one that acted knowing that key's current value.
 *
 * Comparing the board held against the board adopted would be cheaper and is
 * what this started as, but it is structurally blind to ABA: a key driven away
 * from a value and back — toggling a view mode, closing and reopening a window —
 * lands on a snapshot identical to the one the stale view remembers, so the
 * comparison reports "untouched" and the superseded intent wins. `keyRevisions`
 * is monotonic, so A → B → A carries a strictly higher revision than the A the
 * stale view saw. That is the whole reason the metadata is durable rather than
 * derived.
 *
 * The key vocabulary is shared with the server in `@/lib/board/keys` — both
 * sides must name keys identically or the fence silently stops matching. */

/** A queued mutation plus the causal revision it observed for each key it
    writes, captured when the operator formed it. */
interface OutboxEntry {
  mutation: BoardMutationV1;
  observed: BoardKeyRevisions;
}

function observeKeys(mutation: BoardMutationV1, board: BoardProjectStateV1): OutboxEntry {
  const observed: BoardKeyRevisions = {};
  /* Keys are canonicalized against the board this intent is formed on, and read
     through `keyRevisionAt` so an absent key picks up the compaction floor
     rather than a bare zero. */
  for (const key of mutationKeys(mutation, board.pathAliases ?? {})) observed[key] = keyRevisionAt(board, key);
  return { mutation, observed };
}

/** True when some key this entry writes has advanced past what it observed —
    another writer has spoken on that key since the operator formed this intent.
    Recorded key names are re-canonicalized against the adopted board, so intent
    formed under a transcript path that has since been aliased onto a successor
    still reads the successor's clock instead of an orphaned one. */
function superseded(entry: OutboxEntry, board: BoardProjectStateV1): boolean {
  return Object.entries(entry.observed).some(([key, at]) => keyRevisionAt(board, key) > at);
}

/** Drop the queued intent a better-informed writer has already superseded. */
export function fenceOutbox(outbox: readonly OutboxEntry[], board: BoardProjectStateV1): OutboxEntry[] {
  return outbox.filter((entry) => !superseded(entry, board));
}

/** Re-observe the keys THIS device just wrote. Our own accepted write is
    causally before intent still queued behind it — the operator formed that
    intent already knowing what they had just done — so it must not fence itself.
    Only the keys the landed prefix actually wrote are refreshed; a key some
    other writer moved in the same response stays observed at its old value and
    still supersedes. */
function reobserve(outbox: readonly OutboxEntry[], ownKeys: ReadonlySet<string>, board: BoardProjectStateV1): OutboxEntry[] {
  if (ownKeys.size === 0) return [...outbox];
  const aliases = board.pathAliases ?? {};
  return outbox.map((entry) => {
    const refreshed: BoardKeyRevisions = { ...entry.observed };
    let moved = false;
    for (const key of Object.keys(entry.observed)) {
      if (!ownKeys.has(canonicalKey(key, aliases))) continue;
      const at = keyRevisionAt(board, key);
      if (at !== refreshed[key]) {
        refreshed[key] = at;
        moved = true;
      }
    }
    return moved ? { ...entry, observed: refreshed } : entry;
  });
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

const mutationsOf = (outbox: readonly OutboxEntry[]): BoardMutationV1[] => outbox.map((entry) => entry.mutation);

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
 * THE DURABLE CONTRACT (#38), in one sentence, for anything that wants to build
 * per-project durable state on this shape:
 *
 *   One project-scoped shared store over a revision-fenced durable API, fencing
 *   every authoritative adoption with server-authored monotonic revisions per
 *   logical key, canonical across aliases and preserved through restart,
 *   migration and causally safe tombstone GC.
 *
 * Every clause is load-bearing, and each was a real defect before it was true:
 *
 * - **project-scoped shared store** — one refcounted store per project per tab.
 *   A private store per binding let one tab render two different window sets for
 *   the same project, settled only by a reload.
 * - **revision-fenced durable API** — a write carries the `baseRevision` it was
 *   formed on; the server refuses any writer whose base is behind, and the state
 *   is a file, so it survives a restart.
 * - **monotonic causal revision per key** — `keyRevisions` in `@/lib/board/keys`.
 *   Comparing the board held against the board adopted is blind to ABA: a key
 *   driven away from a value and back reads identical to one never touched, so
 *   superseded intent replayed and won. A monotonic clock cannot be fooled that
 *   way.
 * - **server-authored** — including whether a write `applied`. A no-op is
 *   accepted from ANY base revision, so an accepted response can carry another
 *   writer's board; when both writers made the same change the two boards are
 *   identical, and only the server can say which happened.
 * - **logical key, surviving aliases** — a conversation that resumes mints a new
 *   transcript path and the board aliases old onto new. Two names with
 *   independent clocks is ABA across an alias boundary, so the clocks merge by
 *   maximum onto one canonical key.
 * - **preserved through migration** — a project-key repair that folds boards
 *   together inherits their causal history by maximum. A migrated key is the
 *   same logical key, so restarting its clock from the target's history rewinds
 *   the class past writes that really happened. This holds even when the merge
 *   moves no CONTENT: history alone moving is still a change worth persisting.
 * - **causally safe tombstone GC** — retired keys are evicted under a bound, and
 *   whatever is dropped raises `keyRevisionFloor`, which every absent key reads.
 *   Evicting without a floor makes forgotten keys read as never-written and
 *   quietly re-enables every stale writer, more likely the longer a board lives.
 * - **EVERY authoritative adoption** — a board arrives from five places: a poll,
 *   a 409, an accepted write, the initial load, and the completion of the legacy
 *   seed. All five install it through `adopt` and nothing else assigns
 *   `confirmed`. The last two were direct assignments and were the third
 *   appearance of the same ABA class, after per-key and across-alias: a remount
 *   paints from the session cache and is live before its load lands, so intent
 *   queued against the cached revision has to be fenced against what the load
 *   reveals. A gate only some entry points use is not a gate.
 * - **monotonic adoption** — and the gate owes the same invariant it enforces.
 *   Responses arrive out of order, so `adopt` refuses any board older than what
 *   is confirmed; otherwise a late read rewinds the rendered board AND the
 *   session cache a later remount primes from. That comparison lives in the gate
 *   alone, so a sixth entry point cannot arrive without it.
 *   The deliberate cost: if the durable board itself ever goes backward — a
 *   state directory reset, a restore from an older backup — an open tab refuses
 *   the rewind for the rest of its session. A page reload clears the session
 *   cache and recovers. Refusing a real rewind costs a reload; accepting a late
 *   echo silently deletes work, so the bias is chosen.
 *
 * The store itself: it holds the last server-confirmed board plus an outbox of
 * unacknowledged semantic mutations (close/restore/reconcile/remap/presentation),
 * each tagged with the causal revision it observed for every key it writes. The
 * UI renders the outbox replayed over the confirmed board (optimistic), and a
 * background drain flushes it as a stable prefix.
 *
 * Adopting a board this view did not author — a revision conflict, a poll, or an
 * accepted response that turns out to carry another writer's work — does NOT
 * replay the whole outbox. Queued intent whose key has advanced past what that
 * intent observed is dropped as superseded; only intent on keys nobody else has
 * written since replays on top and retries. So a close, restore or remap
 * survives an interleaved write to a DIFFERENT key, and loses to an interleaved
 * write to the SAME key: the last writer on a key is always one that acted
 * knowing that key's current value.
 *
 * The one-time legacy seed still writes whole prefs; localStorage serves as
 * read-only migration input.
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
    keyRevisions: {},
    keyRevisionFloor: 0,
    prefs: EMPTY_BOARD_PREFS,
  });

  /* Last board the server acknowledged, and the semantic mutations not yet
     acknowledged. The optimistic arrangement is the outbox replayed over the
     confirmed board. A project loaded earlier this session primes both the
     confirmed board and `loaded` from the cache, so the first snapshot already
     carries the settled arrangement (#172) while a background GET revalidates. */
  const cachedConfirmed = confirmedBoards.get(project);
  let confirmed: BoardProjectStateV1 = cachedConfirmed ?? emptyBoard();
  let outbox: OutboxEntry[] = [];
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
    const board = optimisticBoard(confirmed, mutationsOf(outbox));
    snapshot = { prefs: board.prefs, explicitManual: board.explicitManual ?? [], revision: confirmed.revision, sync: syncFor(), loaded };
    /* Cache only a genuinely loaded, available board — never the pre-load empty
       board or an unavailable one — so a later mount primes from the settled
       arrangement and not from a placeholder that would paint an unpruned set. */
    if (loaded && !unavailable) confirmedBoards.set(project, confirmed);
    emit();
  };

  /**
   * THE causal gate. Every authoritative board — a poll, a 409, an accepted
   * write, the initial load, the completion of the legacy seed — is installed
   * through here and nowhere else. A board arriving by any other route would be
   * adopted unfenced, and a gate only some entry points use is not a gate.
   *
   * Queued intent whose key has advanced past what that intent observed is
   * superseded and dropped; the rest replays on top and still lands. Surviving
   * intent marks the view stale, because it now renders something no other
   * device has.
   *
   * `ownKeys` names keys THIS device just wrote and had acknowledged. Those are
   * re-observed instead of fenced: our own accepted write is causally before the
   * intent queued behind it — the operator formed that intent already knowing
   * what they had just done — so it must not fence itself. Pass null whenever
   * the board might carry another writer's work.
   *
   * The gate also owns MONOTONICITY, and owns it in exactly one place. Responses
   * arrive out of order — overlapping polls, a load racing the write that
   * overtakes it — and installing an older revision rewinds both the rendered
   * board and the session cache a later remount primes from, so a window that is
   * durably present visibly disappears. Every adoption path passes through here,
   * so this single comparison is the invariant rather than something each new
   * entry point has to remember.
   */
  const adopt = (board: BoardProjectStateV1, ownKeys: ReadonlySet<string> | null = null) => {
    if (board.revision < confirmed.revision) {
      /* A late echo of a board we have already moved past. Nothing to adopt, but
         `loaded` may have flipped on the way in, so the snapshot still publishes. */
      refresh();
      return;
    }
    confirmed = board;
    unavailable = false;
    if (outbox.length > 0) {
      outbox = fenceOutbox(ownKeys === null ? outbox : reobserve(outbox, ownKeys, board), board);
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
      if (res.ok) {
        const body = (await res.json()) as { applied?: boolean; board: BoardProjectStateV1 };
        return { status: "ok", applied: body.applied, board: body.board };
      }
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
      if (res.ok) {
        /* The seed is a write like any other and its verdict matters just as
           much: accepted-but-no-op means the board came from somewhere else. */
        const body = (await res.json()) as { applied?: boolean; board: BoardProjectStateV1 };
        return { status: "ok", applied: body.applied, board: body.board };
      }
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
    const before = optimisticBoard(confirmed, mutationsOf(outbox));
    /* Each mutation records the causal revision it observes for every key it
       writes, taken from the board the operator is looking at right now. That is
       the fixed point the fence compares against later. */
    const nextOutbox = [...outbox, ...mutations.map((mutation) => observeKeys(mutation, confirmed))];
    let after: BoardProjectStateV1 | null;
    try {
      after = applyBoardMutations(confirmed, mutationsOf(nextOutbox));
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
    const prefix = patchPrefix(mutationsOf(outbox), rejectCap ?? MAX_MUTATIONS_PER_PATCH);
    const result = await attemptMutations(prefix, confirmed.revision);
    inflight = false;
    if (disposed) return;
    if (result.status === "ok") {
      cancelRetry();
      conflictStreak = 0;
      rejectCap = null;
      unavailable = false;
      /* Accepted does not mean authored. The server accepts a batch that
         reduces to nothing from ANY base revision, so this response can carry a
         board another writer moved, with no 409 to mark this view as behind —
         and if that writer made the same change we did, the board it returns is
         byte-identical to the one our write would have produced. Content cannot
         separate those, so the server's own `applied` verdict decides; the
         arrangement comparison is only the fallback for a server that predates
         the field. */
      const authored = result.applied ?? sameArrangement(optimisticBoard(confirmed, prefix), result.board);
      /* Only the keys THIS prefix wrote, and only when the write was ours. */
      const ownKeys = authored
        ? new Set(prefix.flatMap((mutation) => mutationKeys(mutation, result.board.pathAliases ?? {})))
        : null;
      /* The prefix is acknowledged either way — it either committed or was a
         no-op — so it leaves the outbox before the rest is fenced. */
      outbox = outbox.slice(prefix.length);
      adopt(result.board, ownKeys);
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
         refused it. Adopt the server board; intent whose key has advanced past
         what it observed is superseded and dropped, and the rest replays on top
         and retries at the returned revision. A satisfied mutation then reduces
         to a server no-op that leaves the revision untouched. */
      adopt(result.board);
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
    /* The first load is authoritative too. A remount for a project already
       loaded this session paints from the session cache and is live before this
       lands (#172), so the operator can queue intent against the cached
       revision — which the gate must fence against whatever the load reveals.
       Decide monotonicity BEFORE the seed branch: a late response can arrive
       reporting revision 0, and the seed path would otherwise assign it
       straight to `confirmed` and rewind a board we have already moved past. */
    loaded = true;
    if (board.revision < confirmed.revision) {
      adopt(board);
      return;
    }
    if (board.revision === 0 && isEmptyPrefs(board.prefs)) {
      const seed = readLegacyPrefs(project, storage);
      if (seed && isMeaningfulPrefs(seed)) {
        /* A local optimistic paint, NOT an adoption: no server state is being
           installed, and it is replaced by a gated `adopt` the moment the seed
           PATCH answers. Keeping the loaded board's `keyRevisions` means intent
           the operator forms against this paint observes real causal history. */
        confirmed = { ...board, prefs: seed };
        inflight = true;
        refresh();
        const result = await attemptSeed(seed, 0);
        inflight = false;
        if (disposed) return;
        /* Seed completion is an adoption, so it goes through the gate. The seed
           only counts as OUR write when the server says it applied: a seed that
           reduced to a no-op was accepted from its stale revision-0 base and the
           board it returns is another writer's. When it did apply, the keys it
           wrote are re-observed so intent the operator formed against the
           optimistic seed — a close of the very node being seeded — is not
           fenced by our own seed. */
        const seeded = result.status === "ok" || result.status === "conflict" ? result.board : board;
        const seedKeys = result.status === "ok" && result.applied === true
          ? boardKeysChanged(board, result.board)
          : null;
        adopt(seeded, seedKeys);
        /* A mutation queued while the seed was inflight parked in the outbox
           because drain returns early during inflight. Flush it now so the
           queued action proceeds without another edit. */
        if (outbox.length) void drain();
        return;
      }
    }
    adopt(board);
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
          adopt(board);
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
