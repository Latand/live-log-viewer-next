import { beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MAX_RETIRED_KEY_REVISIONS } from "@/lib/board/keys";
import { boardFor, mutateBoard, patchBoard } from "@/lib/board/store";
import type { BoardMutationV1 } from "@/lib/board/mutations";
import type { BoardPatch } from "@/lib/board/validation";

import { createBoardStore, resetPendingOpensForTest } from "./useBoardState";

/*
 * Convergence across desktop, phone and agents (revives #38).
 *
 * Every case here runs two writers against ONE durable board: the store under
 * test (a device) and `server.otherDevice(...)`, which stands for the second
 * phone/desktop or an agent PATCHing /api/board. The "server" is the real
 * `mutateBoard`/`patchBoard`/`boardFor` over an isolated temp file, so these
 * assert the shipped server semantics — including durability, since `boardFor`
 * re-reads the file on every call and a fresh store is a restart.
 */

const settle = async () => {
  for (let index = 0; index < 24; index += 1) await Promise.resolve();
};

function temporaryBoardFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "llv-board-converge-")), "board.json");
}

/** The real board API over an isolated file, plus a handle for the other device. */
function durableBoard() {
  const file = temporaryBoardFile();
  const fetcher = async (input: string, init?: RequestInit) => {
    if (!init || (init.method ?? "GET") === "GET") {
      const project = new URL(input, "http://x").searchParams.get("project")!;
      return { ok: true, status: 200, json: async () => ({ ok: true, board: boardFor(project, file) }) };
    }
    const body = JSON.parse(String(init.body)) as { project: string; baseRevision: number; patch?: BoardPatch; mutations?: BoardMutationV1[] };
    const result = body.mutations
      ? mutateBoard(body.project, body.baseRevision, body.mutations, file)
      : patchBoard(body.project, body.baseRevision, body.patch!, file);
    if (!result.ok) return { ok: false, status: 409, json: async () => ({ error: "BOARD_REVISION_CONFLICT", board: result.board }) };
    /* Mirrors the route: `applied` reports whether the write committed or
       reduced to a no-op, which is what separates our own work from another
       writer's when both produce the same board. */
    return { ok: true, status: 200, json: async () => ({ ok: true, applied: result.applied, board: result.board }) };
  };
  return {
    file,
    fetcher,
    board: (project: string) => boardFor(project, file),
    /** Another device (or an agent) writing at the revision it just read. */
    otherDevice: (project: string, mutations: BoardMutationV1[]) => {
      const result = mutateBoard(project, boardFor(project, file).revision, mutations, file);
      if (!result.ok) throw new Error("otherDevice write was rejected");
      return result.board;
    },
  };
}

/** A device whose PATCHes can be cut off while its GETs keep working — a phone
    that lost its uplink mid-drag, or a laptop lid closed with queued intent. */
function flakyDevice(server: ReturnType<typeof durableBoard>) {
  const state = { patchDown: false };
  const fetcher = async (input: string, init?: RequestInit) => {
    if (init && (init.method ?? "GET") !== "GET" && state.patchDown) throw new Error("offline");
    return server.fetcher(input, init);
  };
  return { state, fetcher };
}

const idleScheduler = () => {
  let pollFn = () => {};
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
    runTimeouts: () => {
      for (const fn of timeouts.splice(0)) fn?.();
    },
  };
};

beforeEach(() => resetPendingOpensForTest());

