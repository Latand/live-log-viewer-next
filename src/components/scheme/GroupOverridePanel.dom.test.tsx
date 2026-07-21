import { afterAll, afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";

import { GroupsLayer } from "./nodes";
import { GroupOverridePanel } from "./GroupOverridePanel";
import type { SchemeGroup } from "./layout";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  HTMLInputElement: dom.HTMLInputElement,
  HTMLSelectElement: dom.HTMLSelectElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
});

/* Capture every PATCH so the note/action a click submits can be asserted. */
const calls: Array<{ url: string; body: unknown }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: { body?: string }) => {
  calls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
  return { ok: true, json: async () => ({}) };
}) as unknown as typeof fetch;

afterEach(() => {
  document.body.replaceChildren();
  calls.length = 0;
});
/* Restore fetch as soon as THIS file finishes: a process-exit restore left the
   answer-everything mock live for every later test file in the run, poisoning
   any component that fetches real JSON shapes (SpeakButton's backend info). */
afterAll(() => { globalThis.fetch = realFetch; });

function mount(node: React.ReactElement): { host: HTMLElement; root: Root } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(node));
  return { host, root };
}

const flowGroup: SchemeGroup = {
  key: "group::flow::f1", kind: "flow", id: "f1", hue: 210, members: ["/impl"],
  label: "Flow one", x: 100, y: 80, w: 900, h: 780,
  flow: {
    id: "f1",
    roles: { implementer: { engine: "codex", model: null, effort: null }, reviewer: { engine: "codex", model: null, effort: null } },
    roundLimit: 5,
    state: "waiting_ready",
    rounds: [],
  } as unknown as Flow,
};

test("the override panel opens in a foreground layer, not nested in a halo stacking context (issue #118 review F1)", () => {
  const { host, root } = mount(<GroupsLayer groups={[flowGroup]} interactive />);
  const chip = host.querySelector("[data-scheme-group] button") as HTMLButtonElement;
  expect(chip).toBeTruthy();
  flushSync(() => chip.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));

  const panel = host.querySelector("[data-group-override]") as HTMLElement;
  expect(panel).toBeTruthy();
  /* The panel must NOT live inside a [data-scheme-group] halo wrapper — that
     wrapper's positioning context would paint it beneath the scheme cards. */
  expect(panel.closest("[data-scheme-group]")).toBeNull();
  /* It sits in a high-z foreground container so it paints above the cards. */
  const foreground = panel.closest(".z-\\[45\\]") ?? panel.parentElement;
  expect(foreground?.className ?? "").toContain("z-[45]");

  flushSync(() => root.unmount());
  host.remove();
});

test("starting the next round from the panel submits the note via advance, not only retry (issue #118 review F2)", async () => {
  /* A waiting_ready flow: the pending action is `advance` (creates the next
     round), which is exactly the path the note must reach. The field is seeded
     from the last round's ready note, and the textarea is bound to the same
     state that the button sends. */
  const seeded: SchemeGroup = {
    ...flowGroup,
    flow: { ...flowGroup.flow!, state: "waiting_ready", rounds: [{ n: 1, readyNote: "check the retry path" }] } as unknown as Flow,
  };
  const { host, root } = mount(<GroupOverridePanel group={seeded} onClose={() => undefined} />);
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  expect(textarea.value).toBe("check the retry path");

  /* Click the pending action (waiting_ready → "Start review" → advance). */
  const start = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("Start review")) as HTMLButtonElement;
  expect(start).toBeTruthy();
  flushSync(() => start.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  await Promise.resolve();

  const patch = calls.find((call) => call.url.includes("/api/flows/f1"));
  expect(patch?.body).toMatchObject({ action: "advance", note: "check the retry path" });

  flushSync(() => root.unmount());
  host.remove();
});

test("an empty note field is still sent so a cleared note reaches the backend (issue #118 review Finding 2)", async () => {
  /* The round has no note; the editor is empty. The advance must carry note:""
     (field present) rather than omitting it, so the backend reads an explicit
     clear instead of preserving a stale note. */
  const empty: SchemeGroup = {
    ...flowGroup,
    flow: { ...flowGroup.flow!, state: "waiting_ready", rounds: [{ n: 1, readyNote: null }] } as unknown as Flow,
  };
  const { host, root } = mount(<GroupOverridePanel group={empty} onClose={() => undefined} />);
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  expect(textarea.value).toBe("");
  const start = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("Start review")) as HTMLButtonElement;
  flushSync(() => start.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  await Promise.resolve();

  const patch = calls.find((call) => call.url.includes("/api/flows/f1"));
  expect(patch?.body).toEqual({ action: "advance", note: "" });

  flushSync(() => root.unmount());
  host.remove();
});

