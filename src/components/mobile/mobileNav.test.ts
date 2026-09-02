import { describe, expect, test } from "bun:test";

import { BOARD, createMobileNav, MOBILE_NAV_STATE_KEY, readMobileNavEntry, topScreen, type MobileNav, type MobileNavHost } from "./mobileNav";

/*
 * The navigation contract (docs/design/mobile-v2/README.md §3.3) over a model
 * of the browser's same-document history: screens push, sheets create no
 * history entry, browser back and the bar's ‹ are the same pop, a sibling
 * switch replaces the top of the stack, and nothing ever lands on a sheet
 * route after a back — forward never re-opens one either.
 */

function browser() {
  const entries: { state: unknown; url: string }[] = [{ state: null, url: "http://phone/#p=atlas" }];
  let index = 0;
  let listener: ((state: unknown) => void) | null = null;
  const host: MobileNavHost = {
    history: {
      get state() {
        return entries[index]!.state;
      },
      pushState(state, _unused, url) {
        entries.splice(index + 1);
        entries.push({ state, url: url ?? entries[index]!.url });
        index += 1;
      },
      replaceState(state, _unused, url) {
        entries[index] = { state, url: url ?? entries[index]!.url };
      },
      back() {
        if (index === 0) return;
        index -= 1;
        listener?.(entries[index]!.state);
      },
    },
    href: () => entries[index]!.url,
    onPopstate(next) {
      listener = next;
      return () => {
        listener = null;
      };
    },
  };
  return {
    host,
    forward() {
      if (index >= entries.length - 1) return;
      index += 1;
      listener?.(entries[index]!.state);
    },
    length: () => entries.length,
    index: () => index,
    url: () => entries[index]!.url,
    state: () => entries[index]!.state,
    /** The Viewer records its own entries (a conversation focus). */
    viewerPush(state: unknown, url: string) {
      entries.splice(index + 1);
      entries.push({ state, url });
      index += 1;
    },
    listening: () => listener !== null,
  };
}

function phone(): { nav: MobileNav; b: ReturnType<typeof browser>; detach: () => void } {
  const b = browser();
  const nav = createMobileNav(b.host);
  const detach = nav.attach();
  return { nav, b, detach };
}

const kinds = (nav: MobileNav) => nav.getState().stack.map((screen) => screen.kind);

describe("screens", () => {
  test("a push adds one history entry, keeps the URL, and ‹ pops it", () => {
    const { nav, b } = phone();
    nav.push({ kind: "accounts" });
    expect(kinds(nav)).toEqual(["board", "accounts"]);
    expect(nav.getState().motion).toBe("push");
    expect(b.length()).toBe(2);
    expect(b.url()).toBe("http://phone/#p=atlas");
    expect(readMobileNavEntry(b.state())).toEqual({ d: 2, screen: { kind: "accounts" } });
    nav.back();
    expect(kinds(nav)).toEqual(["board"]);
    expect(nav.getState().motion).toBe("pop");
    expect(b.index()).toBe(0);
  });

  test("browser back and ‹ agree: both pop exactly one screen", () => {
    const { nav, b } = phone();
    nav.push({ kind: "pipelines" });
    nav.push({ kind: "pipeline", id: "p2" });
    expect(kinds(nav)).toEqual(["board", "pipelines", "pipeline"]);
    b.host.history.back();
    expect(kinds(nav)).toEqual(["board", "pipelines"]);
    nav.back();
    expect(kinds(nav)).toEqual(["board"]);
    expect(b.index()).toBe(0);
  });

  test("forward re-enters the popped screen", () => {
    const { nav, b } = phone();
    nav.push({ kind: "accounts" });
    b.host.history.back();
    expect(kinds(nav)).toEqual(["board"]);
    b.forward();
    expect(kinds(nav)).toEqual(["board", "accounts"]);
    expect(nav.getState().motion).toBe("push");
  });

  test("a sibling switch replaces the top: no new entry, and the host's own keys on that entry survive", () => {
    const { nav, b } = phone();
    b.host.history.replaceState({ llvFocus: { v: 1, conversationId: "c1", path: null, project: "atlas" } }, "", b.url());
    nav.push({ kind: "chat", id: "c1" });
    const before = b.length();
    b.host.history.replaceState({ ...(b.state() as object), llvFocus: { v: 1, conversationId: "c1", path: null, project: "atlas" } }, "", b.url());
    nav.replace({ kind: "chat", id: "c2" });
    expect(b.length()).toBe(before);
    expect(topScreen(nav.getState())).toEqual({ kind: "chat", id: "c2" });
    expect(nav.getState().motion).toBe("switch");
    const state = b.state() as Record<string, unknown>;
    expect(state.llvFocus).toEqual({ v: 1, conversationId: "c1", path: null, project: "atlas" });
    expect(readMobileNavEntry(state)).toEqual({ d: 2, screen: { kind: "chat", id: "c2" } });
    /* ‹ still leaves the way the operator came in. */
    nav.back();
    expect(kinds(nav)).toEqual(["board"]);
  });

  test("‹ at the bottom of the stack stays on the board and writes nothing", () => {
    const { nav, b } = phone();
    nav.back();
    expect(kinds(nav)).toEqual(["board"]);
    expect(b.length()).toBe(1);
    expect(b.state()).toBeNull();
  });

  test("a deep-linked screen at the bottom: ‹ replaces it with the board", () => {
    const { nav, b } = phone();
    nav.replace({ kind: "pipeline", id: "p1" });
    expect(kinds(nav)).toEqual(["pipeline"]);
    nav.back();
    expect(kinds(nav)).toEqual(["board"]);
    expect(nav.getState().motion).toBe("pop");
    expect(b.length()).toBe(1);
  });
});