test("a view holding unflushed intent still converges on the other device's board", async () => {
  const server = durableBoard();
  server.otherDevice("proj", [
    { kind: "restore", path: "/a", placement: "manual" },
    { kind: "restore", path: "/x", placement: "manual" },
  ]);
  const device = flakyDevice(server);
  const sched = idleScheduler();
  const store = createBoardStore({ project: "proj", fetcher: device.fetcher, storage: null, scheduler: sched.scheduler });
  await settle();
  expect(store.getSnapshot().revision).toBe(1);

  /* This device loses its uplink and the operator closes /x on it. The intent
     is queued and rendered optimistically; the PATCH cannot land. */
  device.state.patchDown = true;
  store.mutate([{ kind: "close", path: "/x" }]);
  await settle();
  expect(store.getSnapshot().prefs.hidden).toEqual(["/x"]);

  /* Meanwhile the operator keeps working on the other device: opens /b and
     switches the project to list view. */
  server.otherDevice("proj", [{ kind: "restore", path: "/b", placement: "manual" }]);
  server.otherDevice("proj", [{ kind: "set-presentation", viewMode: "list" }]);

  sched.tick();
  await settle();

  /* The regression: a read is not a write, so queued local intent must never
     stop a view from learning where the board has moved. The old store skipped
     every poll while the outbox was non-empty, so this device kept rendering the
     revision-1 picture — /b missing, still on the scheme view — until a reload. */
  const behind = store.getSnapshot();
  expect(behind.prefs.manual).toEqual(["/a", "/b"]);
  expect(behind.prefs.viewMode).toBe("list");
  /* Its own unacknowledged close is replayed on top, not lost. */
  expect(behind.prefs.hidden).toEqual(["/x"]);
  /* And the view says out loud that it is rendering intent the durable board
     does not carry, instead of claiming to be current. */
  expect(behind.sync).toBe("stale");

  device.state.patchDown = false;
  sched.runTimeouts();
  await settle();
  expect(store.getSnapshot().sync).toBe("current");
  expect(server.board("proj").prefs.manual).toEqual(["/a", "/b"]);
  expect(server.board("proj").prefs.hidden).toEqual(["/x"]);
  expect(server.board("proj").prefs.viewMode).toBe("list");
  store.dispose();

  /* Restart: a fresh store reads the same converged arrangement off disk. */
  resetPendingOpensForTest();
  const restarted = createBoardStore({ project: "proj", fetcher: server.fetcher, storage: null, scheduler: idleScheduler().scheduler });
  await settle();
  expect(restarted.getSnapshot().prefs).toMatchObject({ manual: ["/a", "/b"], hidden: ["/x"], viewMode: "list" });
  restarted.dispose();
});

test("a view whose first load failed recovers on the next poll, not on a reload", async () => {
  const server = durableBoard();
  let firstGet = true;
  const fetcher = async (input: string, init?: RequestInit) => {
    if ((!init || (init.method ?? "GET") === "GET") && firstGet) {
      firstGet = false;
      throw new Error("offline");
    }
    return server.fetcher(input, init);
  };
  const sched = idleScheduler();
  const store = createBoardStore({ project: "proj", fetcher, storage: null, scheduler: sched.scheduler });
  await settle();
  expect(store.getSnapshot().sync).toBe("unavailable");

  sched.tick();
  await settle();
  /* The project is untouched, so the poll reads back the same revision 0 it
     already holds. The old store only cleared `unavailable` when the revision
     CHANGED, so a fresh project whose first GET failed stayed unavailable
     forever — the dashboard held its skeleton and its convergence effects, which
     bail on an unavailable board, never ran again. */
  expect(store.getSnapshot()).toMatchObject({ revision: 0, loaded: true, sync: "current" });

  /* And it is a live, writable board from here on. */
  store.mutate([{ kind: "restore", path: "/a", placement: "manual" }]);
  await settle();
  expect(server.board("proj").prefs.manual).toEqual(["/a"]);
  store.dispose();
});

