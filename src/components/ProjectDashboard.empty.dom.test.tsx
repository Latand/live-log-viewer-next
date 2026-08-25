import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { setLocale, translate } from "@/lib/i18n";
import { en } from "@/lib/i18n/en";
import { uk } from "@/lib/i18n/uk";

/*
 * Issue #1162, the empty project. A board with nothing on it used to advise
 * opening the switchboard and clicking a conversation — advice that presumes
 * conversations exist. It now names the two ways work starts here and wires
 * both to handlers the dashboard already owns: the orchestrator dock's toggle
 * and the «+ Agent» draft. The phone leaf carries the same two lines; its
 * orchestrator row and header already carry the controls.
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

const { ProjectDashboard } = await import("@/components/ProjectDashboard");

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;

let mobile = false;
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
const waitFor = async (pred: () => boolean, timeoutMs = 4000): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return pred();
};

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
/* Drafts and board preferences are persisted per project: without this, the
   draft one case creates makes the NEXT mount a populated board. */
beforeEach(() => {
  mobile = false;
  roots = [];
  dom.document.body.replaceChildren();
  dom.localStorage.clear();
  dom.sessionStorage.clear();
});
afterEach(() => { for (const root of roots) flushSync(() => root.unmount()); roots = []; setLocale("en"); });

/** A project the operator just created: no conversations, no tasks, no catalog
    rows — the exact state this issue is about. */
const emptyProjectProps = () => ({
  files: [], flows: [], pipelines: [], workflows: [], tasks: [],
  project: "atlas", loaded: true, openNonce: 0, archived: false, catalogKnown: false,
  projectCwd: "/home/user/Projects/atlas", catalogConversationCount: 0,
  onArchive: () => {}, onUnarchive: () => {},
});

/** Mount and wait for the board's first paint — until it lands the dashboard
    renders its skeleton, not any leaf. */
async function mount(extra: Record<string, unknown> = {}): Promise<HTMLElement> {
  const node = dom.document.createElement("div");
  dom.document.body.appendChild(node);
  const root = createRoot(node as unknown as Element);
  flushSync(() => root.render(<ProjectDashboard {...emptyProjectProps()} {...extra} />));
  roots.push(root);
  const host = node as unknown as HTMLElement;
  expect(await waitFor(() => leaf(host) !== null)).toBe(true);
  return host;
}

const q = (host: HTMLElement, sel: string) => host.querySelector(sel) as unknown as HTMLElement | null;
const leaf = (host: HTMLElement) => q(host, '[data-testid="project-empty"]');
const click = (node: HTMLElement) => flushSync(() => node.click());

test("desktop: the empty project offers the orchestrator and one agent, both wired", async () => {
  const toggles: string[] = [];
  const host = await mount({ onToggleOrchestratorPanel: () => toggles.push("orchestrator") });
  const empty = leaf(host);
  expect(empty).not.toBeNull();
  expect(empty!.textContent).toContain(en["dash.emptyTitle"]);
  /* Both lines, with the project named in the first one. */
  expect(empty!.textContent).toContain(translate("en", "dash.emptyStartHere", { project: "atlas" }));
  expect(empty!.textContent).toContain("atlas");
  expect(empty!.textContent).toContain(en["dash.emptyOneAgent"]);

  const orchestrator = q(host, '[data-testid="project-empty-orchestrator"]')!;
  expect(orchestrator).not.toBeNull();
  expect(orchestrator.textContent).toContain(en["orchPanel.title"]);
  click(orchestrator);
  expect(toggles).toEqual(["orchestrator"]);

  /* The agent button runs the same draft flow as the board's «+ Agent»: a draft
     pane appears on the board, which is exactly what leaves this empty state. */
  const agent = q(host, '[data-testid="project-empty-agent"]')!;
  expect(agent).not.toBeNull();
  expect(agent.textContent).toContain(en["dash.agent"]);
  click(agent);
  expect(await waitFor(() => leaf(host) === null)).toBe(true);
  await settle();
});

test("desktop: both offers are real 44px targets", async () => {
  const host = await mount({ onToggleOrchestratorPanel: () => {} });
  for (const id of ["project-empty-orchestrator", "project-empty-agent"]) {
    expect(q(host, `[data-testid="${id}"]`)!.className).toContain("min-h-11");
  }
});

test("desktop: with no orchestrator dock wired, the agent offer still stands alone", async () => {
  const host = await mount();
  expect(q(host, '[data-testid="project-empty-orchestrator"]')).toBeNull();
  expect(q(host, '[data-testid="project-empty-agent"]')).not.toBeNull();
  expect(leaf(host)!.textContent).toContain(en["dash.emptyOneAgent"]);
});

test("the phone leaf carries the same two lines, and no duplicate controls", async () => {
  mobile = true;
  const host = await mount({ onToggleOrchestratorPanel: () => {} });
  const empty = leaf(host)!;
  expect(empty.textContent).toContain(translate("en", "dash.emptyStartHere", { project: "atlas" }));
  expect(empty.textContent).toContain(en["dash.emptyOneAgent"]);
  /* The phone's orchestrator row sits above this leaf and its header owns
     «Create», so the leaf itself adds no second copy of either. */
  expect(q(host, '[data-testid="project-empty-orchestrator"]')).toBeNull();
  expect(q(host, '[data-testid="project-empty-agent"]')).toBeNull();
  expect(q(host, '[data-testid="mobile-orchestrator-slot"]')).not.toBeNull();
});

test("the retired switchboard advice is gone from both dictionaries and both leaves", async () => {
  const desktop = await mount({ onToggleOrchestratorPanel: () => {} });
  expect(desktop.textContent).not.toContain("Open the switchboard");
  expect(Object.keys(en)).not.toContain("dash.emptyHint");
  expect(Object.keys(uk)).not.toContain("dash.emptyHint");
});

test("Ukrainian carries the same two lines", async () => {
  setLocale("uk");
  const host = await mount({ onToggleOrchestratorPanel: () => {} });
  const empty = leaf(host)!;
  expect(empty.textContent).toContain(translate("uk", "dash.emptyStartHere", { project: "atlas" }));
  expect(empty.textContent).toContain(translate("uk", "dash.emptyOneAgent"));
});
