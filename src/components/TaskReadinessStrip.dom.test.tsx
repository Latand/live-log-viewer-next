import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { setLocale, translate } from "@/lib/i18n";
import type { Flow } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { TaskReadinessStrip } from "./TaskReadinessStrip";

const dom = new Window();
let mobile = false;
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: mobile,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
});

afterEach(() => {
  setLocale("en");
  mobile = false;
  document.body.replaceChildren();
});

function task(id: string, status: BoardTask["status"], text: string, overrides: Partial<BoardTask> = {}): BoardTask {
  return {
    id,
    project: "demo",
    status,
    text,
    placement: "pinned",
    pos: { x: 740, y: 120 },
    assignments: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  } as BoardTask;
}

const liveFile = { path: "/tmp/agent.jsonl", activity: "live", proc: "running" } as unknown as FileEntry;

function reviewingFlow(implementerPath: string): Flow {
  return {
    id: "flow-1",
    template: "implement-review-loop",
    project: "demo",
    cwd: "/repo",
    implementerPath,
    roles: {
      implementer: { engine: "claude", model: null, effort: null },
      reviewer: { engine: "claude", model: null, effort: null },
    },
    baseRef: "r",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
    state: "reviewing",
    stateDetail: null,
    rounds: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    closedAt: null,
  } as Flow;
}

function render(ui: React.ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(ui));
  return { host, root };
}

const noop = () => {};

