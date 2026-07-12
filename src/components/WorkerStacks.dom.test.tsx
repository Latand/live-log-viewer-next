import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";

import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

import { WorkerStacks } from "./WorkerStacks";
import type { WorkerStack } from "./scheme/workerCollapse";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
});

afterEach(() => document.body.replaceChildren());

function entry(overrides: Partial<FileEntry> & { path: string }): FileEntry {
  return {
    root: "claude-projects",
    name: overrides.path,
    project: "demo",
    title: overrides.path,
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: 1_000,
    size: 10,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

const roleConfig = { engine: "claude" as const, model: null, effort: null };

function flow(overrides: Partial<Flow> & { id: string; implementerPath: string }): Flow {
  return {
    template: "implement-review-loop",
    project: "demo",
    cwd: "/tmp",
    roles: { implementer: roleConfig, reviewer: roleConfig },
    baseRef: "abc",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
    state: "reviewing",
    stateDetail: null,
    rounds: [
      {
        n: 9,
        reviewerPath: "/rev9",
        findingsPath: null,
        triggeredBy: "marker",
        readyNote: null,
        verdict: "APPROVE",
        findingsCount: null,
        startedAt: "2026-07-05T00:00:00Z",
        reviewedAt: "2026-07-05T01:00:00Z",
        relayedAt: null,
        error: null,
      },
    ],
    createdAt: "2026-07-05T00:00:00Z",
    closedAt: null,
    ...overrides,
  };
}

function mount(node: React.ReactElement): { host: HTMLElement; root: Root } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(node));
  return { host, root };
}

function click(button: Element) {
  flushSync(() => button.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
}

test("renders nothing when there are no collapsed workers", () => {
  const { host } = mount(<WorkerStacks stacks={[]} files={[]} flows={[]} onSelect={() => {}} />);
  expect(host.querySelector('[data-testid="worker-stacks"]')).toBeNull();
});

test("expands a flow stack and opens a folded reviewer round", () => {
  const reviewer = entry({ path: "/rev9", title: "review round 9", flow: { flowId: "f1", flowRole: "reviewer", round: 9 } });
  const impl = entry({ path: "/impl", title: "Ship the reaper" });
  const flows = [flow({ id: "f1", implementerPath: "/impl", rounds: flow({ id: "f1", implementerPath: "/impl" }).rounds })];
  const stacks: WorkerStack[] = [{ key: "wstack::flow::f1", kind: "flow", id: "f1", items: [reviewer] }];

  const opened: FileEntry[] = [];
  const { host } = mount(
    <WorkerStacks stacks={stacks} files={[impl, reviewer]} flows={flows} onSelect={(file) => opened.push(file)} />,
  );

  /* The strip header carries the total count and starts collapsed. */
  const header = host.querySelector('[data-testid="worker-stacks"] > button') as HTMLButtonElement;
  expect(header).toBeTruthy();
  expect(header.getAttribute("aria-expanded")).toBe("false");
  expect(header.textContent).toContain("1");

  /* Open the strip; the flow stack row shows the implementer title as its label. */
  click(header);
  const stackRow = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("Ship the reaper")) as HTMLButtonElement;
  expect(stackRow).toBeTruthy();
  expect(stackRow.getAttribute("aria-expanded")).toBe("false");

  /* Expand the stack, then open the reviewer card. */
  click(stackRow);
  const memberButton = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes("review round 9")) as HTMLButtonElement;
  expect(memberButton).toBeTruthy();
  /* The approve verdict glyph rides along on the folded reviewer chip. */
  expect(memberButton.textContent).toContain("✓");

  click(memberButton);
  expect(opened.map((file) => file.path)).toEqual(["/rev9"]);
});

test("labels a worktree stack by its worktree name", () => {
  const worker = entry({ path: "/w", kind: "subagent", parent: "/root", worktree: "feat-x", title: "spawned worker" });
  const stacks: WorkerStack[] = [{ key: "wstack::worktree::feat-x", kind: "worktree", id: "feat-x", items: [worker] }];
  const { host } = mount(<WorkerStacks stacks={stacks} files={[worker]} flows={[]} onSelect={() => {}} />);
  const header = host.querySelector('[data-testid="worker-stacks"] > button') as HTMLButtonElement;
  click(header);
  expect(Array.from(host.querySelectorAll("button")).some((b) => b.textContent?.includes("feat-x"))).toBe(true);
});
