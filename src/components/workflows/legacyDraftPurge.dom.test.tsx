import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import { applyBoardMutations, type BoardMutationV1 } from "@/lib/board/mutations";
import type { BoardProjectStateV1 } from "@/lib/board/types";
import type { BoardTask } from "@/lib/tasks/types";
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
    items: [],
    nextCursor: null,
    total: 0,
    loading: false,
    error: false,
    loadMore: () => {},
    retry: () => {},
  }),
}));

const { ProjectDashboard } = await import("@/components/ProjectDashboard");
const { MobileFocusView } = await import("@/components/mobile/MobileFocusView");

const dom = new Window({ url: "http://localhost/" });
/* The Board measures itself for its bar's tier (#1801); happy-dom lays nothing
   out, so the board reports a desktop width and its bar carries «+ Agent». */
const measureRect = dom.HTMLElement.prototype.getBoundingClientRect;
dom.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
  const rect = measureRect.call(this);
  return this.classList?.contains("kb") ? { ...rect, width: 2292, right: 2292 } as DOMRect : rect;
} as typeof measureRect;

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
  fetch: (async (input: string | URL | Request) => {
    const body = String(input).startsWith("/api/conversations") ? { items: [], nextCursor: null } : {};
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }) as unknown as typeof fetch,
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
  mock.module("@/hooks/useConversationCatalog", () => actualConversationCatalogHooks);
});

const BOARD_WRITE_REFUSED = { ok: false, status: 400, json: async () => ({ error: "INVALID_REQUEST" }), text: async () => "" };
const WF_PANE = '[aria-label="Draft of a new workflow"]';
const AGENT_PANE = '[aria-label="Draft of a new agent conversation"]';

const draftsKey = (project: string) => `llvDrafts:${project}`;
const wfField = (id: string, name: string) => `llvWfDraft:${id}:${name}`;
const agentField = (id: string, name: string) => `llvDraftPane:${id}:${name}`;
const WF_FIELDS = ["template", "dir", "task", "mode"];
/* A draft id, deliberately not uuid-shaped: publication surfaces carry no
   identifier that reads like a real resource id. */
const agentA = "agent_3f2504e0_4f89_41d3";

/* The working directory is a picker now (#887), so the chosen path lives on the
   closed trigger instead of an input's value — same assertion, new surface. */
/* The desktop's agent control (#1695 K9a): «+ Agent» in the Board's bar, or the
   empty project's offer while the project has nothing to draw a Board for. */
const agentControl = () => (dom.document.querySelector("[data-new-agent]") ?? dom.document.querySelector('[data-testid="project-empty-agent"]')) as unknown as HTMLButtonElement | null;
/* A conversation's handoff on the Board: open its reader from its tile, then
   «Hand off to a new agent» in the reader's actions menu. */
const readerAction = async (path: string, label: string): Promise<boolean> => {
  if (!(await waitFor(() => dom.document.querySelector(`[data-member="${path}"]`) !== null))) return false;
  (dom.document.querySelector(`[data-member="${path}"]`) as unknown as HTMLElement).dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  if (!(await waitFor(() => dom.document.querySelector("[data-reader-menu]") !== null))) return false;
  (dom.document.querySelector("[data-reader-menu]") as unknown as HTMLElement).dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  const item = () => [...dom.document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent?.includes(label)) as unknown as HTMLElement | undefined;
  if (!(await waitFor(() => item() !== undefined))) return false;
  item()!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  return true;
};
const handOff = (path: string) => readerAction(path, "Hand off to a new agent");

/* A project whose catalog is known and whose board has nothing opens on Conversations;
   its Board is one tab away and carries «+ Agent». The board route is served by the
   same reducer the server runs, so the tab's write lands. */
