import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";

/* A mounted behavioral test for the shared desktop/mobile legacy-draft purge
   (#136/#156). It seeds sessionStorage the way a pre-fencing tab left it, drives
   the real restore path (loadDrafts — the function ProjectDashboard calls on
   mount) through the real mobile surface (MobileFocusView), and asserts the real
   WorkflowDraftPane never mounts while an ordinary agent draft's pane does. The
   desktop scheme (DraftShell) and this surface route drafts by the same
   isWorkflowDraftId gate, so exercising the mobile surface proves the routing. */

/* The surface renders ConnectionPill, which subscribes to the runtime bus; a
   sibling suite (useFiles.dom.test) leaves a `./runtimeBus` mock installed whose
   stub bus lacks `.start`. Mock the hooks inert — the same shape nodes.dom.test
   uses — and dynamic-import the surface afterward so it binds to the inert hooks.
   Restored in afterAll so no sibling suite inherits it. */
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
const { loadDrafts } = await import("@/components/ProjectDashboard");

const dom = new Window({ url: "http://localhost/" });

/* Every global this file overrides is installed in beforeAll and restored in
   afterAll — bun shares one process across test files, so a leaked `fetch`/
   `document` here would break sibling DOM suites. */
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
  matchMedia: dom.matchMedia?.bind(dom) ?? (() => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })),
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
  ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } },
  // The draft panes lazily fetch templates/dirs on mount; keep those inert.
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

const surfaceProps = (project: string, drafts: string[]) => ({
  project,
  groups: [],
  manual: [],
  files: [],
  flows: [],
  pipelines: [],
  tasks: [],
  drafts,
  loaded: true,
  focus: null,
  onSelect: () => {},
  onClose: () => {},
  onDraftClose: () => {},
  onDraftSpawned: () => {},
});

function mount(node: React.ReactElement): { root: Root } {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(node));
  return { root };
}

/* Mirrors ProjectDashboard: restore the persisted draft list on mount, then hand
   it to the real surface. useState's lazy initializer runs the purge during the
   first render, exactly like the dashboard's restore effect. */
function RestoredSurface({ project }: { project: string }) {
  const [drafts] = useState(() => loadDrafts(project));
  return <MobileFocusView {...surfaceProps(project, drafts)} />;
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

test("restoring a pre-fencing tab purges the legacy draft and never mounts WorkflowDraftPane (#136/#156)", () => {
  const project = "restore-demo";
  /* The pre-fencing tab state: an agent draft interleaved with a legacy wf-*
     draft that still has all its pane fields persisted. */
  dom.sessionStorage.setItem(draftsKey(project), JSON.stringify([agentA, "wf-legacy"]));
  for (const name of WF_FIELDS) dom.sessionStorage.setItem(wfField("wf-legacy", name), `wf-legacy-${name}`);

  const { root } = mount(<RestoredSurface project={project} />);
  roots.push(root);

  /* The surface actually rendered: the ordinary agent draft mounted its real
     pane — so the WorkflowDraftPane's absence below is meaningful, not vacuous. */
  expect(dom.document.querySelector(AGENT_PANE)).not.toBeNull();
  /* The legacy workflow pane never mounts — restoration dropped its id. */
  expect(dom.document.querySelector(WF_PANE)).toBeNull();

  /* The persisted list is rewritten in place and every llvWfDraft:* field of the
     legacy draft is purged, so a later remount can't resurrect the pane. */
  expect(JSON.parse(dom.sessionStorage.getItem(draftsKey(project))!)).toEqual([agentA]);
  for (const name of WF_FIELDS) expect(dom.sessionStorage.getItem(wfField("wf-legacy", name))).toBeNull();
});

test("the same surface DOES mount the real WorkflowDraftPane for a live wf draft (routing is real)", () => {
  /* Positive control: fed a workflow draft directly (no purge), the surface
     mounts the genuine WorkflowDraftPane — proving the previous test's absence
     is the purge at work, not a surface that can't render the pane at all. */
  const { root } = mount(<MobileFocusView {...surfaceProps("control", ["wf-control"])} />);
  roots.push(root);
  expect(dom.document.querySelector(WF_PANE)).not.toBeNull();
  expect(dom.document.querySelector(AGENT_PANE)).toBeNull();
});
