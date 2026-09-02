import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { emptyStore, type ConnectionState } from "@/components/runtime/runtimeModel";
import { translate } from "@/lib/i18n";

/*
 * The shell (mobile v2 §2, §3.2–§3.4): one bar with the title cell and at
 * most three 44 px targets, one banner slot with one precedence, ⋯ and ⚠
 * opening over the current screen and closing back onto it, the browser's
 * back and the bar's ‹ as one pop, the receipt in flow above the dock.
 */

const actualRuntimeHooks = await import("@/hooks/useRuntime");
let runtime = {
  enabled: false,
  connection: "live" as ConnectionState,
  lastEventAt: null as number | null,
  resyncedAt: null,
  store: emptyStore(),
  structuredHostsEnabled: false,
};
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => runtime,
  useRuntime: () => runtime,
  useRuntimeSelector: (selector: (state: typeof runtime) => unknown) => selector(runtime),
  useRuntimeSession: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));

const { ATTENTION_PX, bannerKind, MobileBarTitle, MobileShell, TITLE_MIN_PX, titleCellWidth } = await import("./MobileShell");
const { MobileSheet } = await import("./MobileSheet");
const { receipts } = await import("./MobileReceipt");
const { createMobileNav, MobileNavContext, topScreen, useMobileNav } = await import("./mobileNav");
type MobileNav = ReturnType<typeof createMobileNav>;
type MobileNavHost = Parameters<typeof createMobileNav>[0];
type MobileShellHost = NonNullable<Parameters<typeof MobileShell>[0]["host"]>;

const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement,
  Event: dom.Event, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
beforeAll(() => { for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; } });
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

let roots: Root[] = [];
beforeEach(() => {
  dom.document.body.replaceChildren();
  dom.document.body.style.overflow = "";
  roots = [];
  runtime = { ...runtime, enabled: false, connection: "live", lastEventAt: null };
  receipts.dismiss();
});
afterEach(() => { for (const root of roots) flushSync(() => root.unmount()); roots = []; receipts.dismiss(); });

/** A model of the browser's same-document history. */
function browser() {
  const entries: { state: unknown; url: string }[] = [{ state: null, url: "http://localhost/#p=atlas" }];
  let index = 0;
  let listener: ((state: unknown) => void) | null = null;
  const host: MobileNavHost = {
    history: {
      get state() { return entries[index]!.state; },
      pushState(state, _unused, url) { entries.splice(index + 1); entries.push({ state, url: url ?? entries[index]!.url }); index += 1; },
      replaceState(state, _unused, url) { entries[index] = { state, url: url ?? entries[index]!.url }; },
      back() { if (index === 0) return; index -= 1; listener?.(entries[index]!.state); },
    },
    href: () => entries[index]!.url,
    onPopstate(next) { listener = next; return () => { listener = null; }; },
  };
  return { host, length: () => entries.length, back: () => host.history.back(), forward() { if (index >= entries.length - 1) return; index += 1; listener?.(entries[index]!.state); } };
}

function shellHost(over: Partial<MobileShellHost> = {}): MobileShellHost {
  return {
    attentionCount: 3,
    arrival: null,
    renderSheet: (name, close) => (
      <MobileSheet name={name} title={name} onClose={close}>
        <div data-testid={`${name}-sheet-body`} />
      </MobileSheet>
    ),
    ...over,
  };
}

function App({ nav, host }: { nav: MobileNav; host: MobileShellHost }) {
  const state = useMobileNav();
  const renderSheet = (name: string, close: () => void) => name === "menu" ? (
    <MobileSheet name="menu" title="atlas" onClose={close}>
      <button type="button" data-testid="go-accounts" data-mobile2-go="accounts" onClick={() => nav.push({ kind: "accounts" })}>Accounts &amp; limits</button>
    </MobileSheet>
  ) : null;
  if (topScreen(state).kind === "accounts") {
    return (
      <MobileShell screen="accounts" back title={<MobileBarTitle>Accounts &amp; limits</MobileBarTitle>} host={host} renderSheet={renderSheet}>
        <div data-testid="accounts-body">limits</div>
      </MobileShell>
    );
  }
  return (
    <MobileShell screen="board" title={<MobileBarTitle>atlas</MobileBarTitle>} titleLabel="Switch project" titleOpens="projects" host={host} onOpenSearch={() => {}} searchTestId="dash-search" renderSheet={renderSheet}>
      <div data-testid="body" className="overflow-y-auto">rows</div>
    </MobileShell>
  );
}

