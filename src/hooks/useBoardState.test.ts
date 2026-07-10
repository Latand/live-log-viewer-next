import { beforeEach, expect, test } from "bun:test";

import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import type { BoardProjectStateV1 } from "@/lib/view/types";

import {
  createBoardStore,
  EMPTY_BOARD_PREFS,
  isEmptyPrefs,
  isMeaningfulPrefs,
  mergePatch,
  queueColumnOpen,
  readLegacyPrefs,
  resetPendingOpensForTest,
  type BoardPrefs,
} from "./useBoardState";

const settle = async () => {
  for (let i = 0; i < 16; i += 1) await Promise.resolve();
};

const prefsWith = (over: Partial<BoardPrefs>): BoardPrefs => ({ ...EMPTY_BOARD_PREFS, ...over });
const boardOf = (revision: number, prefs: Partial<BoardPrefs> = {}, pathAliases: Record<string, string> = {}): BoardProjectStateV1 => ({
  schemaVersion: 1,
  revision,
  updatedAt: new Date(0).toISOString(),
  pathAliases,
  prefs: prefsWith(prefs),
});

/** Same durable arrangement the server compares to treat a write as a no-op. */
const sameReduced = (left: BoardProjectStateV1, right: BoardProjectStateV1): boolean =>
  JSON.stringify({ prefs: left.prefs, pathAliases: left.pathAliases ?? {} }) ===
  JSON.stringify({ prefs: right.prefs, pathAliases: right.pathAliases ?? {} });

/**
 * In-memory board API mirroring the real GET/PATCH contract: whole-array `patch`
 * (used by the legacy seed) and the `mutations` protocol applied through the real
 * shared reducer. A semantic no-op preserves the revision even on a stale base,
 * exactly like `mutateBoard` on the server.
 */
function fakeServer(seed: Record<string, BoardProjectStateV1> = {}) {
  const projects: Record<string, BoardProjectStateV1> = { ...seed };
  const read = (project: string) => projects[project] ?? boardOf(0);
  let patchCount = 0;
  const commit = (project: string, reduced: BoardProjectStateV1, revision: number): BoardProjectStateV1 => {
    const next: BoardProjectStateV1 = {
      ...reduced,
      schemaVersion: 1,
      revision,
      updatedAt: new Date(0).toISOString(),
      pathAliases: reduced.pathAliases ?? {},
    };
    projects[project] = next;
    return next;
  };
  const fetcher = async (input: string, init?: RequestInit) => {
    if (!init || (init.method ?? "GET") === "GET") {
      const project = new URL(input, "http://x").searchParams.get("project")!;
      return { ok: true, status: 200, json: async () => ({ ok: true, board: read(project) }) };
    }
    patchCount += 1;
    const body = JSON.parse(String(init.body)) as {
      project: string;
      baseRevision: number;
      patch?: Partial<BoardPrefs>;
      mutations?: BoardMutationV1[];
    };
    const current = read(body.project);
    const conflict = () => ({ ok: false, status: 409, json: async () => ({ error: "BOARD_REVISION_CONFLICT", board: current }) });
    if (body.mutations) {
      const reduced = applyBoardMutations(current, body.mutations);
      if (sameReduced(current, reduced)) return { ok: true, status: 200, json: async () => ({ ok: true, board: current }) };
      if (current.revision !== body.baseRevision) return conflict();
      const next = commit(body.project, reduced, current.revision + 1);
      return { ok: true, status: 200, json: async () => ({ ok: true, board: next }) };
    }
    /* Whole-array patch form: the legacy seed onto an empty revision-0 board. */
    if (current.revision !== body.baseRevision) return conflict();
    const next = boardOf(current.revision + 1, { ...current.prefs, ...body.patch });
    projects[body.project] = next;
    return { ok: true, status: 200, json: async () => ({ ok: true, board: next }) };
  };
  /* Another device landing an accepted whole-array patch. */
  const bump = (project: string, patch: Partial<BoardPrefs>) => {
    const current = read(project);
    projects[project] = boardOf(current.revision + 1, { ...current.prefs, ...patch });
  };
  /* Another device landing an accepted semantic mutation. */
  const bumpMutations = (project: string, mutations: BoardMutationV1[]) => {
    const current = read(project);
    commit(project, applyBoardMutations(current, mutations), current.revision + 1);
  };
  return { projects, fetcher, bump, bumpMutations, patchCount: () => patchCount };
}