const serveBoardWrites = () => {
  const boards = new Map<string, BoardProjectStateV1>();
  const empty = (): BoardProjectStateV1 => ({
    schemaVersion: 1, revision: 0, updatedAt: new Date(0).toISOString(), pathAliases: {},
    prefs: { manual: [], hidden: [], expanded: [], favorites: [], foldedEngineChildIds: [], expandedEngineTrayParentIds: [], viewMode: null, taskPanelOpen: false },
  });
  G.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/board")) {
      if ((init?.method ?? "GET") === "GET") {
        const project = new URL(url, "http://x").searchParams.get("project")!;
        return { ok: true, status: 200, json: async () => ({ ok: true, board: boards.get(project) ?? empty() }), text: async () => "" };
      }
      const body = JSON.parse(String(init?.body)) as { project: string; mutations?: BoardMutationV1[] };
      const current = boards.get(body.project) ?? empty();
      const reduced = applyBoardMutations(current, body.mutations ?? []);
      const next = { ...reduced, schemaVersion: 1 as const, revision: current.revision + 1, updatedAt: new Date(0).toISOString(), pathAliases: reduced.pathAliases ?? {} };
      boards.set(body.project, next);
      return { ok: true, status: 200, json: async () => ({ ok: true, applied: true, board: next }), text: async () => "" };
    }
    const body = url.startsWith("/api/conversations") ? { items: [], nextCursor: null } : {};
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  }) as unknown as typeof fetch;
};
const openBoardTab = async (): Promise<boolean> => {
  if (!(await waitFor(() => dom.document.querySelector('[data-view-tab="kanban"]') !== null))) return false;
  (dom.document.querySelector('[data-view-tab="kanban"]') as unknown as HTMLElement).dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  return waitFor(() => dom.document.querySelector("[data-kanban-board]") !== null);
};

const directoryTrigger = () => dom.document.querySelector("[data-directory-trigger]") as unknown as HTMLButtonElement | null;
const directoryValue = () => directoryTrigger()?.getAttribute("data-directory-value") ?? null;

/* React's own onChange, the way the sibling draft suites drive the composer:
   happy-dom's `input` event does not reach a controlled textarea. */
const typePrompt = (text: string) => {
  const textarea = dom.document.querySelector('textarea[aria-label="First prompt text"]') as unknown as HTMLTextAreaElement;
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onChange: (event: unknown) => void }>)[propsKey]!;
  flushSync(() => props.onChange({ target: { value: text } }));
};

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
  projectCwd: `/home/user/Projects/${project}`,
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
  expect(directoryValue()).toBe(`/home/user/Projects/${project}`);
});

test("the 390px draft working-directory picker keeps a 44px touch target", async () => {
  const project = "mobile-cwd-target-project";
  const windowWithMatchMedia = dom as unknown as { matchMedia: typeof mobileMatchMedia };
  const previousMatchMedia = windowWithMatchMedia.matchMedia;
  const previousInnerWidth = dom.innerWidth;
  windowWithMatchMedia.matchMedia = mobileMatchMedia;
  (dom as unknown as { innerWidth: number }).innerWidth = 390;
  try {
    roots.push(mount(<ProjectDashboard {...dashboardProps(project)} />));

    /* The phone's create actions are rows in the board menu behind the bar's
       ⋯ (mobile v2 lane 1); «New agent» is the first row. */
    const more = dom.document.querySelector('[data-mobile2-open="menu"]') as unknown as HTMLButtonElement | null;
    more?.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
    expect(await waitFor(() => dom.document.querySelector('[data-mobile2-menu-row="new-agent"]') !== null)).toBe(true);
    const agent = dom.document.querySelector('[data-mobile2-menu-row="new-agent"]') as unknown as HTMLButtonElement | null;
    expect(agent?.getAttribute("role")).toBe("menuitem");
    agent?.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
    expect(await waitFor(() => dom.document.querySelector(AGENT_PANE) !== null)).toBe(true);
    expect(dom.innerWidth).toBe(390);
    expect(directoryTrigger()?.className).toContain("min-h-11");
    expect(directoryTrigger()?.className).toContain("sm:min-h-0");
    /* The list the trigger opens is reachable and its rows are targets too. */
    flushSync(() => directoryTrigger()?.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
    const option = dom.document.querySelector('[role="option"]') as unknown as HTMLElement | null;
    expect(option?.className).toContain("min-h-11");
  } finally {
    windowWithMatchMedia.matchMedia = previousMatchMedia;
    (dom as unknown as { innerWidth: number }).innerWidth = previousInnerWidth;
  }
});

test("a task card agent action seeds the task prompt and canonical project directory", async () => {
  const project = "task-agent-project";
  const projectRoot = `/home/user/Projects/${project}`;
  const task: BoardTask = {
    id: "task-agent-draft",
    project,
    status: "inbox",
    text: "Investigate the cache race\nand add a regression test.",
    placement: "pinned",
    pos: { x: 120, y: 120 },
    assignments: [],
    /* Freshly touched: a quiet old card folds into the status stack strip
       (taskStacks.ts), and this test drives the FULL card's agent action. */
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const previousMatchMedia = G.matchMedia;
  G.matchMedia = (query: string) => ({ ...mobileMatchMedia(query), matches: false });
  try {
    roots.push(mount(<ProjectDashboard {...dashboardProps(project)} projectCwd={projectRoot} tasks={[task]} />));

    /* The card's «+ Agent» (#1695 K9a): the draft opens on that card. */
    expect(await waitFor(() => dom.document.querySelector(`[data-add-agent="task:${task.id}"]`) !== null)).toBe(true);
    (dom.document.querySelector(`[data-add-agent="task:${task.id}"]`) as unknown as HTMLButtonElement).click();

    expect(await waitFor(() => dom.document.querySelector(`[data-kanban-card="task:${task.id}"] ${AGENT_PANE}`) !== null)).toBe(true);
    const prompt = dom.document.querySelector('textarea[aria-label="First prompt text"]') as unknown as HTMLTextAreaElement | null;
    expect(directoryValue()).toBe(projectRoot);
    expect(prompt?.value).toBe(task.text);
  } finally {
    G.matchMedia = previousMatchMedia;
  }
});

test("a restored handoff draft shows its populated source cwd and never asks to confirm it (#887)", async () => {
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
  G.fetch = (async (input: string | URL | Request) => {
    if (String(input).startsWith("/api/spawn?")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ dirs: [sourceCwd], cwd: sourceCwd, cwdExists: false }),
        text: async () => "",
      };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  }) as unknown as typeof fetch;

  roots.push(mount(<ProjectDashboard {...dashboardProps(project)} files={[source]} />));

  expect(await waitFor(() => dom.document.querySelector(AGENT_PANE) !== null)).toBe(true);
  expect(directoryValue()).toBe(sourceCwd);
  expect(dom.document.querySelector('p[role="alert"]')).toBeNull();
});

