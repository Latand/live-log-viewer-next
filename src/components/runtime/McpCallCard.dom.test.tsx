import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { publishConversationAvailability } from "@/lib/mcp/availability";

import type { ToolEvent } from "../feed/parse";
import { McpCallCard } from "./McpCallCard";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLAnchorElement: dom.HTMLAnchorElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
});

let root: Root | null = null;
let rootContainer: HTMLDivElement | null = null;
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  rootContainer = null;
  document.body.replaceChildren();
});

function toolEvent(over: Partial<ToolEvent> = {}): ToolEvent {
  return {
    kind: "tool",
    id: "call-1",
    ts: "2026-07-19T10:00:00Z",
    srcCall: 0,
    family: "mcp",
    tool: "spawn_agent",
    icon: "spawn",
    summary: "spawn_agent",
    chips: [],
    status: "run",
    statusLabel: "running",
    outputPreview: "",
    outputTruncated: false,
    open: false,
    mcp: {
      serverName: "viewer",
      toolName: "spawn_agent",
      args: { model: "gpt-5.6-sol", effort: "xhigh", role: "reviewer", prompt: "Review PR #431" },
      result: null,
    },
    ...over,
  };
}

function render(event: ToolEvent, availableConversationIds?: ReadonlySet<string>) {
  if (!rootContainer) {
    rootContainer = document.createElement("div");
    document.body.appendChild(rootContainer);
  }
  root ??= createRoot(rootContainer);
  flushSync(() => root!.render(
    <McpCallCard event={event} availableConversationIds={availableConversationIds} />,
  ));
  return rootContainer;
}

test("renders a pending MCP call with a live CSS progress treatment", () => {
  const container = render(toolEvent(), new Set());
  const card = container.querySelector('[data-testid="mcp-call-card"]');
  expect(card?.getAttribute("data-state")).toBe("pending");
  expect(card?.textContent).toContain("Creating agent: gpt-5.6-sol xhigh reviewer · Review PR #431");
  expect(container.querySelector('[data-testid="mcp-call-progress"]')?.className).toContain("animate-pulse");
});

test("renders success and upgrades a disabled conversation chip when scanning catches up", () => {
  const complete = toolEvent({
    status: "ok",
    statusLabel: "done",
    mcp: {
      ...toolEvent().mcp!,
      result: {
        conversationId: "conversation-431",
        transcriptPath: "/sessions/reviewer.jsonl",
        operationId: "op-1",
      },
    },
  });
  let container = render(complete, new Set());
  const disabled = container.querySelector('[data-testid="mcp-link-conversation"]');
  expect(disabled?.getAttribute("aria-disabled")).toBe("true");
  expect(disabled?.getAttribute("title")).toContain("scanner");

  container = render(complete, new Set(["conversation-431"]));
  const ready = container.querySelector('[data-testid="mcp-link-conversation"]');
  expect(ready?.getAttribute("href")).toBe("#c=conversation-431");
  expect(ready?.getAttribute("aria-disabled")).toBeNull();
  expect(container.textContent).toContain("Open agent");
});

test("uses the Viewer's scanner snapshot for production conversation links", () => {
  publishConversationAvailability(new Set(["conversation-431"]));
  const container = render(toolEvent({
    status: "ok",
    mcp: {
      ...toolEvent().mcp!,
      result: { conversationId: "conversation-431", transcriptPath: "/sessions/reviewer.jsonl" },
    },
  }));
  expect(container.querySelector('[data-testid="mcp-link-conversation"]')?.getAttribute("href")).toBe("#c=conversation-431");
});

test("renders structured MCP failures with their error text", () => {
  const container = render(toolEvent({
    status: "err",
    statusLabel: "failed",
    outputPreview: "MCP process restarted during the call",
    mcp: {
      ...toolEvent().mcp!,
      result: { error: "MCP process restarted during the call", retryable: true },
    },
  }), new Set());
  const card = container.querySelector('[data-testid="mcp-call-card"]');
  expect(card?.getAttribute("data-state")).toBe("error");
  expect(card?.textContent).toContain("MCP process restarted during the call");
  expect(card?.textContent).toContain("Retryable");
});

test("marks an idempotent replay in the completed card", () => {
  const container = render(toolEvent({
    status: "ok",
    mcp: {
      ...toolEvent().mcp!,
      result: { conversationId: "conversation-431", replayed: true },
    },
  }), new Set(["conversation-431"]));
  expect(container.querySelector('[data-testid="mcp-replay"]')?.textContent).toBe("Replay");
});

test("routes task chips through the viewer entity navigation channel", () => {
  let detail: unknown;
  const listener = (event: Event) => { detail = (event as CustomEvent).detail; };
  window.addEventListener("llv:mcp-navigate", listener);
  try {
    const container = render(toolEvent({
      status: "ok",
      tool: "create_task",
      mcp: {
        serverName: "viewer",
        toolName: "create_task",
        args: { project: "viewer", text: "Audit MCP cards" },
        result: { taskId: "task-431" },
      },
    }), new Set());
    const chip = container.querySelector('[data-testid="mcp-link-task"]') as HTMLAnchorElement;
    flushSync(() => chip.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
    expect(detail).toEqual({ kind: "task", id: "task-431" });
  } finally {
    window.removeEventListener("llv:mcp-navigate", listener);
  }
});
