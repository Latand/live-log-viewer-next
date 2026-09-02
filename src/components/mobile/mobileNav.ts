"use client";

import { createContext, useContext, useSyncExternalStore } from "react";

/*
 * The phone's navigation contract (docs/design/mobile-v2/README.md §3.3; the
 * prototype's `route` in prototype/app.js): screens push onto a stack, sheets
 * never create a history entry, the browser's back gesture and the bar's ‹ are
 * the same pop, a sibling switch replaces the top of the stack, and nothing
 * ever lands on a sheet route after a back — a traversal takes any open sheet
 * with it, and forward never re-opens one.
 *
 * The stack lives here, in one store every shell screen reads; the browser's
 * history only counts depth. A screen push writes an entry whose state carries
 * the depth and the screen (the URL stays as it is: the Viewer owns the
 * fragment, and a shell screen is a place inside the document, not a deep
 * link), so a later popstate can tell a pop from a forward without reading the
 * URL. Entries the Viewer writes itself — a project switch, a conversation
 * focus — carry no shell state and read as depth 1, the board, which is where
 * those navigations land (`home`).
 */

export type MobileScreen =
  | { kind: "board" }
  | { kind: "chat"; id: string }
  | { kind: "pipelines" }
  | { kind: "pipeline"; id: string }
  | { kind: "accounts" };
export type MobileScreenKind = MobileScreen["kind"];
export type MobileSheetName = "projects" | "attention" | "menu" | "host" | "search" | "seat" | "rotate" | "switch" | "model";
/** How the current state was reached; the shell picks its transition from it. */
export type MobileNavMotion = "load" | "push" | "pop" | "switch" | "sheet" | "act";

export interface MobileNavState {
  readonly stack: readonly MobileScreen[];
  readonly sheet: MobileSheetName | null;
  readonly motion: MobileNavMotion;
  /** The title cell's bump after an end-of-list swipe (§3.3); the bar clears it. */
  readonly bump: "left" | "right" | null;
}

export const BOARD: MobileScreen = { kind: "board" };
export const INITIAL_MOBILE_NAV: MobileNavState = { stack: [BOARD], sheet: null, motion: "load", bump: null };

/** The key a shell screen's history entry carries its depth and screen under. */
export const MOBILE_NAV_STATE_KEY = "mobile2";

export interface MobileNavEntry {
  /** 1 is the board, the bottom of every stack. */
  d: number;
  screen: MobileScreen;
}

const SCREEN_KINDS: ReadonlySet<string> = new Set(["board", "chat", "pipelines", "pipeline", "accounts"]);
const WITH_ID: ReadonlySet<string> = new Set(["chat", "pipeline"]);

function isScreen(value: unknown): value is MobileScreen {
  if (typeof value !== "object" || value === null) return false;
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !SCREEN_KINDS.has(kind)) return false;
  const id = (value as { id?: unknown }).id;
  return WITH_ID.has(kind) ? typeof id === "string" && id.length > 0 : id === undefined;
}

/** The shell entry inside a history state, or null for an entry the shell did
    not write (the Viewer's own, a foreign page, a malformed one). */
export function readMobileNavEntry(state: unknown): MobileNavEntry | null {
  if (typeof state !== "object" || state === null) return null;
  const raw = (state as Record<string, unknown>)[MOBILE_NAV_STATE_KEY];
  if (typeof raw !== "object" || raw === null) return null;
  const { d, screen } = raw as { d?: unknown; screen?: unknown };
  if (typeof d !== "number" || !Number.isInteger(d) || d < 1) return null;
  if (!isScreen(screen)) return null;
  return { d, screen: screen.kind === "chat" || screen.kind === "pipeline" ? { kind: screen.kind, id: screen.id } : { kind: screen.kind } };
}

export function screenKey(screen: MobileScreen): string {
  return "id" in screen ? `${screen.kind}:${screen.id}` : screen.kind;
}

export function sameScreen(a: MobileScreen, b: MobileScreen): boolean {
  return screenKey(a) === screenKey(b);
}

export function topScreen(state: MobileNavState): MobileScreen {
  return state.stack[state.stack.length - 1] ?? BOARD;
}

/** What the store needs from the browser: the same-document history and its
    traversal events. Injected so the contract is testable without a window. */
export interface MobileNavHistory {
  readonly state: unknown;
  pushState(state: unknown, unused: string, url?: string): void;
  replaceState(state: unknown, unused: string, url?: string): void;
  back(): void;
}

export interface MobileNavHost {
  history: MobileNavHistory;
  /** The document's current URL: a screen push keeps it. */
  href(): string;
  /** Subscribe to history traversals with the landed entry's state. */
  onPopstate(listener: (state: unknown) => void): () => void;
}

export interface MobileNav {
  getState(): MobileNavState;
  subscribe(listener: () => void): () => void;
  /** Push a screen (200 ms slide from the right). Closes any open sheet. */
  push(screen: MobileScreen): void;
  /** Replace the top of the stack: a sibling switch (120 ms crossfade). */
  replace(screen: MobileScreen, motion?: "switch" | "pop"): void;
  /** The bar's ‹ and the platform back are the same pop; at the bottom of the
      stack it lands on the board and closes whatever sheet is open. */
  back(): void;
  /** Open a sheet over the current screen: no history entry. */
  openSheet(name: MobileSheetName): void;
  closeSheet(): void;
  /** The host navigated itself (a project switch, a conversation focus): the
      shell lands on the board with no sheet. */
  home(): void;
  bump(side: "left" | "right"): void;
  clearBump(): void;
  /** Start following history traversals; returns the detach. Ref-counted, so
      several mounted screens share one listener. */
  attach(): () => void;
}