test("a stale view's presentation intent loses to the device that acted on current state", async () => {
  const server = durableBoard();
  server.otherDevice("proj", [{ kind: "restore", path: "/a", placement: "manual" }]);
  const device = flakyDevice(server);
  const sched = idleScheduler();
  const store = createBoardStore({ project: "proj", fetcher: device.fetcher, storage: null, scheduler: sched.scheduler });
  await settle();
  expect(store.getSnapshot().prefs.viewMode).toBeNull();

  /* Laptop goes offline holding a view-mode switch. */
  device.state.patchDown = true;
  store.mutate([{ kind: "set-presentation", viewMode: "list" }]);
  await settle();
  expect(store.getSnapshot().prefs.viewMode).toBe("list");

  /* Later, on the phone, the operator picks the scheme view against the board
     as it actually stands. That writer saw current state; the laptop's queued
     intent was formed against a picture the operator has since superseded. */
  server.otherDevice("proj", [{ kind: "set-presentation", viewMode: "scheme" }]);
  expect(server.board("proj").revision).toBe(2);

  sched.tick();
  await settle();
  /* The laptop adopts the newer board and DROPS its superseded view-mode
     intent instead of replaying it on top. */
  expect(store.getSnapshot().prefs.viewMode).toBe("scheme");

  device.state.patchDown = false;
  sched.runTimeouts();
  await settle();
  /* The stale writer never lands: the phone's choice is still the durable one
     and no revision was burned undoing it. */
  expect(server.board("proj").prefs.viewMode).toBe("scheme");
  expect(server.board("proj").revision).toBe(2);
  expect(store.getSnapshot()).toMatchObject({ revision: 2, sync: "current" });
  store.dispose();
});

test("an accepted no-op cannot smuggle a newer board past the fence", async () => {
  const server = durableBoard();
  server.otherDevice("proj", [
    { kind: "restore", path: "/a", placement: "manual" },
    { kind: "restore", path: "/x", placement: "manual" },
  ]);
  /* Hold the first PATCH open so a second intent queues behind it. */
  let releaseFirst = () => {};
  const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
  let patches = 0;
  const fetcher = async (input: string, init?: RequestInit) => {
    if (init && (init.method ?? "GET") !== "GET") {
      patches += 1;
      if (patches === 1) await gate;
    }
    return server.fetcher(input, init);
  };
  const sched = idleScheduler();
  const store = createBoardStore({ project: "proj", fetcher, storage: null, scheduler: sched.scheduler });
  await settle();

  store.mutate([{ kind: "close", path: "/x" }]); // PATCH #1, held inflight at base revision 1
  await settle();

  /* While that write is in flight the other device closes /x itself and then
     picks the scheme view — both against current state. */
  server.otherDevice("proj", [{ kind: "close", path: "/x" }]);
  server.otherDevice("proj", [{ kind: "set-presentation", viewMode: "scheme" }]);
  expect(server.board("proj").revision).toBe(3);

  store.mutate([{ kind: "set-presentation", viewMode: "list" }]); // queues behind the held PATCH

  releaseFirst();
  await settle();

  /* PATCH #1 arrives with a base of 1 against a revision-3 board. The server
     accepts it anyway — closing an already-closed /x changes nothing, and a
     no-op is accepted from ANY base — so the response hands this view a board
     another writer moved, with no 409 to mark it as behind. The queued view-mode
     intent must still be fenced against that board rather than replayed on top. */
  expect(store.getSnapshot().prefs.viewMode).toBe("scheme");
  expect(server.board("proj").prefs.viewMode).toBe("scheme");
  expect(server.board("proj").revision).toBe(3);
  expect(store.getSnapshot().sync).toBe("current");
  store.dispose();
});

/*
 * ABA. Comparing the board a view held against the board it adopted can only see
 * endpoints: a key driven away from a value and back again lands on a snapshot
 * identical to the one the stale view remembers, so a snapshot diff reports "no
 * other writer touched this" and the superseded intent replays and wins. Both
 * cycles below are ordinary operator behaviour — toggling a view mode, closing
 * and reopening a window — so this is the common case, not a corner. Only a
 * monotonic per-key revision distinguishes "never written" from "written twice".
 */

