import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";
import { buildBranchGroups } from "@/components/projectModel";
import { compactPipelineArtifactPaths, excludeCompactPipelineArtifacts } from "@/components/pipelines/pipelineModel";

import { SchemeBoard } from "./SchemeBoard";

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

function entry(over: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects", name: over.path, project: "demo", title: over.path,
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1000,
    size: 10, activity: "live", proc: null, pid: null, model: null,
    pendingQuestion: null, waitingInput: null, ...over,
  };
}

const stageRole = (access: "read-write" | "read-only") =>
  ({ roleId: null, engine: "codex" as const, model: null, effort: null, access, promptScaffold: null });

/* Five declared stages: three materialized conversations and two future shells. */
const architect = entry({ path: "/arch", conversationId: "c-arch" });
const builder = entry({ path: "/build", conversationId: "c-build" });
const verify = entry({ path: "/verify", conversationId: "c-verify" });

const pipeline = {
  id: "pipe-1", task: "Restore the colored halo", project: "demo", repoDir: "/r", worktreeDir: "/w",
  branch: "b", baseBranch: "main", baseRef: "a", lastPassedCommit: "a",
  stages: [
    { id: "architect", kind: "run", prompt: "", next: "builder", effectiveRole: stageRole("read-write") },
    { id: "builder", kind: "run", prompt: "", next: "verify", effectiveRole: stageRole("read-write") },
    { id: "verify", kind: "run", prompt: "", next: "polish", effectiveRole: stageRole("read-write") },
    { id: "polish", kind: "run", prompt: "{{prev.output}}", next: "review", effectiveRole: stageRole("read-write") },
    { id: "review", kind: "review-loop", prompt: "", next: null, effectiveRole: stageRole("read-only") },
  ],
  runs: [
    { stageId: "architect", attempts: [{ n: 1, state: "passed", agentPath: "/arch", flowId: null }] },
    { stageId: "builder", attempts: [{ n: 1, state: "passed", agentPath: "/build", flowId: null }] },
    { stageId: "verify", attempts: [{ n: 1, state: "running", agentPath: "/verify", flowId: null }] },
  ],
  cursor: { stageId: "verify", state: "running", input: null, activatedBy: null },
  state: "running", pausedState: null, stateDetail: null,
  srcPath: null, srcConversationId: null, createdAt: new Date(0).toISOString(), closedAt: null,
} as unknown as Pipeline;

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => undefined);
};

function mountScene(files: FileEntry[]): HTMLElement {
  const groups = buildBranchGroups(files, "demo");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => root.render(
    <SchemeBoard
      project="demo"
      groups={groups}
      manual={[]}
      files={files}
      flows={[]}
      pipelines={[pipeline]}
      surfacePipelines={[pipeline]}
      tasks={[]}
      drafts={[]}
      focus={null}
      onSelect={() => {}}
      onClose={() => {}}
      onDraftClose={() => {}}
      onDraftSpawned={() => {}}
    />,
  ));
  return host;
}

test("the production scene keeps EVERY current stage a full real card and shells the future stages inside one halo (#507 F2)", async () => {
  /* No stage compacts on an active pipeline: the two passed stages and the live
     stage all keep their transcripts in the scene as full conversation cards. */
  const allFiles = [architect, builder, verify];
  const compactPaths = compactPipelineArtifactPaths([pipeline], []);
  expect([...compactPaths]).toEqual([]);
  const files = excludeCompactPipelineArtifacts(allFiles, compactPaths);
  const host = mountScene(files);
  await settle();

  /* Exactly one colored pipeline region — the halo — is the single visual owner. */
  expect(host.querySelectorAll('[data-scheme-group="pipeline"]')).toHaveLength(1);
  expect(host.querySelector('[data-pipeline-group-header="pipe-1"]')).toBeTruthy();

  /* All three materialized stages keep a full conversation pane — no stub. */
  expect(host.querySelector('[data-scheme-node="/arch"]')).toBeTruthy();
  expect(host.querySelector('[data-scheme-node="/build"]')).toBeTruthy();
  expect(host.querySelector('[data-scheme-node="/verify"]')).toBeTruthy();
  expect(host.querySelectorAll('[data-pipeline-stage-completed="true"]')).toHaveLength(0);

  /* Both future stages render conversation-shaped shells. */
  expect(host.querySelector('[data-scheme-node="slot::pipe-1::polish"]')).toBeTruthy();
  expect(host.querySelector('[data-scheme-node="slot::pipe-1::review"]')).toBeTruthy();
  /* Every declared stage projects EXACTLY ONE surface: three real cards + two
     future shells = five cards. */
  const stageCards = [...host.querySelectorAll('[data-pipeline-stage-card^="pipe-1::"]')];
  expect(stageCards.map((card) => card.getAttribute("data-pipeline-stage-card")).sort()).toEqual([
    "pipe-1::architect",
    "pipe-1::builder",
    "pipe-1::polish",
    "pipe-1::review",
    "pipe-1::verify",
  ]);

  /* No detached PipelineGroup body, duplicate stage graph, or empty white slab. */
  expect(host.querySelector("[data-pipeline-group-body]")).toBeNull();
  expect(host.querySelector("[data-pipeline-group]")).toBeNull();
  expect(host.querySelector("[data-scheme-group-strip]")).toBeNull();
  expect(host.querySelector("[data-pipeline-stage-graph]")).toBeNull();
});

test("an idle completed stage still renders as a full conversation card inside the halo, not a compact stub (#507 F2)", async () => {
  /* Realistic scene: the two passed stages have gone idle, so the board's
     activity gate would not surface them as live nodes. They must still stand in
     at their stage positions as FULL conversation cards (the completed slot), so
     the five-stage graph stays five real/placeholder cards. */
  const idleArchitect = { ...architect, activity: "idle" as const };
  const idleBuilder = { ...builder, activity: "idle" as const };
  const files = [idleArchitect, idleBuilder, verify];
  const host = mountScene(files);
  await settle();

  expect(host.querySelectorAll('[data-scheme-group="pipeline"]')).toHaveLength(1);
  /* The live cursor stage is a full board node; the idle passed stages are full
     completed cards at their slot positions. */
  expect(host.querySelector('[data-scheme-node="/verify"]')).toBeTruthy();
  const completed = [...host.querySelectorAll('[data-pipeline-stage-completed="true"]')];
  expect(completed).toHaveLength(2);
  expect(host.querySelector('[data-scheme-node="slot::pipe-1::architect"]')).toBeTruthy();
  expect(host.querySelector('[data-scheme-node="slot::pipe-1::builder"]')).toBeTruthy();
  /* The completed card is full-size (the live/placeholder footprint), NOT the
     old 168px compact stub. */
  const archSlot = host.querySelector('[data-scheme-node="slot::pipe-1::architect"]') as HTMLElement;
  expect(Number.parseInt(archSlot.style.height, 10)).toBeGreaterThan(400);
  /* It shows the real prompt that was sent (minimal visual difference from the
     eventual live conversation) and opens the transcript. */
  expect(completed[0]!.textContent).toContain("Pinned task:");
  expect(completed.some((card) => card.textContent?.includes("Open conversation"))).toBe(true);

  /* Still exactly five stage cards, one per declared stage. */
  const stageCards = [...host.querySelectorAll('[data-pipeline-stage-card^="pipe-1::"]')];
  expect(stageCards.map((card) => card.getAttribute("data-pipeline-stage-card")).sort()).toEqual([
    "pipe-1::architect",
    "pipe-1::builder",
    "pipe-1::polish",
    "pipe-1::review",
    "pipe-1::verify",
  ]);
});
