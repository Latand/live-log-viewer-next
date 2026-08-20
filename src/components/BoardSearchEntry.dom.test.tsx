import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { en } from "@/lib/i18n/en";

/*
 * Issue #1054 — the search affordance must be reachable from ANYWHERE.
 *
 * Both boards carry it: the overview and a project, on the desktop chrome row
 * and in the phone header. The phone copy of each is a 44px target, because
 * the whole point of the requirement is that finding a sent message is fast.
 */

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const actualConversationCatalogHooks = await import("@/hooks/useConversationCatalog");
const inertRuntime = { enabled: false, connection: "offline" as const, resyncedAt: null, store: emptyStore() };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ ...inertRuntime, lastEventAt: null }),
  useRuntime: () => inertRuntime,
  useRuntimeSession: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));
mock.module("@/hooks/useConversationCatalog", () => ({
  useConversationCatalog: () => ({
    items: [], nextCursor: null, total: 0, loading: false, error: false, loadMore: () => {}, retry: () => {},
  }),
}));

const { OverviewBoard } = await import("@/components/OverviewBoard");
const { ProjectDashboard } = await import("@/components/ProjectDashboard");

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;

let mobile = false;
/* useIsMobile reads `window.matchMedia`, so the query must live on the dom. */
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: mobile && /max-width/.test(String(query)),
  media: String(query), onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; },
});
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  fetch: (async (input: string | URL | Request) => {
    const url = String(input);
    const body = url.startsWith("/api/conversations") ? { items: [], nextCursor: null } : {};
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }) as unknown as typeof fetch,
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};

const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
  (dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useConversationCatalog", () => actualConversationCatalogHooks);
});

let roots: Root[] = [];
let opened = 0;
beforeEach(() => { mobile = false; opened = 0; roots = []; dom.document.body.replaceChildren(); });
afterEach(() => { for (const root of roots) flushSync(() => root.unmount()); roots = []; });

function mount(node: React.ReactElement): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(node));
  roots.push(root);
  return host as unknown as HTMLElement;
}

function overview(): HTMLElement {
  return mount(
    <OverviewBoard
      files={[]}
      projectCatalog={[]}
      pipelines={[]}
      workflows={[]}
      archivedProjects={new Set()}
      now={1_000}
      onSelectProject={() => {}}
      onSelectFile={() => {}}
      onOpenSearch={() => { opened += 1; }}
    />,
  );
}

function dashboard(): HTMLElement {
  return mount(
    <ProjectDashboard
      files={[]}
      flows={[]}
      pipelines={[]}
      workflows={[]}
      tasks={[]}
      project="atlas"
      projectCwd="/repo/atlas"
      loaded
      openNonce={0}
      archived={false}
      catalogKnown={false}
      catalogConversationCount={0}
      onArchive={() => {}}
      onUnarchive={() => {}}
      onOpenSearch={() => { opened += 1; }}
    />,
  );
}

const search = (host: HTMLElement, testId: string) =>
  host.querySelector(`[data-testid="${testId}"]`) as unknown as HTMLElement | null;

test("the overview header carries the search button and names its shortcut", () => {
  const host = overview();
  const button = search(host, "overview-search")!;

  expect(button).not.toBeNull();
  expect(button.getAttribute("title")).toBe(en["search.open"]);
  expect(button.className).toContain("h-7");
  flushSync(() => button.click());
  expect(opened).toBe(1);
});

test("the project header carries the same button", () => {
  const host = dashboard();
  const button = search(host, "dash-search")!;

  expect(button).not.toBeNull();
  expect(button.getAttribute("aria-label")).toBe(en["search.open"]);
  flushSync(() => button.click());
  expect(opened).toBe(1);
});

test("on a phone both buttons are 44px targets", () => {
  mobile = true;

  expect(search(overview(), "overview-search")!.className).toContain("h-11");
  expect(search(dashboard(), "dash-search")!.className).toContain("h-11");
});

test("a shell that offers no search renders no button rather than a dead one", () => {
  const host = mount(
    <OverviewBoard
      files={[]}
      projectCatalog={[]}
      pipelines={[]}
      workflows={[]}
      archivedProjects={new Set()}
      now={1_000}
      onSelectProject={() => {}}
      onSelectFile={() => {}}
    />,
  );

  expect(search(host, "overview-search")).toBeNull();
});
