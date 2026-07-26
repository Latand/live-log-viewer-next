import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { WakeLockEnvironment, WakeLockSentinelLike } from "@/hooks/useScreenWakeLock";
import { translate } from "@/lib/i18n";

import { KeepAwakeMenuRow, KeepAwakeProvider } from "./KeepAwakeControl";

/*
 * Issue #712 — the React seam: the provider is the app's ONE wake-lock owner and
 * the «⋯»-menu row is the only surface that reports it. These tests drive the
 * real component pair over an injected Wake Lock API and assert the visible
 * truth: no state may read as «screen held» unless a sentinel is actually held.
 */

const dom = new Window({ url: "https://viewer.local/", width: 390, height: 844 });
/* The phone face, switchable per test: the provider owns a controller only there
   (the control lives in the phone header, so a desktop window must not hold a
   lock it cannot show an off switch for). */
let phoneFace = true;
(dom as unknown as { matchMedia(query: string): unknown }).matchMedia = (query: string) => ({
  matches: phoneFace && /max-width|pointer: coarse/.test(String(query)),
  media: String(query),
  onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
});
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
});

interface FakeSentinel extends WakeLockSentinelLike {
  released: boolean;
  systemRelease(): void;
}

function fakeSentinel(): FakeSentinel {
  const listeners = new Set<() => void>();
  const sentinel: FakeSentinel = {
    released: false,
    async release() {
      if (sentinel.released) return;
      sentinel.released = true;
      for (const listener of [...listeners]) listener();
    },
    addEventListener: (_type, listener) => void listeners.add(listener),
    removeEventListener: (_type, listener) => void listeners.delete(listener),
    systemRelease() {
      sentinel.released = true;
      for (const listener of [...listeners]) listener();
    },
  };
  return sentinel;
}

interface Scene {
  granted: FakeSentinel[];
  requests: number;
  hidden: boolean;
  store: Map<string, string>;
  /** Sentinels handed out that nobody released — must never exceed one. */
  held(): FakeSentinel[];
  environment: WakeLockEnvironment;
  /** Stable identity: the hook rebuilds its controller when this changes. */
  factory(): WakeLockEnvironment;
}

function world(options: { supported?: boolean; secureContext?: boolean; persisted?: boolean } = {}): Scene {
  const store = new Map<string, string>();
  if (options.persisted) store.set("llvKeepAwake", "1");
  /* One mutable object handed straight to the test — spreading it into a copy
     would freeze `requests`/`hidden` at their initial values. */
  const scene: Scene = {
    granted: [] as FakeSentinel[],
    requests: 0,
    hidden: false,
    store,
    held: () => scene.granted.filter((sentinel) => !sentinel.released),
    environment: {
      request:
        options.supported === false
          ? null
          : () => {
              scene.requests += 1;
              const sentinel = fakeSentinel();
              scene.granted.push(sentinel);
              return Promise.resolve(sentinel);
            },
      secureContext: options.secureContext !== false,
      isVisible: () => !scene.hidden,
      storage: { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => void store.set(key, value) },
    } satisfies WakeLockEnvironment,
    /* A stable factory identity: the hook re-creates its controller whenever the
       environment factory changes, which would look like a remount. */
    factory: () => scene.environment,
  };
  return scene;
}

const roots = new Set<Root>();
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
  phoneFace = true;
});

function mount(environment: () => WakeLockEnvironment, extra?: { nested?: boolean }) {
  const element = dom.document.createElement("div");
  dom.document.body.append(element);
  const host = element as unknown as HTMLElement;
  const root = createRoot(host);
  roots.add(root);
  const row = <KeepAwakeMenuRow />;
  flushSync(() =>
    root.render(
      <KeepAwakeProvider environment={environment}>
        {extra?.nested ? <KeepAwakeProvider environment={environment}>{row}</KeepAwakeProvider> : row}
      </KeepAwakeProvider>,
    ),
  );
  return host;
}

const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const row = (host: HTMLElement) => host.querySelector('[data-testid="keep-awake-row"]') as unknown as HTMLElement;
const status = (host: HTMLElement) => row(host).getAttribute("data-wake-lock-status");
const caption = (host: HTMLElement) => (row(host).querySelector('[role="status"]') as unknown as HTMLElement).textContent?.trim();
const toggle = (host: HTMLElement) => row(host).querySelector('[role="switch"]') as unknown as HTMLButtonElement;
const en = (key: Parameters<typeof translate>[1]) => translate("en", key);

test("the row is a 44px accessible switch that starts off and names the sleep behaviour", async () => {
  const scene = world();
  const host = mount(scene.factory);
  await settle();

  const control = toggle(host);
  expect(control.className).toContain("h-11");
  expect(control.className).toContain("w-11");
  expect(control.getAttribute("aria-checked")).toBe("false");
  expect(control.getAttribute("aria-label")).toBe(en("keepAwake.enableAria"));
  expect(control.getAttribute("aria-describedby")).toBe("keep-awake-caption");
  expect(control.disabled).toBe(false);
  expect(row(host).textContent).toContain(en("keepAwake.label"));
  expect(status(host)).toBe("off");
  expect(caption(host)).toBe(en("keepAwake.off"));
  expect(scene.requests).toBe(0);
});

test("one tap acquires a single sentinel, says the screen is held, and names the battery cost", async () => {
  const scene = world();
  const host = mount(scene.factory);
  await settle();

  flushSync(() => toggle(host).click());
  await settle();

  expect(status(host)).toBe("active");
  expect(caption(host)).toBe(en("keepAwake.active"));
  expect(caption(host)?.toLowerCase()).toContain("battery");
  expect(scene.requests).toBe(1);
  expect(scene.held()).toHaveLength(1);
  expect(toggle(host).getAttribute("aria-checked")).toBe("true");
  expect(toggle(host).getAttribute("aria-label")).toBe(en("keepAwake.disableAria"));
  /* The choice is this device's, written locally and nowhere else. */
  expect(scene.store.get("llvKeepAwake")).toBe("1");
});

