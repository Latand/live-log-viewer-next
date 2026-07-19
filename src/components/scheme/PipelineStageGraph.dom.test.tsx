import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { useState } from "react";

import type { Pipeline, PipelineStage, PipelineStageAttempt } from "@/lib/pipelines/types";

import { PipelineStageGraph } from "./PipelineStageGraph";

const dom = new HappyWindow();
const roots = new Set<Root>();

function bindDomGlobals() {
  Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    Node: dom.Node,
    HTMLElement: dom.HTMLElement,
    HTMLButtonElement: dom.HTMLButtonElement,
    Event: dom.Event,
    MouseEvent: dom.MouseEvent,
    localStorage: dom.localStorage,
    sessionStorage: dom.sessionStorage,
  });
}

beforeEach(bindDomGlobals);
afterEach(() => {
  for (const root of roots) flushSync(() => root.unmount());
  roots.clear();
  dom.document.body.replaceChildren();
  dom.localStorage.clear();
});

const builderRole = {
  roleId: "builder" as const,
  engine: "codex" as const,
  model: "gpt-5.6-sol",
  effort: "high",
  access: "read-write" as const,
  promptScaffold: "build",
};

function runStage(id: string, next: string | null): PipelineStage {
  return { id, kind: "run", prompt: id, next, onFail: null, effectiveRole: builderRole };
}

function reviewStage(id: string, next: string | null): PipelineStage {
  return {
    id, kind: "review-loop", prompt: id, next, onFail: null,
    effectiveRole: { ...builderRole, roleId: "reviewer", access: "read-only", promptScaffold: "review" },
  };
}

function attempt(
  n: number,
  state: PipelineStageAttempt["state"],
  conversationId: string | null,
  activatedBy: PipelineStageAttempt["activatedBy"] = null,
): PipelineStageAttempt {
  return {
    n, state, effectiveRole: builderRole, launchId: null, conversationId, sessionId: null,
    agentPath: conversationId ? `/${conversationId}.jsonl` : null, paneId: null, flowId: null,
    startedAt: null, completedAt: null, input: null, activatedBy, output: null, verdict: null, error: null,
  };
}

function pipeline(stages: PipelineStage[], attemptsByStage: Record<string, PipelineStageAttempt[]>): Pipeline {
  return {
    id: "p1", task: "Stage graph", project: "project", repoDir: "/repo", worktreeDir: "/worktree",
    branch: "feature", baseBranch: "main", baseRef: "abc", lastPassedCommit: "abc", stages,
    runs: stages.map((stage) => ({ stageId: stage.id, attempts: attemptsByStage[stage.id] ?? [] })),
    cursor: { stageId: stages[0]!.id, state: "running", input: null, activatedBy: null },
    state: "running", pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null,
    createdAt: new Date(0).toISOString(), closedAt: null,
  };
}

function mount(value: Pipeline, onOpenConversation: (conversationId: string) => void = () => {}): HTMLElement {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  roots.add(root);
  flushSync(() => root.render(<PipelineStageGraph pipeline={value} onOpenConversation={onOpenConversation} />));
  return host as unknown as HTMLElement;
}

function mountMutable(value: Pipeline, onOpenConversation: (conversationId: string) => void = () => {}) {
  const host = dom.document.createElement("div");
  dom.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  roots.add(root);
  let update: (next: Pipeline) => void = () => undefined;
  function MutableGraph() {
    const [current, setCurrent] = useState(value);
    update = setCurrent;
    return <PipelineStageGraph pipeline={current} onOpenConversation={onOpenConversation} />;
  }
  flushSync(() => root.render(<MutableGraph />));
  return { host: host as unknown as HTMLElement, update: (next: Pipeline) => flushSync(() => update(next)) };
}

test("a fresh two-stage pipeline renders its running node and clickable review settings ghost", () => {
  const stages = [runStage("build", "review"), reviewStage("review", null)];
  const opened: string[] = [];
  const host = mount(
    pipeline(stages, { build: [attempt(1, "running", "conversation-build")] }),
    (conversationId) => opened.push(conversationId),
  );

  expect(host.querySelectorAll("[data-stage-graph-node]")).toHaveLength(2);
  expect(host.querySelectorAll("[data-stage-graph-edge]")).toHaveLength(1);
  const ghost = host.querySelector('[data-stage-graph-node="review"]') as HTMLElement;
  expect(ghost.getAttribute("data-ghost")).toBe("true");
  const trigger = ghost.querySelector("button[data-open-stage]") as HTMLButtonElement;
  expect(trigger.disabled).toBe(false);
  flushSync(() => trigger.click());
  expect(ghost.querySelector('[data-stage-settings="review"]')).not.toBeNull();
  expect(opened).toEqual([]);
  expect(host.querySelector('[data-stage-group-owner="build"]')?.contains(ghost)).toBe(true);
});

