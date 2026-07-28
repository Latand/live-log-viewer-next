import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { useEffect } from "react";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";

import {
  documentPictureInPictureSupported,
  PIP_DEFAULT_SIZE,
  useDocumentPictureInPicture,
  type PictureInPictureHandle,
} from "./useDocumentPictureInPicture";

/**
 * The window provider, on its own.
 *
 * Kept separate from the host's suite because this is the only file that touches the
 * browser API, and because the Electron phase replaces exactly this module and nothing
 * else. Whatever provides the window later has to satisfy these cases unchanged.
 */

installActEnv();

const dom = new Window({ url: "http://localhost/" });
const pip = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};

const OVERRIDES = (): Record<string, unknown> => ({
  window: dom,
  document: dom.document,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  /* A recording stand-in for the browser's own. The module's late-CSS follower is
     only reachable through it, and happy-dom delivers real mutation records on a
     schedule this harness cannot pin down — which would make the coalescing
     assertions below a race rather than a test. Firing the callbacks by hand is
     exactly what the browser does, minus the timing. */
  MutationObserver: class {
    static instances: { targets: unknown[]; options: unknown[]; fire: () => void; disconnected: number }[] = [];
    private record: { targets: unknown[]; options: unknown[]; fire: () => void; disconnected: number };
    constructor(callback: () => void) {
      this.record = { targets: [], options: [], fire: callback, disconnected: 0 };
      (this.constructor as typeof this.constructor & { instances: unknown[] }).instances.push(this.record);
    }
    observe(target: unknown, options: unknown) {
      this.record.targets.push(target);
      this.record.options.push(options);
    }
    disconnect() { this.record.disconnected += 1; }
    takeRecords() { return []; }
  },
});

const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0)); };

/** The observers the module attached, in construction order. */
type ObserverRecord = { targets: unknown[]; options: unknown[]; fire: () => void; disconnected: number };
const observers = (): ObserverRecord[] =>
  (G.MutationObserver as unknown as { instances: ObserverRecord[] }).instances;

let supported = true;
let rejects = false;
let requested: { width?: number; height?: number }[] = [];
let closes = 0;
let sheets: unknown[] = [];
/* Every `adoptStyles` run reads the opener's stylesheet list exactly once, so this
   counts ADOPTIONS — the number the coalescing exists to keep at one per burst. */
let adoptions = 0;

beforeAll(() => {
  const overrides = OVERRIDES();
  for (const key of Object.keys(overrides)) {
    HAS[key] = key in G;
    SAVED[key] = G[key];
    G[key] = overrides[key];
  }
  Object.defineProperty(dom.document, "styleSheets", {
    configurable: true,
    get: () => { adoptions += 1; return sheets; },
  });
});

afterAll(async () => {
  await settle();
  for (const key of Object.keys(HAS)) {
    if (HAS[key]) G[key] = SAVED[key];
    else delete G[key];
  }
});

let roots: Root[] = [];

beforeEach(() => {
  dom.document.body.replaceChildren();
  pip.document.head.replaceChildren();
  pip.document.body.replaceChildren();
  roots = [];
  supported = true;
  rejects = false;
  requested = [];
  closes = 0;
  sheets = [];
  adoptions = 0;
  observers().length = 0;
  Object.defineProperty(dom, "documentPictureInPicture", {
    configurable: true,
    get: () => (supported
      ? {
        window: null,
        requestWindow: async (options?: { width?: number; height?: number }) => {
          requested.push(options ?? {});
          if (rejects) throw new Error("denied");
          return pip as unknown as Window;
        },
      }
      : undefined),
  });
  Object.defineProperty(pip, "close", { configurable: true, writable: true, value: () => { closes += 1; } });
});

afterEach(async () => {
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];
  await settle();
});

/** Drives the hook through a real render so the effects under test actually run.
    The handle is published from an effect rather than during render, so the probe
    stays a pure component and the accessor always returns the committed handle. */