function carried(state: unknown): Record<string, unknown> {
  return typeof state === "object" && state !== null ? { ...(state as Record<string, unknown>) } : {};
}

export function createMobileNav(host: MobileNavHost): MobileNav {
  let state: MobileNavState = INITIAL_MOBILE_NAV;
  const listeners = new Set<() => void>();
  const set = (next: Partial<MobileNavState>): void => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const entry = (stack: readonly MobileScreen[]): MobileNavEntry => ({ d: stack.length, screen: stack[stack.length - 1] ?? BOARD });

  const replace = (screen: MobileScreen, motion: "switch" | "pop" = "switch"): void => {
    const stack = [...state.stack.slice(0, -1), screen];
    /* Same entry, so the host's own keys on it stay (a typed focus entry keeps
       replaying after a sibling switch); only the shell's key moves. */
    host.history.replaceState({ ...carried(host.history.state), [MOBILE_NAV_STATE_KEY]: entry(stack) }, "", host.href());
    set({ stack, sheet: null, motion, bump: null });
  };

  /* A traversal landed on `landed`. Its depth against the stack says whether
     the operator went back or forward; either way the sheet is gone. */
  const onTraversal = (landed: unknown): void => {
    const target = readMobileNavEntry(landed);
    const d = target?.d ?? 1;
    const depth = state.stack.length;
    if (d < depth) {
      set({ stack: state.stack.slice(0, d), sheet: null, motion: "pop", bump: null });
    } else if (d > depth) {
      set({ stack: target ? [...state.stack, target.screen] : state.stack, sheet: null, motion: target ? "push" : "act", bump: null });
    } else if (target && !sameScreen(target.screen, topScreen(state))) {
      set({ stack: [...state.stack.slice(0, -1), target.screen], sheet: null, motion: "switch", bump: null });
    } else if (state.sheet) {
      set({ sheet: null, motion: "sheet" });
    }
  };

  let attached = 0;
  let detach: (() => void) | null = null;

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    push(screen) {
      const stack = [...state.stack, screen];
      host.history.pushState({ [MOBILE_NAV_STATE_KEY]: entry(stack) }, "", host.href());
      set({ stack, sheet: null, motion: "push", bump: null });
    },
    replace,
    back() {
      if (state.stack.length > 1) {
        host.history.back();
        return;
      }
      if (topScreen(state).kind === "board") {
        if (state.sheet) set({ sheet: null, motion: "sheet" });
        return;
      }
      replace(BOARD, "pop");
    },
    openSheet(name) {
      if (state.sheet !== name) set({ sheet: name, motion: "sheet" });
    },
    closeSheet() {
      if (state.sheet) set({ sheet: null, motion: "sheet" });
    },
    home() {
      if (state.stack.length === 1 && topScreen(state).kind === "board" && !state.sheet && !state.bump) return;
      set({ stack: [BOARD], sheet: null, motion: "act", bump: null });
    },
    bump(side) {
      set({ bump: side });
    },
    clearBump() {
      if (state.bump) set({ bump: null });
    },
    attach() {
      attached += 1;
      if (!detach) detach = host.onPopstate(onTraversal);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        attached -= 1;
        if (attached === 0 && detach) {
          detach();
          detach = null;
        }
      };
    },
  };
}

const noop = (): void => {};
/** The server render and any non-browser reader see the board with no sheet. */
const INERT: MobileNav = {
  getState: () => INITIAL_MOBILE_NAV,
  subscribe: () => noop,
  push: noop,
  replace: noop,
  back: noop,
  openSheet: noop,
  closeSheet: noop,
  home: noop,
  bump: noop,
  clearBump: noop,
  attach: () => noop,
};

let browserNav: MobileNav | null = null;
let browserNavWindow: Window | null = null;

/** The tab's one navigation store, over the real history. A test process
    that swaps its window gets a store over the new one. */
export function getMobileNav(): MobileNav {
  if (typeof window === "undefined") return INERT;
  if (!browserNav || browserNavWindow !== window) {
    browserNavWindow = window;
    browserNav = createMobileNav({
      history: window.history,
      href: () => window.location.href,
      onPopstate(listener) {
        const handler = (event: PopStateEvent) => listener(event.state);
        window.addEventListener("popstate", handler);
        return () => window.removeEventListener("popstate", handler);
      },
    });
  }
  return browserNav;
}

/** Tests mount a shell over their own store (a fake history); the app reads
    the browser singleton. */
export const MobileNavContext = createContext<MobileNav | null>(null);

export function useMobileNavStore(): MobileNav {
  return useContext(MobileNavContext) ?? getMobileNav();
}

export function useMobileNav(): MobileNavState {
  const nav = useMobileNavStore();
  return useSyncExternalStore(nav.subscribe, nav.getState, () => INITIAL_MOBILE_NAV);
}