test("an A→B→A cycle on a presentation key still supersedes a stale writer", async () => {
  const server = durableBoard();
  server.otherDevice("proj", [{ kind: "restore", path: "/a", placement: "manual" }]);
  server.otherDevice("proj", [{ kind: "set-presentation", viewMode: "scheme" }]);
  const device = flakyDevice(server);
  const sched = idleScheduler();
  const store = createBoardStore({ project: "proj", fetcher: device.fetcher, storage: null, scheduler: sched.scheduler });
  await settle();
  expect(store.getSnapshot()).toMatchObject({ revision: 2, prefs: { viewMode: "scheme" } });

  /* Offline, this device queues a switch to list view. */
  device.state.patchDown = true;
  store.mutate([{ kind: "set-presentation", viewMode: "list" }]);
  await settle();

  /* On the phone the operator tries list, then goes back to scheme — A → B → A.
     The board ends on the same view mode the stale device last saw, but it was
     written twice in between, and the second write is the informed decision. */
  server.otherDevice("proj", [{ kind: "set-presentation", viewMode: "list" }]);
  server.otherDevice("proj", [{ kind: "set-presentation", viewMode: "scheme" }]);
  expect(server.board("proj").revision).toBe(4);
  expect(server.board("proj").prefs.viewMode).toBe("scheme");

  sched.tick();
  await settle();
  device.state.patchDown = false;
  sched.runTimeouts();
  await settle();

  /* The stale switch must lose. A snapshot diff sees revision 2's "scheme" and
     revision 4's "scheme" and concludes nobody wrote this key. */
  expect(server.board("proj").prefs.viewMode).toBe("scheme");
  expect(server.board("proj").revision).toBe(4);
  expect(store.getSnapshot()).toMatchObject({ revision: 4, sync: "current", prefs: { viewMode: "scheme" } });
  store.dispose();
});

test("an A→B→A cycle on a path key still supersedes a stale writer", async () => {
  const server = durableBoard();
  server.otherDevice("proj", [
    { kind: "restore", path: "/a", placement: "manual" },
    { kind: "restore", path: "/x", placement: "manual" },
  ]);
  const device = flakyDevice(server);
  const sched = idleScheduler();
  const store = createBoardStore({ project: "proj", fetcher: device.fetcher, storage: null, scheduler: sched.scheduler });
  await settle();

  /* Offline, this device closes /x. */
  device.state.patchDown = true;
  store.mutate([{ kind: "close", path: "/x" }]);
  await settle();

  /* On the phone the operator closes /x and then reopens it — the placement
     leaves manual and comes back to exactly the same manual pin. */
  server.otherDevice("proj", [{ kind: "close", path: "/x" }]);
  server.otherDevice("proj", [{ kind: "restore", path: "/x", placement: "manual" }]);
  expect(server.board("proj").prefs.manual).toEqual(["/a", "/x"]);
  expect(server.board("proj").revision).toBe(3);

  sched.tick();
  await settle();
  device.state.patchDown = false;
  sched.runTimeouts();
  await settle();

  /* The reopen is the informed decision and must stand: the stale close cannot
     re-hide a window the operator has since deliberately brought back. */
  expect(server.board("proj").prefs.hidden).toEqual([]);
  expect(server.board("proj").prefs.manual).toEqual(["/a", "/x"]);
  expect(server.board("proj").revision).toBe(3);
  expect(store.getSnapshot()).toMatchObject({ revision: 3, sync: "current" });
  expect(store.getSnapshot().prefs.manual).toEqual(["/a", "/x"]);
  store.dispose();
});

