import { afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { Pipeline } from "@/lib/pipelines/types";

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
    cursor: { stageId: "build", state: "pending" },
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