function expandStrip(host: HTMLElement) {
  const header = host.querySelector('[data-testid="task-readiness"] button') as HTMLButtonElement;
  flushSync(() => header.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  return header;
}

function sectionRow(host: HTMLElement, readiness: string): HTMLButtonElement {
  return host.querySelector(`[data-readiness-section="${readiness}"] > button`) as HTMLButtonElement;
}

test("uk locale renders all five Ukrainian headings, the legend, a truthful total, and zero-count sections", () => {
  setLocale("uk");
  const tasks = [
    task("t-done", "done", "Land the tokens refresh"),
    task("t-planned", "inbox", "Draft the rollout"),
  ];
  const { host, root } = render(
    <TaskReadinessStrip tasks={tasks} files={[]} pipelines={[]} flows={[]} onOpenTask={noop} onOpenFile={noop} />,
  );
  expect(host.textContent).toContain("Готовність задач");
  expect(host.textContent).toContain("· 2");
  expandStrip(host);
  for (const heading of ["Зараз", "На рев'ю", "Заблоковано", "Заплановано", "Готово"]) {
    expect(host.textContent).toContain(heading);
  }
  const legend = host.querySelector('[role="note"]') as HTMLElement;
  expect(legend.textContent).toBe(translate("uk", "readiness.legend"));
  /* Zero-count sections still render as counted rows. */
  expect(sectionRow(host, "now").getAttribute("aria-label")).toBe("Задачі «Зараз» · 0");
  expect(sectionRow(host, "done").getAttribute("aria-label")).toBe("Задачі «Готово» · 1");
  /* Fixed DOM order = spec order. */
  const rows = [...host.querySelectorAll("[data-readiness-section]")].map((row) => row.getAttribute("data-readiness-section"));
  expect(rows).toEqual(["now", "review", "blocked", "planned", "done"]);
  flushSync(() => root.unmount());
});

test("chip actions: placed opens the task, unplaced goes to place-on-map, falling back to open without it", () => {
  const opened: string[] = [];
  const placed: string[] = [];
  const tasks = [
    task("t-placed", "inbox", "Placed card"),
    task("t-unplaced", "inbox", "Unplaced card", { placement: "unplaced", pos: undefined }),
  ];
  const { host, root } = render(
    <TaskReadinessStrip
      tasks={tasks}
      files={[]}
      pipelines={[]}
      flows={[]}
      onOpenTask={(item) => opened.push(item.id)}
      onPlaceOnMap={(item) => placed.push(item.id)}
      onOpenFile={noop}
    />,
  );
  expandStrip(host);
  flushSync(() => sectionRow(host, "planned").dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  const chip = (label: string) =>
    [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label")?.includes(label)) as HTMLButtonElement;
  flushSync(() => chip("Placed card").dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  flushSync(() => chip("Unplaced card").dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  expect(opened).toEqual(["t-placed"]);
  expect(placed).toEqual(["t-unplaced"]);
  expect(chip("Unplaced card").getAttribute("aria-label")).toBe("Place task on the map: Unplaced card");
  flushSync(() => root.unmount());

  /* Without onPlaceOnMap (the phone shell) the unplaced chip opens the task. */
  const fallbackOpened: string[] = [];
  const second = render(
    <TaskReadinessStrip
      tasks={[tasks[1]!]}
      files={[]}
      pipelines={[]}
      flows={[]}
      onOpenTask={(item) => fallbackOpened.push(item.id)}
      onOpenFile={noop}
    />,
  );
  expandStrip(second.host);
  flushSync(() => sectionRow(second.host, "planned").dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  const fallbackChip = [...second.host.querySelectorAll("button")].find((button) =>
    button.getAttribute("aria-label")?.includes("Unplaced card"))!;
  flushSync(() => fallbackChip.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  expect(fallbackOpened).toEqual(["t-unplaced"]);
  flushSync(() => second.root.unmount());
});

test("agent chip opens the transcript only when the assignment is openable; a gone assignment decorates instead", () => {
  const openedPaths: string[] = [];
  const tasks = [
    task("t-live", "assigned", "Live agent card", {
      assignments: [{ path: liveFile.path, panePid: null, state: "delivered", error: null, at: "2026-07-01T00:00:00.000Z" }],
    }),
    task("t-gone", "assigned", "Gone agent card", {
      assignments: [{ path: "/tmp/deleted.jsonl", panePid: null, state: "delivered", error: null, at: "2026-07-01T00:00:00.000Z" }],
    }),
  ];
  const { host, root } = render(
    <TaskReadinessStrip
      tasks={tasks}
      files={[liveFile]}
      pipelines={[]}
      flows={[]}
      onOpenTask={noop}
      onOpenFile={(file) => openedPaths.push(file.path)}
    />,
  );
  expandStrip(host);
  flushSync(() => sectionRow(host, "now").dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  const agentChips = [...host.querySelectorAll("button")].filter((button) =>
    button.getAttribute("aria-label")?.startsWith("Open the assigned agent"));
  expect(agentChips.map((button) => button.getAttribute("aria-label"))).toEqual(["Open the assigned agent: Live agent card"]);
  flushSync(() => agentChips[0]!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  expect(openedPaths).toEqual([liveFile.path]);
  /* The vanished worktree stays in its section with a gone decoration. */
  expect(host.textContent).toContain("Gone agent card");
  expect(host.textContent).toContain(translate("en", "readiness.state.gone"));
  flushSync(() => root.unmount());
});

test("pipeline chip opens the running operational attempt after a passed historical child", () => {
  const openedPaths: string[] = [];
  const operationalFile = { path: "/tmp/pipeline-running.jsonl", activity: "live", proc: "running" } as unknown as FileEntry;
  const historicalFile = { path: "/tmp/pipeline-history.jsonl", activity: "idle", proc: null } as unknown as FileEntry;
  const linked = {
    id: "pipeline-history",
    project: "demo",
    state: "running",
    stages: [{ id: "build", kind: "run", prompt: "", next: null }],
    runs: [{
      stageId: "build",
      attempts: [
        { n: 1, state: "running", agentPath: operationalFile.path, historical: false },
        { n: 2, state: "passed", agentPath: historicalFile.path, historical: true, verdict: { status: "pass" } },
      ],
    }],
    cursor: { stageId: "build", state: "running", input: null, activatedBy: null },
  } as unknown as Pipeline;
  const item = task("t-pipeline-history", "assigned", "Operational pipeline card", {
    assignments: [{ path: operationalFile.path, panePid: null, state: "delivered", error: null, at: "2026-07-01T00:00:00.000Z" }],
  });
  const { host, root } = render(
    <TaskReadinessStrip
      tasks={[item]}
      files={[operationalFile, historicalFile]}
      pipelines={[linked]}
      flows={[]}
      onOpenTask={noop}
      onOpenFile={(file) => openedPaths.push(file.path)}
    />,
  );

  expandStrip(host);
  expect(sectionRow(host, "now").getAttribute("aria-label")).toBe("“Now” tasks · 1");
  flushSync(() => sectionRow(host, "now").dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  const pipelineChip = [...host.querySelectorAll("button")].find((button) =>
    button.getAttribute("aria-label")?.startsWith("Open the linked pipeline"))!;
  flushSync(() => pipelineChip.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  expect(openedPaths).toEqual([operationalFile.path]);
  flushSync(() => root.unmount());
});

test("pipeline chip opens the cursor retry after a fail-edge loop-back", () => {
  const openedPaths: string[] = [];
  const retryFile = { path: "/tmp/pipeline-build-retry.jsonl", activity: "live", proc: "running" } as unknown as FileEntry;
  const staleFile = { path: "/tmp/pipeline-stale-verify.jsonl", activity: "idle", proc: null } as unknown as FileEntry;
  const linked = {
    id: "pipeline-readiness-loop-back",
    project: "demo",
    state: "running",
    stages: [
      { id: "build", kind: "run", prompt: "", next: "verify" },
      { id: "verify", kind: "run", prompt: "", next: null, onFail: { to: "build", maxRounds: 2 } },
    ],
    runs: [
      { stageId: "build", attempts: [
        {
          n: 1,
          state: "passed",
          agentPath: "/tmp/pipeline-build-first.jsonl",
          historical: false,
          startedAt: "2026-07-20T11:20:00.000Z",
          completedAt: "2026-07-20T11:21:00.000Z",
        },
        {
          n: 2,
          state: "running",
          agentPath: retryFile.path,
          historical: false,
          startedAt: "2026-07-20T11:23:00.000Z",
          completedAt: null,
          activatedBy: { stageId: "verify", attempt: 1, edge: "fail" },
        },
      ] },
      { stageId: "verify", attempts: [{
        n: 1,
        state: "failed",
        agentPath: staleFile.path,
        historical: false,
        startedAt: "2026-07-20T11:21:00.000Z",
        completedAt: "2026-07-20T11:22:00.000Z",
      }] },
    ],
    cursor: {
      stageId: "build",
      state: "running",
      input: "Fix the failed verification",
      activatedBy: { stageId: "verify", attempt: 1, edge: "fail" },
    },
  } as unknown as Pipeline;
  const item = task("t-pipeline-loop-back", "assigned", "Loop-back pipeline card", {
    assignments: [{ path: retryFile.path, panePid: null, state: "delivered", error: null, at: "2026-07-20T11:23:00.000Z" }],
  });
  const { host, root } = render(
    <TaskReadinessStrip
      tasks={[item]}
      files={[retryFile, staleFile]}
      pipelines={[linked]}
      flows={[]}
      onOpenTask={noop}
      onOpenFile={(file) => openedPaths.push(file.path)}
    />,
  );

  expandStrip(host);
  flushSync(() => sectionRow(host, "now").dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  const pipelineChip = [...host.querySelectorAll("button")].find((button) =>
    button.getAttribute("aria-label")?.startsWith("Open the linked pipeline"))!;
  flushSync(() => pipelineChip.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  expect(openedPaths).toEqual([retryFile.path]);
  expect(openedPaths).not.toContain(staleFile.path);
  flushSync(() => root.unmount());
});

test("review chip navigates to the linked flow transcript", () => {
  const openedPaths: string[] = [];
  const flowFile = { path: "/tmp/impl.jsonl", activity: "idle", proc: null } as unknown as FileEntry;
  const reviewerFile = { path: "/tmp/reviewer.jsonl", activity: "idle", proc: null } as unknown as FileEntry;
  const linked = reviewingFlow(flowFile.path);
  linked.rounds = [
    {
      n: 1,
      reviewerPath: reviewerFile.path,
      findingsPath: null,
      triggeredBy: "marker",
      readyNote: null,
      verdict: null,
      findingsCount: null,
      startedAt: "2026-07-01T00:00:00.000Z",
      reviewedAt: null,
      relayedAt: null,
      error: null,
    },
  ];
  const item = task("t-review", "assigned", "Reviewed card", {
    assignments: [{ path: flowFile.path, panePid: null, state: "delivered", error: null, at: "2026-07-01T00:00:00.000Z" }],
  });
  const { host, root } = render(
    <TaskReadinessStrip
      tasks={[item]}
      files={[flowFile, reviewerFile]}
      pipelines={[]}
      flows={[linked]}
      onOpenTask={noop}
      onOpenFile={(file) => openedPaths.push(file.path)}
    />,
  );
  expandStrip(host);
  expect(sectionRow(host, "review").getAttribute("aria-label")).toBe("“In review” tasks · 1");
  flushSync(() => sectionRow(host, "review").dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  const reviewChip = [...host.querySelectorAll("button")].find((button) =>
    button.getAttribute("aria-label")?.startsWith("Open the linked review"))!;
  flushSync(() => reviewChip.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  expect(openedPaths).toEqual([reviewerFile.path]);
  flushSync(() => root.unmount());
});

test("issue chips: an external GitHub link with a repository, plain text without one", () => {
  const item = task("t-issue", "inbox", "Implement issue #290 as production UI");
  const withRepo = render(
    <TaskReadinessStrip
      tasks={[item]}
      files={[]}
      pipelines={[]}
      flows={[]}
      repository="Latand/live-log-viewer-next"
      onOpenTask={noop}
      onOpenFile={noop}
    />,
  );
  expandStrip(withRepo.host);
  flushSync(() => sectionRow(withRepo.host, "planned").dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  const link = withRepo.host.querySelector('a[aria-label="Open issue #290 on GitHub"]') as HTMLAnchorElement;
  expect(link.getAttribute("href")).toBe("https://github.com/Latand/live-log-viewer-next/issues/290");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noreferrer");
  flushSync(() => withRepo.root.unmount());

  const withoutRepo = render(
    <TaskReadinessStrip tasks={[item]} files={[]} pipelines={[]} flows={[]} onOpenTask={noop} onOpenFile={noop} />,
  );
  expandStrip(withoutRepo.host);
  flushSync(() => sectionRow(withoutRepo.host, "planned").dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  expect(withoutRepo.host.querySelector("a")).toBe(null);
  expect(withoutRepo.host.textContent).toContain("#290");
  flushSync(() => withoutRepo.root.unmount());
});

test("aria-expanded toggling, phone tap targets, and no nested horizontal scroll container", () => {
  mobile = true;
  const tasks = [task("t1", "inbox", "One card")];
  const { host, root } = render(
    <TaskReadinessStrip tasks={tasks} files={[]} pipelines={[]} flows={[]} onOpenTask={noop} onOpenFile={noop} />,
  );
  const header = host.querySelector('[data-testid="task-readiness"] button') as HTMLButtonElement;
  expect(header.getAttribute("aria-expanded")).toBe("false");
  expect(header.className).toContain("min-h-11");
  flushSync(() => header.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  expect(header.getAttribute("aria-expanded")).toBe("true");
  const row = sectionRow(host, "planned");
  expect(row.getAttribute("aria-expanded")).toBe("false");
  expect(row.className).toContain("min-h-11");
  flushSync(() => row.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  expect(row.getAttribute("aria-expanded")).toBe("true");
  const chipButton = [...host.querySelectorAll("button")].find((button) => button.getAttribute("aria-label")?.includes("One card"))!;
  expect(chipButton.className).toContain("min-h-11");
  /* 390px compactness: the strip scrolls vertically only — nothing inside may
     introduce a horizontal scroll container. */
  for (const element of [host.querySelector('[data-testid="task-readiness"]')!, ...host.querySelectorAll('[data-testid="task-readiness"] *')]) {
    expect((element as HTMLElement).className.toString()).not.toContain("overflow-x");
  }
  flushSync(() => root.unmount());
});

test("no tasks renders nothing", () => {
  const { host, root } = render(
    <TaskReadinessStrip tasks={[]} files={[]} pipelines={[]} flows={[]} onOpenTask={noop} onOpenFile={noop} />,
  );
  expect(host.querySelector('[data-testid="task-readiness"]')).toBe(null);
  flushSync(() => root.unmount());
});
