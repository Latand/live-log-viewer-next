import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import type { FileEntry } from "@/lib/types";

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
const agentField = (id: string, name: string) => `llvDraftPane:${id}:${name}`;
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
  projectCwd: `/home/tester/Projects/${project}`,
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
  G.fetch = OVERRIDES.fetch;
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

test("a restored project draft renders with its deterministic project directory on the first pane render", async () => {
  const project = "legacy-project";
  dom.sessionStorage.setItem(draftsKey(project), JSON.stringify([agentA]));
  dom.sessionStorage.setItem(agentField(agentA, "cwd"), "   ");

  roots.push(mount(<ProjectDashboard {...dashboardProps(project)} />));

  expect(await waitFor(() => dom.document.querySelector(AGENT_PANE) !== null)).toBe(true);
  const directory = dom.document.querySelector('input[aria-label="Agent working directory"]') as unknown as HTMLInputElement | null;
  expect(directory?.value).toBe(`/home/tester/Projects/${project}`);
});

test("a restored handoff draft renders with the source conversation cwd", async () => {
  const project = "handoff-project";
  const sourcePath = "/sessions/source.jsonl";
  const sourceCwd = "/repos/handoff/.worktrees/source-branch";
  const source: FileEntry = {
    path: sourcePath,
    root: "codex-sessions",
    name: "source.jsonl",
    project,
    cwd: sourceCwd,
    projectRoot: "/repos/handoff",
    title: "Source conversation",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "recent",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
  dom.sessionStorage.setItem(draftsKey(project), JSON.stringify([agentA]));
  dom.sessionStorage.setItem(agentField(agentA, "src"), sourcePath);

  roots.push(mount(<ProjectDashboard {...dashboardProps(project)} files={[source]} />));

  expect(await waitFor(() => dom.document.querySelector(AGENT_PANE) !== null)).toBe(true);
  const directory = dom.document.querySelector('input[aria-label="Agent working directory"]') as unknown as HTMLInputElement | null;
  expect(directory?.value).toBe(sourceCwd);
});

test("a restored handoff waits for its out-of-snapshot source cwd before exposing the composer", async () => {
  const project = "archived-handoff-project";
  const sourcePath = "/archive/source.jsonl";
  const sourceCwd = "/repos/archived/.worktrees/source-branch";
  let releaseSpawn!: () => void;
  const spawnGate = new Promise<void>((resolve) => { releaseSpawn = resolve; });
  let spawnRequested = false;
  dom.sessionStorage.setItem(draftsKey(project), JSON.stringify([agentA]));
  dom.sessionStorage.setItem(agentField(agentA, "src"), sourcePath);
  G.fetch = (async (input: string | URL | Request) => {
    if (String(input).startsWith("/api/spawn?")) {
      spawnRequested = true;
      await spawnGate;
      return { ok: true, status: 200, json: async () => ({ dirs: [sourceCwd], cwd: sourceCwd }), text: async () => "" };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  }) as unknown as typeof fetch;

  roots.push(mount(<ProjectDashboard {...dashboardProps(project)} />));

  expect(await waitFor(() => spawnRequested)).toBe(true);
  expect(dom.document.querySelector(AGENT_PANE)).toBeNull();
  releaseSpawn();
  expect(await waitFor(() => {
    const directory = dom.document.querySelector('input[aria-label="Agent working directory"]') as unknown as HTMLInputElement | null;
    return directory?.value === sourceCwd;
  })).toBe(true);
});

test("a restored handoff stays unresolved while source cwd lookup retries", async () => {
  const project = "retry-handoff-project";
  const sourcePath = "/archive/retry-source.jsonl";
  const sourceCwd = "/repos/retry/.worktrees/source-branch";
  let spawnCalls = 0;
  let releaseSuccess!: () => void;
  const successGate = new Promise<void>((resolve) => { releaseSuccess = resolve; });
  dom.sessionStorage.setItem(draftsKey(project), JSON.stringify([agentA]));
  dom.sessionStorage.setItem(agentField(agentA, "src"), sourcePath);
  G.fetch = (async (input: string | URL | Request) => {
    if (!String(input).startsWith("/api/spawn?")) {
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    }
    spawnCalls += 1;
    if (spawnCalls === 1) {
      return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
    }
    if (spawnCalls === 2) {
      return { ok: true, status: 200, json: async () => ({ cwd: null }), text: async () => "" };
    }
    await successGate;
    return { ok: true, status: 200, json: async () => ({ cwd: sourceCwd }), text: async () => "" };
  }) as unknown as typeof fetch;

  roots.push(mount(<ProjectDashboard {...dashboardProps(project)} />));

  expect(await waitFor(() => spawnCalls === 3, 250)).toBe(true);
  expect(dom.document.querySelector(AGENT_PANE)).toBeNull();
  releaseSuccess();
  expect(await waitFor(() => {
    const directory = dom.document.querySelector('input[aria-label="Agent working directory"]') as unknown as HTMLInputElement | null;
    return directory?.value === sourceCwd;
  })).toBe(true);
});

test("a cold dashboard cannot create an agent draft before project metadata hydrates", async () => {
  const project = "cold-project";
  const windowWithMatchMedia = dom as unknown as { matchMedia: typeof mobileMatchMedia };
  const previousMatchMedia = windowWithMatchMedia.matchMedia;
  windowWithMatchMedia.matchMedia = mobileMatchMedia;
  try {
    roots.push(mount(<ProjectDashboard {...dashboardProps(project)} loaded={false} />));

    expect(await waitFor(() => dom.document.querySelector('button[aria-haspopup="menu"]') !== null)).toBe(true);
    const create = dom.document.querySelector('button[aria-haspopup="menu"]') as unknown as HTMLButtonElement;
    create.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
    expect(await waitFor(() => dom.document.querySelector('[role="menuitem"]') !== null)).toBe(true);
    const agent = dom.document.querySelector('[role="menuitem"]') as unknown as HTMLButtonElement | null;
    expect(agent?.disabled).toBe(true);
    agent?.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
    expect(dom.sessionStorage.getItem(draftsKey(project))).toBeNull();
  } finally {
    windowWithMatchMedia.matchMedia = previousMatchMedia;
  }
});

test("the desktop agent control stays disabled until project metadata hydrates", async () => {
  const project = "cold-desktop-project";
  const previousMatchMedia = G.matchMedia;
  G.matchMedia = (query: string) => ({ ...mobileMatchMedia(query), matches: false });
  try {
    roots.push(mount(<ProjectDashboard {...dashboardProps(project)} loaded={false} />));
    const create = dom.document.querySelector('[aria-label="New conversation with an agent"]') as unknown as HTMLButtonElement | null;
    expect(create?.disabled).toBe(true);
    create?.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
    expect(dom.sessionStorage.getItem(draftsKey(project))).toBeNull();
  } finally {
    G.matchMedia = previousMatchMedia;
  }
});

test("a missing restored handoff reaches an editable bounded recovery card", async () => {
  const project = "missing-handoff-project";
  const sourcePath = "/archive/deleted-source.jsonl";
  let spawnCalls = 0;
  let launchCalls = 0;
  dom.sessionStorage.setItem(draftsKey(project), JSON.stringify([agentA]));
  dom.sessionStorage.setItem(agentField(agentA, "src"), sourcePath);
  G.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST" && String(input) === "/api/spawn") {
      launchCalls += 1;
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    }
    if (String(input).startsWith("/api/spawn?")) {
      spawnCalls += 1;
      return { ok: true, status: 200, json: async () => ({ cwd: null }), text: async () => "" };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  }) as unknown as typeof fetch;

  roots.push(mount(<ProjectDashboard {...dashboardProps(project)} />));

  expect(await waitFor(() => dom.document.querySelector(AGENT_PANE) !== null, 2500)).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const settledCalls = spawnCalls;
  expect(settledCalls).toBeGreaterThanOrEqual(4);
  expect(settledCalls).toBeLessThanOrEqual(5);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  expect(spawnCalls).toBe(settledCalls);
  const directory = dom.document.querySelector('input[aria-label="Agent working directory"]') as unknown as HTMLInputElement | null;
  expect(directory?.value).toBe(`/home/tester/Projects/${project}`);
  expect(directory?.disabled).toBe(false);
  expect(dom.document.querySelector('p[role="alert"]')?.textContent).toContain("source working directory");
  const launch = dom.document.querySelector('[aria-label="Launch the agent"]') as unknown as HTMLButtonElement | null;
  launch?.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  await settle();
  expect(launchCalls).toBe(0);
});

test("closing a conversation card reports its path to the dashboard owner", async () => {
  const project = "close-project";
  const path = "/sessions/close-me.jsonl";
  const closed: string[] = [];
  G.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      return { ok: false, status: 400, json: async () => ({ error: "INVALID_REQUEST" }), text: async () => "" };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  }) as unknown as typeof fetch;
  const file: FileEntry = {
    path,
    root: "codex-sessions",
    name: "close-me.jsonl",
    project,
    cwd: "/repos/close-project",
    projectRoot: "/repos/close-project",
    title: "Close me",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "recent",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };

  roots.push(mount(
    <ProjectDashboard
      {...dashboardProps(project)}
      files={[file]}
      onConversationClose={(closedPath) => closed.push(closedPath)}
    />,
  ));

  expect(await waitFor(() => dom.document.querySelector('[aria-label="Remove column Close me"]') !== null)).toBe(true);
  const close = dom.document.querySelector('[aria-label="Remove column Close me"]') as unknown as HTMLElement;
  close.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  expect(closed).toEqual([path]);
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