test("a second tap releases the sentinel", async () => {
  const scene = world({ persisted: true });
  const host = mount(scene.factory);
  await settle();
  expect(status(host)).toBe("active");

  flushSync(() => toggle(host).click());
  await settle();

  expect(status(host)).toBe("off");
  expect(scene.held()).toHaveLength(0);
  expect(scene.granted[0]!.released).toBe(true);
  expect(scene.store.get("llvKeepAwake")).toBe("0");
});

test("backgrounding the tab releases the lock and coming back re-acquires it", async () => {
  const scene = world({ persisted: true });
  const host = mount(scene.factory);
  await settle();
  const first = scene.granted[0]!;

  scene.hidden = true;
  flushSync(() => void dom.document.dispatchEvent(new dom.Event("visibilitychange")));
  await settle();
  expect(status(host)).toBe("waiting");
  expect(caption(host)).toBe(en("keepAwake.waiting"));
  expect(first.released).toBe(true);
  /* The switch still reads on: the intent survives, only the hold is paused. */
  expect(toggle(host).getAttribute("aria-checked")).toBe("true");

  scene.hidden = false;
  flushSync(() => void dom.document.dispatchEvent(new dom.Event("visibilitychange")));
  await settle();
  expect(status(host)).toBe("active");
  expect(scene.requests).toBe(2);
  expect(scene.held()).toHaveLength(1);
});

test("a page restored from the back/forward cache re-acquires on pageshow alone", async () => {
  const scene = world({ persisted: true });
  const host = mount(scene.factory);
  await settle();

  /* iOS can restore a page with no visibilitychange at all, and the sentinel is
     long gone by then. */
  scene.granted[0]!.systemRelease();
  scene.hidden = true;
  flushSync(() => void dom.document.dispatchEvent(new dom.Event("visibilitychange")));
  await settle();
  const before = scene.requests;

  scene.hidden = false;
  flushSync(() => void dom.window.dispatchEvent(new dom.Event("pageshow")));
  await settle();

  expect(scene.requests).toBe(before + 1);
  expect(status(host)).toBe("active");
});

test("the system dropping the lock while visible is surfaced, never hidden behind a green switch", async () => {
  const scene = world({ persisted: true });
  const host = mount(scene.factory);
  await settle();

  /* One bounded recovery, then the truth. */
  scene.granted[0]!.systemRelease();
  await settle();
  expect(status(host)).toBe("active");
  scene.granted[1]!.systemRelease();
  await settle();

  expect(status(host)).toBe("interrupted");
  expect(caption(host)).toBe(en("keepAwake.interrupted"));
  expect(scene.held()).toHaveLength(0);
});

test("unmounting releases the sentinel and unhooks the visibility listeners", async () => {
  const scene = world({ persisted: true });
  mount(scene.factory);
  await settle();
  const granted = scene.granted[0]!;

  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  await settle();
  expect(granted.released).toBe(true);
  expect(scene.held()).toHaveLength(0);

  /* No listener left behind to resurrect a lock nothing is showing. */
  flushSync(() => void dom.document.dispatchEvent(new dom.Event("visibilitychange")));
  flushSync(() => void dom.window.dispatchEvent(new dom.Event("pageshow")));
  await settle();
  expect(scene.requests).toBe(1);
  expect(scene.held()).toHaveLength(0);
});

test("an unsupported browser shows an inert switch with the reason, not a dead toggle", async () => {
  const scene = world({ supported: false, persisted: true });
  const host = mount(scene.factory);
  await settle();

  expect(status(host)).toBe("unsupported");
  expect(caption(host)).toBe(en("keepAwake.unsupported"));
  expect(toggle(host).disabled).toBe(true);
  /* A persisted intent must not read as «on» when it can never be honoured. */
  expect(toggle(host).getAttribute("aria-checked")).toBe("false");
});

test("a plain-HTTP page explains the secure-context requirement instead of failing silently", async () => {
  const scene = world({ secureContext: false });
  const host = mount(scene.factory);
  await settle();

  expect(status(host)).toBe("insecure");
  expect(caption(host)).toBe(en("keepAwake.insecure"));
  expect(caption(host)).toContain("HTTPS");
  expect(toggle(host).disabled).toBe(true);
  expect(scene.requests).toBe(0);
});

test("nesting providers still yields exactly one owner and one sentinel", async () => {
  const scene = world({ persisted: true });
  const host = mount(scene.factory, { nested: true });
  await settle();

  expect(status(host)).toBe("active");
  /* The inner provider defers to the outer controller: one request, one hold. */
  expect(scene.requests).toBe(1);
  expect(scene.held()).toHaveLength(1);
});

test("a desktop-width window owns no controller, so a persisted intent holds nothing there", async () => {
  const scene = world({ persisted: true });
  phoneFace = false;
  const host = mount(scene.factory);
  await settle();

  /* The control only exists in the phone header — a lock held here would have no
     visible off switch. */
  expect(host.querySelector('[data-testid="keep-awake-row"]')).toBeNull();
  expect(scene.requests).toBe(0);
  expect(scene.held()).toHaveLength(0);
});

test("outside a provider the row renders nothing at all", () => {
  const element = dom.document.createElement("div");
  dom.document.body.append(element);
  const host = element as unknown as HTMLElement;
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => root.render(<KeepAwakeMenuRow />));
  expect(host.querySelector('[data-testid="keep-awake-row"]')).toBeNull();
});
