import { afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { Pipeline } from "@/lib/pipelines/types";
import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

const dom = new Window({ url: "http://localhost" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  localStorage: dom.localStorage,
});

globalThis.fetch = mock(async () => new Response(JSON.stringify({ roles: [] }), {
  status: 200,
  headers: { "content-type": "application/json" },
})) as unknown as typeof fetch;

const { PipelineStrip } = await import("./PipelineStrip");

let root: Root | null = null;
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  dom.document.body.replaceChildren();
});

function draftPipeline(): Pipeline {
  return {
    id: "p1",
    task: "Compact stages",
    project: "proj",
    repoDir: "/r",
    worktreeDir: "/w",
    branch: "b",
    baseBranch: "main",
    baseRef: "a",
    lastPassedCommit: "a",
    stages: [{
      id: "build",
      kind: "run",
      role: { roleId: "builder" },
      prompt: "{{task}}",
      next: null,
      effectiveRole: { roleId: "builder", engine: "codex", model: "gpt-5.6-sol", effort: "high", access: "read-write", promptScaffold: null },
    }],
    runs: [],
    cursor: { stageId: "build", state: "pending", input: null, activatedBy: null },
    state: "draft",
    pausedState: null,
    stateDetail: null,
    srcPath: null,
    srcConversationId: null,
    createdAt: "2026-07-18T00:00:00.000Z",
    closedAt: null,
  };
}

test("planned stage configuration opens on demand and Escape restores the compact rail (#353)", async () => {
  const element = dom.document.createElement("div");
  dom.document.body.append(element);
  const host = element as unknown as HTMLElement;
  root = createRoot(host);
  flushSync(() => root!.render(<PipelineStrip pipeline={draftPipeline()} />));

  const configure = host.querySelector<HTMLButtonElement>('[aria-label="Configure stage Builder, state pending"]');
  expect(configure).toBeTruthy();
  flushSync(() => configure!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  await Promise.resolve();

  const body = dom.document.body as unknown as HTMLElement;
  const dialog = body.querySelector<HTMLElement>('[role="dialog"]');
  expect(dialog?.getAttribute("aria-label")).toBe("Configuration for stage Builder");
  expect(dialog?.textContent).toContain("reasoning");

  flushSync(() => window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event));
  expect(body.querySelector('[role="dialog"]')).toBeNull();
  expect(dom.document.activeElement?.getAttribute("aria-label")).toBe("Configure stage Builder, state pending");
});

test("desktop history opens both durable bindings from one logical review round (#353)", async () => {
  const stage = {
    id: "review",
    kind: "review-loop",
    prompt: "",
    next: null,
    effectiveRole: { roleId: "reviewer", engine: "codex", model: "gpt-5.6-sol", effort: "xhigh", access: "read-only", promptScaffold: null },
  } as const;
  const currentPath = "/review-current.jsonl";
  const pipeline = {
    ...draftPipeline(),
    state: "running",
    stages: [stage],
    runs: [{ stageId: stage.id, attempts: [{
      n: 1,
      state: "reviewing",
      effectiveRole: stage.effectiveRole,
      launchId: "launch-review",
      conversationId: "conversation-current",
      sessionId: "session-current",
      agentPath: currentPath,
      paneId: null,
      flowId: "flow-1",
      startedAt: "2026-07-18T00:00:00Z",
      completedAt: null,
      output: null,
      verdict: null,
      error: null,
    }] }],
    cursor: { stageId: stage.id, state: "reviewing", input: null, activatedBy: null },
  } as unknown as Pipeline;
  const membership = (slot: string) => ({
    kind: "flow" as const, containerId: "flow-1", role: "reviewer", slot,
    stageId: null, stageOrder: null, round: 1, parentConversationId: "conversation-builder",
  });
  const files = [
    { path: "/review-prior.jsonl", conversationId: "conversation-prior", durableLineage: { memberships: [membership("reviewer:1:binding-a")] } },
    { path: currentPath, conversationId: "conversation-current", durableLineage: { memberships: [membership("reviewer:1:binding-b")] } },
  ] as unknown as FileEntry[];
  const flows = [{
    id: "flow-1",
    implementerPath: "/builder.jsonl",
    rounds: [{ n: 1, reviewerPath: currentPath, reviewerConversationId: "conversation-current" }],
  }] as unknown as Flow[];
  const opened: string[] = [];
  const element = dom.document.createElement("div");
  dom.document.body.append(element);
  root = createRoot(element as unknown as HTMLElement);
  flushSync(() => root!.render(
    <PipelineStrip
      pipeline={pipeline}
      flows={flows}
      files={files}
      renderablePaths={new Set(files.map((file) => file.path))}
      onOpenPath={(path) => opened.push(path)}
    />,
  ));

  const verdict = element.querySelector('[aria-label^="Open verdict for stage"]') as unknown as HTMLButtonElement | null;
  expect(verdict).toBeTruthy();
  flushSync(() => verdict!.click());
  await Promise.resolve();

  const body = dom.document.body as unknown as HTMLElement;
  const prior = body.querySelector<HTMLButtonElement>('[aria-label="Open review transcript 1"]');
  const current = body.querySelector<HTMLButtonElement>('[aria-label="Open transcript for attempt 1"]');
  expect(prior).toBeTruthy();
  expect(current).toBeTruthy();
  const buttons = [...body.querySelectorAll("button")];
  expect(buttons.indexOf(prior!)).toBeLessThan(buttons.indexOf(current!));

  flushSync(() => prior!.click());
  flushSync(() => current!.click());
  expect(opened).toEqual(["/review-prior.jsonl", currentPath]);
});

