import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { OrchestratorChatButton } from "./OrchestratorChatButton";

const dom = new Window({ url: "http://127.0.0.1/" });
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

let root: Root | null = null;
const realFetch = globalThis.fetch;
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  globalThis.fetch = realFetch;
  dom.window.location.hash = "";
});

function render(node: React.ReactElement): HTMLElement {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  root = createRoot(container as unknown as Element);
  flushSync(() => root!.render(node));
  return container as unknown as HTMLElement;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test("a click on a live record navigates to the orchestrator deep link", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ record: { conversationId: "conv-1", path: "/t.jsonl" }, exists: true, defaultCwd: "/repo" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  const container = render(<OrchestratorChatButton />);
  const button = container.querySelector("button")!;
  expect(button.getAttribute("aria-label")).toBe("Open the orchestrator chat");

  flushSync(() => button.click());
  await settle();
  expect(dom.window.location.hash).toBe("#c=conv-1");
  expect(button.hasAttribute("disabled")).toBe(false);
});

test("a failed resolve flips the button into the retryable error state", async () => {
  globalThis.fetch = (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
  const container = render(<OrchestratorChatButton />);
  const button = container.querySelector("button")!;

  flushSync(() => button.click());
  await settle();
  flushSync(() => {});
  expect(button.textContent).toContain("Couldn't open the orchestrator");
  expect(button.hasAttribute("disabled")).toBe(false);
  expect(dom.window.location.hash).toBe("");
});
