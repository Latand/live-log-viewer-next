import { afterEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { RuntimeSessionView } from "@/hooks/useRuntime";
import type { HostAxis, HostKind } from "@/components/runtime/runtimeModel";

/* Finding 2 (issue #241 §4): the header Kill must obey the one capability matrix
   rather than posting to `/api/proc` on every running PID. A structured host
   shows a *disabled* Kill with the #240 tooltip; a dead host omits it; only a
   live tmux root (or a shell task) actually hits the endpoint. `useRuntimeSession`
   is mocked so each surface can be exercised deterministically. */

let currentRv: RuntimeSessionView | null = null;
const actual = await import("@/hooks/useRuntime");
mock.module("@/hooks/useRuntime", () => ({ ...actual, useRuntimeSession: () => currentRv }));

const { ProcessStatusControls } = await import("./TaskHeader");

const dom = new Window();
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
});

function rv(hostKind: HostKind, host: HostAxis): RuntimeSessionView {
  return { session: { hostKind, host } as RuntimeSessionView["session"], uiState: {} as RuntimeSessionView["uiState"], attentions: [], receipts: [], legacy: false };
}

function file(over: Partial<FileEntry> = {}): FileEntry {
  return {
    path: "/c.jsonl", root: "claude-projects", name: "c.jsonl", project: "viewer", title: "c",
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: 1, size: 1,
    activity: "live", proc: "running", pid: 77, model: "sonnet", effort: "high", fast: false,
    pendingQuestion: null, waitingInput: null, ...over,
  } as FileEntry;
}

const realFetch = globalThis.fetch;

function mount(f: FileEntry): { host: HTMLElement; root: Root } {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<ProcessStatusControls file={f} />));
  return { host, root };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  currentRv = null;
  document.body.replaceChildren();
});

const killBtns = (host: HTMLElement) =>
  Array.from(host.querySelectorAll("button")).filter((b) => (b.textContent ?? "").includes(translate("en", "task.kill")));

test("a live tmux root shows an enabled Kill that confirms then posts to /api/proc", async () => {
  currentRv = null; // no structured host → live-root
  const calls: string[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push(String(url));
    void init;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, pid: 77 }) } as unknown as Response);
  }) as typeof fetch;

  const { host, root } = mount(file());
  const kill = killBtns(host)[0]!;
  expect(kill.disabled).toBe(false);
  // first click arms the confirmation, no request yet
  flushSync(() => kill.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event));
  expect(calls.length).toBe(0);
  const confirm = Array.from(host.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(translate("en", "task.confirmKillYes")))!;
  flushSync(() => confirm.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event));
  await new Promise((r) => setTimeout(r, 0));
  expect(calls.filter((u) => u.includes("/api/proc")).length).toBe(1);
  flushSync(() => root.unmount());
});

test("a structured host shows a DISABLED Kill with the #240 reason and never posts", () => {
  currentRv = rv("codex-app-server", "hosted");
  const calls: string[] = [];
  globalThis.fetch = ((url: string) => { calls.push(String(url)); return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as unknown as Response); }) as typeof fetch;

  const { host, root } = mount(file());
  const kill = killBtns(host)[0]!;
  expect(kill.disabled).toBe(true);
  expect(kill.getAttribute("aria-label")).toContain(translate("en", "strip.awaits240"));
  // clicking a disabled control does nothing — no /api/proc, no capability bypass
  flushSync(() => kill.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event));
  expect(calls.length).toBe(0);
  flushSync(() => root.unmount());
});

test("a dead host omits the Kill control entirely (the banner owns recovery)", () => {
  currentRv = rv("claude-broker", "dead");
  const { host, root } = mount(file());
  expect(killBtns(host).length).toBe(0);
  flushSync(() => root.unmount());
});