const idleScheduler = () => {
  let pollFn = () => {};
  /* Captured backoff timers: never fire on their own, so a test drives PATCH
     retry deterministically with runTimeouts() instead of wall-clock waiting. */
  const timeouts: Array<(() => void) | null> = [];
  return {
    scheduler: {
      setInterval: (fn: () => void) => ((pollFn = fn), 1 as unknown as ReturnType<typeof setInterval>),
      clearInterval: () => {},
      setTimeout: (fn: () => void) => (timeouts.push(fn), timeouts.length as unknown as ReturnType<typeof setTimeout>),
      clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
        const index = (handle as unknown as number) - 1;
        if (timeouts[index]) timeouts[index] = null;
      },
    },
    tick: () => pollFn(),
    /** Fire every pending backoff timer once, in schedule order. */
    runTimeouts: () => {
      const due = timeouts.splice(0);
      for (const fn of due) fn?.();
    },
    pendingTimeouts: () => timeouts.filter((fn) => fn !== null).length,
  };
};

beforeEach(() => resetPendingOpensForTest());

test("prefs emptiness and meaningfulness", () => {
  expect(isEmptyPrefs(EMPTY_BOARD_PREFS)).toBe(true);
  expect(isMeaningfulPrefs(EMPTY_BOARD_PREFS)).toBe(false);
  expect(isMeaningfulPrefs(prefsWith({ manual: ["/a"] }))).toBe(true);
  expect(isMeaningfulPrefs(prefsWith({ viewMode: "list" }))).toBe(true);
  expect(isMeaningfulPrefs(prefsWith({ taskPanelOpen: true }))).toBe(true);
});

test("readLegacyPrefs reconstructs the three old localStorage tiers", () => {
  const map = new Map<string, string>([
    ["llvCols:proj", JSON.stringify({ manual: ["/a"], hidden: ["/b"], expanded: ["/c"] })],
    ["llvEmptyView:proj", "list"],
    ["llvTaskPanel", "1"],
  ]);
  const storage = { getItem: (key: string) => map.get(key) ?? null };
  expect(readLegacyPrefs("proj", storage)).toEqual({ manual: ["/a"], hidden: ["/b"], expanded: ["/c"], viewMode: "list", taskPanelOpen: true });
  expect(readLegacyPrefs("other", storage)).toEqual({ manual: [], hidden: [], expanded: [], viewMode: null, taskPanelOpen: true });
  expect(readLegacyPrefs("proj", { getItem: () => null })).toBeNull();
});

test("mergePatch lets later keys win", () => {
  expect(mergePatch({ manual: ["/a"] }, { hidden: ["/b"] })).toEqual({ manual: ["/a"], hidden: ["/b"] });
  expect(mergePatch({ taskPanelOpen: false }, { taskPanelOpen: true })).toEqual({ taskPanelOpen: true });
  expect(mergePatch(null, { viewMode: "scheme" })).toEqual({ viewMode: "scheme" });
});

test("loads and adopts the server board", async () => {
  const server = fakeServer({ proj: boardOf(4, { manual: ["/a"], viewMode: "scheme" }) });
  const store = createBoardStore({ project: "proj", fetcher: server.fetcher, storage: null, scheduler: idleScheduler().scheduler });
  await settle();
  expect(store.getSnapshot()).toMatchObject({ revision: 4, sync: "current", loaded: true, prefs: prefsWith({ manual: ["/a"], viewMode: "scheme" }) });
  store.dispose();
});

test("one-time migration seeds revision 0 from legacy localStorage", async () => {
  const server = fakeServer(); // proj is uninitialized (revision 0, empty)
  const storage = { getItem: (key: string) => (key === "llvCols:proj" ? JSON.stringify({ manual: ["/seed"], hidden: [], expanded: [] }) : null) };
  const store = createBoardStore({ project: "proj", fetcher: server.fetcher, storage, scheduler: idleScheduler().scheduler });
  await settle();
  /* The seed is written as revision 1 and becomes the shared source of truth. */
  expect(server.projects.proj.revision).toBe(1);
  expect(server.projects.proj.prefs.manual).toEqual(["/seed"]);
  expect(store.getSnapshot()).toMatchObject({ revision: 1, sync: "current", prefs: prefsWith({ manual: ["/seed"] }) });
  store.dispose();
});