function stableHeaderPipeline(): Pipeline {
  return {
    ...draftPipeline(),
    id: "pipeline-388",
    task: "Repair pipeline UX",
    baseRef: "1234567890abcdef1234567890abcdef12345678",
    lastPassedCommit: "1234567890abcdef1234567890abcdef12345678",
    stages: [
      { id: "build", kind: "run", prompt: "", next: "review", effectiveRole: { roleId: "builder", engine: "codex", model: "gpt-5.6", effort: "xhigh", access: "read-write", promptScaffold: null } },
      { id: "review", kind: "review-loop", prompt: "", next: null, effectiveRole: { roleId: "reviewer", engine: "claude", model: "fable", effort: "high", access: "read-only", promptScaffold: null } },
    ],
    cursor: { stageId: "build", state: "spawning", input: null, activatedBy: null },
    state: "running",
  } as Pipeline;
}

function mountStable(pipeline = stableHeaderPipeline(), mobile = false): HTMLElement {
  const element = dom.document.createElement("div");
  dom.document.body.append(element);
  const host = element as unknown as HTMLElement;
  root = createRoot(host);
  flushSync(() => root!.render(<PipelineStrip pipeline={pipeline} mobile={mobile} />));
  return host;
}

async function settleStable(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => undefined);
}

test("the stable header shows eight base characters and copies the complete commit (#388)", async () => {
  let copied = "";
  Object.defineProperty(dom.navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied = value; } } });
  const pipeline = stableHeaderPipeline();
  const host = mountStable(pipeline);
  const button = host.querySelector("[data-pipeline-base-ref]") as HTMLButtonElement;

  expect(button.textContent).toContain("12345678");
  expect(button.textContent).not.toContain("90abcdef");
  flushSync(() => button.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  await settleStable();

  expect(copied).toBe(pipeline.baseRef);
  expect(host.textContent).toContain("Full base commit copied");
});

test("the base-commit live region announces clipboard failure (#388)", async () => {
  Object.defineProperty(dom.navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw new Error("denied"); } } });
  const host = mountStable();
  const button = host.querySelector("[data-pipeline-base-ref]") as HTMLButtonElement;
  flushSync(() => button.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  await settleStable();
  expect(host.textContent).toContain("Could not copy the base commit");
});

test("the overflow menu focuses its first action and Escape restores trigger focus (#388)", async () => {
  const host = mountStable();
  const trigger = host.querySelector('[aria-label="More pipeline actions"]') as HTMLButtonElement;
  flushSync(() => trigger.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  await settleStable();

  const menu = dom.document.body.querySelector('[role="menu"]') as unknown as HTMLElement;
  const first = menu.querySelector('[role="menuitem"]') as HTMLButtonElement;
  expect(first.textContent).toContain("Close pipeline");
  expect(dom.document.activeElement?.getAttribute("role")).toBe("menuitem");

  flushSync(() => window.dispatchEvent(new dom.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event));
  await settleStable();
  expect(dom.document.body.querySelector('[role="menu"]')).toBeNull();
  expect(dom.document.activeElement?.getAttribute("aria-label")).toBe(trigger.getAttribute("aria-label"));
});

test("the overflow trigger regains focus after a menu action settles (#388)", async () => {
  globalThis.fetch = mock(async () => new Response(JSON.stringify({ pipeline: stableHeaderPipeline() }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;
  const host = mountStable();
  const trigger = host.querySelector('[aria-label="More pipeline actions"]') as HTMLButtonElement;
  flushSync(() => trigger.click());
  await settleStable();

  const close = dom.document.body.querySelector('[role="menuitem"]') as unknown as HTMLButtonElement;
  flushSync(() => close.click());
  await settleStable();

  expect(dom.document.body.querySelector('[role="menu"]')).toBeNull();
  expect(dom.document.activeElement?.getAttribute("aria-label")).toBe(trigger.getAttribute("aria-label"));
});

test("the mobile rail keeps queued and waiting labels inside isolated overflow (#388)", () => {
  const host = mountStable(stableHeaderPipeline(), true);
  const strip = host.querySelector('[role="group"]') as HTMLElement;
  const rail = host.querySelector("[data-pipeline-stage-rail]") as HTMLElement;
  expect(strip.className).toContain("overflow-visible");
  expect(strip.className).not.toContain("overflow-x-auto");
  expect(rail.className).toContain("overflow-x-auto");
  expect(host.querySelector('[data-stage-presentation="queued"]')?.textContent).toContain("Queued");
  expect(host.querySelector('[data-stage-presentation="waiting"]')?.textContent).toContain("Waiting");
  expect(host.querySelector('[data-stage-compact="true"]')).toBeNull();
});