test("review rounds stay grouped under their implementer and show bounded progress", () => {
  const build = runStage("build", "review");
  const review = reviewStage("review", null);
  review.onFail = { to: "build", maxRounds: 3 };
  const value = pipeline([build, review], {
    build: [attempt(1, "passed", "conversation-build")],
    review: [
      attempt(1, "failed", "conversation-review-1", { stageId: "build", attempt: 1, edge: "pass" }),
      attempt(2, "reviewing", "conversation-review-2"),
    ],
  });
  value.cursor = { stageId: "review", state: "reviewing", input: null, activatedBy: { stageId: "build", attempt: 1, edge: "pass" } };

  const host = mount(value);
  const owner = host.querySelector('[data-stage-group-owner="build"]')!;
  const reviewNode = host.querySelector('[data-stage-graph-node="review"]')!;

  expect(owner.contains(reviewNode)).toBe(true);
  expect(reviewNode.getAttribute("data-review-round")).toBe("2/3");
  expect(reviewNode.textContent).toContain("round 2/3");
});

test("clicking a materialized node opens its conversation while failed transcripts remain linkable", () => {
  const build = runStage("build", null);
  const opened: string[] = [];
  const host = mount(
    pipeline([build], { build: [attempt(1, "failed", "conversation-dead-host")] }),
    (conversationId) => opened.push(conversationId),
  );
  const node = host.querySelector('[data-stage-graph-node="build"]')!;

  expect(node.getAttribute("data-stage-state")).toBe("failed");
  expect(node.className).toContain("opacity-60");
  (node.querySelector("button[data-open-stage]") as HTMLButtonElement).click();
  expect(opened).toEqual(["conversation-dead-host"]);
});

test("many retries collapse into an expandable attempt stack with transcript links", () => {
  const build = runStage("build", null);
  const opened: string[] = [];
  const host = mount(pipeline([build], { build: [
    attempt(1, "failed", "conversation-1"),
    attempt(2, "failed", "conversation-2"),
    attempt(3, "running", "conversation-3"),
  ] }), (conversationId) => opened.push(conversationId));

  const stack = host.querySelector("details[data-attempt-stack]") as HTMLDetailsElement;
  expect(stack.open).toBe(false);
  expect(stack.querySelector("summary")?.textContent).toContain("attempt 3");
  (stack.querySelector("summary") as HTMLElement).click();
  expect(stack.open).toBe(true);
  const links = stack.querySelectorAll("button[data-attempt-conversation]");
  expect(links).toHaveLength(3);
  (links[0] as HTMLButtonElement).click();
  expect(opened).toEqual(["conversation-1"]);
});

test("a fail-loop return emphasizes the durable cursor path before the retry attempt spawns", () => {
  const build = runStage("build", "verify");
  const verify = runStage("verify", null);
  verify.onFail = { to: "build", maxRounds: 2 };
  const value = pipeline([build, verify], {
    build: [attempt(1, "passed", "conversation-build")],
    verify: [attempt(1, "failed", "conversation-verify", { stageId: "build", attempt: 1, edge: "pass" })],
  });
  value.cursor = {
    stageId: "build", state: "running", input: "repair",
    activatedBy: { stageId: "verify", attempt: 1, edge: "fail" },
  };

  const host = mount(value);
  expect(host.querySelector('[data-stage-graph-node="build"]')?.getAttribute("data-current")).toBe("true");
  expect(host.querySelector('[data-edge-kind="fail"]')?.getAttribute("data-edge-taken")).toBe("true");
  expect(host.querySelector('[data-edge-kind="fail"]')?.getAttribute("data-edge-return")).toBe("true");
});

test("a cursorless closed pipeline marks the stage where work truthfully rested", () => {
  const stages = [runStage("plan", "build"), runStage("build", "ship"), runStage("ship", null)];
  const value = pipeline(stages, {
    plan: [attempt(1, "passed", "conversation-plan")],
    build: [attempt(1, "pending", null, { stageId: "plan", attempt: 1, edge: "pass" })],
  });
  value.state = "closed";
  value.cursor = null;

  const host = mount(value);
  expect(host.querySelector('[data-stage-graph-node="build"]')?.getAttribute("data-resting")).toBe("true");
  expect(host.querySelectorAll('[data-current="true"]')).toHaveLength(0);
  expect(host.querySelectorAll("[data-stage-graph-node]")).toHaveLength(3);
});

