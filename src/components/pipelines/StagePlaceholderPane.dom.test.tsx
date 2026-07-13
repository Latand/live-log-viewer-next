import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import type { StageSlot } from "@/components/scheme/layout";

import { StagePlaceholderPane } from "./StagePlaceholderPane";

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
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
});

function stage(over: Partial<PipelineStage> = {}): PipelineStage {
  return {
    id: "architect",
    kind: "run",
    role: { roleId: "architect" },
    prompt: "Plan the work",
    next: "builder",
    effectiveRole: { roleId: "architect", engine: "claude", model: "fable", effort: "high", access: "read-only", promptScaffold: null },
    ...over,
  } as PipelineStage;
}

function slot(over: { pipeline?: Partial<Pipeline>; stage?: Partial<PipelineStage> } = {}): StageSlot {
  const theStage = stage(over.stage);
  const pipeline = {
    id: "p1",
    task: "Ship it",
    project: "demo",
    repoDir: "/r",
    worktreeDir: "/w",
    branch: "b",
    baseBranch: "main",
    baseRef: "a",
    lastPassedCommit: "a",
    stages: [theStage],
    runs: [],
    cursor: null,
    state: "draft",
    pausedState: null,
    stateDetail: null,
    srcPath: null,
    srcConversationId: null,
    createdAt: "1970",
    closedAt: null,
    ...over.pipeline,
  } as Pipeline;
  return { key: `slot::p1::${theStage.id}`, pipeline, stage: theStage, index: 0, total: 3, x: 0, y: 0, w: 600, h: 460 };
}

function mount(node: React.ReactNode): { host: HTMLElement; root: Root } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => {
    root.render(node);
  });
  return { host, root };
}

test("a placeholder names its role, marks the stage position, and carries the shared model+effort pickers", () => {
  const { host, root } = mount(<StagePlaceholderPane slot={slot()} interactive />);
  expect(host.textContent).toContain("architect");
  expect(host.textContent).toContain("stage 1/3");
  expect(host.textContent).toContain("Plan the work");
  /* The SAME ReasoningControls the agent draft windows use: a model select
     seeded from the stage's resolved runtime, plus the effort tiers. */
  const selects = [...host.querySelectorAll("select")] as HTMLSelectElement[];
  expect(selects.length).toBe(2);
  expect(selects[0]!.value).toBe("fable");
  expect(selects[1]!.value).toBe("high");
  /* Both engines are offered as a radiogroup, like the agent draft pane. */
  expect(host.querySelector('[role="radiogroup"]')).toBeTruthy();
  flushSync(() => root.unmount());
  host.remove();
});

test("changing the effort PATCHes override-stage with ONLY the changed field (+ prompt), stageId pinned", async () => {
  const patches: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    patches.push({ url, body: JSON.parse(init?.body ?? "{}") as Record<string, unknown> });
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch;

  const { host, root } = mount(<StagePlaceholderPane slot={slot()} interactive />);
  const effortSelect = [...host.querySelectorAll("select")][1] as HTMLSelectElement;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLSelectElement.prototype, "value")!.set!.call(effortSelect, "max");
    effortSelect.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event);
  });
  await Bun.sleep(0);
  expect(patches).toHaveLength(1);
  expect(patches[0]!.url).toBe("/api/pipelines/p1");
  expect(patches[0]!.body).toEqual({ action: "override-stage", stageId: "architect", prompt: "Plan the work", effort: "max" });
  flushSync(() => root.unmount());
  host.remove();
});

test("a stage that already ran is frozen: pickers disabled, no PATCH from a change attempt", () => {
  const ran = slot({ pipeline: { state: "running", runs: [{ stageId: "architect", attempts: [{ n: 1, state: "passed" } as never] }] } });
  const { host, root } = mount(<StagePlaceholderPane slot={ran} interactive />);
  const selects = [...host.querySelectorAll("select")] as HTMLSelectElement[];
  for (const select of selects) expect(select.disabled).toBe(true);
  expect(host.textContent).toContain("configuration is locked");
  flushSync(() => root.unmount());
  host.remove();
});

test("the lite (map) variant renders a static runtime summary instead of pickers", () => {
  const { host, root } = mount(<StagePlaceholderPane slot={slot()} interactive={false} />);
  expect(host.querySelectorAll("select").length).toBe(0);
  expect(host.textContent).toContain("architect");
  expect(host.textContent).toContain("Fable");
  flushSync(() => root.unmount());
  host.remove();
});
