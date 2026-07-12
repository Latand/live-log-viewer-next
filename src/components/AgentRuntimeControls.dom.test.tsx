import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";

import { AgentRuntimeControls } from "./AgentRuntimeControls";

const dom = new Window();
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, HTMLSelectElement: dom.HTMLSelectElement,
  Event: dom.Event, localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
});

const file: FileEntry = {
  path: "/codex.jsonl", root: "codex-sessions", name: "codex.jsonl", project: "viewer", title: "codex",
  engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1, size: 1, activity: "idle",
  proc: "running", pid: 10, conversationId: "conversation_runtime", model: "gpt-5.6-sol", effort: "high", fast: false,
  pendingQuestion: null, waitingInput: null,
};
const key = "llvAgentRuntime:conversation_runtime";
const realFetch = globalThis.fetch;

function mount(): { host: HTMLElement; root: Root } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<AgentRuntimeControls file={file} />));
  return { host, root };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
});

for (const phase of ["pending", "confirming"] as const) {
  test(`editing during ${phase} clears the persisted operation before reload`, async () => {
    localStorage.setItem(key, JSON.stringify({ model: "gpt-5.6-sol", effort: "high", fast: false }));
    localStorage.setItem(key + ":phase", phase);
    const first = mount();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const effort = first.host.querySelector('select[aria-label="Running agent reasoning effort"]') as HTMLSelectElement;
    effort.value = "medium";
    flushSync(() => effort.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event));
    expect(localStorage.getItem(key + ":phase")).toBeNull();
    flushSync(() => first.root.unmount());
    first.host.remove();

    const reloaded = mount();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reloaded.host.textContent).toContain("Apply");
    expect(reloaded.host.textContent).not.toContain("After turn");
    expect(reloaded.host.textContent).not.toContain("Next turn");
    flushSync(() => reloaded.root.unmount());
  });
}

test("an edited draft ignores the previous queued response", async () => {
  let resolveFetch!: (value: Response) => void;
  globalThis.fetch = (() => new Promise<Response>((resolve) => { resolveFetch = resolve; })) as unknown as typeof fetch;
  const mounted = mount();
  const apply = mounted.host.querySelector('button[aria-label="Apply"]') as HTMLButtonElement;
  flushSync(() => apply.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));

  const effort = mounted.host.querySelector('select[aria-label="Running agent reasoning effort"]') as HTMLSelectElement;
  effort.value = "medium";
  flushSync(() => effort.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event));
  resolveFetch({ ok: true, json: async () => ({ ok: true, outcome: "pending" }) } as Response);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(localStorage.getItem(key + ":phase")).toBeNull();
  expect(mounted.host.textContent).toContain("Apply");
  flushSync(() => mounted.root.unmount());
});
