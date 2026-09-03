import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { emptyStore, type ConnectionState } from "@/components/runtime/runtimeModel";
import { translate } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

/*
 * One pipeline on the phone (mobile v2 lane 7, #1439; README §4.7). What this
 * guards is the shape behind the frames the capture harness measures:
 *
 *   - the BAR carries the task title and its meta line, so the body holds no
 *     header block and no template line;
 *   - the findings of the round that parked the chain lead, under a heading in
 *     the product's own words (the stage's role name, its round, the count);
 *   - every stage that ran has a conversation and the row opens it, and the
 *     current stage is the one with the accent edge;
 *   - the linked tasks come last.
 */

const actualRuntimeHooks = await import("@/hooks/useRuntime");
const runtime = {
  enabled: false,
  connection: "live" as ConnectionState,
  lastEventAt: null as number | null,
  resyncedAt: null,
  store: emptyStore(),
  structuredHostsEnabled: false,
};
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeBusState: () => runtime,
  useRuntime: () => runtime,
  useRuntimeSelector: (selector: (state: typeof runtime) => unknown) => selector(runtime),
  useRuntimeSession: () => null,
  useRuntimeReceiptsForArtifact: () => [],
  useRuntimeFlow: () => null,
}));

const { MobilePipelineScreen, mobilePipelineActions, stageMetaLine, stageRowTitle } = await import("./MobilePipelineScreen");
const { createMobileNav, MobileNavContext } = await import("./mobileNav");
const { receipts } = await import("./MobileReceipt");
const { getLocale, translate: t } = await import("@/lib/i18n");

const dom = new Window({ url: "http://localhost/", width: 390, height: 844 });
const G = globalThis as Record<string, unknown>;
const OVERRIDES: Record<string, unknown> = {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement,
  Event: dom.Event, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0) as unknown as number,
  cancelAnimationFrame: (id: number) => clearTimeout(id),
};
const HAS: Record<string, boolean> = {};
const SAVED: Record<string, unknown> = {};
beforeAll(() => { for (const key of Object.keys(OVERRIDES)) { HAS[key] = key in G; SAVED[key] = G[key]; G[key] = OVERRIDES[key]; } });
afterAll(async () => {
  await new Promise((r) => setTimeout(r, 0));
  for (const key of Object.keys(OVERRIDES)) { if (HAS[key]) G[key] = SAVED[key]; else delete G[key]; }
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

let roots: Root[] = [];
beforeEach(() => { dom.document.body.replaceChildren(); roots = []; receipts.dismiss(); });
afterEach(() => { for (const root of roots) flushSync(() => root.unmount()); roots = []; receipts.dismiss(); });

function nav() {
  const entries: { state: unknown; url: string }[] = [{ state: null, url: "http://localhost/#p=atlas" }];
  let index = 0;
  return createMobileNav({
    history: {
      get state() { return entries[index]!.state; },
      pushState(state, _unused, url) { entries.splice(index + 1); entries.push({ state, url: url ?? entries[index]!.url }); index += 1; },
      replaceState(state, _unused, url) { entries[index] = { state, url: url ?? entries[index]!.url }; },
      back() { if (index > 0) index -= 1; },
    },
    href: () => entries[index]!.url,
    onPopstate: () => () => {},
  });
}

function mount(node: React.ReactNode): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.appendChild(host);
  const root = createRoot(host as unknown as Element);
  flushSync(() => root.render(<MobileNavContext.Provider value={nav()}>{node}</MobileNavContext.Provider>));
  roots.push(root);
  return host as unknown as HTMLElement;
}

const q = (host: HTMLElement, selector: string) => host.querySelector(selector) as unknown as HTMLElement | null;
const qa = (host: HTMLElement, selector: string) => Array.from(host.querySelectorAll(selector)) as unknown as HTMLElement[];
const click = (el: Element | null) => {
  if (!el) throw new Error("nothing to click");
  flushSync(() => el.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as never));
};

