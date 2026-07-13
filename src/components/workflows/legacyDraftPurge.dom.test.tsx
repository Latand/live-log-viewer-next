import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";

/* A mounted behavioral test for the shared desktop/mobile legacy-draft purge
   (#136/#156). It seeds sessionStorage the way a pre-fencing tab left it, mounts
   the real ProjectDashboard so ITS restoration effect (ProjectDashboard.tsx:303,
   `setDrafts(loadDrafts(project))` — the production wiring itself) runs, and
   asserts the real WorkflowDraftPane never mounts while the ordinary agent
   draft's pane does. Disable that effect and drafts stay `[]`, so the agent pane
   never appears and this test fails — the regression the review asks for. */

/* The dashboard's mobile surface renders ConnectionPill, which subscribes to the
   runtime bus; a sibling suite (useFiles.dom.test) leaves a `./runtimeBus` mock
   installed whose stub bus lacks `.start`. Mock the hooks inert — the shape
   nodes.dom.test uses — and dynamic-import the components afterward so they bind
   to the inert hooks. Restored in afterAll so no sibling suite inherits it. */
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

const { ProjectDashboard } = await import("@/components/ProjectDashboard");
const { MobileFocusView } = await import("@/components/mobile/MobileFocusView");

const dom = new Window({ url: "http://localhost/" });

/* Every global this file overrides is installed in beforeAll and restored in
   afterAll — bun shares one process across test files, so a leaked `fetch`/
   `document` here would break sibling DOM suites. matchMedia reports mobile so
   the dashboard renders its phone surface (MobileFocusView). */
const G = globalThis as Record<string, unknown>;
const mobileMatchMedia = (query: string) => ({
  matches: /max-width/.test(String(query)),
  media: String(query),
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() { return false; },
});
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
  matchMedia: mobileMatchMedia,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  // The board store and draft panes fetch on mount; keep those inert.
  fetch: (async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => "" })) as unknown as typeof fetch,
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};

/* Let React's scheduler drain any queued callback while `window` is still set —
   a stray one firing after restore would hit `window.event` on a bare global. */
const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

/* Poll until a predicate holds. React flushes passive effects (the dashboard's
   restoration effect) and the follow-up re-render on scheduler macrotasks, so a
   timer loop lets them complete without depending on React's test-only `act`
   (whose named export is absent in some bun/react resolutions). */
const waitFor = async (pred: () => boolean, timeoutMs = 4000): Promise<boolean> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  return pred();
};

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) {
    HAS[key] = key in G;
    SAVED[key] = G[key];
    G[key] = OVERRIDES[key];
  }
  // Confined to this window's element prototype, so it never leaks globally.
  (dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) {
    if (HAS[key]) G[key] = SAVED[key];
    else delete G[key];
  }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

const WF_PANE = '[aria-label="Draft of a new workflow"]';
const AGENT_PANE = '[aria-label="Draft of a new agent conversation"]';

const draftsKey = (project: string) => `llvDrafts:${project}`;
const wfField = (id: string, name: string) => `llvWfDraft:${id}:${name}`;
const WF_FIELDS = ["template", "dir", "task", "mode"];
const agentA = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

const dashboardProps = (project: string) => ({
  files: [],
  flows: [],
  pipelines: [],
  workflows: [],
  tasks: [],
  project,
  loaded: true,
  openNonce: 0,
  archived: false,
  catalogKnown: true,
  catalogConversationCount: 0,
  onArchive: () => {},
  onUnarchive: () => {},
});

function mount(node: React.ReactElement): Root {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(node));
  return root;
}

let roots: Root[] = [];
beforeEach(() => {
  dom.document.body.replaceChildren();
  roots = [];
});
afterEach(async () => {
  for (const root of roots) flushSync(() => root.unmount());
  roots = [];
  await settle();
  dom.sessionStorage.clear();
});

test("the dashboard's restoration effect purges the legacy draft and never mounts WorkflowDraftPane (#136/#156)", async () => {
  const project = "restore-demo";
  /* The pre-fencing tab state: an agent draft interleaved with a legacy wf-*
     draft that still has all its pane fields persisted. */
  dom.sessionStorage.setItem(draftsKey(project), JSON.stringify([agentA, "wf-legacy"]));
  for (const name of WF_FIELDS) dom.sessionStorage.setItem(wfField("wf-legacy", name), `wf-legacy-${name}`);

  roots.push(mount(<ProjectDashboard {...dashboardProps(project)} />));

  /* Wait for the dashboard's restoration effect to populate `drafts` from
     storage and the phone surface to mount the ordinary agent draft's real pane.
     Its presence makes the WorkflowDraftPane check below a live signal — an empty
     surface would pass that check on its own. */
  expect(await waitFor(() => dom.document.querySelector(AGENT_PANE) !== null)).toBe(true);
  /* The legacy workflow pane never mounts — restoration dropped its id. */
  expect(dom.document.querySelector(WF_PANE)).toBeNull();

  /* The persisted list is rewritten in place and every llvWfDraft:* field of the
     legacy draft is purged, so a later remount can't resurrect the pane. */
  expect(JSON.parse(dom.sessionStorage.getItem(draftsKey(project))!)).toEqual([agentA]);
  for (const name of WF_FIELDS) expect(dom.sessionStorage.getItem(wfField("wf-legacy", name))).toBeNull();
});

test("the phone surface DOES mount the real WorkflowDraftPane for a live wf draft (routing is real)", async () => {
  /* Positive control: fed a workflow draft directly (no purge), the same surface
     the dashboard renders mounts the genuine WorkflowDraftPane. This pins down
     what the previous test's absence means: the purge removed it, and the surface
     can otherwise render it. */
  roots.push(
    mount(
      <MobileFocusView
        project="control"
        groups={[]}
        manual={[]}
        files={[]}
        flows={[]}
        pipelines={[]}
        tasks={[]}
        drafts={["wf-control"]}
        loaded
        focus={null}
        onSelect={() => {}}
        onClose={() => {}}
        onDraftClose={() => {}}
        onDraftSpawned={() => {}}
      />,
    ),
  );
  expect(await waitFor(() => dom.document.querySelector(WF_PANE) !== null)).toBe(true);
  expect(dom.document.querySelector(AGENT_PANE)).toBeNull();
});
