import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";
import { emptyStore } from "@/components/runtime/runtimeModel";

import type { SchemeLayout, SchemeNode, StageSlot } from "./layout";
import { SLOT_H, SLOT_ROW_H } from "./layout";

/*
 * Settled pipeline stages on the board collapse to one status row (#658). A
 * skipped or completed stage used to render its whole conversation card —
 * stage-prompt block included — at its stage position, so a chain that had
 * already walked past two stages read as if all that work were still ahead.
 */

const dom = new HappyWindow();

class InertResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function bindDomGlobals() {
  Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    Node: dom.Node,
    HTMLElement: dom.HTMLElement,
    HTMLButtonElement: dom.HTMLButtonElement,
    HTMLInputElement: dom.HTMLInputElement,
    HTMLSelectElement: dom.HTMLSelectElement,
    HTMLTextAreaElement: dom.HTMLTextAreaElement,
    Event: dom.Event,
    CustomEvent: dom.CustomEvent,
    MouseEvent: dom.MouseEvent,
    KeyboardEvent: dom.KeyboardEvent,
    sessionStorage: dom.sessionStorage,
    localStorage: dom.localStorage,
    ResizeObserver: InertResizeObserver,
    IntersectionObserver: undefined,
  });
}

bindDomGlobals();

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

const actualLogTail = await import("@/hooks/useLogTail");
mock.module("@/hooks/useLogTail", () => ({
  useLogTail: () => ({
    lines: [], linesStart: 0, size: 0, loading: false, error: null, tickTime: null, paused: false,
    setPaused: () => undefined, clear: () => undefined, hasMore: false, loadingOlder: false,
    loadOlder: async () => 0, prependGen: 0,
  }),
}));

const { NodesLayer } = await import("./nodes");

const roots = new Set<Root>();

beforeEach(bindDomGlobals);

afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
  mock.module("@/hooks/useLogTail", () => actualLogTail);
});

afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
});

/* A stage prompt shaped like the real ones: a shared preamble first (the string
   that used to become every pane's title), the actual instruction after. */
const stagePrompt = ["Work alone and launch no helpers, workflows, teams or subagents.", "", "Integrate the voice relay."].join("\n");

function stage(id: string, roleId?: string): PipelineStage {
  return {
    id,
    kind: "run",
    ...(roleId ? { role: { roleId } } : {}),
    next: null, prompt: stagePrompt,
    effectiveRole: { roleId: roleId ?? null, engine: "codex", model: null, effort: null, access: "read-write", promptScaffold: null },
  } as unknown as PipelineStage;
}

const stages = [stage("plan_v3_voice", "architect"), stage("integrate_v3_voice", "builder"), stage("verify_v3_voice", "verifier")];

function pipeline(over: Partial<Pipeline> = {}): Pipeline {
  return {
    id: "p658", task: "V3 voice", project: "project", repoDir: "/r", worktreeDir: "/w", branch: "b",
    baseBranch: "main", baseRef: "a", lastPassedCommit: "a", stages, runs: [],
    cursor: { stageId: "integrate_v3_voice", state: "running", input: null, activatedBy: null },
    state: "running", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null,
    createdAt: "1970", closedAt: null, ...over,
  } as unknown as Pipeline;
}

function slot(over: Partial<StageSlot> & { stage: PipelineStage; index: number }): StageSlot {
  return {
    key: `slot::p658::${over.stage.id}`,
    pipeline: pipeline(over.pipeline ? { ...over.pipeline } : {}),
    total: stages.length,
    presentation: "placeholder",
    x: 0,
    y: 0,
    w: 600,
    h: SLOT_H,
    ...over,
  } as StageSlot;
}

function layout(slots: StageSlot[]): SchemeLayout {
  return {
    nodes: [], edges: [], stacks: [], decks: [], loops: [], groups: [], links: [], drafts: [],
    slots, regionTasks: [], byPath: new Map(), width: 2000, height: 1000,
  };
}

/* Escaping a slot key (it carries `::`) for a CSS id selector. */
const CSS_ESCAPE = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);

function mountLayer(next: SchemeLayout, pipelines: Pipeline[] = [], options: { lite?: boolean } = {}): { host: HTMLElement; root: Root } {
  const element = dom.document.createElement("div");
  dom.document.body.append(element);
  const host = element as unknown as HTMLElement;
  const root = createRoot(host);
  roots.add(root);
  flushSync(() => {
    root.render(
      <NodesLayer
        layout={next}
        project="project"
        files={next.nodes.map((item) => item.file)}
        pipelines={pipelines}
        interactive
        lite={options.lite ?? false}
        dormant
        selected={null}
        multi={new Set()}
        session={false}
        focus={null}
        attentionPaths={null}
        flowsByImpl={new Map()}
        flows={[]}
        pipelineStrips={new Map()}
        linkedTasksByPipeline={new Map()}
        deckFocus={null}
        onSelect={() => undefined}
        onClose={() => undefined}
        onFocusRound={() => undefined}
        onDraftClose={() => undefined}
        onDraftSpawned={() => undefined}
        onExpand={() => undefined}
      />,
    );
  });
  return { host, root };
}

const skippedPipeline = pipeline({
  runs: [{ stageId: "plan_v3_voice", attempts: [{ n: 1, state: "skipped", output: "Skipped by operator." } as never] }],
});

