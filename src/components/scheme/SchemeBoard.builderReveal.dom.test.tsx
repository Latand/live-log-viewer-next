import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";

import { SchemeBoard } from "./SchemeBoard";

/* Like the sibling SchemeBoard DOM tests, the happy-dom globals stay installed
   after teardown — React's scheduler drains a deferred task and would throw if
   `window` were removed underneath it. Only per-test state is cleaned up. */
const dom = new Window();
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(dom as unknown as { matchMedia: (q: string) => unknown }).matchMedia = () => ({
  matches: false, media: "", addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
});
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLDivElement: dom.HTMLDivElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
  localStorage: dom.localStorage,
  ResizeObserver: TestResizeObserver,
  IntersectionObserver: undefined,
});

const roots = new Set<Root>();
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  document.body.replaceChildren();
  dom.sessionStorage.clear();
});

/* A fresh draft materializes its declared stages as placeholder cards inside one
   colored halo (#353); the halo is the draft's world-space region. */
const draft: Pipeline = {
  id: "d1", task: "New pipeline", taskIds: [], project: "demo", repoDir: "/r",
  worktreeDir: "/r-pipeline-d1", branch: "pipeline/new-pipeline-d1",
  baseBranch: "", baseRef: "", lastPassedCommit: "",
  stages: [
    { id: "build", kind: "run", prompt: "", next: "review", effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null } },
    { id: "review", kind: "review-loop", prompt: "", next: null, effectiveRole: { roleId: null, engine: "codex", model: null, effort: null, access: "read-only", promptScaffold: null } },
  ],
  runs: [],
  cursor: null, state: "draft", pausedState: null, stateDetail: null,
  srcPath: null, srcConversationId: null, createdAt: new Date(0).toISOString(), closedAt: null,
} as unknown as Pipeline;

function board(builderPipelineId: string | null, value: Pipeline = draft, tasks: BoardTask[] = []) {
  return (
    <SchemeBoard
      project="demo"
      groups={[]}
      manual={[]}
      files={[]}
      flows={[]}
      pipelines={[value]}
      surfacePipelines={[value]}
      tasks={tasks}
      drafts={[]}
      focus={null}
      onSelect={() => {}}
      onClose={() => {}}
      onDraftClose={() => {}}
      onDraftSpawned={() => {}}
      builderPipelineId={builderPipelineId}
      onBuilderOpened={() => {}}
    />
  );
}

/* Passive effects (the reveal) and their cascaded re-render settle across a few
   macrotasks; drain them, then flush any pending render synchronously. */
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => undefined);
};

test("the builder reveal ends an active selection session and opens the world-group editor", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => root.render(board(null)));
  await settle();

  /* Arm a selection session via the lasso tool — its ToolButton sets `armed`. */
  const lasso = Array.from(host.querySelectorAll("button")).find((b) =>
    (b.getAttribute("title") || "").startsWith("Multi-select"),
  ) as HTMLButtonElement;
  expect(lasso).toBeTruthy();
  flushSync(() => lasso.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  await settle();

  /* The draft owns one colored halo (its sole world-space region), config closed. */
  expect(host.querySelector("[data-group-override]")).toBeNull();
  expect(host.querySelector('[data-scheme-group="pipeline"]')).toBeTruthy();
  expect(host.querySelector('[data-pipeline-group-header="d1"]')).toBeTruthy();
  /* No detached pipeline control card exists on the board (#353). */
  expect(host.querySelector('[data-pipeline-group="d1"]')).toBeNull();

  /* Targeting this draft clears the world session and opens its config in place. */
  flushSync(() => root.render(board("d1")));
  await settle();
  expect(host.querySelector("[data-group-override]")).toBeTruthy();
});

test("a linked pipeline renders as one colored halo with no detached control card", async () => {
  const task: BoardTask = {
    id: "task-linked",
    project: "demo",
    status: "assigned",
    text: "Linked task",
    placement: "pinned",
    pos: { x: 420, y: 180 },
    assignments: [],
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: "2026-07-19T00:00:00.000Z",
  };
  const linked = { ...draft, id: "linked", taskIds: [task.id] } as Pipeline;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);

  flushSync(() => root.render(board(null, linked, [task])));
  await settle();

  /* Exactly one visual owner: the colored halo. No detached PipelineGroup card. */
  expect(host.querySelector('[data-pipeline-group-header="linked"]')).toBeTruthy();
  expect(host.querySelectorAll('[data-scheme-group="pipeline"]')).toHaveLength(1);
  expect(host.querySelector('[data-pipeline-group="linked"]')).toBeNull();
});