test("an A→B→A cycle still supersedes a stale writer when the key leaves the board", async () => {
  const server = durableBoard();
  server.otherDevice("proj", [{ kind: "restore", path: "/a", placement: "manual" }]);
  const device = flakyDevice(server);
  const sched = idleScheduler();
  const store = createBoardStore({ project: "proj", fetcher: device.fetcher, storage: null, scheduler: sched.scheduler });
  await settle();
  expect(store.getSnapshot().prefs.favorites).toEqual([]);

  /* Offline, this device crowns conv-1 a favourite. */
  device.state.patchDown = true;
  store.mutate([{ kind: "set-favorite", id: "conv-1", favorite: true }]);
  await settle();

  /* On the phone the operator crowns it and then takes it back. "Off" leaves no
     trace in the board — conv-1 is simply absent from `favorites` again, exactly
     as the stale device last saw it — so the key's causal revision is the only
     surviving evidence that two writers have spoken. */
  server.otherDevice("proj", [{ kind: "set-favorite", id: "conv-1", favorite: true }]);
  server.otherDevice("proj", [{ kind: "set-favorite", id: "conv-1", favorite: false }]);
  expect(server.board("proj").prefs.favorites).toEqual([]);
  expect(server.board("proj").revision).toBe(3);

  sched.tick();
  await settle();
  device.state.patchDown = false;
  sched.runTimeouts();
  await settle();

  /* Taking it back is the informed decision and must stand. */
  expect(server.board("proj").prefs.favorites).toEqual([]);
  expect(server.board("proj").revision).toBe(3);
  expect(store.getSnapshot()).toMatchObject({ revision: 3, sync: "current" });
  expect(store.getSnapshot().prefs.favorites).toEqual([]);
  store.dispose();
});

test("an accepted no-op that another writer made identical is not mistaken for our own write", async () => {
  const server = durableBoard();
  server.otherDevice("proj", [
    { kind: "restore", path: "/a", placement: "manual" },
    { kind: "restore", path: "/x", placement: "manual" },
  ]);
  let releaseFirst = () => {};
  const gate = new Promise<void>((resolve) => (releaseFirst = resolve));
  let patches = 0;
  const fetcher = async (input: string, init?: RequestInit) => {
    if (init && (init.method ?? "GET") !== "GET") {
      patches += 1;
      if (patches === 1) await gate;
    }
    return server.fetcher(input, init);
  };
  const sched = idleScheduler();
  const store = createBoardStore({ project: "proj", fetcher, storage: null, scheduler: sched.scheduler });
  await settle();

  store.mutate([{ kind: "close", path: "/x" }]); // PATCH #1, held inflight at base revision 1

  /* The phone closes /x too — the SAME change, so the board it produces is
     byte-identical to the one this device's write would have produced. Nothing
     in the response content can tell the two writers apart. */
  server.otherDevice("proj", [{ kind: "close", path: "/x" }]);
  expect(server.board("proj").revision).toBe(2);

  /* Then this device changes its mind and reopens /x, formed against its own
     revision-1 picture — before it could know the phone had spoken. */
  store.mutate([{ kind: "restore", path: "/x", placement: "manual" }]);

  releaseFirst();
  await settle();

  /* PATCH #1 reduces to nothing against revision 2 and is accepted from its
     stale base. Treating that as "our write landed" would re-observe path:/x at
     the phone's revision and let the queued reopen through, undoing a close this
     device never saw. The server's `applied: false` is the only thing that
     distinguishes the two, so the reopen must be fenced. */
  expect(server.board("proj").prefs.hidden).toEqual(["/x"]);
  expect(server.board("proj").prefs.manual).toEqual(["/a"]);
  expect(server.board("proj").revision).toBe(2);
  expect(store.getSnapshot()).toMatchObject({ revision: 2, sync: "current" });
  expect(store.getSnapshot().prefs.hidden).toEqual(["/x"]);
  store.dispose();
});