describe("sheets", () => {
  test("a sheet opens over the current screen and creates no history entry; closing returns to it", () => {
    const { nav, b } = phone();
    nav.push({ kind: "accounts" });
    const before = b.length();
    nav.openSheet("menu");
    expect(nav.getState().sheet).toBe("menu");
    expect(nav.getState().motion).toBe("sheet");
    expect(b.length()).toBe(before);
    expect(kinds(nav)).toEqual(["board", "accounts"]);
    nav.closeSheet();
    expect(nav.getState().sheet).toBeNull();
    expect(kinds(nav)).toEqual(["board", "accounts"]);
    expect(b.length()).toBe(before);
  });

  test("a back gesture with a sheet open pops the screen underneath and takes the sheet with it; forward never re-opens it", () => {
    const { nav, b } = phone();
    nav.push({ kind: "pipelines" });
    nav.openSheet("menu");
    b.host.history.back();
    expect(kinds(nav)).toEqual(["board"]);
    expect(nav.getState().sheet).toBeNull();
    b.forward();
    expect(kinds(nav)).toEqual(["board", "pipelines"]);
    expect(nav.getState().sheet).toBeNull();
  });

  test("‹ with a sheet open on the board closes the sheet and stays", () => {
    const { nav, b } = phone();
    nav.openSheet("projects");
    nav.back();
    expect(nav.getState().sheet).toBeNull();
    expect(kinds(nav)).toEqual(["board"]);
    expect(b.length()).toBe(1);
  });

  test("a push closes the sheet it was tapped in", () => {
    const { nav } = phone();
    nav.openSheet("menu");
    nav.push({ kind: "accounts" });
    expect(nav.getState().sheet).toBeNull();
    expect(kinds(nav)).toEqual(["board", "accounts"]);
  });
});

describe("the host's own navigations", () => {
  test("a Viewer entry above a shell screen reads as the board; back from it re-enters the shell screen, then the board", () => {
    const { nav, b } = phone();
    nav.push({ kind: "accounts" });
    /* The operator opened a conversation from the queue: the Viewer records a
       typed entry and the shell lands on the board. */
    b.viewerPush({ llvFocus: { v: 1, conversationId: "c2", path: null, project: "atlas" } }, "http://phone/#c=c2");
    nav.home();
    expect(kinds(nav)).toEqual(["board"]);
    expect(nav.getState().sheet).toBeNull();
    b.host.history.back();
    expect(kinds(nav)).toEqual(["board", "accounts"]);
    b.host.history.back();
    expect(kinds(nav)).toEqual(["board"]);
    expect(nav.getState().motion).toBe("pop");
  });

  test("home from a deep stack lands on the board with no sheet and no bump", () => {
    const { nav } = phone();
    nav.push({ kind: "pipelines" });
    nav.push({ kind: "pipeline", id: "p1" });
    nav.openSheet("menu");
    nav.bump("right");
    nav.home();
    expect(nav.getState()).toMatchObject({ stack: [BOARD], sheet: null, bump: null, motion: "act" });
  });

  test("a bump is cleared by the bar", () => {
    const { nav } = phone();
    nav.bump("left");
    expect(nav.getState().bump).toBe("left");
    nav.clearBump();
    expect(nav.getState().bump).toBeNull();
  });
});

describe("history entries", () => {
  test("readMobileNavEntry refuses what the shell did not write", () => {
    expect(readMobileNavEntry(null)).toBeNull();
    expect(readMobileNavEntry({ llvFocus: { v: 1 } })).toBeNull();
    expect(readMobileNavEntry({ [MOBILE_NAV_STATE_KEY]: { d: 0, screen: { kind: "board" } } })).toBeNull();
    expect(readMobileNavEntry({ [MOBILE_NAV_STATE_KEY]: { d: 2, screen: { kind: "chat" } } })).toBeNull();
    expect(readMobileNavEntry({ [MOBILE_NAV_STATE_KEY]: { d: 2, screen: { kind: "bench" } } })).toBeNull();
    expect(readMobileNavEntry({ [MOBILE_NAV_STATE_KEY]: { d: 2, screen: { kind: "chat", id: "c1", extra: 1 } } })).toEqual({ d: 2, screen: { kind: "chat", id: "c1" } });
  });

  test("attach is ref-counted: the listener stays until the last screen detaches", () => {
    const b = browser();
    const nav = createMobileNav(b.host);
    const first = nav.attach();
    const second = nav.attach();
    expect(b.listening()).toBe(true);
    first();
    expect(b.listening()).toBe(true);
    second();
    expect(b.listening()).toBe(false);
    nav.push({ kind: "accounts" });
    b.host.history.back();
    /* Detached: the store no longer follows the browser. */
    expect(kinds(nav)).toEqual(["board", "accounts"]);
  });

  test("subscribers hear every change once", () => {
    const { nav } = phone();
    let heard = 0;
    const off = nav.subscribe(() => { heard += 1; });
    nav.openSheet("menu");
    nav.openSheet("menu");
    nav.closeSheet();
    off();
    nav.openSheet("menu");
    expect(heard).toBe(2);
  });
});
