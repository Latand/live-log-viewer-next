import { describe, expect, test } from "bun:test";

import { commitMarqueeSelection, planBackgroundPress, pruneSelection, toggleSelected } from "./selectionGesture";

const mouse = { pointerType: "mouse", isPrimary: true, button: 0 };

describe("background press plan (#771 gap 1)", () => {
  test("a primary mouse press always lassos and owns the native selection", () => {
    expect(planBackgroundPress(mouse, { enabled: true, session: false })).toEqual({
      claim: true,
      track: true,
      suppressSelection: true,
    });
    /* Suppression does not depend on a running session: the very first drag on a
       fresh board must not leave highlighted text behind either. */
    expect(planBackgroundPress(mouse, { enabled: true, session: true }).suppressSelection).toBe(true);
  });

  test("a pen press behaves exactly like the mouse", () => {
    expect(planBackgroundPress({ ...mouse, pointerType: "pen" }, { enabled: true, session: false })).toEqual({
      claim: true,
      track: true,
      suppressSelection: true,
    });
  });

  test("touch claims only inside a session, and never suppresses the default", () => {
    const touch = { pointerType: "touch", isPrimary: true, button: 0 };
    /* Inside a session the press is claimed so the camera's press-time clear
       cannot eat the set — but the finger keeps panning, so the default stands. */
    expect(planBackgroundPress(touch, { enabled: true, session: true })).toEqual({
      claim: true,
      track: false,
      suppressSelection: false,
    });
    expect(planBackgroundPress(touch, { enabled: true, session: false })).toEqual({
      claim: false,
      track: false,
      suppressSelection: false,
    });
  });

  test("the map, secondary buttons and non-primary pointers are left alone", () => {
    expect(planBackgroundPress(mouse, { enabled: false, session: true })).toEqual({
      claim: false,
      track: false,
      suppressSelection: false,
    });
    expect(planBackgroundPress({ ...mouse, button: 2 }, { enabled: true, session: false }).suppressSelection).toBe(false);
    expect(planBackgroundPress({ ...mouse, isPrimary: false }, { enabled: true, session: false }).claim).toBe(false);
  });
});

describe("selection toggle reducer (#771 gap 2)", () => {
  test("adds a path that is out and removes one that is in", () => {
    const empty: ReadonlySet<string> = new Set();
    const one = toggleSelected(empty, "/a");
    expect([...one]).toEqual(["/a"]);
    expect([...toggleSelected(one, "/a")]).toEqual([]);
  });

  test("leaves every other member untouched, in insertion order", () => {
    const start: ReadonlySet<string> = new Set(["/a", "/b"]);
    expect([...toggleSelected(start, "/c")]).toEqual(["/a", "/b", "/c"]);
    expect([...toggleSelected(start, "/a")]).toEqual(["/b"]);
  });

  test("never mutates the input set, so a React state write is a real change", () => {
    const start = new Set(["/a"]);
    const next = toggleSelected(start, "/b");
    expect([...start]).toEqual(["/a"]);
    expect(next).not.toBe(start);
  });
});

describe("marquee commit reducer", () => {
  test("a plain release replaces the set, an additive one unions into it", () => {
    const start: ReadonlySet<string> = new Set(["/a"]);
    expect([...commitMarqueeSelection(start, ["/b", "/c"], false)]).toEqual(["/b", "/c"]);
    expect([...commitMarqueeSelection(start, ["/b", "/c"], true)]).toEqual(["/a", "/b", "/c"]);
  });

  test("an empty plain release clears, an empty additive release changes nothing", () => {
    const start: ReadonlySet<string> = new Set(["/a"]);
    expect([...commitMarqueeSelection(start, [], false)]).toEqual([]);
    expect(commitMarqueeSelection(start, [], true)).toBe(start);
  });
});

describe("selection pruning (#771 — the mode-switch trap)", () => {
  test("keeps every path whose conversation still exists", () => {
    const selected = new Set(["/a", "/b"]);
    /* The pruning input is what EXISTS, never what the current view renders: the
       list mode draws neither of these as a board node, and both must survive. */
    expect(pruneSelection(selected, new Set(["/a", "/b", "/c"]))).toBe(selected);
    expect(pruneSelection(selected, new Set(["/b", "/a"]))).toBe(selected);
  });

  test("drops only the paths that are gone, keeping the rest in order", () => {
    const selected = new Set(["/a", "/b", "/c"]);
    const pruned = pruneSelection(selected, new Set(["/c", "/a"]));
    expect(pruned).not.toBe(selected);
    expect([...pruned]).toEqual(["/a", "/c"]);
    expect([...pruneSelection(selected, new Set())]).toEqual([]);
  });

  test("returns the same reference when nothing was dropped, so a store write bails", () => {
    const empty: ReadonlySet<string> = new Set();
    expect(pruneSelection(empty, new Set(["/a"]))).toBe(empty);
  });
});