function mount(host: MobileShellHost = shellHost()): { root: HTMLElement; nav: MobileNav; b: ReturnType<typeof browser>; rerender: () => void } {
  const b = browser();
  const nav = createMobileNav(b.host);
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const reactRoot = createRoot(container as unknown as Element);
  const render = () => flushSync(() => reactRoot.render(<MobileNavContext.Provider value={nav}><App nav={nav} host={host} /></MobileNavContext.Provider>));
  render();
  roots.push(reactRoot);
  return { root: container as unknown as HTMLElement, nav, b, rerender: render };
}

const q = (root: HTMLElement, selector: string) => root.querySelector(selector) as unknown as HTMLElement | null;
const label = (el: Element) => el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "";
const click = (el: HTMLElement | null) => { expect(el).not.toBeNull(); flushSync(() => el!.click()); };

test("the bar budget: the title cell keeps at least 190 px at 390 with every target present, on the board and on a conversation", () => {
  expect(titleCellWidth(390, { back: false, attention: true, search: true, menu: true })).toBeGreaterThanOrEqual(TITLE_MIN_PX);
  expect(titleCellWidth(390, { back: true, attention: true, search: false, menu: true })).toBeGreaterThanOrEqual(TITLE_MIN_PX);
  /* The pill is the one target that is not 44 wide; the budget names it. */
  expect(ATTENTION_PX).toBeGreaterThan(44);
  expect(titleCellWidth(390, { back: false, attention: true, search: true, menu: true })).toBe(236);
});

test("the board bar: a title cell that is the project switcher, then at most three 44 px targets — badge, search, ⋯", () => {
  const { root } = mount();
  const bar = q(root, "[data-mobile2-bar]")!;
  expect(q(root, '[data-mobile2-screen="board"]')).not.toBeNull();
  expect(q(root, "[data-mobile2-back]")).toBeNull();
  const title = q(root, "[data-mobile2-title]")!;
  expect(title.tagName).toBe("BUTTON");
  expect(title.getAttribute("data-mobile2-open")).toBe("projects");
  expect(title.className).toContain("flex-1");
  expect(title.className).toContain("min-w-0");
  expect(title.textContent).toContain("atlas");
  const targets = Array.from(bar.querySelectorAll("button")).filter((el) => el !== (title as unknown as Element));
  expect(targets.map(label)).toEqual([
    translate("en", "mobile2.bar.attention", { count: 3 }),
    translate("en", "mobile2.bar.search"),
    translate("en", "mobile2.bar.more"),
  ]);
  for (const target of targets) expect(`${target.className} `).toMatch(/(^|\s)h-11(\s|$)/);
  expect(targets[0]!.getAttribute("data-mobile2-open")).toBe("attention");
  expect(targets[1]!.getAttribute("data-testid")).toBe("dash-search");
  expect(targets[2]!.getAttribute("data-mobile2-open")).toBe("menu");
  /* Nothing else rides the bar. */
  expect(bar.querySelectorAll("button, a, select").length).toBe(4);
});

test("the badge is hidden at zero, and a screen without search keeps two targets", () => {
  const { root } = mount(shellHost({ attentionCount: 0 }));
  expect(q(root, '[data-mobile2-open="attention"]')).toBeNull();
  const bar = q(root, "[data-mobile2-bar]")!;
  expect(bar.querySelectorAll("button").length).toBe(3);
});

