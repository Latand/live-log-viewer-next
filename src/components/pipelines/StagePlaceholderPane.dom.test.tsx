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
    role: { roleId: "architect" }, prompt: "Plan the work",
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
  return { key: `slot::p1::${theStage.id}`, pipeline, stage: theStage, index: 0, total: 3, presentation: "placeholder", x: 0, y: 0, w: 600, h: 460 };
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

function openConfig(host: HTMLElement): void {
  const button = host.querySelector('button[aria-label="Update stage"]') as HTMLButtonElement;
  flushSync(() => button.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
}

test("a future stage defaults to a conversation preview and discloses the full stage editor in place", () => {
  const { host, root } = mount(<StagePlaceholderPane slot={slot()} interactive />);
  expect(host.textContent).toContain("Architect");
  expect(host.textContent).toContain("stage 1/3");
  expect(host.querySelector('[data-pipeline-stage-card="p1::architect"]')).toBeTruthy();
  expect(host.textContent).toContain("Plan the work");
  expect(host.textContent).toContain("Pinned task:");
  expect(host.textContent).toContain("Ship it");
  expect(host.querySelectorAll("select")).toHaveLength(0);
  expect(host.querySelector("textarea")).toBeNull();

  openConfig(host);
  expect(host.querySelector('[role="radiogroup"]')).toBeTruthy();
  const selects = [...host.querySelectorAll("select")] as HTMLSelectElement[];
  expect(selects.length).toBe(3);
  expect(selects[1]!.value).toBe("fable");
  expect(selects[2]!.value).toBe("high");
  expect(host.textContent).toContain("Automatically receives: the task text");
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  expect(textarea.value).toBe("Plan the work");
  expect(textarea.value).not.toContain("{{");
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
  openConfig(host);
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
  openConfig(host);
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
  /* The edited ADDITIONAL text is reassembled onto the stage's wiring (a
     token-less legacy prompt gains its position default) — issue #221 §5. */
  expect(patches).toEqual([{ action: "override-stage", stageId: "architect", prompt: "{{task}}\n\nPlan the rework carefully" }]);
  flushSync(() => root.unmount());
  host.remove();
});

test("a stage that already ran is frozen: pickers disabled, no PATCH from a change attempt", () => {
  const ran = slot({ pipeline: { state: "running", runs: [{ stageId: "architect", attempts: [{ n: 1, state: "passed" } as never] }] } });
  const { host, root } = mount(<StagePlaceholderPane slot={ran} interactive />);
  openConfig(host);
  const selects = [...host.querySelectorAll("select")] as HTMLSelectElement[];
  for (const select of selects) expect(select.disabled).toBe(true);
  expect(host.textContent).toContain("configuration is locked");
  flushSync(() => root.unmount());
  host.remove();
});

test("placeholder runtime controls stay usable at 390px: the row wraps and every control carries a 44px target (#405)", () => {
  const { host, root } = mount(<StagePlaceholderPane slot={slot()} interactive />);
  openConfig(host);
  /* No pixel browser in CI — acceptance is structural: the classes that carry
     the 390px contract (wrap + max-md 44px inflation, design rule 8) must be
     on the real controls. */
  const controls = host.querySelector('select[aria-label="Running agent model"]')!.parentElement as HTMLElement;
  expect(controls.className).toContain("flex-wrap");
  const selects = [...controls.querySelectorAll("select")] as HTMLSelectElement[];
  expect(selects).toHaveLength(2);
  for (const select of selects) expect(select.className).toContain("max-md:min-h-11");
  const apply = controls.querySelector('button[aria-label="Apply"]') as HTMLButtonElement;
  expect(apply.className).toContain("max-md:min-h-11");
  flushSync(() => root.unmount());
  host.remove();
});

function draftSlot(stages: PipelineStage[], index: number): StageSlot {
  const pipeline = {
    id: "p1", task: "Ship it", project: "demo", repoDir: "/r", worktreeDir: "/w", branch: "b", baseBranch: "main",
    baseRef: "a", lastPassedCommit: "a", stages, runs: [], cursor: null, state: "draft", pausedState: null,
    stateDetail: null, srcPath: null, srcConversationId: null, createdAt: "1970", closedAt: null,
  } as unknown as Pipeline;
  const theStage = stages[index]!;
  return { key: `slot::p1::${theStage.id}`, pipeline, stage: theStage, index, total: stages.length, presentation: "placeholder", x: 0, y: 0, w: 600, h: 460 };
}

test("on-canvas reorder: a middle draft card moves later with an optimistic reorder-stage PATCH (#507)", async () => {
  const patches: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (url: string, init?: { method?: string; body?: string }) => {
    if (!init?.method || init.method !== "PATCH") return { ok: true, json: async () => ({ roles: [] }) };
    patches.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch;

  const stages = [
    stage({ id: "architect", next: "builder" }),
    stage({ id: "builder", role: { roleId: "builder" }, next: "review" }),
    stage({ id: "review", kind: "review-loop", role: { roleId: "reviewer" }, next: null }),
  ];
  const { host, root } = mount(<StagePlaceholderPane slot={draftSlot(stages, 1)} interactive />);
  const later = host.querySelector('button[data-stage-move="later"]') as HTMLButtonElement;
  expect(later.disabled).toBe(false);
  flushSync(() => later.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  await Bun.sleep(0);
  expect(patches).toEqual([{ action: "reorder-stage", stageId: "builder", toIndex: 2 }]);
  flushSync(() => root.unmount());
  host.remove();
});

test("on-canvas reorder: a run cannot swap behind the review-loop it feeds — the guard disables the illegal move (#507)", () => {
  const stages = [
    stage({ id: "architect", next: "review" }),
    stage({ id: "review", kind: "review-loop", role: { roleId: "reviewer" }, next: null }),
  ];
  /* The lone run (index 0): earlier is off the front, and moving it later to
     index 1 would front the review-loop — reviewLoopChainValid forbids it, so
     both controls are disabled. */
  const runCard = mount(<StagePlaceholderPane slot={draftSlot(stages, 0)} interactive />);
  expect((runCard.host.querySelector('button[data-stage-move="earlier"]') as HTMLButtonElement).disabled).toBe(true);
  expect((runCard.host.querySelector('button[data-stage-move="later"]') as HTMLButtonElement).disabled).toBe(true);
  flushSync(() => runCard.root.unmount());
  runCard.host.remove();

  /* The review-loop (index 1): later is off the end, and moving it earlier to
     index 0 would leave no preceding run — also forbidden. */
  const reviewCard = mount(<StagePlaceholderPane slot={draftSlot(stages, 1)} interactive />);
  expect((reviewCard.host.querySelector('button[data-stage-move="earlier"]') as HTMLButtonElement).disabled).toBe(true);
  expect((reviewCard.host.querySelector('button[data-stage-move="later"]') as HTMLButtonElement).disabled).toBe(true);
  flushSync(() => reviewCard.root.unmount());
  reviewCard.host.remove();
});

test("on-canvas reorder controls are absent on a single-stage draft and on a started pipeline", () => {
  const single = mount(<StagePlaceholderPane slot={slot()} interactive />);
  expect(single.host.querySelector('button[data-stage-move]')).toBeNull();
  flushSync(() => single.root.unmount());
  single.host.remove();

  const stages = [stage({ id: "architect", next: "builder" }), stage({ id: "builder", role: { roleId: "builder" }, next: null })];
  const started = draftSlot(stages, 0);
  (started.pipeline as { state: string }).state = "running";
  const run = mount(<StagePlaceholderPane slot={started} interactive />);
  expect(run.host.querySelector('button[data-stage-move]')).toBeNull();
  flushSync(() => run.root.unmount());
  run.host.remove();
});

test("the lite (map) variant renders a static runtime summary instead of pickers", () => {
  const { host, root } = mount(<StagePlaceholderPane slot={slot()} interactive={false} />);
  expect(host.querySelectorAll("select").length).toBe(0);
  expect(host.textContent).toContain("Architect");
  expect(host.textContent).toContain("Fable");
  flushSync(() => root.unmount());
  host.remove();
});