const NOW = 1_800_000_000;
const at = (secondsAgo: number) => new Date((NOW - secondsAgo) * 1_000).toISOString();

const file = (path: string, title: string): FileEntry => ({
  root: "claude-projects", name: path.split("/").pop(), path, project: "atlas", title, engine: "claude", kind: "session",
  fmt: "claude", parent: null, mtime: NOW - 60, size: 2_048, activity: "idle", proc: null, pid: null, model: "opus",
  pendingQuestion: null, waitingInput: null, conversationId: null,
} as unknown as FileEntry);

const IMPLEMENT = file("/repo/implement.jsonl", "Implement fast switching");
const REVIEW = file("/repo/review.jsonl", "Review round 3");

const STAGES = [
  { id: "design", kind: "run", role: { roleId: "architect" }, prompt: "p", next: "implement" },
  { id: "implement", kind: "run", role: { roleId: "builder" }, prompt: "p", next: "review" },
  { id: "review", kind: "review-loop", role: { roleId: "reviewer" }, prompt: "p", next: "fix", onFail: { to: "implement", maxRounds: 3 } },
  { id: "fix", kind: "run", role: { roleId: "builder" }, prompt: "p", next: "merge" },
  { id: "merge", kind: "run", role: { roleId: "builder" }, prompt: "p", next: null },
];

const attempt = (over: Record<string, unknown>) => ({
  n: 1, state: "passed", launchId: null, conversationId: null, sessionId: null, agentPath: null, paneId: null, flowId: null,
  startedAt: at(4_000), completedAt: at(3_600), input: null, activatedBy: null, output: null, verdict: { status: "pass" }, error: null,
  ...over,
});

function parkedPipeline(over: Partial<Pipeline> = {}): Pipeline {
  return {
    id: "p2", task: "Fast conversation switching", taskIds: [], project: "atlas", repoDir: "/repo", worktreeDir: "/repo-w",
    branch: "lane/p2", baseBranch: "main", baseRef: "main", lastPassedCommit: "", stages: STAGES,
    runs: [
      { stageId: "design", attempts: [attempt({})] },
      { stageId: "implement", attempts: [attempt({ agentPath: IMPLEMENT.path })] },
      {
        stageId: "review",
        attempts: [attempt({
          n: 3, state: "failed", agentPath: REVIEW.path,
          verdict: { status: "fail", findings: ["Switching projects remounts the board, so the feed cache is dropped every time.", "The measured switch is 640 ms at 12 trees; the bar is 200 ms."] },
        })],
      },
    ],
    cursor: { stageId: "review", state: "reviewing", input: null, activatedBy: null },
    state: "needs_decision", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null,
    createdAt: at(7_200), closedAt: null,
    ...over,
  } as unknown as Pipeline;
}

test("the bar carries the task title and its meta line — no header block, no template line in the body", () => {
  const host = mount(<MobilePipelineScreen pipeline={parkedPipeline()} files={[IMPLEMENT, REVIEW]} now={NOW} onOpenConversation={() => {}} />);
  expect(q(host, '[data-mobile2-screen="pipeline"]')).not.toBeNull();
  expect(q(host, '[data-mobile2-pipeline="p2"]')).not.toBeNull();
  expect(q(host, "[data-mobile2-back]")).not.toBeNull();

  const title = q(host, "[data-mobile2-title-text]")!;
  expect(title.textContent).toBe("Fast conversation switching");
  const meta = q(host, "[data-mobile2-meta]")!;
  expect(meta.textContent).toContain(translate("en", "mobile2.pipelines.badgeDecision"));
  expect(meta.textContent).toContain(translate("en", "pipelineStrip.stageOf", { k: 3, n: 5 }));
  expect(meta.textContent).toContain(translate("en", "mobile2.pipeline.started", { age: "2h" }));

  /* The body says the rest — it never repeats the title, and there is no
     template/spec line under the bar (README §4.7, critique P3-3). */
  const body = q(host, "[data-mobile2-pipeline-body]")!;
  expect(body.textContent).not.toContain("Fast conversation switching");
  expect(body.textContent).not.toContain("lane/p2");
  expect(body.textContent).not.toContain("/repo-w");
});