test("a skipped stage collapses to one status row — badge, role-first title, why — with no stage-prompt block", () => {
  const { host } = mountLayer(layout([
    slot({ stage: stages[0]!, index: 0, pipeline: skippedPipeline, collapsedRow: true, h: SLOT_ROW_H }),
  ]));
  const row = host.querySelector('[data-pipeline-stage-row="true"]') as HTMLElement;
  expect(row).toBeTruthy();
  expect(row.getAttribute("data-pipeline-stage-state")).toBe("skipped");
  /* The title is the stage's identity, not the prompt's shared preamble. */
  expect(row.textContent).toContain("Architect · plan_v3_voice · stage 1/3");
  expect(row.textContent).toContain("skipped");
  /* The why-line comes from the catalogue, not from the engine's English marker. */
  expect(row.textContent).toContain("Skipped by the operator — the chain moved on");
  expect(row.textContent).not.toContain("Work alone");
  /* Collapsed means collapsed: no prompt block, and the reserved row height. */
  expect(host.textContent).not.toContain("Stage prompt");
  expect((host.querySelector('[data-scheme-node="slot::p658::plan_v3_voice"]') as HTMLElement).style.height).toBe(`${SLOT_ROW_H}px`);
});

test("the collapsed row discloses the full stage card on demand", () => {
  const { host } = mountLayer(layout([
    slot({ stage: stages[0]!, index: 0, pipeline: skippedPipeline, collapsedRow: true, h: SLOT_ROW_H }),
  ]));
  const toggle = host.querySelector("button[data-stage-row-toggle]") as HTMLButtonElement;
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  flushSync(() => toggle.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  expect((host.querySelector("button[data-stage-row-toggle]") as HTMLButtonElement).getAttribute("aria-expanded")).toBe("true");
  /* The full card — prompt included — floats over the board, so the row's own
     reserved geometry stays one row. */
  expect(host.textContent).toContain("Stage prompt");
  expect(host.textContent).toContain("Integrate the voice relay.");
  /* One surface per declared stage: the identity moves to the disclosed card
     instead of being claimed twice. */
  expect(host.querySelectorAll('[data-pipeline-stage-card="p658::plan_v3_voice"]')).toHaveLength(1);
});

test("the disclosure is a real overlay: the toggle names the card it opens, and Escape closes it", () => {
  /* The disclosed card floats over whatever the board placed below it, so it owes
     the operator the same way out an overlay does — and the toggle owes assistive
     tech a pointer to what it controls. */
  const { host } = mountLayer(layout([
    slot({ stage: stages[0]!, index: 0, pipeline: skippedPipeline, collapsedRow: true, h: SLOT_ROW_H }),
  ]));
  const toggle = host.querySelector("button[data-stage-row-toggle]") as HTMLButtonElement;
  const controls = toggle.getAttribute("aria-controls")!;
  expect(controls).toBeTruthy();
  flushSync(() => toggle.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  /* aria-controls resolves to the card that just appeared. */
  const card = host.querySelector(`#${CSS_ESCAPE(controls)}`) as HTMLElement;
  expect(card).toBeTruthy();
  expect(card.hasAttribute("data-stage-row-card")).toBe(true);
  expect(card.textContent).toContain("Stage prompt");

  flushSync(() => dom.document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(host.querySelector("[data-stage-row-card]")).toBeNull();
  expect((host.querySelector("button[data-stage-row-toggle]") as HTMLButtonElement).getAttribute("aria-expanded")).toBe("false");
});

test("at map zoom the row is a label, not a control — no disclosure to open", () => {
  const { host } = mountLayer(layout([
    slot({ stage: stages[0]!, index: 0, pipeline: skippedPipeline, collapsedRow: true, h: SLOT_ROW_H }),
  ]), [], { lite: true });
  expect(host.querySelector('[data-pipeline-stage-row="true"]')).toBeTruthy();
  expect(host.querySelector("button[data-stage-row-toggle]")).toBeNull();
});

test("a pending stage ahead of the cursor keeps its full card", () => {
  const { host } = mountLayer(layout([slot({ stage: stages[2]!, index: 2 })]));
  expect(host.querySelector('[data-pipeline-stage-row="true"]')).toBeNull();
  expect(host.textContent).toContain("Stage prompt");
  expect(host.textContent).toContain("Verifier · verify_v3_voice · stage 3/3");
});

function conversation(path: string, title: string): FileEntry {
  return {
    path, root: "codex-sessions", name: path, project: "project", title, engine: "codex", kind: "session",
    fmt: "codex", parent: null, mtime: 1, size: 1, activity: "live", proc: "running", pid: 1, model: null,
    pendingQuestion: null, waitingInput: null,
  } as FileEntry;
}

function node(file: FileEntry): SchemeNode {
  return { file, tasks: [], under: [], isRoot: true, x: 0, y: 0, w: 600, h: 780 };
}

test("a live stage pane is titled role · stage · position, never the prompt's shared preamble", () => {
  /* The scanner titled this transcript by its opening prompt — the preamble every
     stage prompt starts with, which named every stage pane on the board the
     same. The pane leads with the stage identity and keeps the transcript title
     in its tooltip. */
  const live = conversation("/integrate", "Work alone and launch no helpers, workflows, teams or subagents.");
  const running = pipeline({
    runs: [{ stageId: "integrate_v3_voice", attempts: [{ n: 1, state: "running", agentPath: "/integrate", flowId: null } as never] }],
  });
  const { host } = mountLayer({ ...layout([]), nodes: [node(live)] }, [running]);
  const pane = host.querySelector("[data-pane-title-override]") as HTMLElement;
  expect(pane).toBeTruthy();
  expect(pane.textContent).toBe("Builder · integrate_v3_voice · stage 2/3");
  expect(pane.getAttribute("title")).toContain("Work alone and launch no helpers");
});