test("a fresh handoff replaces its provisional project root with the resolved source cwd", async () => {
  const project = "fresh-handoff-project";
  const sourcePath = "/sessions/fresh-source.jsonl";
  const projectRoot = "/repos/fresh-handoff";
  const sourceCwd = `${projectRoot}/.worktrees/source-branch`;
  const source: FileEntry = {
    path: sourcePath,
    root: "codex-sessions",
    name: "fresh-source.jsonl",
    project,
    cwd: "",
    projectRoot,
    title: "Fresh source conversation",
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
  G.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    /* Opening the source's reader stamps it seen; this board store refuses the write and keeps nothing. */
    if (init?.method === "PATCH" && String(input) === "/api/board") return BOARD_WRITE_REFUSED;
    if (String(input).startsWith("/api/spawn?")) {
      return { ok: true, status: 200, json: async () => ({ dirs: [projectRoot, sourceCwd], cwd: sourceCwd }), text: async () => "" };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  }) as unknown as typeof fetch;

  roots.push(mount(<ProjectDashboard {...dashboardProps(project)} files={[source]} projectCwd={projectRoot} />));

  expect(await handOff(sourcePath)).toBe(true);
  expect(await waitFor(() => directoryValue() === sourceCwd)).toBe(true);
  /* The draft sits on the card that holds the conversation it continues. */
  const holder = [...dom.document.querySelectorAll("[data-kanban-card]")].find((card) => card.querySelector(AGENT_PANE) !== null);
  expect(holder?.querySelector(`[data-reader-slot], [data-member="${sourcePath}"]`)).toBeTruthy();
  expect(dom.document.querySelector('p[role="alert"]')).toBeNull();
});

test("a fresh handoff shows a deleted source checkout's cwd without gating on it (#887)", async () => {
  const project = "fresh-deleted-handoff-project";
  const sourcePath = "/sessions/fresh-deleted-source.jsonl";
  const projectRoot = "/repos/fresh-deleted-handoff";
  const sourceCwd = `${projectRoot}/.worktrees/deleted-source-branch`;
  const source: FileEntry = {
    path: sourcePath,
    root: "codex-sessions",
    name: "fresh-deleted-source.jsonl",
    project,
    cwd: sourceCwd,
    projectRoot,
    title: "Deleted source checkout",
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
  G.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PATCH" && String(input) === "/api/board") return BOARD_WRITE_REFUSED;
    if (String(input).startsWith("/api/spawn?")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ dirs: [sourceCwd], cwd: sourceCwd, cwdExists: false }),
        text: async () => "",
      };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  }) as unknown as typeof fetch;

  roots.push(mount(<ProjectDashboard {...dashboardProps(project)} files={[source]} projectCwd={projectRoot} />));

  expect(await handOff(sourcePath)).toBe(true);
  expect(await waitFor(() => directoryValue() === sourceCwd)).toBe(true);
  /* The draft sits on the card that holds the conversation it continues. */
  const holder = [...dom.document.querySelectorAll("[data-kanban-card]")].find((card) => card.querySelector(AGENT_PANE) !== null);
  expect(holder?.querySelector(`[data-reader-slot], [data-member="${sourcePath}"]`)).toBeTruthy();
  expect(dom.document.querySelector('p[role="alert"]')).toBeNull();
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
  expect(await waitFor(() => directoryValue() === sourceCwd)).toBe(true);
});