test("an edit queued during the legacy seed PATCH drains as soon as the seed lands", async () => {
  const server = fakeServer(); // proj uninitialized (revision 0, empty)
  const storage = { getItem: (key: string) => (key === "llvCols:proj" ? JSON.stringify({ manual: ["/seed"], hidden: [], expanded: [] }) : null) };
  /* Gate the seed PATCH open so an edit can be queued while it is inflight. */
  let releaseSeed = () => {};
  const seedGate = new Promise<void>((resolve) => (releaseSeed = resolve));
  let patchCount = 0;
  const fetcher = async (input: string, init?: RequestInit) => {
    if (!init || (init.method ?? "GET") === "GET") return server.fetcher(input, init);
    patchCount += 1;
    if (patchCount === 1) await seedGate; // hold the seed PATCH inflight
    return server.fetcher(input, init);
  };
  const store = createBoardStore({ project: "proj", fetcher, storage, scheduler: idleScheduler().scheduler });
  await settle(); // load(): GET resolves, the seed PATCH is now inflight and gated
  store.mutate([{ kind: "set-presentation", viewMode: "list" }]); // queued while the seed is inflight (drain early-returns)
  expect(store.getSnapshot().prefs.viewMode).toBe("list"); // optimistic
  releaseSeed();
  await settle();
  /* Without the post-seed drain the edit stays stranded (patchCount === 1) until
     a later edit; it must flush as soon as the seed completes. */
  expect(patchCount).toBe(2);
  expect(store.getSnapshot()).toMatchObject({ sync: "current", prefs: prefsWith({ manual: ["/seed"], viewMode: "list" }) });
  expect(server.projects.proj.prefs.viewMode).toBe("list");
  expect(server.projects.proj.prefs.manual).toEqual(["/seed"]);
  store.dispose();
});

test("an empty legacy state leaves the server uninitialized", async () => {
  const server = fakeServer();
  const store = createBoardStore({ project: "proj", fetcher: server.fetcher, storage: { getItem: () => null }, scheduler: idleScheduler().scheduler });
  await settle();
  expect(server.patchCount()).toBe(0);
  expect(store.getSnapshot()).toMatchObject({ revision: 0, sync: "current" });
  store.dispose();
});

test("a mutation applies optimistically, then bumps the revision", async () => {
  const server = fakeServer({ proj: boardOf(2) });
  const store = createBoardStore({ project: "proj", fetcher: server.fetcher, storage: null, scheduler: idleScheduler().scheduler });
  await settle();
  store.mutate([{ kind: "set-presentation", viewMode: "list" }]);
  /* Immediately visible, before the PATCH resolves. */
  expect(store.getSnapshot().prefs.viewMode).toBe("list");
  expect(store.getSnapshot().sync).toBe("pending");
  await settle();
  expect(store.getSnapshot()).toMatchObject({ revision: 3, sync: "current", prefs: prefsWith({ viewMode: "list" }) });
  store.dispose();
});

test("a revision conflict adopts the server board and replays the outbox", async () => {
  const server = fakeServer({ proj: boardOf(1) });
  const store = createBoardStore({ project: "proj", fetcher: server.fetcher, storage: null, scheduler: idleScheduler().scheduler });
  await settle();
  /* Another device closes /other after this store loaded at revision 1. */
  server.bumpMutations("proj", [{ kind: "close", path: "/other" }]); // now revision 2, hidden:[/other]
  store.mutate([{ kind: "restore", path: "/mine", placement: "manual" }]); // base 1 → 409 → adopt rev 2, replay, retry
  await settle();
  const snap = store.getSnapshot();
  expect(snap.revision).toBe(3);
  expect(snap.sync).toBe("current");
  /* The other device's change survives and this intent replayed on top. */
  expect(snap.prefs.hidden).toEqual(["/other"]);
  expect(snap.prefs.manual).toEqual(["/mine"]);
  store.dispose();
});

test("polling adopts a change another device made", async () => {
  const server = fakeServer({ proj: boardOf(1, { manual: ["/a"] }) });
  const poll = idleScheduler();
  const store = createBoardStore({ project: "proj", fetcher: server.fetcher, storage: null, scheduler: poll.scheduler });
  await settle();
  expect(store.getSnapshot().revision).toBe(1);
  server.bump("proj", { manual: ["/a", "/b"] }); // revision 2 elsewhere
  poll.tick();
  await settle();
  expect(store.getSnapshot()).toMatchObject({ revision: 2, prefs: prefsWith({ manual: ["/a", "/b"] }) });
  store.dispose();
});

