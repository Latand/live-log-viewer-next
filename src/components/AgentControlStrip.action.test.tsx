import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import { translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";
import type { RuntimeSessionView } from "@/hooks/useRuntime";
import type { HostAxis, HostKind } from "@/components/runtime/runtimeModel";

/* Integration/action coverage for the container's real wiring (issue #241
   findings 1, 2 & 7): a running Claude *subagent* pane whose transcript is
   scanner-shaped — proc:null, pid:null, because the root process writes the
   child transcript (src/lib/scanner/transcripts.ts). The strip's liveness comes
   from the canonical ROOT host, and its ROUTING follows the root's kind:
   - a live claude-broker (structured) root → Stop relays to the root's
     structured interrupt (/api/runtime/interrupt), Kill/images disabled, and
     zero /api/tmux + /api/proc requests fire.
   - a live tmux-legacy root → Stop keeps the canonical /api/tmux child path. */

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event,
  localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
});

/* Recording ResizeObserver: happy-dom has none, and the strip's width folding
   must attach its observer even when the strip root mounts LATE (#257 — the
   gated/unresolved surface renders nothing until host evidence arrives). */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  constructor(private cb: (entries: { contentRect: { width: number } }[]) => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element): void {
    this.observed.push(el);
  }
  unobserve(): void {}
  disconnect(): void {
    this.observed = [];
  }
  resize(width: number): void {
    this.cb([{ contentRect: { width } }]);
  }
}
Object.assign(globalThis, { ResizeObserver: FakeResizeObserver });

/* The runtime plane is authoritative (enabled) and carries the subagent's root
   host keyed by its artifact path — the production shape. */
function rootView(kind: HostKind, host: HostAxis): RuntimeSessionView {
  return {
    session: { hostKind: kind, host, artifactPath: "/root.jsonl", conversationId: "conv-root" } as RuntimeSessionView["session"],
    uiState: {} as RuntimeSessionView["uiState"], attentions: [], receipts: [], legacy: kind === "tmux-legacy", structuredControlsEnabled: true,
  };
}
let rootKind: HostKind = "claude-broker";
let rootAxis: HostAxis = "hosted";
// The mock registry is global across files: keep the plane mutable and flip it
// off in afterAll so later suites (BranchPane.render SSR) see the disabled
// default shape without a live runtime — a re-mock to the real module does not
// reliably un-bind already-loaded consumers, but flipping the flag does.
let planeEnabled = true;
const actual = await import("@/hooks/useRuntime");
mock.module("@/hooks/useRuntime", () => ({
  ...actual,
  useRuntime: () => ({ enabled: planeEnabled, connection: planeEnabled ? "live" : "offline", resyncedAt: null, store: {} }),
  useRuntimeSession: () => null,
  useRuntimeSessionByArtifact: (path: string | null) => (planeEnabled && path === "/root.jsonl" ? rootView(rootKind, rootAxis) : null),
}));

afterAll(() => {
  planeEnabled = false;
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
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
  rootKind = "claude-broker";
  rootAxis = "hosted";
  FakeResizeObserver.instances = [];
  document.body.replaceChildren();
  localStorage.clear();
});

const stopButton = (host: HTMLElement) =>
  host.querySelector(`button[aria-label^="${translate("en", "composer.interruptAria")}"]`) as HTMLButtonElement | null;

test("a scanner-shaped subagent with a live structured root renders an ENABLED Stop with the root-agent note", async () => {
  const { host, root } = await mount(subagent);
  expect(host.querySelector('[data-strip-surface="structured-subagent"]')).not.toBeNull();
  const stop = stopButton(host);
  expect(stop).not.toBeNull();
  expect(stop!.disabled).toBe(false);
  expect(stop!.getAttribute("aria-disabled")).toBeNull();
  expect(stop!.getAttribute("aria-label")).toContain(translate("en", "strip.stopSubagent"));
  await act(async () => root.unmount());
});

test("a scanner-shaped subagent whose root is dead stays gated — no strip", async () => {
  rootAxis = "dead";
  const { host, root } = await mount(subagent);
  expect(host.querySelector("[data-agent-control-strip]")).toBeNull();
  await act(async () => root.unmount());
});

test("the width observer attaches when the strip mounts late (gated → live root) and folds the layout", async () => {
  // The root host is not live yet: the strip renders nothing, so nothing is observed.
  rootAxis = "dead";
  const { host, root } = await mount(subagent);
  expect(host.querySelector("[data-agent-control-strip]")).toBeNull();
  expect(FakeResizeObserver.instances.reduce((n, o) => n + o.observed.length, 0)).toBe(0);

  // Host evidence arrives: the strip root mounts NOW, and the observer must
  // attach to it (a mount-once effect would have missed this late mount).
  rootAxis = "hosted";
  await act(async () => root.render(<AgentControlStrip file={subagent} />));
  expect(host.querySelector("[data-agent-control-strip]")).not.toBeNull();
  const attached = FakeResizeObserver.instances.filter((o) => o.observed.length > 0);
  expect(attached).toHaveLength(1);

  // Measured width drives the §3 faces: <430 folds to narrow, <300 to mini.
  await act(async () => attached[0]!.resize(360));
  expect(host.querySelector('[data-strip-layout="narrow"]')).not.toBeNull();
  await act(async () => attached[0]!.resize(250));
  expect(host.querySelector('[data-strip-layout="mini"]')).not.toBeNull();
  await act(async () => attached[0]!.resize(600));
  expect(host.querySelector('[data-strip-layout="full"]')).not.toBeNull();
  await act(async () => root.unmount());
});

test("Stop on a structured-root subagent relays to the root's structured interrupt — zero /api/tmux, /api/proc", async () => {
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, operationId: "op-1" }) } as unknown as Response);
  }) as typeof fetch;

  const { host, root } = await mount(subagent);
  const stop = stopButton(host)!;
  await act(async () => {
    stop.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  // exactly one root structured interrupt, carrying the ROOT conversationId
  const interrupts = calls.filter((c) => c.url.includes("/api/runtime/interrupt"));
  expect(interrupts.length).toBe(1);
  expect((interrupts[0]!.body as { conversationId?: string }).conversationId).toBe("conv-root");
  // never the legacy routes for a structured root
  expect(calls.some((c) => c.url.includes("/api/tmux"))).toBe(false);
  expect(calls.some((c) => c.url.includes("/api/proc"))).toBe(false);
  await act(async () => root.unmount());
});

test("Stop on a live TMUX-root subagent keeps the canonical /api/tmux child path", async () => {
  rootKind = "tmux-legacy";
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, target: "root:%1" }) } as unknown as Response);
  }) as typeof fetch;

  const { host, root } = await mount(subagent);
  expect(host.querySelector('[data-strip-surface="live-subagent"]')).not.toBeNull();
  const stop = stopButton(host)!;
  await act(async () => {
    stop.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  const interrupts = calls.filter((c) => c.url.includes("/api/tmux"));
  expect(interrupts.length).toBe(1);
  expect(interrupts[0]!.body).toEqual({ action: "interrupt", path: "/child.jsonl" });
  expect(calls.some((c) => c.url.includes("/api/runtime/interrupt"))).toBe(false);
  await act(async () => root.unmount());
});