test("a deleted source checkout's cwd launches with no confirmation in the way (#887)", async () => {
  const project = "deleted-checkout-handoff-project";
  const sourcePath = "/archive/deleted-checkout-source.jsonl";
  const sourceCwd = "/repos/deleted-checkout/.worktrees/source-branch";
  let launchCalls = 0;
  dom.sessionStorage.setItem(draftsKey(project), JSON.stringify([agentA]));
  dom.sessionStorage.setItem(agentField(agentA, "src"), sourcePath);
  G.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST" && String(input) === "/api/spawn") {
      launchCalls += 1;
      return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
    }
    if (String(input).startsWith("/api/spawn?")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ dirs: [sourceCwd], cwd: sourceCwd, cwdExists: false }),
        text: async () => "",
      };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
  }) as unknown as typeof fetch;

  roots.push(mount(<ProjectDashboard {...dashboardProps(project)} />));

  expect(await waitFor(() => directoryValue() === sourceCwd)).toBe(true);
  expect(dom.document.querySelector('p[role="alert"]')).toBeNull();
  typePrompt("Continue the review in the recovered checkout");
  const launch = dom.document.querySelector('[aria-label="Launch the agent"]') as unknown as HTMLButtonElement | null;
  launch?.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  await settle();
  expect(launchCalls).toBe(1);
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
  expect(await waitFor(() => directoryValue() === sourceCwd)).toBe(true);
});