test("a cross-project queued open is flushed when its board loads", async () => {
  const server = fakeServer({ proj: boardOf(3) });
  queueColumnOpen("proj", "/opened", false); // recorded before the project mounts
  const store = createBoardStore({ project: "proj", fetcher: server.fetcher, storage: null, scheduler: idleScheduler().scheduler });
  await settle();
  expect(store.getSnapshot().prefs.manual).toEqual(["/opened"]);
  expect(server.projects.proj.prefs.manual).toEqual(["/opened"]);
  store.dispose();
});

test("a PATCH network error backs off instead of spinning, then recovers", async () => {
  const backing = fakeServer({ proj: boardOf(1) });
  let failPatches = true;
  let patchAttempts = 0;
  /* Wrap the fake server: PATCH throws (a real network error attempt() catches)
     while the network is down, and every PATCH attempt is counted. */
  const fetcher = async (input: string, init?: RequestInit) => {
    if (init && (init.method ?? "GET") !== "GET") {
      patchAttempts += 1;
      if (failPatches) throw new Error("network down");
    }
    return backing.fetcher(input, init);
  };
  const sched = idleScheduler();
  const store = createBoardStore({ project: "proj", fetcher, storage: null, scheduler: sched.scheduler });
  await settle();

  store.mutate([{ kind: "set-presentation", viewMode: "list" }]);
  await settle();
  /* The regression: exactly one attempt, not a tight microtask storm. The old
     code re-drained synchronously and reached thousands of attempts here. */
  expect(patchAttempts).toBe(1);
  /* Optimistic prefs survive the failure and a single backoff timer is armed. */
  expect(store.getSnapshot().prefs.viewMode).toBe("list");
  expect(store.getSnapshot().sync).toBe("pending");
  expect(sched.pendingTimeouts()).toBe(1);

  /* Backoff fires while still down: one more attempt, still bounded, re-armed. */
  sched.runTimeouts();
  await settle();
  expect(patchAttempts).toBe(2);
  expect(sched.pendingTimeouts()).toBe(1);

  /* Network heals; the next backoff flushes the queued mutation and lands it. */
  failPatches = false;
  sched.runTimeouts();
  await settle();
  expect(patchAttempts).toBe(3);
  expect(store.getSnapshot()).toMatchObject({ revision: 2, sync: "current", prefs: prefsWith({ viewMode: "list" }) });
  /* Recovery cancels the backoff — no timer left spinning. */
  expect(sched.pendingTimeouts()).toBe(0);
  store.dispose();
});

test("a connected open is queued into the expand set", async () => {
  const server = fakeServer({ proj: boardOf(0) });
  queueColumnOpen("proj", "/child", true);
  const store = createBoardStore({ project: "proj", fetcher: server.fetcher, storage: null, scheduler: idleScheduler().scheduler });
  await settle();
  expect(store.getSnapshot().prefs.expanded).toEqual(["/child"]);
  store.dispose();
});

/* ── Sol frontend cases 13–19 (membership stability under the mutation contract). */

test("13: remote close survives local root reconciliation conflict", async () => {
  /* revision 1: /a and /x are both manual roots. */
  const server = fakeServer({ proj: boardOf(1, { manual: ["/a", "/x"] }) });
  const store = createBoardStore({ project: "proj", fetcher: server.fetcher, storage: null, scheduler: idleScheduler().scheduler });
  await settle();
  expect(store.getSnapshot().revision).toBe(1);
  /* A remote device closes /x → revision 2, hidden:[/x], manual:[/a]. */
  server.bumpMutations("proj", [{ kind: "close", path: "/x" }]);
  expect(server.projects.proj.revision).toBe(2);
  /* Local root reconciliation still at base revision 1: keep /a, retire /x. */
  store.mutate([{ kind: "reconcile-roots", roots: ["/a"], removeManual: ["/x"] }]);
  await settle();
  const snap = store.getSnapshot();
  /* Converges on the remote close, /x stays hidden and absent from manual, and the
     satisfied reconciliation adds no extra revision. */
  expect(snap.revision).toBe(2);
  expect(snap.prefs.hidden).toEqual(["/x"]);
  expect(snap.prefs.manual).toEqual(["/a"]);
  expect(server.projects.proj.revision).toBe(2);
  store.dispose();
});