test("the findings of the round that parked the chain lead, under a heading in the product's own words", () => {
  const host = mount(<MobilePipelineScreen pipeline={parkedPipeline()} files={[IMPLEMENT, REVIEW]} now={NOW} onOpenConversation={() => {}} />);
  const block = q(host, '[data-testid="mobile-pipeline-findings"]')!;
  expect(block).not.toBeNull();
  expect(q(block, "[data-pipeline-findings-heading]")!.textContent).toBe(translate("en", "mobile2.pipeline.findingsHeading", {
    stage: translate("en", "mobile2.pipeline.stageTitle", { role: translate("en", "roleCopy.reviewer.name"), stage: "review" }),
    round: 3,
    findings: translate("en", "pipelineVerdict.findings", { count: 2 }),
  }));
  const items = qa(block, "li");
  expect(items.length).toBe(2);
  expect(items[0]!.textContent).toContain("the feed cache is dropped");
  /* A numbered list, the prototype's own shape for the block. */
  expect(block.querySelector("ol")).not.toBeNull();
});

test("a pipeline with nothing to decide shows no findings block", () => {
  const running = parkedPipeline({
    state: "running",
    runs: [
      { stageId: "design", attempts: [attempt({})] },
      { stageId: "implement", attempts: [attempt({ agentPath: IMPLEMENT.path })] },
    ],
  } as unknown as Partial<Pipeline>);
  const host = mount(<MobilePipelineScreen pipeline={running} files={[IMPLEMENT]} now={NOW} onOpenConversation={() => {}} />);
  expect(q(host, '[data-testid="mobile-pipeline-findings"]')).toBeNull();
});

test("every reviewed stage opens its own conversation; a stage with none is a statement, and the current one carries the edge", () => {
  const opened: string[] = [];
  const host = mount(<MobilePipelineScreen pipeline={parkedPipeline()} files={[IMPLEMENT, REVIEW]} now={NOW} onOpenConversation={(entry) => opened.push(entry.path)} />);
  const stages = qa(host, "[data-mobile2-stage]");
  expect(stages.map((el) => el.getAttribute("data-mobile2-stage"))).toEqual(["design", "implement", "review", "fix", "merge"]);
  /* Only the stage the cursor is on carries the accent edge. */
  expect(stages.map((el) => el.getAttribute("data-mobile2-stage-current"))).toEqual([null, null, "true", null, null]);
  /* The two stages whose transcripts are in the scan are doors; the design
     stage ran without one, and the two pending stages have not run at all. */
  expect(stages.map((el) => el.getAttribute("data-mobile2-go"))).toEqual([null, "chat", "chat", null, null]);
  expect(stages.map((el) => el.tagName)).toEqual(["DIV", "BUTTON", "BUTTON", "DIV", "DIV"]);

  click(stages[2]!);
  expect(opened).toEqual([REVIEW.path]);
  click(stages[1]!);
  expect(opened).toEqual([REVIEW.path, IMPLEMENT.path]);

  /* Each row names its stage in the product's words and says where its round
     stands. */
  /* Three of the five stages are Builder stages: the role alone names none of
     them, so the row carries the product's own identity for the stage. */
  expect(stages.map((el) => el.textContent!.split("\n")[0])).not.toEqual(expect.arrayContaining([translate("en", "roleCopy.builder.name")]));
  expect(stages[2]!.textContent).toContain(translate("en", "mobile2.pipeline.stageTitle", { role: translate("en", "roleCopy.reviewer.name"), stage: "review" }));
  expect(stages[3]!.textContent).toContain(translate("en", "mobile2.pipeline.stageTitle", { role: translate("en", "roleCopy.builder.name"), stage: "fix" }));
  expect(stages[4]!.textContent).toContain(translate("en", "mobile2.pipeline.stageTitle", { role: translate("en", "roleCopy.builder.name"), stage: "merge" }));
  expect(stages[2]!.textContent).toContain(translate("en", "mobile2.pipeline.reviewRound", { round: 3 }));
  expect(stages[2]!.textContent).toContain(translate("en", "pipelineChipState.failed"));
  expect(stages[2]!.textContent).toContain(translate("en", "pipelineVerdict.findings", { count: 2 }));
});