test("the note re-seeds when the current round changes across a poll, discarding a stale edit (issue #118 review)", () => {
  /* Round 1 parked; operator types a note but does not submit. */
  const round1: SchemeGroup = {
    ...flowGroup,
    flow: { ...flowGroup.flow!, state: "needs_decision", rounds: [{ n: 1, readyNote: "round-1 note" }] } as unknown as Flow,
  };
  const { host, root } = mount(<GroupOverridePanel group={round1} onClose={() => undefined} />);
  const textarea = () => host.querySelector("textarea") as HTMLTextAreaElement;
  expect(textarea().value).toBe("round-1 note");
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(textarea(), "operator edit for round 1");
    textarea().dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
  });
  expect(textarea().value).toBe("operator edit for round 1");

  /* A poll advances the flow to round 2 (also parked). The stale round-1 edit
     must NOT survive into round 2 — the field re-seeds from round 2. */
  const round2: SchemeGroup = {
    ...flowGroup,
    flow: { ...flowGroup.flow!, state: "needs_decision", rounds: [{ n: 1, readyNote: "round-1 note" }, { n: 2, readyNote: "round-2 note" }] } as unknown as Flow,
  };
  flushSync(() => root.render(<GroupOverridePanel group={round2} onClose={() => undefined} />));
  expect(textarea().value).toBe("round-2 note");

  flushSync(() => root.unmount());
  host.remove();
});