test("a stale pre-remap close loses to an informed post-remap write on the same conversation", async () => {
  const server = durableBoard();
  server.otherDevice("proj", [{ kind: "restore", path: "/old", placement: "manual" }]);
  const device = flakyDevice(server);
  const sched = idleScheduler();
  const store = createBoardStore({ project: "proj", fetcher: device.fetcher, storage: null, scheduler: sched.scheduler });
  await settle();
  expect(store.getSnapshot().prefs.manual).toEqual(["/old"]);

  /* Offline, this device closes the conversation under the name it knows. */
  device.state.patchDown = true;
  store.mutate([{ kind: "close", path: "/old" }]);
  await settle();

  /* The conversation resumes and mints a new transcript path; succession aliases
     /old onto /new. Two names, ONE logical thing. */
  server.otherDevice("proj", [{ kind: "remap-paths", pairs: [{ from: "/old", to: "/new" }] }]);
  expect(server.board("proj").prefs.manual).toEqual(["/new"]);

  /* Then, on the phone and against current state, the operator wires it under
     its parent. This is an informed write on the same logical key. */
  server.otherDevice("proj", [{ kind: "restore", path: "/new", placement: "expanded" }]);

  sched.tick();
  await settle();
  device.state.patchDown = false;
  sched.runTimeouts();
  await settle();

  /* The stale close named /old and the informed write named /new. If the two
     names carry independent clocks, the close looks unopposed, replays, resolves
     through the alias and hides the very node the phone just placed — ABA across
     an alias boundary. One logical key, one causal revision. */
  const durable = server.board("proj");
  expect(durable.prefs.expanded).toEqual(["/new"]);
  expect(durable.prefs.hidden).toEqual([]);
  expect(store.getSnapshot()).toMatchObject({ sync: "current" });
  expect(store.getSnapshot().prefs.expanded).toEqual(["/new"]);
  expect(store.getSnapshot().prefs.hidden).toEqual([]);
  store.dispose();
});

test("a stale writer still loses after its key was evicted by retired-key compaction", async () => {
  const server = durableBoard();
  /* A board whose retired-key history has long outgrown the cap: 600 favourites
     the operator has since taken back, plus conv-1, retired at a much older
     revision than any of them. Written straight to disk because reaching this
     state through the API would take 600 round trips. */
  const keyRevisions: Record<string, number> = { "favorite:conv-1": 50 };
  for (let index = 0; index < 600; index += 1) keyRevisions[`favorite:dead-${index}`] = 200 + index;
  fs.writeFileSync(server.file, JSON.stringify({ projects: { proj: {
    schemaVersion: 1, revision: 1000, updatedAt: "2026-07-27T00:00:00.000Z",
    pathAliases: {}, explicitManual: ["/a"], keyRevisions,
    prefs: { manual: ["/a"], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [], viewMode: null, taskPanelOpen: false },
  } } }), "utf8");

  const device = flakyDevice(server);
  const sched = idleScheduler();
  const store = createBoardStore({ project: "proj", fetcher: device.fetcher, storage: null, scheduler: sched.scheduler });
  await settle();
  expect(store.getSnapshot().revision).toBe(1000);

  /* Offline, this device crowns conv-1 — intent formed against conv-1's history
     as it stood at revision 50. */
  device.state.patchDown = true;
  store.mutate([{ kind: "set-favorite", id: "conv-1", favorite: true }]);
  await settle();

  /* One unrelated write on the other device runs compaction. conv-1's entry is
     far outside the cap and is evicted. */
  server.otherDevice("proj", [{ kind: "set-presentation", viewMode: "list" }]);
  const compacted = server.board("proj");
  expect(Object.keys(compacted.keyRevisions ?? {}).length).toBeLessThanOrEqual(MAX_RETIRED_KEY_REVISIONS + 8);
  expect(compacted.keyRevisions?.["favorite:conv-1"]).toBeUndefined();

  sched.tick();
  await settle();
  device.state.patchDown = false;
  sched.runTimeouts();
  await settle();

  /* Eviction must not resurrect the stale writer. Dropping an entry has to raise
     a floor that absent keys read through, or forgetting history silently hands
     old intent a win — the failure gets MORE likely the longer a board lives. */
  expect(server.board("proj").prefs.favorites).toEqual([]);
  expect(store.getSnapshot().prefs.favorites).toEqual([]);
  expect(store.getSnapshot()).toMatchObject({ sync: "current" });
  store.dispose();
});

