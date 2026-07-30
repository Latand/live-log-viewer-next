/**
 * The lifted canonical selection (#771). Everything here is about the property
 * that made the lift necessary: the selection must outlive the view that made
 * it, and must only ever be pruned because a conversation genuinely disappeared.
 */
import { beforeEach, expect, test } from "bun:test";

import type { BoardProjectStateV1 } from "@/lib/view/types";

import { createBoardStore, EMPTY_BOARD_PREFS, resetSelectionSessionsForTest, type BoardStore } from "./useBoardState";

const settle = async () => {
  for (let i = 0; i < 16; i += 1) await Promise.resolve();
};

const board = (revision: number): BoardProjectStateV1 => ({
  schemaVersion: 1,
  revision,
  updatedAt: new Date(0).toISOString(),
  pathAliases: {},
  prefs: EMPTY_BOARD_PREFS,
});

/** Inert board API: the selection owes the server nothing, so every case here
    only needs the store to load without throwing. */
const okFetcher = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, board: board(1) }) });
/** A server that is simply not there. */
const deadFetcher = async () => {
  throw new Error("offline");
};

const idleScheduler = {
  setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
  clearInterval: () => {},
  setTimeout: () => 1 as unknown as ReturnType<typeof setTimeout>,
  clearTimeout: () => {},
};

function storeFor(project: string, fetcher = okFetcher): BoardStore {
  return createBoardStore({ project, fetcher: fetcher as never, storage: null, scheduler: idleScheduler });
}

const selected = (store: BoardStore) => [...store.getSnapshot().selection];

beforeEach(() => resetSelectionSessionsForTest());

test("the selection survives the store being recreated behind a view switch", async () => {
  const first = storeFor("lift");
  await settle();
  first.toggleSelection("/alpha");
  first.toggleSelection("/beta");
  expect(selected(first)).toEqual(["/alpha", "/beta"]);

  /* Leaving scheme mode used to unmount the owner of this state. Even the
     project's whole binding going away and coming back — the harshest version of
     that — must not lose the operator's selection. */
  first.dispose();
  const second = storeFor("lift");
  expect(selected(second)).toEqual(["/alpha", "/beta"]);
  await settle();
  expect(selected(second)).toEqual(["/alpha", "/beta"]);
  second.dispose();
});

test("the recreated store's FIRST snapshot already carries the selection", () => {
  const first = storeFor("first-frame");
  first.toggleSelection("/alpha");
  first.dispose();
  /* Read before any await: a remounted view must paint the selection on its
     first frame instead of blinking empty until the store's snapshot lands. */
  const second = storeFor("first-frame");
  expect(selected(second)).toEqual(["/alpha"]);
  second.dispose();
});

test("a second holder of the same project reads and writes the one set", async () => {
  const a = storeFor("shared");
  const b = storeFor("shared");
  await settle();
  a.toggleSelection("/alpha");
  expect(selected(b)).toEqual(["/alpha"]);
  b.toggleSelection("/beta");
  expect(selected(a)).toEqual(["/alpha", "/beta"]);
  b.toggleSelection("/alpha");
  expect(selected(a)).toEqual(["/beta"]);
  a.dispose();
  b.dispose();
});

test("selections in different projects do not see each other", async () => {
  const one = storeFor("project-one");
  const two = storeFor("project-two");
  await settle();
  one.toggleSelection("/alpha");
  expect(selected(two)).toEqual([]);
  two.toggleSelection("/beta");
  expect(selected(one)).toEqual(["/alpha"]);
  one.dispose();
  two.dispose();
});

test("pruning drops a conversation that is GONE and keeps one the current view merely does not render", async () => {
  const store = storeFor("prune");
  await settle();
  store.commitSelection(["/alpha", "/beta"], false);
  expect(selected(store)).toEqual(["/alpha", "/beta"]);

  /* THE TRAP. Both conversations still exist in the scan; the view the operator
     just switched to renders neither. Pruning against a view would wipe the
     selection here — which is the original bug one layer up. */
  store.pruneSelectionTo(new Set(["/alpha", "/beta", "/gamma"]));
  expect(selected(store)).toEqual(["/alpha", "/beta"]);

  /* The other half: /beta's conversation is genuinely gone from the scan. */
  store.pruneSelectionTo(new Set(["/alpha", "/gamma"]));
  expect(selected(store)).toEqual(["/alpha"]);
  store.dispose();
});

test("a prune that drops nothing notifies nobody", async () => {
  const store = storeFor("prune-quiet");
  await settle();
  store.toggleSelection("/alpha");
  let notifications = 0;
  const unsubscribe = store.subscribe(() => {
    notifications += 1;
  });
  /* The dashboard calls this on every scan; an unchanged prune must be inert or
     it would cascade a render on each poll. */
  store.pruneSelectionTo(new Set(["/alpha", "/beta"]));
  store.pruneSelectionTo(new Set(["/alpha"]));
  expect(notifications).toBe(0);
  store.pruneSelectionTo(new Set(["/beta"]));
  expect(notifications).toBe(1);
  expect(selected(store)).toEqual([]);
  unsubscribe();
  store.dispose();
});

test("the selection is live while the durable board is unavailable", async () => {
  const store = storeFor("offline", deadFetcher);
  await settle();
  expect(store.getSnapshot().sync).toBe("unavailable");
  /* Session state owes the server nothing: a dead uplink must not cost the
     operator the ability to select. */
  store.toggleSelection("/alpha");
  expect(selected(store)).toEqual(["/alpha"]);
  store.dispose();
});

test("armed latches a session with no members, and clearing drops both", async () => {
  const store = storeFor("armed");
  await settle();
  store.setSelectionArmed(true);
  expect(store.getSnapshot().selectionArmed).toBe(true);
  expect(selected(store)).toEqual([]);

  store.toggleSelection("/alpha");
  store.clearSelection();
  expect(store.getSnapshot().selectionArmed).toBe(false);
  expect(selected(store)).toEqual([]);
  /* A cleared session leaves nothing behind for the next store to prime from. */
  store.dispose();
  const next = storeFor("armed");
  expect(selected(next)).toEqual([]);
  expect(next.getSnapshot().selectionArmed).toBe(false);
  next.dispose();
});

test("a marquee commit replaces, and an additive one unions", async () => {
  const store = storeFor("marquee");
  await settle();
  store.commitSelection(["/alpha"], false);
  store.commitSelection(["/beta", "/gamma"], true);
  expect(selected(store)).toEqual(["/alpha", "/beta", "/gamma"]);
  store.commitSelection(["/delta"], false);
  expect(selected(store)).toEqual(["/delta"]);
  store.dispose();
});

test("selecting never touches the durable board", async () => {
  const writes: string[] = [];
  const store = createBoardStore({
    project: "no-writes",
    fetcher: (async (input: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") !== "GET") writes.push(String(input));
      return { ok: true, status: 200, json: async () => ({ ok: true, board: board(1) }) };
    }) as never,
    storage: null,
    scheduler: idleScheduler,
  });
  await settle();
  store.toggleSelection("/alpha");
  store.setSelectionArmed(true);
  store.commitSelection(["/beta"], true);
  store.clearSelection();
  await settle();
  /* The selection is ephemeral: it is never PATCHed, and it never appears in
     prefs, so it cannot leak into another device's durable arrangement. */
  expect(writes).toEqual([]);
  expect(store.getSnapshot().prefs).toEqual(EMPTY_BOARD_PREFS);
  store.dispose();
});