async function mountHook(): Promise<() => PictureInPictureHandle> {
  const published: PictureInPictureHandle[] = [];
  function Probe({ publish }: { publish: (handle: PictureInPictureHandle) => void }) {
    const handle = useDocumentPictureInPicture();
    useEffect(() => { publish(handle); }, [handle, publish]);
    return null;
  }
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  roots.push(root);
  const publish = (handle: PictureInPictureHandle) => { published.push(handle); };
  flushSync(() => root.render(<Probe publish={publish} />));
  await settle();
  return () => published.at(-1)!;
}

test("support is read from the API's presence, not from a user-agent string", () => {
  expect(documentPictureInPictureSupported()).toBe(true);
  supported = false;
  expect(documentPictureInPictureSupported()).toBe(false);
});

test("an unsupported browser reports unsupported and opens nothing (AC8)", async () => {
  supported = false;
  const handle = await mountHook();
  expect(handle().supported).toBe(false);

  await handle().open();
  await settle();
  expect(requested).toEqual([]);
  expect(handle().pipWindow).toBeNull();
});

test("opening asks for the design's default size once and yields the window", async () => {
  const handle = await mountHook();
  await handle().open();
  await settle();

  expect(requested).toEqual([{ width: PIP_DEFAULT_SIZE.width, height: PIP_DEFAULT_SIZE.height }]);
  expect(handle().pipWindow).toBe(pip as unknown as PictureInPictureHandle["pipWindow"]);
});

test("a second open while one is up asks for nothing", async () => {
  const handle = await mountHook();
  await handle().open();
  await settle();
  await handle().open();
  await settle();
  expect(requested).toHaveLength(1);
});

test("a refused request leaves the caller docked with no error to handle", async () => {
  rejects = true;
  const handle = await mountHook();
  await handle().open();
  await settle();

  expect(requested).toHaveLength(1);
  expect(handle().pipWindow).toBeNull();
});

test("same-origin rules are copied and cross-origin sheets are re-linked by href", async () => {
  sheets = [
    { get cssRules() { return [{ cssText: ".a{color:red}" }, { cssText: ".b{color:blue}" }]; }, href: null },
    /* A cross-origin sheet throws on `cssRules`; its href is the only thing available
       and re-linking is the only way the floater gets those styles at all. */
    { get cssRules(): never { throw new Error("SecurityError"); }, href: "https://cdn.example/theme.css" },
    /* Inaccessible and hrefless: nothing to copy, nothing to link, must not throw. */
    { get cssRules(): never { throw new Error("SecurityError"); }, href: null },
  ];
  const handle = await mountHook();
  await handle().open();
  await settle();

  const styles = Array.from(pip.document.head.querySelectorAll("style"));
  expect(styles).toHaveLength(1);
  expect(styles[0]!.textContent).toBe(".a{color:red}\n.b{color:blue}");

  const links = Array.from(pip.document.head.querySelectorAll("link"));
  expect(links).toHaveLength(1);
  expect(links[0]!.getAttribute("href")).toBe("https://cdn.example/theme.css");
  expect(links[0]!.getAttribute("rel")).toBe("stylesheet");
});

test("the theme, language and direction come across so the floater is the same product", async () => {
  dom.document.documentElement.className = "dark";
  dom.document.body.className = "bg-canvas";
  dom.document.documentElement.lang = "uk";
  dom.document.documentElement.dir = "ltr";

  const handle = await mountHook();
  await handle().open();
  await settle();

  expect(pip.document.documentElement.className).toBe("dark");
  expect(pip.document.body.className).toBe("bg-canvas");
  expect(pip.document.documentElement.lang).toBe("uk");
  expect(pip.document.documentElement.dir).toBe("ltr");
});

test("closing closes the window and forgets it", async () => {
  const handle = await mountHook();
  await handle().open();
  await settle();

  flushSync(() => handle().close());
  await settle();
  expect(closes).toBe(1);
  expect(handle().pipWindow).toBeNull();
});

