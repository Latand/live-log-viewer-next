import { beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

import {
  attachFocusPopstate,
  currentFocusEntry,
  FOCUS_HISTORY_STATE_KEY,
  recordFocusNavigation,
  recordProjectNavigation,
  retargetRecordedProject,
  type FocusHistoryEntry,
} from "./focusHistory";

let dom: Window;
beforeEach(() => {
  dom = new Window({ url: "http://localhost:3000/" });
  Object.assign(globalThis, { window: dom, document: dom.document, location: dom.location, history: dom.history });
});

const fileA = { conversationId: "conv-a", path: "/logs/a.jsonl" };
const fileB = { conversationId: "conv-b", path: "/logs/b.jsonl" };
const legacy = { conversationId: null, path: "/logs/old.jsonl" };

const popstate = (state: unknown) =>
  dom.dispatchEvent(new dom.PopStateEvent("popstate", { state: state as object }));

describe("recordFocusNavigation", () => {
  test("a deliberate focus pushes one typed same-document entry keyed by conversation id", () => {
    const before = dom.history.length;
    recordFocusNavigation(fileA, "-p");
    expect(dom.history.length).toBe(before + 1);
    expect(dom.location.hash).toBe("#c=conv-a");
    expect(currentFocusEntry()).toEqual({ v: 1, conversationId: "conv-a", path: "/logs/a.jsonl", project: "-p" });
  });

  test("a legacy file without an id records its path form", () => {
    recordFocusNavigation(legacy, "-p");
    expect(dom.location.hash).toBe("#f=" + encodeURIComponent("/logs/old.jsonl"));
    expect(currentFocusEntry()?.conversationId).toBeNull();
  });

  test("repeated focus on the current target coalesces instead of stacking entries", () => {
    recordFocusNavigation(fileA, "-p");
    const length = dom.history.length;
    recordFocusNavigation(fileA, "-p");
    recordFocusNavigation({ ...fileA, path: "/logs/a-rotated.jsonl" }, "-p");
    expect(dom.history.length).toBe(length);
    expect(currentFocusEntry()?.path).toBe("/logs/a-rotated.jsonl");
  });

  test("focusing a second card pushes a second entry", () => {
    recordFocusNavigation(fileA, "-p");
    const length = dom.history.length;
    recordFocusNavigation(fileB, "-p");
    expect(dom.history.length).toBe(length + 1);
    expect(currentFocusEntry()?.conversationId).toBe("conv-b");
  });

  test("a restoration types the current entry in place — initial deep links add no duplicate", () => {
    const before = dom.history.length;
    recordFocusNavigation(fileA, "-p", { restore: true });
    expect(dom.history.length).toBe(before);
    expect(currentFocusEntry()?.conversationId).toBe("conv-a");
  });

  test("popstate replay re-recorded through the restore path creates no entry and no loop", () => {
    recordFocusNavigation(fileA, "-p");
    recordFocusNavigation(fileB, "-p");
    const length = dom.history.length;
    /* Back landed on A's entry; the resolver re-opens A and re-records it. */
    dom.history.replaceState({ [FOCUS_HISTORY_STATE_KEY]: { v: 1, conversationId: "conv-a", path: "/logs/a.jsonl", project: "-p" } }, "", "#c=conv-a");
    recordFocusNavigation(fileA, "-p", { restore: true });
    expect(dom.history.length).toBe(length);
    expect(currentFocusEntry()?.conversationId).toBe("conv-a");
  });

  test("an unbounded identity is never recorded", () => {
    const before = dom.history.length;
    recordFocusNavigation({ conversationId: null, path: "x".repeat(5000) }, "-p");
    expect(dom.history.length).toBe(before);
    expect(currentFocusEntry()).toBeNull();
  });
});

describe("recordProjectNavigation", () => {
  test("replaces in place over an untyped entry (existing behavior)", () => {
    const before = dom.history.length;
    recordProjectNavigation("#p=-proj");
    expect(dom.history.length).toBe(before);
    expect(dom.location.hash).toBe("#p=-proj");
    expect(currentFocusEntry()).toBeNull();
  });

  test("pushes over a focused-card entry so Back can return to the card", () => {
    recordFocusNavigation(fileA, "-p");
    const length = dom.history.length;
    recordProjectNavigation("#p=-proj");
    expect(dom.history.length).toBe(length + 1);
    expect(currentFocusEntry()).toBeNull();
  });
});

describe("retargetRecordedProject", () => {
  test("rewrites the stored project of a typed entry without touching the hash", () => {
    recordFocusNavigation(fileA, "-alias");
    retargetRecordedProject("-canonical", "#p=-canonical");
    expect(currentFocusEntry()?.project).toBe("-canonical");
    expect(dom.location.hash).toBe("#c=conv-a");
  });

  test("falls back to the project hash on an untyped entry", () => {
    retargetRecordedProject("-canonical", "#p=-canonical");
    expect(dom.location.hash).toBe("#p=-canonical");
    expect(currentFocusEntry()).toBeNull();
  });
});

describe("attachFocusPopstate", () => {
  test("delivers typed entries to the replay handler", () => {
    const seen: FocusHistoryEntry[] = [];
    attachFocusPopstate((replayed) => seen.push(replayed));
    popstate({ [FOCUS_HISTORY_STATE_KEY]: { v: 1, conversationId: "conv-a", path: null, project: "-p" } });
    expect(seen).toEqual([{ v: 1, conversationId: "conv-a", path: null, project: "-p" }]);
  });

  test("ignores untyped and malformed states — hash-only navigations stay with the hashchange path", () => {
    const seen: FocusHistoryEntry[] = [];
    attachFocusPopstate((replayed) => seen.push(replayed));
    popstate(null);
    popstate({ scroll: 4 });
    popstate({ [FOCUS_HISTORY_STATE_KEY]: { v: 9, conversationId: "conv-a", path: null, project: "-p" } });
    expect(seen).toEqual([]);
  });

  test("detaches cleanly", () => {
    const seen: FocusHistoryEntry[] = [];
    const detach = attachFocusPopstate((replayed) => seen.push(replayed));
    detach();
    popstate({ [FOCUS_HISTORY_STATE_KEY]: { v: 1, conversationId: "conv-a", path: null, project: "-p" } });
    expect(seen).toEqual([]);
  });
});
