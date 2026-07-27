import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";

import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import type { BoardProjectStateV1 } from "@/lib/view/types";

import { EMPTY_BOARD_PREFS, resetPendingOpensForTest, useBoardState, type BoardState } from "./useBoardState";

/*
 * One tab, two views of the same project (#38). The shell binds the project
 * board for its favourites rail and the dashboard binds it for the scheme, so
 * `useBoardState(project)` is mounted twice against one durable board. Both
 * bindings must render the same window set at all times — a mutation dispatched
 * through one is state the other is already showing, with no poll wait and no
 * reload.
 */

const dom = new Window({ url: "http://localhost/" });
const globals = globalThis as Record<string, unknown>;
const overrides: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const savedGlobals = new Map<string, { present: boolean; value: unknown }>();
let savedFetch: unknown;

beforeAll(() => {
  for (const [key, value] of Object.entries(overrides)) {
    savedGlobals.set(key, { present: key in globals, value: globals[key] });
    globals[key] = value;
  }
  savedFetch = globals.fetch;
});

afterAll(() => {
  for (const [key, saved] of savedGlobals) {
    if (saved.present) globals[key] = saved.value;
    else delete globals[key];
  }
  globals.fetch = savedFetch;
  dom.close();
});

afterEach(() => resetPendingOpensForTest());

/** Minimal in-memory board API stubbed onto global fetch, which is what the
    hook's default fetcher calls. Counts GETs so a second store is detectable. */
function stubBoardApi(initial: BoardProjectStateV1) {
  let board = initial;
  const counts = { get: 0, patch: 0 };
  globals.fetch = (async (input: string, init?: RequestInit) => {
    if (!init || (init.method ?? "GET") === "GET") {
      counts.get += 1;
      return { ok: true, status: 200, json: async () => ({ ok: true, board }) };
    }
    counts.patch += 1;
    const body = JSON.parse(String(init.body)) as { baseRevision: number; mutations?: BoardMutationV1[] };
    if (board.revision !== body.baseRevision) return { ok: false, status: 409, json: async () => ({ error: "BOARD_REVISION_CONFLICT", board }) };
    board = { ...applyBoardMutations(board, body.mutations ?? []), revision: board.revision + 1, updatedAt: new Date(0).toISOString() };
    return { ok: true, status: 200, json: async () => ({ ok: true, board }) };
  }) as unknown as typeof fetch;
  return { counts, current: () => board };
}

test("two bindings on one project render the same board without a reload", async () => {
  const api = stubBoardApi({
    schemaVersion: 1,
    revision: 1,
    updatedAt: new Date(0).toISOString(),
    pathAliases: {},
    explicitManual: [],
    prefs: { ...EMPTY_BOARD_PREFS, manual: ["/a", "/x"] },
  });

  /* The shell's binding and the dashboard's binding, side by side. */
  const seen: { shell: BoardState | null; dashboard: BoardState | null } = { shell: null, dashboard: null };
  function Shell() {
    seen.shell = useBoardState("proj");
    return null;
  }
  function Dashboard() {
    seen.dashboard = useBoardState("proj");
    return null;
  }
  function Tab() {
    return (
      <>
        <Shell />
        <Dashboard />
      </>
    );
  }

  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  await act(async () => {
    root.render(<Tab />);
  });
  await act(async () => {});

  expect(seen.shell!.prefs.manual).toEqual(["/a", "/x"]);
  expect(seen.dashboard!.prefs.manual).toEqual(["/a", "/x"]);
  /* One project board, one loader: a second private store would double the GET
     and give the two views separate outboxes and separate poll clocks. */
  expect(api.counts.get).toBe(1);

  /* The operator closes /x from the dashboard. */
  await act(async () => {
    seen.dashboard!.close("/x");
  });
  await act(async () => {});

  /* Both views are on the same picture immediately — same window set, same
     revision, same sync state. The regression: the shell's private store kept
     showing /x until its own 10-second poll came round. */
  expect(seen.dashboard!.prefs.manual).toEqual(["/a"]);
  expect(seen.shell!.prefs.manual).toEqual(["/a"]);
  expect(seen.shell!.prefs.hidden).toEqual(["/x"]);
  expect(seen.shell!.revision).toBe(seen.dashboard!.revision);
  expect(seen.shell!.sync).toBe(seen.dashboard!.sync);
  expect(api.current().prefs.hidden).toEqual(["/x"]);

  await act(async () => {
    root.unmount();
  });
  host.remove();
});