test("the next-round note editor is disabled where no action can save it (issue #118 review)", () => {
  /* auto-mode fixing: the next round is created by the engine's marker, which
     never reads this field — the editor must be disabled, not silently discard. */
  const fixing: SchemeGroup = { ...flowGroup, flow: { ...flowGroup.flow!, state: "fixing", rounds: [{ n: 1, readyNote: null }] } as unknown as Flow };
  const a = mount(<GroupOverridePanel group={fixing} onClose={() => undefined} />);
  expect((a.host.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(true);
  flushSync(() => a.root.unmount());
  a.host.remove();

  /* waiting_ready: Start review will persist the note, so the editor is live. */
  const ready: SchemeGroup = { ...flowGroup, flow: { ...flowGroup.flow!, state: "waiting_ready", rounds: [] } as unknown as Flow };
  const b = mount(<GroupOverridePanel group={ready} onClose={() => undefined} />);
  expect((b.host.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(false);
  flushSync(() => b.root.unmount());
  b.host.remove();
});

const pipelineGroup: SchemeGroup = {
  key: "group::pipeline::p1", kind: "pipeline", id: "p1", hue: 24, members: ["/plan"],
  label: "Pipe one", x: 0, y: 0, w: 10, h: 10,
  pipeline: {
    id: "p1",
    task: "Ship it",
    state: "running",
    stages: [
      { id: "plan", kind: "run", role: { roleId: "architect" }, prompt: "Plan", next: "build", effectiveRole: { engine: "claude", model: "fable", effort: "high", access: "read-only", roleId: "architect", promptScaffold: null } },
      { id: "build", kind: "run", role: { roleId: "architect" }, prompt: "Build it", next: null, effectiveRole: { engine: "claude", model: "fable", effort: "high", access: "read-write", roleId: "architect", promptScaffold: null } },
    ],
    runs: [
      { stageId: "plan", attempts: [{ agentPath: "/plan", state: "running" }] },
      { stageId: "build", attempts: [] },
    ],
  } as unknown as Pipeline,
};

function draftFixture(): SchemeGroup {
  return {
    ...pipelineGroup,
    pipeline: {
      ...pipelineGroup.pipeline!,
      state: "draft",
      repoDir: "/repo",
      cursor: { stageId: "plan", state: "pending", input: null, activatedBy: null },
      runs: pipelineGroup.pipeline!.stages.map((stage) => ({ stageId: stage.id, attempts: [] })),
    } as Pipeline,
  };
}

function emptyDraftFixture(): SchemeGroup {
  return {
    ...pipelineGroup,
    pipeline: {
      ...pipelineGroup.pipeline!,
      state: "draft",
      repoDir: "/repo",
      stages: [],
      runs: [],
      cursor: null,
    } as unknown as Pipeline,
  };
}

/* Stage editing moved entirely onto the canvas conversation/placeholder cards
   (#507 review F1): the override panel is now pipeline-scoped only. These tests
   pin that contract — no nested stage form, no nested scroller — and that the
   pipeline-level actions the panel alone owns still fire. Per-stage editing is
   covered on its new home in StagePlaceholderPane.dom.test.tsx. */

test("the override panel keeps only pipeline-level controls and points stage edits to the canvas (#507 F1)", () => {
  const { host, root } = mount(<GroupOverridePanel group={draftFixture()} onClose={() => undefined} />);
  /* No per-stage editor: no draggable stage cards, no nested scroller, and no
     stage role/engine/effort <select> (the draft form uses inputs + textarea only). */
  expect(host.querySelectorAll("[data-stage-card]").length).toBe(0);
  expect(host.querySelectorAll("select").length).toBe(0);
  /* No nested stage scroller — the removed DraftStageCards used a max-h-[46vh]
     overflow-y-auto list; only the panel's own outer scroll remains. */
  expect(host.querySelector(".max-h-\\[46vh\\]")).toBeNull();
  /* The operator is pointed at the canvas cards instead. */
  const hint = host.querySelector("[data-pipeline-editor-canvas-hint]");
  expect(hint?.textContent ?? "").toContain("Edit stages on their cards");
  /* Pipeline-level controls remain: draft details, Start, Discard. */
  expect(host.querySelector('input')).toBeTruthy();
  expect(Array.from(host.querySelectorAll("button")).some((b) => b.textContent?.includes("Start pipeline"))).toBe(true);
  expect(Array.from(host.querySelectorAll("button")).some((b) => b.textContent?.includes("Discard"))).toBe(true);
  flushSync(() => root.unmount());
  host.remove();
});

test("a draft's Start action posts start (#507 F1)", async () => {
  const { host, root } = mount(<GroupOverridePanel group={draftFixture()} onClose={() => undefined} />);
  const start = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("Start pipeline")) as HTMLButtonElement;
  expect(start.disabled).toBe(false);
  flushSync(() => start.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  await Promise.resolve();
  expect(calls.at(-1)?.body).toEqual({ action: "start" });
  flushSync(() => root.unmount());
  host.remove();
});

test("an empty draft has no stages, no canvas hint, and disables Start (#507 F1)", () => {
  const { host, root } = mount(<GroupOverridePanel group={emptyDraftFixture()} onClose={() => undefined} />);
  expect(host.querySelectorAll("[data-stage-card]").length).toBe(0);
  /* No editable stage yet → no pointer to the canvas, and Start is blocked until
     the first stage is added on the canvas. */
  expect(host.querySelector("[data-pipeline-editor-canvas-hint]")).toBeNull();
  const start = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("Start pipeline")) as HTMLButtonElement;
  expect(start.disabled).toBe(true);
  flushSync(() => root.unmount());
  host.remove();
});

test("Discard posts delete on the draft (#507 F1)", async () => {
  const { host, root } = mount(<GroupOverridePanel group={draftFixture()} onClose={() => undefined} />);
  const discard = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("Discard")) as HTMLButtonElement;
  expect(discard).toBeTruthy();
  flushSync(() => discard.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  await Promise.resolve();
  expect(calls.at(-1)?.body).toEqual({ action: "delete" });
  flushSync(() => root.unmount());
  host.remove();
});

test("a running pipeline shows the canvas hint for its unrun stages and posts pause (#507 F1)", async () => {
  const { host, root } = mount(<GroupOverridePanel group={pipelineGroup} onClose={() => undefined} />);
  /* The build stage has never run, so an on-canvas edit is still possible — the
     panel points there rather than mounting a nested next-stage form. */
  expect(host.querySelector("[data-pipeline-editor-canvas-hint]")).toBeTruthy();
  expect(host.querySelectorAll("select").length).toBe(0);
  const pause = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("Pause")) as HTMLButtonElement;
  flushSync(() => pause.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  await Promise.resolve();
  expect(calls.at(-1)?.body).toEqual({ action: "pause" });
  flushSync(() => root.unmount());
  host.remove();
});

test("a parked pipeline offers retry and skip", async () => {
  const parked: SchemeGroup = {
    ...pipelineGroup,
    pipeline: { ...pipelineGroup.pipeline!, state: "needs_decision" } as Pipeline,
  };
  const { host, root } = mount(<GroupOverridePanel group={parked} onClose={() => undefined} />);
  const retry = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("Retry")) as HTMLButtonElement;
  const skip = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("Skip")) as HTMLButtonElement;
  expect(retry).toBeTruthy();
  expect(skip).toBeTruthy();
  flushSync(() => retry.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  await Promise.resolve();
  expect((calls.at(-1)?.body as { action?: string })?.action).toBe("retry-stage");
  flushSync(() => root.unmount());
  host.remove();
});