test("the operator or the OS closing the window is reported back as docked", async () => {
  const handle = await mountHook();
  await handle().open();
  await settle();
  expect(handle().pipWindow).not.toBeNull();

  /* The OS killing the floater arrives as `pagehide` on that window and must read
     exactly like the operator pressing its own close control. */
  flushSync(() => { pip.dispatchEvent(new dom.Event("pagehide")); });
  await settle();

  expect(handle().pipWindow).toBeNull();
  expect(closes).toBe(0);
});

test("late CSS and a theme toggle reach the open window, coalesced into ONE re-adoption", async () => {
  /* `adoptStyles` runs once at open, but the opener keeps moving: a theme toggle
     rewrites the root classes and a route's CSS chunk lands in `document.head`
     mid-call. Both would silently never reach the floater. And a burst — a chunk
     load inserts several nodes, across three observers — must produce ONE
     re-adoption, or the PiP document gets n copies of every sheet. */
  sheets = [{ get cssRules() { return [{ cssText: ".a{color:red}" }]; }, href: null }];
  const handle = await mountHook();
  await handle().open();
  await settle();
  expect(handle().pipWindow).not.toBeNull();
  expect(pip.document.head.querySelectorAll("style")).toHaveLength(1);

  /* Head, root classes, body classes: the three things that change under an open
     window, each with its own observer. */
  expect(observers()).toHaveLength(3);
  expect(observers().map((observer) => observer.targets[0])).toEqual([
    dom.document.head,
    dom.document.documentElement,
    dom.document.body,
  ]);

  const adoptionsAtOpen = adoptions;
  sheets = [
    { get cssRules() { return [{ cssText: ".a{color:red}" }]; }, href: null },
    { get cssRules() { return [{ cssText: ".late{color:green}" }]; }, href: null },
  ];
  dom.document.documentElement.className = "dark";

  /* The burst: two head insertions and a class change, delivered in one tick. */
  observers()[0]!.fire();
  observers()[0]!.fire();
  observers()[1]!.fire();
  await settle();

  /* ONE re-adoption for the whole burst, not one per record. */
  expect(adoptions - adoptionsAtOpen).toBe(1);

  const styles = Array.from(pip.document.head.querySelectorAll("style"));
  expect(styles).toHaveLength(2);
  expect(styles.map((style) => style.textContent)).toEqual([".a{color:red}", ".late{color:green}"]);
  /* And the late arrivals actually arrived. */
  expect(pip.document.documentElement.className).toBe("dark");

  /* A LATER burst re-adopts again: coalescing is per burst, never a one-shot. */
  observers()[0]!.fire();
  await settle();
  expect(adoptions - adoptionsAtOpen).toBe(2);
  expect(pip.document.head.querySelectorAll("style")).toHaveLength(2);
});

test("the observers stop with the window, and a window that dies mid-tick is not written into", async () => {
  sheets = [{ get cssRules() { return [{ cssText: ".a{color:red}" }]; }, href: null }];
  const handle = await mountHook();
  await handle().open();
  await settle();
  const attached = observers();
  expect(attached).toHaveLength(3);

  /* The race the guard exists for: a mutation is recorded, and the window goes
     away before the coalescing tick runs. Adopting into a dead document is the
     one thing that throws in production. */
  const adoptionsBeforeRace = adoptions;
  attached[0]!.fire();
  Object.defineProperty(pip, "closed", { configurable: true, get: () => true });
  await settle();
  expect(adoptions).toBe(adoptionsBeforeRace);
  Object.defineProperty(pip, "closed", { configurable: true, get: () => false });

  flushSync(() => handle().close());
  await settle();

  /* And every observer is released — an opener that kept them would go on copying
     stylesheets into a window nobody can see for the rest of the session. */
  for (const observer of attached) expect(observer.disconnected).toBeGreaterThan(0);
});
