import { beforeEach, expect, test } from "bun:test";

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
const boardOf = (revision: number, prefs: Partial<BoardPrefs> = {}): BoardProjectStateV1 => ({ schemaVersion: 1, revision, updatedAt: new Date(0).toISOString(), prefs: prefsWith(prefs) });

/** In-memory board API: mirrors the real GET/PATCH revision semantics. */
function fakeServer(seed: Record<string, BoardProjectStateV1> = {}) {
  const projects: Record<string, BoardProjectStateV1> = { ...seed };
  const read = (project: string) => projects[project] ?? boardOf(0);
  let patchCount = 0;
  const fetcher = async (input: string, init?: RequestInit) => {
    if (!init || (init.method ?? "GET") === "GET") {
      const project = new URL(input, "http://x").searchParams.get("project")!;
      return { ok: true, status: 200, json: async () => ({ ok: true, board: read(project) }) };
    }
    patchCount += 1;
    const body = JSON.parse(String(init.body)) as { project: string; baseRevision: number; patch: Partial<BoardPrefs> };
    const current = read(body.project);
    if (current.revision !== body.baseRevision) return { ok: false, status: 409, json: async () => ({ error: "BOARD_REVISION_CONFLICT", board: current }) };
    const next = boardOf(current.revision + 1, { ...current.prefs, ...body.patch });
    projects[body.project] = next;
    return { ok: true, status: 200, json: async () => ({ ok: true, board: next }) };
  };
  /* Simulate another device landing an accepted PATCH. */
  const bump = (project: string, patch: Partial<BoardPrefs>) => {
    const current = read(project);
    projects[project] = boardOf(current.revision + 1, { ...current.prefs, ...patch });
  };
  return { projects, fetcher, bump, patchCount: () => patchCount };
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
  store.patch({ viewMode: "list" }); // queued while the seed is inflight (drain early-returns)
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

test("a patch applies optimistically, then bumps the revision", async () => {
  const server = fakeServer({ proj: boardOf(2) });
  const store = createBoardStore({ project: "proj", fetcher: server.fetcher, storage: null, scheduler: idleScheduler().scheduler });
  await settle();
  store.patch({ viewMode: "list" });
  /* Immediately visible, before the PATCH resolves. */
  expect(store.getSnapshot().prefs.viewMode).toBe("list");
  expect(store.getSnapshot().sync).toBe("pending");
  await settle();
  expect(store.getSnapshot()).toMatchObject({ revision: 3, sync: "current", prefs: prefsWith({ viewMode: "list" }) });
  store.dispose();
});

test("a revision conflict rebases exactly once onto the server state", async () => {
  const server = fakeServer({ proj: boardOf(1) });
  const store = createBoardStore({ project: "proj", fetcher: server.fetcher, storage: null, scheduler: idleScheduler().scheduler });
  await settle();
  /* Another device advances the board after this store loaded at revision 1. */
  server.bump("proj", { hidden: ["/other"] }); // now revision 2
  store.patch({ manual: ["/mine"] }); // still thinks base is 1 → 409 → rebase onto 2
  await settle();
  const snap = store.getSnapshot();
  expect(snap.revision).toBe(3);
  expect(snap.sync).toBe("current");
  /* Rebase kept the other device's change and replayed this intent on top. */
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

  store.patch({ viewMode: "list" });
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

  /* Network heals; the next backoff flushes the queued patch and lands it. */
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