test("a stale view loses only the keys another device wrote, and keeps the rest", async () => {
  const server = durableBoard();
  server.otherDevice("proj", [
    { kind: "restore", path: "/a", placement: "manual" },
    { kind: "restore", path: "/x", placement: "manual" },
    { kind: "restore", path: "/b", placement: "manual" },
  ]);
  const device = flakyDevice(server);
  const sched = idleScheduler();
  const store = createBoardStore({ project: "proj", fetcher: device.fetcher, storage: null, scheduler: sched.scheduler });
  await settle();

  /* Offline, this device closes two windows. */
  device.state.patchDown = true;
  store.mutate([{ kind: "close", path: "/x" }, { kind: "close", path: "/b" }]);
  await settle();
  expect(store.getSnapshot().prefs.hidden).toEqual(["/x", "/b"]);

  /* The other device rearranges /b — it wired /b under its parent — knowing the
     current board. Nothing it did touches /x. */
  server.otherDevice("proj", [{ kind: "restore", path: "/b", placement: "expanded" }]);

  sched.tick();
  await settle();
  /* Per-key resolution: the close of /b is superseded and dropped; the close of
     /x names a key nobody else wrote and survives. */
  expect(store.getSnapshot().prefs.expanded).toEqual(["/b"]);
  expect(store.getSnapshot().prefs.hidden).toEqual(["/x"]);

  device.state.patchDown = false;
  sched.runTimeouts();
  await settle();
  const durable = server.board("proj");
  expect(durable.prefs.manual).toEqual(["/a"]);
  expect(durable.prefs.expanded).toEqual(["/b"]);
  expect(durable.prefs.hidden).toEqual(["/x"]);
  expect(store.getSnapshot()).toMatchObject({ sync: "current", prefs: durable.prefs });
  store.dispose();
});

test("a stale root reconciliation cannot retire the window another device just opened", async () => {
  const server = durableBoard();
  /* Both roots are board bookkeeping, seeded by reconciliation — neither is a
     genuine user pin yet. */
  server.otherDevice("proj", [{ kind: "reconcile-roots", roots: ["/a", "/gone"], removeManual: [] }]);
  const device = flakyDevice(server);
  const sched = idleScheduler();
  const store = createBoardStore({ project: "proj", fetcher: device.fetcher, storage: null, scheduler: sched.scheduler });
  await settle();
  expect(store.getSnapshot().prefs.manual).toEqual(["/a", "/gone"]);

  /* Offline, this device's dashboard reconciles roots against the picture it can
     see: only /a is a live root, and its catalog says /gone is gone. */
  device.state.patchDown = true;
  store.mutate([{ kind: "reconcile-roots", roots: ["/a"], removeManual: ["/gone"] }]);
  store.mutate([{ kind: "close", path: "/a" }]);
  await settle();
  expect(store.getSnapshot().prefs.manual).toEqual([]);

  /* On the phone the operator deliberately pins /gone against current state. */
  server.otherDevice("proj", [{ kind: "restore", path: "/gone", placement: "manual" }]);
  expect(server.board("proj").explicitManual).toEqual(["/gone"]);

  sched.tick();
  await settle();
  device.state.patchDown = false;
  sched.runTimeouts();
  await settle();

  /* The stale reconciliation named /gone, so it is dropped rather than replayed
     over the pin. The close of /a, which nobody else wrote, still lands. */
  const durable = server.board("proj");
  expect(durable.prefs.manual).toEqual(["/gone"]);
  expect(durable.explicitManual).toEqual(["/gone"]);
  expect(durable.prefs.hidden).toEqual(["/a"]);
  expect(store.getSnapshot()).toMatchObject({ sync: "current", prefs: durable.prefs });
  store.dispose();
});