test("a stage the product already names once says it once", () => {
  const locale = getLocale();
  const tt = ((key: string, params?: Record<string, unknown>) => t(locale, key as never, params as never)) as never;
  /* No role: `stageChipLabel` falls back to the stage id, which is then the
     whole identity — the row does not repeat it. */
  expect(stageRowTitle(tt, { id: "merge", kind: "run" } as never)).toBe("merge");
  expect(stageRowTitle(tt, { id: "fix", kind: "run", role: { roleId: "builder" } } as never))
    .toBe(translate("en", "mobile2.pipeline.stageTitle", { role: translate("en", "roleCopy.builder.name"), stage: "fix" }));
});

test("the stage meta line reads the kind, the round and the verdict count from the pipeline itself", () => {
  const pipeline = parkedPipeline();
  const locale = getLocale();
  const tt = ((key: string, params?: Record<string, unknown>) => t(locale, key as never, params as never)) as never;
  expect(stageMetaLine(tt, pipeline, pipeline.stages[1]!)).toBe(
    `${translate("en", "mobile2.pipeline.run")} · ${translate("en", "pipelineChipState.passed")}`,
  );
  expect(stageMetaLine(tt, pipeline, pipeline.stages[4]!)).toBe(
    `${translate("en", "mobile2.pipeline.run")} · ${translate("en", "pipelineChipState.pending")}`,
  );
});

test("linked tasks come last and open the task they name", () => {
  const task = { id: "t1", project: "atlas", text: "Approve the phone prototype\nmore", status: "assigned", assignments: [], updatedAt: new Date(NOW * 1_000).toISOString() } as unknown as BoardTask;
  const opened: string[] = [];
  const host = mount(
    <MobilePipelineScreen
      pipeline={parkedPipeline({ taskIds: ["t1"] } as unknown as Partial<Pipeline>)}
      files={[IMPLEMENT, REVIEW]}
      tasks={[task]}
      now={NOW}
      onOpenConversation={() => {}}
      onOpenTask={(picked) => opened.push(picked.id)}
    />,
  );
  const sections = qa(host, "[data-mobile2-section]").map((el) => el.getAttribute("data-mobile2-section"));
  expect(sections).toEqual(["stages", "tasks"]);
  const row = q(host, '[data-mobile2-linked-task="t1"]')!;
  expect(row.textContent).toContain("Approve the phone prototype");
  click(row);
  expect(opened).toEqual(["t1"]);
});

test("the action set for a state is the desktop's own set for it", () => {
  expect(mobilePipelineActions("needs_decision").map((spec) => spec.action)).toEqual(["skip-stage", "retry-stage"]);
  expect(mobilePipelineActions("running").map((spec) => spec.action)).toEqual(["pause"]);
  expect(mobilePipelineActions("provisioning").map((spec) => spec.action)).toEqual(["pause"]);
  expect(mobilePipelineActions("paused").map((spec) => spec.action)).toEqual(["resume"]);
  expect(mobilePipelineActions("completed").map((spec) => spec.action)).toEqual(["close"]);
  expect(mobilePipelineActions("closed").map((spec) => spec.action)).toEqual(["close"]);
  /* A draft is edited where it is written; the phone's list never lists one. */
  expect(mobilePipelineActions("draft")).toEqual([]);
});
