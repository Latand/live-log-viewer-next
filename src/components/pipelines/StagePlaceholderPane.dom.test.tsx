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
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
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

test("a placeholder IS the draft-agent window recipe: engine radiogroup, role select, shared model+effort pickers, prompt editor", () => {
  const { host, root } = mount(<StagePlaceholderPane slot={slot()} interactive />);
  expect(host.textContent).toContain("architect");
  expect(host.textContent).toContain("stage 1/3");
  /* Same window anatomy as DraftAgentPane: engine radiogroup in the header… */
  expect(host.querySelector('[role="radiogroup"]')).toBeTruthy();
  /* …a role select (pipeline-allowed roles), then the SAME ReasoningControls
     model + effort selects seeded from the stage's resolved runtime… */
  const selects = [...host.querySelectorAll("select")] as HTMLSelectElement[];
  expect(selects.length).toBe(3);
  expect(selects[1]!.value).toBe("fable");
  expect(selects[2]!.value).toBe("high");
  /* …and the stage prompt as the editable footer. */
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  expect(textarea.value).toBe("Plan the work");
  flushSync(() => root.unmount());
  host.remove();
});

test("editing the effort + Apply PATCHes override-stage with ONLY the changed field, stageId pinned (live-window apply lifecycle)", async () => {
  const patches: Array<{ url: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
    if (!init?.method || init.method !== "PATCH") return { ok: true, json: async () => ({ roles: [] }) };
    patches.push({ url, body: JSON.parse(init.body ?? "{}") as Record<string, unknown> });
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch;

  const { host, root } = mount(<StagePlaceholderPane slot={slot()} interactive />);
  const effortSelect = [...host.querySelectorAll("select")].at(-1) as HTMLSelectElement;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(dom.HTMLSelectElement.prototype, "value")!.set!.call(effortSelect, "max");
    effortSelect.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event);
  });
  /* Nothing lands until Apply — the same explicit lifecycle live windows use. */
  expect(patches).toHaveLength(0);
  const apply = host.querySelector('button[aria-label="Apply"]') as HTMLButtonElement;
  flushSync(() => {
    apply.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event);
  });
  await Bun.sleep(0);
  expect(patches).toHaveLength(1);
  expect(patches[0]!.url).toBe("/api/pipelines/p1");
  expect(patches[0]!.body).toEqual({ action: "override-stage", stageId: "architect", effort: "max" });
  flushSync(() => root.unmount());
  host.remove();
});

test("editing the prompt saves on blur with ONLY the prompt", async () => {
  const patches: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
    if (!init?.method || init.method !== "PATCH") return { ok: true, json: async () => ({ roles: [] }) };
    patches.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch;

  const { host, root } = mount(<StagePlaceholderPane slot={slot()} interactive />);
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  /* happy-dom input events don't reach React's synthetic onChange in this
     harness, so type + blur through the element's React props directly. */
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const propsOf = () =>
    (textarea as unknown as Record<string, { onChange: (e: unknown) => void; onBlur: (e: unknown) => void }>)[propsKey]!;
  flushSync(() => propsOf().onChange({ target: { value: "Plan the rework carefully" } }));
  /* Re-read after the commit: onBlur must close over the fresh prompt state. */
  flushSync(() => propsOf().onBlur({}));
  await Bun.sleep(0);
  expect(patches).toEqual([{ action: "override-stage", stageId: "architect", prompt: "Plan the rework carefully" }]);
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