test("a cold dashboard cannot create an agent draft before project metadata hydrates", async () => {
  const project = "cold-project";
  const windowWithMatchMedia = dom as unknown as { matchMedia: typeof mobileMatchMedia };
  const previousMatchMedia = windowWithMatchMedia.matchMedia;
  windowWithMatchMedia.matchMedia = mobileMatchMedia;
  try {
    roots.push(mount(<ProjectDashboard {...dashboardProps(project)} loaded={false} />));

    expect(await waitFor(() => dom.document.querySelector('[data-mobile2-open="menu"]') !== null)).toBe(true);
    const more = dom.document.querySelector('[data-mobile2-open="menu"]') as unknown as HTMLButtonElement;
    more.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
    expect(await waitFor(() => dom.document.querySelector('[data-mobile2-menu-row="new-agent"]') !== null)).toBe(true);
    const agent = dom.document.querySelector('[data-mobile2-menu-row="new-agent"]') as unknown as HTMLButtonElement | null;
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
    const pending: BoardTask = {
      id: "task-cold-desktop", project, status: "inbox", text: "Wait for the catalog", placement: "unplaced", assignments: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    const root = mount(<ProjectDashboard {...dashboardProps(project)} tasks={[pending]} loaded={false} />);
    roots.push(root);
    /* Before hydration no control that could create a draft is enabled, and pressing what there is stores nothing. */
    await settle();
    const cold = agentControl();
    expect(cold === null || cold.disabled).toBe(true);
    cold?.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
    expect(dom.sessionStorage.getItem(draftsKey(project))).toBeNull();
    /* Hydrated, the Board's «+ Agent» opens a draft. */
    flushSync(() => root.render(<ProjectDashboard {...dashboardProps(project)} tasks={[pending]} loaded />));
    expect(await waitFor(() => agentControl()?.disabled === false)).toBe(true);
    agentControl()!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
    expect(await waitFor(() => dom.document.querySelector(AGENT_PANE) !== null)).toBe(true);
  } finally {
    G.matchMedia = previousMatchMedia;
  }
});

test("an unmatched metadata-poor project opens a nonempty draft on the root placeholder", async () => {
  const project = "unmatched-task-only-project";
  serveBoardWrites();
  roots.push(mount(<ProjectDashboard {...dashboardProps(project)} projectCwd={undefined} />));

  expect(await openBoardTab()).toBe(true);
  expect(await waitFor(() => agentControl() !== null)).toBe(true);
  agentControl()!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  expect(await waitFor(() => dom.document.querySelector(AGENT_PANE) !== null)).toBe(true);
  expect(directoryValue()).toBe("/");
  expect(dom.document.querySelector('p[role="alert"]')).toBeNull();
});

test("an untouched provisional project draft adopts a canonical root after catalog hydration", async () => {
  const project = "hydrating-catalog-project";
  const canonicalRoot = "/repos/hydrated-canonical-root";
  serveBoardWrites();
  const root = mount(<ProjectDashboard {...dashboardProps(project)} projectCwd={undefined} />);
  roots.push(root);

  expect(await openBoardTab()).toBe(true);
  expect(await waitFor(() => agentControl() !== null)).toBe(true);
  agentControl()!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  expect(await waitFor(() => dom.document.querySelector(AGENT_PANE) !== null)).toBe(true);
  expect(directoryValue()).toBe("/");

  flushSync(() => root.render(
    <ProjectDashboard
      {...dashboardProps(project)}
      projectCwd={undefined}
      projectCatalog={[{ project, projectRoot: canonicalRoot, smt: 2, conversations: 1 }]}
    />,
  ));

  expect(await waitFor(() => directoryValue() === canonicalRoot)).toBe(true);
  expect(dom.document.querySelector('p[role="alert"]')).toBeNull();
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
  expect(directoryValue()).toBe(`/home/user/Projects/${project}`);
  expect(directoryTrigger()?.disabled).toBe(false);
  expect(dom.document.querySelector('p[role="alert"]')).toBeNull();
  typePrompt("Rebuild the lost handoff from the project root");
  const launch = dom.document.querySelector('[aria-label="Launch the agent"]') as unknown as HTMLButtonElement | null;
  launch?.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  await settle();
  expect(launchCalls).toBe(1);
});

test("a retried launch opens its draft on the Board, prefilled from the launch, and its receipt stays in launch history", async () => {
  const project = "retried-launch-project";
  const launchCwd = "/repos/retried-launch/.worktrees/lane";
  const pending: BoardTask = {
    id: "task-retry-host", project, status: "inbox", text: "Keep the board drawn", placement: "unplaced", assignments: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const receipt = {
    path: "spawn:launch-retry-fixture", root: "claude-projects", name: "spawn", project, title: "Builder launch", engine: "claude",
    kind: "session", fmt: "claude", parent: null, mtime: Date.now() / 1000 - 3_600, size: 0, activity: "idle", proc: null, pid: null,
    pendingQuestion: null, waitingInput: null, cwd: launchCwd,
    goal: { objective: "Rebuild the search index without downtime", status: "active", tokensUsed: null, timeUsedSeconds: null },
    spawn: { launchId: "launch-retry-fixture", clientAttemptId: null, accountId: "default", state: "failed", initialMessage: "failed", retrySafe: true, error: "structured spawn failed before host binding" },
  } as unknown as FileEntry;
  /* The project's own root differs from the launch's directory, so the draft's directory says which one it came from. */
  roots.push(mount(<ProjectDashboard {...dashboardProps(project)} tasks={[pending]} files={[receipt]} projectCatalog={[{ project, projectRoot: "/repos/retried-launch", smt: 2, conversations: 1 }]} />));

  expect(await waitFor(() => dom.document.querySelector('[aria-label="Terminal launch receipts"]') !== null)).toBe(true);
  (dom.document.querySelector('[aria-label="Terminal launch receipts"]') as unknown as HTMLElement).dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  expect(await waitFor(() => dom.document.querySelector('[aria-label="Retry launch: Builder launch"]') !== null)).toBe(true);
  (dom.document.querySelector('[aria-label="Retry launch: Builder launch"]') as unknown as HTMLElement).dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);

  expect(await waitFor(() => dom.document.querySelector(`.card[data-id^="draft:"] ${AGENT_PANE}`) !== null)).toBe(true);
  const prompt = dom.document.querySelector('.card[data-id^="draft:"] textarea[aria-label="First prompt text"]') as unknown as HTMLTextAreaElement | null;
  expect(prompt?.value).toBe("Rebuild the search index without downtime");
  expect(directoryValue()).toBe(launchCwd);
  /* Nothing launched, and the receipt is still the evidence. */
  expect(dom.document.querySelector('[aria-label="Retry launch: Builder launch"]')).not.toBeNull();
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
      onCloseFile={(closedPath) => closed.push(closedPath)}
    />,
  ));

  /* On the Board: the conversation's reader, then «Remove from the board» in its actions menu. */
  expect(await readerAction(path, "Remove from the board")).toBe(true);
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
