import { afterEach, expect, test } from "bun:test";
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
process.on("exit", () => { globalThis.fetch = realFetch; });

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

test("an unchanged stage override submits no stale runtime or role (issue #118 review F4)", async () => {
  const { host, root } = mount(<GroupOverridePanel group={pipelineGroup} onClose={() => undefined} />);
  /* The role select (the one offering "No role") seeds from the stage's role. */
  const roleSelect = Array.from(host.querySelectorAll("select")).find((select) =>
    Array.from(select.options).some((option) => option.value === "architect"),
  ) as HTMLSelectElement;
  expect(roleSelect?.value).toBe("architect");

  const apply = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("Update stage")) as HTMLButtonElement;
  expect(apply).toBeTruthy();
  flushSync(() => apply.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  await Promise.resolve();

  /* Nothing was edited, so only stageId + prompt travel — never the current
     engine/model/effort/role as spurious pins that would defeat role-reset. */
  const patch = calls.find((call) => call.url.includes("/api/pipelines/p1"));
  expect(patch?.body).toEqual({ action: "override-stage", stageId: "build", prompt: "Build it" });

  flushSync(() => root.unmount());
  host.remove();
});

function effortOptions(host: HTMLElement): string[] {
  /* The effort select is the one whose options are exactly the tier list. */
  const select = Array.from(host.querySelectorAll("select")).find((s) =>
    Array.from(s.options).some((o) => o.value === "xhigh"),
  ) as HTMLSelectElement;
  return Array.from(select.options).map((o) => o.value);
}

function selectByOption(host: HTMLElement, optionValue: string): HTMLSelectElement {
  return Array.from(host.querySelectorAll("select")).find((s) =>
    Array.from(s.options).some((o) => o.value === optionValue),
  ) as HTMLSelectElement;
}

function setSelect(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLSelectElement.prototype, "value")!.set!;
  flushSync(() => {
    setter.call(select, value);
    select.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event);
  });
}

function stagePipeline(effectiveRole: Record<string, unknown>): Pipeline {
  return {
    ...(pipelineGroup.pipeline as Pipeline),
    stages: [
      (pipelineGroup.pipeline as Pipeline).stages[0]!,
      { ...(pipelineGroup.pipeline as Pipeline).stages[1]!, role: undefined, effectiveRole },
    ],
  } as unknown as Pipeline;
}

test("switching the engine clears the previous engine's model (issue #118 review F2, codex→claude)", () => {
  const group = { ...pipelineGroup, pipeline: stagePipeline({ engine: "codex", model: "gpt-5.6", effort: "high", access: "read-write", roleId: null, promptScaffold: null }) };
  const { host, root } = mount(<GroupOverridePanel group={group} onClose={() => undefined} />);
  const modelInput = host.querySelector('input[placeholder]') as HTMLInputElement;
  expect(modelInput.value).toBe("gpt-5.6");
  setSelect(selectByOption(host, "codex"), "claude"); // the engine select offers codex
  expect(modelInput.value).toBe(""); // the gpt model no longer rides along
  flushSync(() => root.unmount());
  host.remove();
});

test("switching the engine resets an incompatible effort (issue #118 review F2, claude→codex)", () => {
  const group = { ...pipelineGroup, pipeline: stagePipeline({ engine: "claude", model: "opus", effort: "max", access: "read-write", roleId: null, promptScaffold: null }) };
  const { host, root } = mount(<GroupOverridePanel group={group} onClose={() => undefined} />);
  const effort = selectByOption(host, "xhigh");
  expect(effort.value).toBe("max");
  setSelect(selectByOption(host, "codex"), "codex"); // switch engine to codex
  expect(effort.value).toBe(""); // codex has no max tier — cleared to default
  flushSync(() => root.unmount());
  host.remove();
});

test("the stage form re-seeds when an override resolves new effective runtime (issue #118 review F5)", () => {
  const before = { ...pipelineGroup, pipeline: stagePipeline({ engine: "codex", model: "gpt-5.6", effort: "high", access: "read-write", roleId: null, promptScaffold: null }) };
  const { host, root } = mount(<GroupOverridePanel group={before} onClose={() => undefined} />);
  const modelInput = () => host.querySelector('input[placeholder]') as HTMLInputElement;
  expect(modelInput().value).toBe("gpt-5.6");

  /* The poll refetches after the override; the same stage id now carries the
     role's resolved runtime. The form must remount and show the new value, not
     the stale gpt-5.6 that a later prompt edit would otherwise re-submit. */
  const after = { ...pipelineGroup, pipeline: stagePipeline({ engine: "claude", model: "fable", effort: "high", access: "read-write", roleId: "architect", promptScaffold: null }) };
  flushSync(() => root.render(<GroupOverridePanel group={after} onClose={() => undefined} />));
  expect(modelInput().value).toBe("fable");

  flushSync(() => root.unmount());
  host.remove();
});

test("the effort control offers only tiers the selected engine accepts (issue #118 review)", () => {
  /* A codex stage must NOT offer max (resolvePipelineRole would 400 codex+max). */
  const codexStage = {
    ...(pipelineGroup.pipeline as Pipeline),
    stages: [
      (pipelineGroup.pipeline as Pipeline).stages[0]!,
      { ...(pipelineGroup.pipeline as Pipeline).stages[1]!, effectiveRole: { engine: "codex", model: "gpt-5.6", effort: "high", access: "read-write", roleId: "builder", promptScaffold: null } },
    ],
  } as unknown as Pipeline;
  const codex = mount(<GroupOverridePanel group={{ ...pipelineGroup, pipeline: codexStage }} onClose={() => undefined} />);
  expect(effortOptions(codex.host)).toEqual(["", "low", "medium", "high", "xhigh"]);
  flushSync(() => codex.root.unmount());
  codex.host.remove();

  /* The claude build stage in the base fixture does offer max. */
  const claude = mount(<GroupOverridePanel group={pipelineGroup} onClose={() => undefined} />);
  expect(effortOptions(claude.host)).toContain("max");
  flushSync(() => claude.root.unmount());
  claude.host.remove();
});
