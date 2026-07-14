import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import { translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { RuntimeSessionView } from "@/hooks/useRuntime";
import type { HostAxis } from "@/components/runtime/runtimeModel";

/* Integration/action coverage for the container's real wiring (issue #241
   findings 1, 2 & 7): a running Claude *subagent* pane whose transcript is
   scanner-shaped — proc:null, pid:null, because the root process writes the
   child transcript (src/lib/scanner/transcripts.ts). The strip must still
   appear: its liveness comes from the canonical ROOT host, resolved from the
   runtime store. Stop is enabled and its ESC lands in the root pane
   (`livePaneHost` resolves the canonical root server-side), so one interrupt
   request carrying the subagent path is exactly the root-host resolution. */

const dom = new Window();
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
});

/* The runtime plane is authoritative (enabled) and carries the subagent's live
   root host keyed by its artifact path — the production shape. */
function rootView(host: HostAxis): RuntimeSessionView {
  return {
    session: { host, hostKind: "claude-broker", artifactPath: "/root.jsonl" } as RuntimeSessionView["session"],
    uiState: {} as RuntimeSessionView["uiState"], attentions: [], receipts: [], legacy: false,
  };
}
let rootAxis: HostAxis = "hosted";
// The mock registry is global across test files: keep the runtime plane
// mutable and restore the disabled default in afterAll so later files see
// the same shape as the real hook without a live runtime.
let runtimeEnabled = true;
const actual = await import("@/hooks/useRuntime");
mock.module("@/hooks/useRuntime", () => ({
  ...actual,
  useRuntime: () => ({
    enabled: runtimeEnabled,
    connection: runtimeEnabled ? "live" : "offline",
    resyncedAt: null,
    store: {},
  }),
  useRuntimeSession: () => null,
  useRuntimeSessionByArtifact: (path: string | null) =>
    runtimeEnabled && path === "/root.jsonl" ? rootView(rootAxis) : null,
}));

afterAll(() => {
  runtimeEnabled = false;
});

const { AgentControlStrip } = await import("./AgentControlStrip");

/** Scanner-shaped Claude subagent: its own proc/pid are null (finding 2). */
const subagent: FileEntry = {
  path: "/child.jsonl", root: "claude-projects", name: "child.jsonl", project: "viewer", title: "child",
  engine: "claude", kind: "subagent", fmt: "claude", parent: "/root.jsonl", mtime: 1, size: 1,
  activity: "live", proc: null, pid: null, model: "sonnet", effort: "high", fast: false,
  pendingQuestion: null, waitingInput: null,
} as FileEntry;

const realFetch = globalThis.fetch;

async function mount(file: FileEntry): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<AgentControlStrip file={file} />));
  return { host, root };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  rootAxis = "hosted";
  document.body.replaceChildren();
  localStorage.clear();
});

const stopButton = (host: HTMLElement) =>
  host.querySelector(`button[aria-label^="${translate("en", "composer.interruptAria")}"]`) as HTMLButtonElement | null;

test("a scanner-shaped subagent with a live root renders an ENABLED Stop whose label hits the root agent", async () => {
  const { host, root } = await mount(subagent);
  const stop = stopButton(host);
  expect(stop).not.toBeNull();
  // enabled — never a dead button
  expect(stop!.disabled).toBe(false);
  expect(stop!.getAttribute("aria-disabled")).toBeNull();
  // the root-agent note rides into the accessible label (design §4)
  expect(stop!.getAttribute("aria-label")).toContain(translate("en", "strip.stopSubagent"));
  await act(async () => root.unmount());
});

test("a scanner-shaped subagent whose root is dead stays gated — no strip", async () => {
  rootAxis = "dead";
  const { host, root } = await mount(subagent);
  expect(host.querySelector("[data-agent-control-strip]")).toBeNull();
  await act(async () => root.unmount());
});

test("clicking Stop issues exactly one interrupt request for the pane (root-host resolution)", async () => {
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, target: "root:%1" }) } as unknown as Response);
  }) as typeof fetch;

  const { host, root } = await mount(subagent);
  const stop = stopButton(host)!;
  await act(async () => {
    stop.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const interrupts = calls.filter((c) => c.url.includes("/api/tmux"));
  expect(interrupts.length).toBe(1);
  expect(interrupts[0]!.body).toEqual({ action: "interrupt", path: "/child.jsonl" });
  await act(async () => root.unmount());
});
