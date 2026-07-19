import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import { emptyStore } from "@/components/runtime/runtimeModel";
import type { BranchGroup } from "@/components/projectModel";
import type { FileEntry } from "@/lib/types";
import type { Pipeline } from "@/lib/pipelines/types";

/*
 * Issue #419 — chat-first viewport. With a conversation focused, the docked
 * pipelines collapse into ONE summary row; the bottom sheet lists them, folding
 * completed pipelines behind a single disclosure. Opening/closing the map never
 * remounts the focused pane.
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
(dom as unknown as { matchMedia: unknown }).matchMedia = OVERRIDES.matchMedia;
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

function pipe(id: string, state: string): Pipeline {
  return {
    id, task: `Task ${id}`, project: "demo", repoDir: "/r", worktreeDir: "/w",
    branch: "b", baseBranch: "main", baseRef: "a", lastPassedCommit: "a",
    stages: [
      { id: "plan", kind: "run", prompt: "", next: "build", effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-only", promptScaffold: null } },
      { id: "build", kind: "run", prompt: "", next: null, effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } },
    ],
    runs: [], cursor: null, state, pausedState: null, stateDetail: null,
    srcPath: null, srcConversationId: null, createdAt: new Date(0).toISOString(), closedAt: null,
  } as unknown as Pipeline;
}

const pipelines = [pipe("p-run", "running"), pipe("p-done1", "completed"), pipe("p-done2", "completed")];

function entry(overrides: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects", name: overrides.path, project: "demo", title: overrides.path,
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1_000, size: 10,
    activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null,
    ...overrides,
  };
}

function view() {
  const conversation = entry({ path: "/session", title: "Main session", activity: "live", mtime: 9_000 });
  const group: BranchGroup = { key: conversation.path, columns: [{ file: conversation, tasks: [] }], returnable: [], finished: [], smt: conversation.mtime, orphanTask: false };
  return (
    <MobileFocusView
      project="demo" groups={[group]} manual={[]} files={[conversation]} flows={[]}
      pipelines={pipelines} surfacePipelines={pipelines} workerStacks={[{ key: "stack::pipe:p-run", kind: "pipeline", id: "p-run", items: [] }]} tasks={[]} drafts={[]}
      loaded focus={null} onSelect={() => {}} onClose={() => {}} onDraftClose={() => {}} onDraftSpawned={() => {}}
    />
  );
}

test("a focused conversation collapses several pipelines into one summary row with live counts (#419)", async () => {
  roots.push(mount(view()));
  await settle();

  const summary = dom.document.querySelector('[data-testid="mobile-pipeline-summary"]');
  expect(summary).not.toBeNull();
  /* One summary row, never a row per pipeline. */
  expect(dom.document.querySelectorAll('[data-testid="mobile-pipeline-summary"]').length).toBe(1);
  expect(dom.document.querySelector('[data-testid="mobile-pipeline-dock"]')).toBeNull();
  /* Counts: 3 total, 1 active, 2 done. */
  expect(summary!.textContent).toContain("3 pipelines");
  expect(summary!.textContent).toContain("1 active");
  expect(summary!.textContent).toContain("2 done");
});

test("the focused chat is one 100dvh-bounded shell whose pane owns the remaining height (#440)", async () => {
  roots.push(mount(view()));
  await settle();

  const shell = dom.document.querySelector('[data-testid="mobile-focused-chat-shell"]') as HTMLElement | null;
  expect(shell).not.toBeNull();
  expect(shell!.className).toContain("h-full");
  expect(shell!.className).toContain("max-h-[100dvh]");
  expect(shell!.className).toContain("overflow-hidden");

  const pane = shell!.querySelector('[data-testid="mobile-focused-pane"]') as HTMLElement | null;
  expect(pane).not.toBeNull();
  expect(pane!.className).toContain("min-h-0");
  expect(pane!.className).toContain("flex-1");

  const transcript = pane!.querySelector(".overflow-y-auto") as HTMLElement | null;
  expect(transcript).not.toBeNull();
  expect(transcript!.className).toContain("min-h-0");
  expect(transcript!.className).toContain("flex-1");
});

test("the 390px agent header uses compact phone spacing above the transcript (#440)", async () => {
  roots.push(mount(view()));
  await settle();

  const header = dom.document.querySelector('[data-testid="mobile-focused-pane"] header') as HTMLElement | null;
  expect(header).not.toBeNull();
  expect(header!.className).toContain("gap-y-0.5");
  expect(header!.className).toContain("px-2");
  expect(header!.className).toContain("py-1");
});

test("the sheet folds completed pipelines behind one reversible disclosure (#419)", async () => {
  roots.push(mount(view()));
  await settle();

  const summary = dom.document.querySelector('[data-testid="mobile-pipeline-summary"]') as unknown as HTMLButtonElement;
  flushSync(() => summary.click());
  await settle();
  const sheet = dom.document.querySelector('[data-testid="mobile-pipeline-sheet"]')!;

  /* The one ongoing pipeline is listed directly; the two completed ones hide
     behind a single "2 completed" disclosure until it is opened. */
  const docksBefore = sheet.querySelectorAll('[data-testid="mobile-pipeline-dock"]');
  expect(docksBefore.length).toBe(1);
  const group = sheet.querySelector('[data-testid="mobile-pipeline-completed-group"]')!;
  expect(group.textContent).toContain("2 completed");

  const toggle = sheet.querySelector('[data-testid="mobile-pipeline-completed-toggle"]') as unknown as HTMLButtonElement;
  flushSync(() => toggle.click());
  await settle();
  expect(sheet.querySelectorAll('[data-testid="mobile-pipeline-dock"]').length).toBe(3);

  /* Reversible. */
  flushSync(() => toggle.click());
  await settle();
  expect(sheet.querySelectorAll('[data-testid="mobile-pipeline-dock"]').length).toBe(1);
});

test("opening and closing the map never remounts the focused pane", async () => {
  roots.push(mount(view()));
  await settle();

  const paneBefore = dom.document.querySelector("textarea");
  expect(paneBefore).not.toBeNull();

  const openBtn = dom.document.querySelector('button[aria-label="Open the project map"]') as unknown as HTMLButtonElement;
  flushSync(() => openBtn.click());
  await settle();
  expect(dom.document.querySelector('[aria-label="Close the map"]')).not.toBeNull();

  const closeBtn = dom.document.querySelector('[aria-label="Close the map"]') as unknown as HTMLButtonElement;
  flushSync(() => closeBtn.click());
  await settle();

  const paneAfter = dom.document.querySelector("textarea");
  /* Same node instance — the pane stayed mounted under the sibling overlay. */
  expect(paneAfter).toBe(paneBefore);
});
