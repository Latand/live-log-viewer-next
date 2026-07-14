import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";

import { AgentRuntimeControls, ResumeRuntimeControls, readResumeDraft, savedResumeProfile } from "./AgentRuntimeControls";

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

test("the on-resume profile (issue #241 §4) persists under a :resume key and round-trips", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<ResumeRuntimeControls file={file} />));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const effort = host.querySelector('select[aria-label="Running agent reasoning effort"]') as HTMLSelectElement;
  effort.value = "medium";
  flushSync(() => effort.dispatchEvent(new dom.Event("change", { bubbles: true }) as unknown as Event));
  const apply = host.querySelector('button[aria-label="Apply"]') as HTMLButtonElement;
  flushSync(() => apply.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));

  // saved under the dedicated resume key — never touching the live-runtime key
  expect(localStorage.getItem(key + ":resume")).toContain('"effort":"medium"');
  expect(localStorage.getItem(key)).toBeNull();
  // and readResumeDraft (what the spawn path reads at send time) returns it
  expect(readResumeDraft(file).effort).toBe("medium");
  flushSync(() => root.unmount());
});

test("savedResumeProfile is null without saved state, so resume sends zero overrides (finding 4)", () => {
  // No saved profile — display defaults must NOT leak into the send as overrides.
  expect(savedResumeProfile(file)).toBeNull();
  // …but the picker still needs a concrete draft to display.
  expect(readResumeDraft(file).model).toBe("gpt-5.6-sol");
});

test("savedResumeProfile returns the applied profile once one is explicitly saved (finding 4)", () => {
  localStorage.setItem(key + ":resume", JSON.stringify({ model: "gpt-5.6-sol", effort: "medium", fast: false }));
  const saved = savedResumeProfile(file);
  expect(saved?.model).toBe("gpt-5.6-sol");
  expect(saved?.effort).toBe("medium");
});

test("readResumeDraft clamps an out-of-range persisted effort back to the file default", () => {
  localStorage.setItem(key + ":resume", JSON.stringify({ model: "gpt-5.6-sol", effort: "not-a-real-effort", fast: false }));
  const draft = readResumeDraft(file);
  expect(draft.model).toBe("gpt-5.6-sol");
  expect(draft.effort).toBe("high"); // the file's own effort, since the stored one is invalid
});

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