test("the banner slot: offline outranks degraded outranks an arrival; the board never shows an arrival; nothing while the runtime UI is off", () => {
  expect(bannerKind(true, "offline", true, "chat")).toBe("offline");
  expect(bannerKind(true, "degraded", true, "chat")).toBe("degraded");
  expect(bannerKind(true, "live", true, "chat")).toBe("arrival");
  expect(bannerKind(true, "live", true, "accounts")).toBe("arrival");
  expect(bannerKind(true, "reconnecting", false, "chat")).toBeNull();
  expect(bannerKind(false, "offline", false, "chat")).toBeNull();
  /* README §2 rule 3: the queue is the board's first section, so the board
     drops the arrival kind and keeps the runtime kinds. */
  expect(bannerKind(true, "live", true, "board")).toBeNull();
  expect(bannerKind(false, "live", true, "board")).toBeNull();
  expect(bannerKind(true, "degraded", true, "board")).toBe("degraded");
  expect(bannerKind(true, "offline", true, "board")).toBe("offline");

  const { root, nav, b, rerender } = mount(shellHost({ arrival: <div data-testid="arrival">Needs you · plan approval</div> }));
  /* A queued arrival with a live runtime: the board renders no banner at all,
     and the ⚠ badge carries the count. */
  expect(q(root, '[data-mobile2-screen="board"]')).not.toBeNull();
  expect(q(root, "[data-mobile2-banner]")).toBeNull();
  expect(q(root, '[data-testid="arrival"]')).toBeNull();
  const badge = q(root, '[data-mobile2-open="attention"]')!;
  expect(badge).not.toBeNull();
  expect(badge.getAttribute("data-mobile2-attention-count")).toBe("3");
  /* Every other screen shows the arrival in the slot, under the bar. */
  flushSync(() => nav.push({ kind: "accounts" }));
  expect(q(root, '[data-mobile2-screen="accounts"]')).not.toBeNull();
  const arrival = q(root, '[data-mobile2-banner-kind="arrival"]')!;
  expect(arrival).not.toBeNull();
  expect(q(root, '[data-testid="arrival"]')).not.toBeNull();
  expect(q(root, "[data-mobile2-bar]")!.compareDocumentPosition(arrival as never) & dom.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  /* The runtime states outrank it, and they show on every screen, the board included. */
  runtime = { ...runtime, enabled: true, connection: "degraded" };
  rerender();
  const degraded = q(root, "[data-mobile2-banner]")!;
  expect(degraded.getAttribute("data-mobile2-banner-kind")).toBe("degraded");
  expect(degraded.getAttribute("data-connection")).toBe("degraded");
  expect(degraded.textContent).toContain(translate("en", "mobile2.banner.degradedTitle"));
  expect(q(root, '[data-testid="arrival"]')).toBeNull();
  flushSync(() => b.back());
  expect(q(root, '[data-mobile2-screen="board"]')).not.toBeNull();
  expect(q(root, "[data-mobile2-banner]")!.getAttribute("data-mobile2-banner-kind")).toBe("degraded");
  runtime = { ...runtime, connection: "offline", lastEventAt: Date.UTC(2100, 0, 2, 14, 2) };
  rerender();
  const offline = q(root, "[data-mobile2-banner]")!;
  expect(offline.getAttribute("data-mobile2-banner-kind")).toBe("offline");
  expect(offline.textContent).toContain(translate("en", "mobile2.banner.offlineTitle"));
  expect(offline.textContent).toContain("last state received ·");
  /* The slot is in flow under the bar: not a control, never over one. */
  expect(offline.querySelectorAll("button").length).toBe(0);
  expect(q(root, "[data-mobile2-bar]")!.compareDocumentPosition(offline as never) & dom.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  /* Runtime UI off: the board stays bare, a pushed screen gets the arrival back. */
  runtime = { ...runtime, enabled: false };
  rerender();
  expect(q(root, "[data-mobile2-banner]")).toBeNull();
  flushSync(() => nav.push({ kind: "accounts" }));
  expect(q(root, '[data-mobile2-banner-kind="arrival"]')).not.toBeNull();
  /* And popping back onto the board drops it again: the suppression follows
     the screen the shell is on, not the render the arrival arrived in. */
  flushSync(() => b.back());
  expect(q(root, '[data-mobile2-screen="board"]')).not.toBeNull();
  expect(q(root, "[data-mobile2-banner]")).toBeNull();
  expect(q(root, '[data-testid="arrival"]')).toBeNull();
});

test("⋯ opens the board menu over the current screen with no history entry; × closes back onto it with its scroll kept", () => {
  const { root, nav, b } = mount();
  const body = q(root, '[data-testid="body"]')!;
  body.scrollTop = 40;
  const before = b.length();
  click(q(root, '[data-mobile2-open="menu"]'));
  expect(nav.getState().sheet).toBe("menu");
  expect(q(root, '[data-mobile2-sheet="menu"]')).not.toBeNull();
  expect(q(root, '[data-mobile2-screen="board"]')).not.toBeNull();
  expect(b.length()).toBe(before);
  expect(q(root, '[data-mobile2-open="menu"]')!.getAttribute("aria-expanded")).toBe("true");
  click(q(root, "[data-mobile2-close]"));
  expect(q(root, "[data-mobile2-sheet]")).toBeNull();
  expect(q(root, '[data-mobile2-screen="board"]')).not.toBeNull();
  expect(q(root, '[data-testid="body"]')).toBe(body);
  expect(body.scrollTop).toBe(40);
  expect(b.length()).toBe(before);
});

test("⚠ opens the queue over the current screen; a navigation from it lands on the board with no sheet", () => {
  const { root, nav, b } = mount();
  const before = b.length();
  click(q(root, '[data-mobile2-open="attention"]'));
  expect(q(root, '[data-mobile2-sheet="attention"]')).not.toBeNull();
  expect(q(root, '[data-testid="attention-sheet-body"]')).not.toBeNull();
  expect(b.length()).toBe(before);
  /* The row's open goes through the Viewer's focus route, which lands home. */
  flushSync(() => nav.home());
  expect(q(root, "[data-mobile2-sheet]")).toBeNull();
  expect(q(root, '[data-mobile2-screen="board"]')).not.toBeNull();
});

test("the title cell opens the project switcher over the board and closes back onto it", () => {
  const { root } = mount();
  click(q(root, "[data-mobile2-title]"));
  expect(q(root, '[data-mobile2-sheet="projects"]')).not.toBeNull();
  expect(q(root, "[data-mobile2-title]")!.getAttribute("aria-expanded")).toBe("true");
  click(q(root, "[data-mobile2-close]"));
  expect(q(root, "[data-mobile2-sheet]")).toBeNull();
  expect(q(root, "[data-mobile2-title]")!.getAttribute("aria-expanded")).toBe("false");
});

test("a menu row pushes a screen; the bar's ‹ and the browser's back are the same pop", () => {
  const { root, b } = mount();
  click(q(root, '[data-mobile2-open="menu"]'));
  click(q(root, '[data-mobile2-go="accounts"]'));
  expect(q(root, '[data-mobile2-screen="accounts"]')).not.toBeNull();
  expect(q(root, '[data-mobile2-screen="board"]')).toBeNull();
  expect(q(root, "[data-mobile2-sheet]")).toBeNull();
  expect(b.length()).toBe(2);
  /* ⋯ on the pushed screen opens the same menu over it. */
  expect(q(root, '[data-mobile2-open="menu"]')).not.toBeNull();
  click(q(root, "[data-mobile2-back]"));
  expect(q(root, '[data-mobile2-screen="board"]')).not.toBeNull();
  expect(q(root, '[data-mobile2-screen="accounts"]')).toBeNull();
  /* The same from the browser. */
  click(q(root, '[data-mobile2-open="menu"]'));
  click(q(root, '[data-mobile2-go="accounts"]'));
  expect(q(root, '[data-mobile2-screen="accounts"]')).not.toBeNull();
  flushSync(() => b.back());
  expect(q(root, '[data-mobile2-screen="board"]')).not.toBeNull();
});

test("a back gesture with a sheet open pops the screen underneath and takes the sheet with it; forward never lands on a sheet", () => {
  const { root, b } = mount();
  click(q(root, '[data-mobile2-open="menu"]'));
  click(q(root, '[data-mobile2-go="accounts"]'));
  click(q(root, '[data-mobile2-open="menu"]'));
  expect(q(root, '[data-mobile2-sheet="menu"]')).not.toBeNull();
  flushSync(() => b.back());
  expect(q(root, '[data-mobile2-screen="board"]')).not.toBeNull();
  expect(q(root, "[data-mobile2-sheet]")).toBeNull();
  flushSync(() => b.forward());
  expect(q(root, '[data-mobile2-screen="accounts"]')).not.toBeNull();
  expect(q(root, "[data-mobile2-sheet]")).toBeNull();
});

test("the receipt sits in flow between the body and the dock; a sheet takes it inside itself", () => {
  const { root } = mount();
  let restored = 0;
  flushSync(() => { receipts.show("Archived", { kind: "restore", run: () => { restored += 1; } }); });
  const flow = q(root, '[data-mobile2-receipt-placement="flow"]')!;
  expect(flow).not.toBeNull();
  expect(q(root, '[data-mobile2-screen="board"]')!.contains(flow as never)).toBe(true);
  const body = q(root, "[data-mobile2-body]")!;
  expect(body.compareDocumentPosition(flow as never) & dom.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  click(q(root, '[data-mobile2-open="menu"]'));
  expect(q(root, '[data-mobile2-receipt-placement="flow"]')).toBeNull();
  const inSheet = q(root, '[data-mobile2-receipt-placement="sheet"]')!;
  expect(q(root, '[data-mobile2-sheet="menu"]')!.contains(inSheet as never)).toBe(true);
  click(q(root, '[data-mobile2-receipt-undo="restore"]'));
  expect(restored).toBe(1);
  expect(q(root, "[data-mobile2-receipt]")).toBeNull();
});
