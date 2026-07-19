import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";

import { StageEdgeControls } from "./StageEdgeControls";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLSelectElement: dom.HTMLSelectElement,
  HTMLInputElement: dom.HTMLInputElement,
  Event: dom.Event,
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
});

function oneStagePipeline(): { pipeline: Pipeline; stage: PipelineStage } {
  const stage: PipelineStage = {
    id: "implement",
    kind: "run",
    prompt: "{{task}}",
    next: null,
    onFail: null,
    effectiveRole: { roleId: null, engine: "claude", model: null, effort: null, access: "read-write", promptScaffold: null },
  } as PipelineStage;
  const pipeline = {
    id: "p1",
    task: "Lone stage",
    taskIds: [],
    project: "demo",
    repoDir: "/r",
    worktreeDir: "/w",
    branch: "b",
    baseBranch: "main",
    baseRef: "a",
    lastPassedCommit: "a",
    stages: [stage],
    runs: [{ stageId: "implement", attempts: [] }],
    cursor: { stageId: "implement", state: "pending", input: null, activatedBy: null },
    state: "draft",
    pausedState: null,
    stateDetail: null,
    srcPath: null,
    srcConversationId: null,
    createdAt: "1970",
    closedAt: null,
  } as Pipeline;
  return { pipeline, stage };
}

function mount(node: React.ReactNode): { host: HTMLElement; root: Root } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(node));
  return { host, root };
}

test("a one-stage pipeline offers a self-targeting fail edge and configures it (#353)", async () => {
  const patches: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "PATCH") patches.push({ url, body: JSON.parse(init.body ?? "{}") as Record<string, unknown> });
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch;

  const { pipeline, stage } = oneStagePipeline();
  const { host, root } = mount(<StageEdgeControls pipeline={pipeline} stage={stage} />);

  const selects = [...host.querySelectorAll("select")] as HTMLSelectElement[];
  expect(selects).toHaveLength(2);
  const [passSelect, failSelect] = selects as [HTMLSelectElement, HTMLSelectElement];

  /* The pass picker excludes the stage itself: the pass graph stays acyclic, so
     the lone stage's only option is the terminal end. */
  expect([...passSelect.options].map((option) => option.value)).toEqual([""]);
  /* The fail picker offers the stage itself: a self-loop is the only cycle a
     one-stage pipeline can carry. */
  expect([...failSelect.options].map((option) => option.value)).toEqual(["", "implement"]);

  /* Selecting the self target emits the set-edge fail mutation. */
  flushSync(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLSelectElement.prototype, "value")!.set!.call(failSelect, "implement");
    failSelect.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event);
  });
  await Bun.sleep(0);

  expect(patches).toHaveLength(1);
  expect(patches[0]!.url).toBe("/api/pipelines/p1");
  expect(patches[0]!.body).toEqual({ action: "set-edge", stageId: "implement", edge: "fail", to: "implement" });

  flushSync(() => root.unmount());
  host.remove();
});
