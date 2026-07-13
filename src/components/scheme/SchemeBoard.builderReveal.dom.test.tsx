import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { Pipeline } from "@/lib/pipelines/types";

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

/* A fresh empty draft — the exact shape `createDraftPipeline` produces on the
   canvas — surfaced so SchemeBoard docks a placeholder group for it. */
const draft: Pipeline = {
  id: "d1", task: "New pipeline", project: "demo", repoDir: "/r",
  worktreeDir: "/r-pipeline-d1", branch: "pipeline/new-pipeline-d1",
  baseBranch: "", baseRef: "", lastPassedCommit: "", stages: [], runs: [],
  cursor: null, state: "draft", pausedState: null, stateDetail: null,
  srcPath: null, srcConversationId: null, createdAt: new Date(0).toISOString(), closedAt: null,
} as Pipeline;

function board(builderPipelineId: string | null) {
  return (
    <SchemeBoard
      project="demo"
      groups={[]}
      manual={[]}
      files={[]}
      flows={[]}
      pipelines={[draft]}
      surfacePipelines={[draft]}
      tasks={[]}
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

test("the builder reveal ends an active selection session so the panel opens (#136)", async () => {
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

  /* While a session is active the group halo is non-interactive: no panel, and the
     draft's label chip is disabled. */
  expect(host.querySelector("[data-group-override]")).toBeNull();
  const chip = host.querySelector('[data-scheme-group] button[aria-haspopup="dialog"]') as HTMLButtonElement;
  expect(chip.disabled).toBe(true);

  /* The canvas builder now targets this draft: the reveal must clear the session
     and open its builder panel, freeing the operator from exiting selection by hand. */
  flushSync(() => root.render(board("d1")));
  await settle();
  expect(host.querySelector("[data-group-override]")).toBeTruthy();
});
