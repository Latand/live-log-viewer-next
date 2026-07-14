import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { AgentControlStrip } from "./AgentControlStrip";

/* Integration/action coverage for the container's real wiring (issue #241
   findings 1 & 7): a running Claude *subagent* pane. The design requires the
   root-interrupt capability — an enabled Stop whose ESC lands in the root pane
   (`livePaneHost` resolves the canonical root server-side), so one interrupt
   request carrying the subagent path is exactly the root-host resolution. */

const dom = new Window();
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
});

const subagent: FileEntry = {
  path: "/child.jsonl", root: "claude-projects", name: "child.jsonl", project: "viewer", title: "child",
  engine: "claude", kind: "subagent", fmt: "claude", parent: "/root.jsonl", mtime: 1, size: 1,
  activity: "live", proc: "running", pid: 42, model: "sonnet", effort: "high", fast: false,
  pendingQuestion: null, waitingInput: null,
} as FileEntry;

const realFetch = globalThis.fetch;

function mount(file: FileEntry): { host: HTMLElement; root: Root } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<AgentControlStrip file={file} />));
  return { host, root };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
});

test("a subagent pane renders an ENABLED Stop whose label explains it hits the root agent", () => {
  const { host, root } = mount(subagent);
  const stop = host.querySelector(
    `button[aria-label^="${translate("en", "composer.interruptAria")}"]`,
  ) as HTMLButtonElement | null;
  expect(stop).not.toBeNull();
  // enabled — never a dead button
  expect(stop!.disabled).toBe(false);
  expect(stop!.getAttribute("aria-disabled")).toBeNull();
  // the root-agent note rides into the accessible label (design §4)
  expect(stop!.getAttribute("aria-label")).toContain(translate("en", "strip.stopSubagent"));
  flushSync(() => root.unmount());
});

test("clicking Stop issues exactly one interrupt request for the pane (root-host resolution)", async () => {
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, target: "root:%1" }) } as unknown as Response);
  }) as typeof fetch;

  const { host, root } = mount(subagent);
  const stop = host.querySelector(
    `button[aria-label^="${translate("en", "composer.interruptAria")}"]`,
  ) as HTMLButtonElement;
  flushSync(() => stop.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const interrupts = calls.filter((c) => c.url.includes("/api/tmux"));
  expect(interrupts.length).toBe(1);
  expect(interrupts[0]!.body).toEqual({ action: "interrupt", path: "/child.jsonl" });
  flushSync(() => root.unmount());
});