test("saving ghost settings issues override-stage and the spawned node shows the overridden model", async () => {
  const stages = [runStage("build", "review"), reviewStage("review", null)];
  const value = pipeline(stages, { build: [attempt(1, "running", "conversation-build")] });
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
    return new Response(JSON.stringify({ pipeline: value }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    const host = mount(value);
    flushSync(() => (host.querySelector('[data-stage-graph-node="review"] button[data-open-stage]') as HTMLButtonElement).click());
    const set = (name: string, selected: string) => {
      const input = host.querySelector(`[data-stage-setting="${name}"]`) as HTMLSelectElement;
      input.value = selected;
      flushSync(() => input.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event));
    };
    set("role", "reviewer");
    set("model", "gpt-5.6-terra");
    set("effort", "xhigh");
    (host.querySelector("button[data-save-stage-settings]") as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      url: "/api/pipelines/p1",
      body: expect.objectContaining({
        action: "override-stage", stageId: "review", role: { roleId: "reviewer" }, model: "gpt-5.6-terra", effort: "xhigh",
      }),
    });

    const spawned = structuredClone(value);
    const review = spawned.stages[1]!;
    review.role = { roleId: "reviewer" };
    review.effectiveRole = { ...review.effectiveRole, model: "gpt-5.6-terra", effort: "xhigh" };
    spawned.runs[1]!.attempts = [{
      ...attempt(1, "reviewing", "conversation-review", { stageId: "build", attempt: 1, edge: "pass" }),
      effectiveRole: { ...review.effectiveRole },
    }];
    spawned.cursor = { stageId: "review", state: "reviewing", input: null, activatedBy: { stageId: "build", attempt: 1, edge: "pass" } };
    const spawnedHost = mount(spawned);
    expect(spawnedHost.querySelector('[data-stage-graph-node="review"]')?.getAttribute("data-attempt-model")).toBe("gpt-5.6-terra");
    expect(spawnedHost.querySelector('[data-stage-graph-node="review"]')?.textContent).toContain("gpt-5.6-terra");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an editor closes with a notice when its stage starts and the node opens the new conversation", () => {
  const stages = [runStage("build", "review"), reviewStage("review", null)];
  const initial = pipeline(stages, { build: [attempt(1, "running", "conversation-build")] });
  const opened: string[] = [];
  const view = mountMutable(initial, (conversationId) => opened.push(conversationId));
  flushSync(() => (view.host.querySelector('[data-stage-graph-node="review"] button[data-open-stage]') as HTMLButtonElement).click());
  expect(view.host.querySelector('[data-stage-settings="review"]')).not.toBeNull();

  const started = structuredClone(initial);
  started.runs[1]!.attempts = [attempt(1, "reviewing", "conversation-review", { stageId: "build", attempt: 1, edge: "pass" })];
  started.cursor = { stageId: "review", state: "reviewing", input: null, activatedBy: { stageId: "build", attempt: 1, edge: "pass" } };
  view.update(started);

  expect(view.host.querySelector('[data-stage-settings="review"]')).toBeNull();
  expect(view.host.querySelector('[data-stage-graph-node="review"] [role="status"]')?.textContent).toContain("started");
  (view.host.querySelector('[data-stage-graph-node="review"] button[data-open-stage]') as HTMLButtonElement).click();
  expect(opened).toEqual(["conversation-review"]);
});

test("an override-stage rejection is surfaced inside the open node", async () => {
  const stages = [runStage("build", "review"), reviewStage("review", null)];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "stage already started" }), {
    status: 409,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
  try {
    const host = mount(pipeline(stages, { build: [attempt(1, "running", "conversation-build")] }));
    flushSync(() => (host.querySelector('[data-stage-graph-node="review"] button[data-open-stage]') as HTMLButtonElement).click());
    (host.querySelector("button[data-save-stage-settings]") as HTMLButtonElement).click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(host.querySelector('[data-stage-settings="review"] [role="alert"]')?.textContent).toBe("stage already started");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a late override rejection replaces the started notice after the editor closes", async () => {
  const stages = [runStage("build", "review"), reviewStage("review", null)];
  const initial = pipeline(stages, { build: [attempt(1, "running", "conversation-build")] });
  const originalFetch = globalThis.fetch;
  let settle: (response: Response) => void = () => undefined;
  globalThis.fetch = (() => new Promise<Response>((resolve) => { settle = resolve; })) as unknown as typeof fetch;
  try {
    const view = mountMutable(initial);
    flushSync(() => (view.host.querySelector('[data-stage-graph-node="review"] button[data-open-stage]') as HTMLButtonElement).click());
    (view.host.querySelector("button[data-save-stage-settings]") as HTMLButtonElement).click();

    const started = structuredClone(initial);
    started.runs[1]!.attempts = [attempt(1, "reviewing", "conversation-review", { stageId: "build", attempt: 1, edge: "pass" })];
    started.cursor = { stageId: "review", state: "reviewing", input: null, activatedBy: { stageId: "build", attempt: 1, edge: "pass" } };
    view.update(started);
    expect(view.host.querySelector('[data-stage-graph-node="review"] [role="status"]')?.textContent).toContain("started");

    settle(new Response(JSON.stringify({ error: "server rejected started-stage override" }), {
      status: 409,
      headers: { "content-type": "application/json" },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.host.querySelector('[data-stage-graph-node="review"] [role="status"]')?.textContent).toContain("server rejected started-stage override");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("draft ghost settings retain the editable stage edge controls", () => {
  const stages = [runStage("build", "review"), reviewStage("review", null)];
  const value = pipeline(stages, {});
  value.state = "draft";
  value.cursor = { stageId: "build", state: "pending", input: null, activatedBy: null };
  const host = mount(value);
  flushSync(() => (host.querySelector('[data-stage-graph-node="build"] button[data-open-stage]') as HTMLButtonElement).click());
  expect(host.querySelector('[data-stage-settings="build"] [data-stage-edges]')).not.toBeNull();
});
