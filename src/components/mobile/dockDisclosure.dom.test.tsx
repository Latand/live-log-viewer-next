import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import type { BranchGroup } from "@/components/projectModel";
import type { FileEntry } from "@/lib/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { WorkerStack } from "@/components/scheme/workerCollapse";

/*
 * Issue #156 — the focused conversation must stay the dominant mobile surface.
 * With a pane focused, every docked pipeline mounts COLLAPSED to one 44px
 * disclosure row inside a bounded (≤34vh) dock bar; expanding one reveals the
 * full rail. The empty-state branch (no conversation — the dock IS the surface)
 * keeps its docks expanded.
 */

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

beforeAll(() => {
  for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; }
  (dom.HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};
});
afterAll(async () => {
  await settle();
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

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

const pipeline = {
  id: "p1", task: "Ship the mobile dock", project: "demo", repoDir: "/r", worktreeDir: "/w",
  branch: "b", baseBranch: "main", baseRef: "a", lastPassedCommit: "a",
  stages: [
    { id: "plan", kind: "run", prompt: "", next: "build", effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-only", promptScaffold: null } },
    { id: "build", kind: "run", prompt: "", next: null, effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } },
  ],
  runs: [], cursor: null, state: "provisioning", pausedState: null, stateDetail: null,
  srcPath: null, srcConversationId: null, createdAt: new Date(0).toISOString(), closedAt: null,
} as unknown as Pipeline;

function entry(overrides: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects",
    name: overrides.path,
    project: "demo",
    title: overrides.path,
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1_000,
    size: 10,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

function view(groups: BranchGroup[], files: FileEntry[], stacks: WorkerStack[] = []) {
  return (
    <MobileFocusView
      project="demo"
      groups={groups}
      manual={[]}
      files={files}
      flows={[]}
      pipelines={[pipeline]}
      surfacePipelines={[pipeline]}
      workerStacks={stacks}
      tasks={[]}
      drafts={[]}
      loaded
      focus={null}
      onSelect={() => {}}
      onClose={() => {}}
      onDraftClose={() => {}}
      onDraftSpawned={() => {}}
    />
  );
}

test("a focused conversation keeps docked pipelines collapsed inside a ≤34vh bar; expanding reveals the rail (#156)", async () => {
  const conversation = entry({ path: "/session", title: "Main session", activity: "live", mtime: 9_000 });
  const group: BranchGroup = {
    key: conversation.path,
    columns: [{ file: conversation, tasks: [] }],
    returnable: [],
    finished: [],
    smt: conversation.mtime,
    orphanTask: false,
  };
  roots.push(mount(view([group], [conversation])));
  await settle();

  /* The dock bar below the focused pane is height-bounded tighter than before. */
  const dock = dom.document.querySelector('[data-testid="mobile-pipeline-dock"]');
  expect(dock).not.toBeNull();
  const bar = dock!.closest("div.shrink-0");
  expect(bar).not.toBeNull();
  expect(bar!.className).toContain("max-h-[34vh]");

  /* Collapsed by default: only the summary row, no stage rail, so the
     conversation stays dominant. */
  expect(dock!.querySelector('[data-testid="mobile-pipeline-dock-summary"]')).not.toBeNull();
  expect(dock!.querySelector('[aria-label="Pipeline stages"]')).toBeNull();

  /* The disclosure expands to the full rail on demand. */
  const toggle = dock!.querySelector('[data-testid="mobile-pipeline-dock-summary"]') as unknown as HTMLButtonElement;
  flushSync(() => toggle.click());
  await settle();
  expect(dom.document.querySelector('[data-testid="mobile-pipeline-dock"] [aria-label="Pipeline stages"]')).not.toBeNull();
});

test("the empty-state branch (no conversation) mounts its docks expanded — the dock IS the surface", async () => {
  roots.push(mount(view([], [])));
  await settle();

  const dock = dom.document.querySelector('[data-testid="mobile-pipeline-dock"]');
  expect(dock).not.toBeNull();
  expect(dock!.querySelector('[aria-label="Pipeline stages"]')).not.toBeNull();
});

test("the map overlay dock bar is bounded to 30vh with collapsed docks (#156)", async () => {
  const conversation = entry({ path: "/session", title: "Main session", activity: "live", mtime: 9_000 });
  const group: BranchGroup = {
    key: conversation.path,
    columns: [{ file: conversation, tasks: [] }],
    returnable: [],
    finished: [],
    smt: conversation.mtime,
    orphanTask: false,
  };
  const stack: WorkerStack = { key: "stack::pipe:p1", kind: "pipeline", id: "p1", items: [] };
  roots.push(mount(view([group], [conversation], [stack])));
  await settle();

  const openBtn = dom.document.querySelector('button[aria-label="Open the project map"]') as HTMLButtonElement | null;
  expect(openBtn).not.toBeNull();
  flushSync(() => openBtn!.click());
  await settle();

  const overlay = dom.document.querySelector('[aria-label="Close the map"]')!.closest("div.fixed")!;
  const dock = overlay.querySelector('[data-testid="mobile-pipeline-dock"]');
  expect(dock).not.toBeNull();
  const bar = dock!.closest("div.shrink-0");
  expect(bar!.className).toContain("max-h-[30vh]");
  expect(dock!.querySelector('[data-testid="mobile-pipeline-dock-summary"]')).not.toBeNull();
  expect(dock!.querySelector('[aria-label="Pipeline stages"]')).toBeNull();
});
