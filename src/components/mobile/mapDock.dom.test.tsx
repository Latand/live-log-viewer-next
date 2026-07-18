import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import type { Pipeline } from "@/lib/pipelines/types";
import type { WorkerStack } from "@/components/scheme/workerCollapse";

/* Finding-1 regression (#156): opening the mobile map must keep the full pipeline
   plan reachable. The map overlay covers the focus-surface dock, and SchemeBoard
   passes no pipelineControls in map mode, so the plan lives on dock cards docked
   inside the overlay itself. This mounts the real MobileFocusView, opens the map,
   and asserts a MobilePipelineDock renders inside the map overlay. */

/* The tree renders ConnectionPill/FlowStrip which subscribe to the runtime bus;
   a sibling suite leaves a `.start`-less runtimeBus mock installed. Mock the
   hooks inert (nodes.dom.test shape), restore in afterAll. */
const actualRuntimeHooks = await import("@/hooks/useRuntime");
const inertRuntime = { enabled: false, connection: "offline" as const, resyncedAt: null, store: emptyStore() };
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => ({ ...inertRuntime, lastEventAt: null }),
  useRuntime: () => inertRuntime,
  useRuntimeSession: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));

const { MobileFocusView } = await import("@/components/mobile/MobileFocusView");

const dom = new Window({ url: "http://localhost/" });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  matchMedia: (q: string) => ({ matches: /max-width/.test(String(q)), media: String(q), onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } }),
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  fetch: (async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" })) as unknown as typeof fetch,
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
const settle = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

/* Poll a predicate across scheduler macrotasks — lets React flush the click's
   state update and the overlay's mount without React's test-only `act` (whose
   named export is absent in some bun/react resolutions). */
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
});

const pipeline = {
  id: "p1", task: "Ship the mobile map", project: "demo", repoDir: "/r", worktreeDir: "/w",
  branch: "b", baseBranch: "main", baseRef: "a", lastPassedCommit: "a",
  stages: [
    { id: "plan", kind: "run", prompt: "", next: "build", effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-only", promptScaffold: null } },
    { id: "build", kind: "run", prompt: "", next: null, effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } },
  ],
  runs: [], cursor: null, state: "paused", pausedState: "running", stateDetail: null,
  srcPath: null, srcConversationId: null, createdAt: new Date(0).toISOString(), closedAt: null,
} as unknown as Pipeline;
// One worker stack makes the map reachable with no placed nodes required.
const stack: WorkerStack = { key: "stack::pipe:p1", kind: "pipeline", id: "p1", items: [] };

let roots: Root[] = [];
beforeEach(() => { dom.document.body.replaceChildren(); roots = []; });
afterEach(async () => { for (const r of roots) flushSync(() => r.unmount()); roots = []; await settle(); dom.sessionStorage.clear(); });

function mount(node: React.ReactElement): Root {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(node));
  return root;
}

test("opening the mobile map keeps every active pipeline's full plan on a dock inside the overlay (#156)", async () => {
  roots.push(
    mount(
      <MobileFocusView
        project="demo"
        groups={[]}
        manual={[]}
        files={[]}
        flows={[]}
        pipelines={[pipeline]}
        surfacePipelines={[pipeline]}
        workerStacks={[stack]}
        tasks={[]}
        drafts={[]}
        loaded
        focus={null}
        onSelect={() => {}}
        onClose={() => {}}
        onDraftClose={() => {}}
        onDraftSpawned={() => {}}
      />,
    ),
  );

  // The map is reachable (a worker stack), so the open-map control is present.
  const openBtn = dom.document.querySelector('button[aria-label="Open the project map"]') as HTMLButtonElement | null;
  expect(openBtn).not.toBeNull();

  flushSync(() => openBtn!.click());

  /* Assert against the map overlay itself — the nearest fixed container of the
     Close-map control. The page root also holds the focus-surface dock, so
     querying it would pass even with the overlay dock removed; scoping to the
     overlay makes the assertion fail without the fix. */
  const found = await waitFor(() => {
    const close = dom.document.querySelector('[aria-label="Close the map"]');
    const overlay = close?.closest("div.fixed");
    return Boolean(overlay?.querySelector('[data-testid="mobile-pipeline-dock"]'));
  });
  expect(found).toBe(true);

  const overlay = dom.document.querySelector('[aria-label="Close the map"]')!.closest("div.fixed");
  // The whole planned stage graph rides on that dock card.
  expect(overlay!.textContent).toContain("plan");
  expect(overlay!.textContent).toContain("build");

  const framing = overlay!.querySelector('[aria-label="Map framing"]')!;
  const all = Array.from(framing.querySelectorAll("button")).find((button) => button.textContent === "All");
  const current = Array.from(framing.querySelectorAll("button")).find((button) => button.textContent === "Current");
  expect(all).toBeTruthy();
  expect(current).toBeTruthy();
  expect(all!.getAttribute("aria-pressed")).toBe("true");
  flushSync(() => current!.click());
  expect(current!.getAttribute("aria-pressed")).toBe("true");
});