test("14: the outbox retains a close through consecutive conflicts", async () => {
  const server = fakeServer({ proj: boardOf(1, { manual: ["/x"] }) });
  let forced = 0;
  /* Force two 409s (a concurrent writer keeps advancing the revision), then let
     the third attempt through. */
  const fetcher = async (input: string, init?: RequestInit) => {
    if (init && (init.method ?? "GET") !== "GET") {
      forced += 1;
      if (forced <= 2) {
        server.bumpMutations("proj", [{ kind: "set-presentation", taskPanelOpen: forced === 1 }]);
        return { ok: false, status: 409, json: async () => ({ error: "BOARD_REVISION_CONFLICT", board: server.projects.proj }) };
      }
    }
    return server.fetcher(input, init);
  };
  const store = createBoardStore({ project: "proj", fetcher, storage: null, scheduler: idleScheduler().scheduler });
  await settle();
  store.mutate([{ kind: "close", path: "/x" }]);
  /* Optimistically hidden the instant the close is dispatched. */
  expect(store.getSnapshot().prefs.hidden).toEqual(["/x"]);
  await settle();
  const snap = store.getSnapshot();
  /* Third attempt lands; the close is durable and never lost across the conflicts. */
  expect(forced).toBe(3);
  expect(snap.prefs.hidden).toEqual(["/x"]);
  expect(snap.prefs.manual).toEqual([]);
  expect(server.projects.proj.prefs.hidden).toEqual(["/x"]);
  expect(server.projects.proj.prefs.manual).toEqual([]);
  store.dispose();
});

test("15: a later restore survives the earlier close acknowledgement", async () => {
  const server = fakeServer({ proj: boardOf(1, { manual: ["/x"] }) });
  let releaseClose = () => {};
  const closeGate = new Promise<void>((resolve) => (releaseClose = resolve));
  let attempts = 0;
  const fetcher = async (input: string, init?: RequestInit) => {
    if (init && (init.method ?? "GET") !== "GET") {
      attempts += 1;
      if (attempts === 1) await closeGate; // hold the close PATCH inflight
    }
    return server.fetcher(input, init);
  };
  const store = createBoardStore({ project: "proj", fetcher, storage: null, scheduler: idleScheduler().scheduler });
  await settle();
  store.mutate([{ kind: "close", path: "/x" }]); // outbox=[close], drain inflight (gated)
  await settle();
  store.mutate([{ kind: "restore", path: "/x", placement: "manual" }]); // queued while close inflight
  /* Optimistic: the later restore wins and /x remains visible in manual. */
  expect(store.getSnapshot().prefs.hidden).toEqual([]);
  expect(store.getSnapshot().prefs.manual).toEqual(["/x"]);
  releaseClose();
  await settle();
  const snap = store.getSnapshot();
  /* After the close ack the still-queued restore keeps /x restored, then persists. */
  expect(snap.prefs.hidden).toEqual([]);
  expect(snap.prefs.manual).toEqual(["/x"]);
  expect(server.projects.proj.prefs.hidden).toEqual([]);
  expect(server.projects.proj.prefs.manual).toEqual(["/x"]);
  store.dispose();
});

test("16: a queued cross-project open dispatches explicit restore", async () => {
  const server = fakeServer({ proj: boardOf(2, { hidden: ["/root", "/child"] }) });
  queueColumnOpen("proj", "/root", false); // standalone → restore manual
  queueColumnOpen("proj", "/child", true); // connected → restore expanded
  const store = createBoardStore({ project: "proj", fetcher: server.fetcher, storage: null, scheduler: idleScheduler().scheduler });
  await settle();
  const snap = store.getSnapshot();
  /* Both tombstones are lifted only through the explicit opens, each placed by role. */
  expect(snap.prefs.hidden).toEqual([]);
  expect(snap.prefs.manual).toEqual(["/root"]);
  expect(snap.prefs.expanded).toEqual(["/child"]);
  expect(server.projects.proj.prefs.hidden).toEqual([]);
  expect(server.projects.proj.prefs.manual).toEqual(["/root"]);
  expect(server.projects.proj.prefs.expanded).toEqual(["/child"]);
  store.dispose();
});
