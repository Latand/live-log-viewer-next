import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window as HappyWindow } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import type { RuntimeSession, RuntimeSnapshot } from "@/components/runtime/runtimeModel";
import { createRuntimeBus, setRuntimeBusForTests } from "@/hooks/runtimeBus";
import { refreshRuntime } from "@/hooks/useRuntime";
import { FILES_CHANGED_EVENT } from "@/lib/filesEvents";
import type { FileEntry } from "@/lib/types";
import { MobileOrchestratorSheet } from "../mobile/MobileOrchestratorSheet";
import { resetOrchestratorIncumbentCacheForTests } from "./useOrchestratorIncumbent";
import { resetOrchestratorSeatCacheForTests, useOrchestratorSeat } from "./useOrchestratorSeat";
import { useSeatPanel } from "./useSeatPanel";

const dom = new HappyWindow({ innerWidth: 390, innerHeight: 844 });
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node,
  HTMLElement: dom.HTMLElement, Event: dom.Event, CustomEvent: dom.CustomEvent,
  sessionStorage: dom.sessionStorage, localStorage: dom.localStorage,
});
const realFetch = globalThis.fetch;
const nativeTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
const nativeInterval = globalThis.setInterval;
const nativeClearInterval = globalThis.clearInterval;
// Only the feedback's bound and retry cadence use this clock. HTTP promises,
// React, the seat poll and runtime bus retain their actual asynchronous paths.
let clock = 0;
let nextTimer = 10_000;
const timers = new Map<number, { at: number; fn: () => void; repeat: number }>();
let root: Root;
let host: HTMLElement;
let project: string;
let conversationId: string;
let open: boolean;
let hostState: string;
let statusDown: boolean;
let runtimeReady: boolean;
let seq: number;
let refreshSeat: () => Promise<void>;
let catalogReads: number;
const requests: { url: string; method: string; body: unknown }[] = [];
const file = (): FileEntry => ({
  path: "/transcripts/seat.jsonl", name: "seat.jsonl", root: "claude-projects", project,
  title: "Atlas orchestrator", engine: "claude", kind: "session", fmt: "claude",
  parent: null, mtime: 100, size: 1, activity: "live", proc: "running", pid: 42,
  conversationId, model: "opus", cwd: "/repo/atlas", projectRoot: "/repo/atlas",
  pendingQuestion: null, waitingInput: null,
} as FileEntry);
const seat = () => ({
  project, seatEpoch: 4, conversationId, path: file().path, mandate: "Run the board.",
  promptVersion: 4, predecessorConversationId: null, state: "active",
  intent: { clientRequestId: "seatreq-0001", mode: "spawn", launchId: "launch-0001", error: null },
  designatedAt: "2026-09-01T10:00:00Z", activatedAt: "2026-09-01T10:00:02Z",
});
const session = (): RuntimeSession => ({
  conversationId, sessionKey: { engine: "claude", sessionId: "seat-session" },
  hostKind: "claude-broker", host: "hosted", turn: "idle", provenance: "structured",
  revision: seq, attentionIds: [], recentReceipts: [], accountId: null,
  parentConversationId: null, flowId: null, workflowId: null, cwd: "/repo/atlas",
  artifactPath: file().path, capabilities: { steer: true, structuredAttention: true }, activeTurnId: null,
});
const snapshot = (): RuntimeSnapshot => ({
  schemaVersion: 1, snapshotSeq: ++seq, retentionFloorSeq: 0,
  structuredHostsEnabled: true, runtime: { hostEpoch: 1, health: "ok" }, filesRevision: 0,
  sessions: runtimeReady ? [session()] : [], attentions: [], recentOperations: [], edges: [],
  flows: [], workflows: [], tasks: [],
});

function Consumer() {
  const read = useOrchestratorSeat(project);
  refreshSeat = read.refresh;
  const panel = useSeatPanel({ project, files: [file()], seat: read, holdsSeat: true, open });
  if (!open || !panel) return null;
  return <MobileOrchestratorSheet project={project} projectName="Atlas" sheet="seat" now={1_800_000_000}
    state={panel.state} status={panel.status} file={panel.file} incumbent={panel.incumbent}
    pendingMandate={panel.pendingMandate} viewerMcpRegistered={panel.viewerMcpRegistered}
    rotate={panel.rotate} submitting={false} onRecheck={panel.onRecheck}
    onConfirm={() => { throw new Error("unexpected mutation"); }} onOpenConversation={() => {}}
    onClose={() => { open = false; render(); }} />;
}
function render() { flushSync(() => root.render(<Consumer />)); }
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => nativeTimeout(resolve, 5));
  flushSync(() => {});
}
async function advance(ms: number) {
  const end = clock + ms;
  while (true) {
    const entry = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
    if (!entry) break;
    const [id, timer] = entry;
    clock = timer.at;
    if (timer.repeat) timer.at += timer.repeat;
    else timers.delete(id);
    flushSync(timer.fn);
    await settle();
  }
  clock = end;
}
const rebind = () => host.querySelector<HTMLButtonElement>("[data-orchestrator-rebind]");
const reason = () => host.querySelector("[data-orchestrator-bind-failure]")?.getAttribute("data-orchestrator-bind-failure") ?? null;
const incumbentReads = () => requests.filter((r) => r.url.includes("/seat/status")).length;
const catalogListener = () => { catalogReads++; };

beforeEach(() => {
  resetOrchestratorIncumbentCacheForTests();
  resetOrchestratorSeatCacheForTests();
  clock = 0; timers.clear(); requests.length = 0; seq = 0; catalogReads = 0;
  project = "atlas"; conversationId = "conv_seat"; open = true;
  hostState = "alive"; statusDown = false; runtimeReady = false;
  globalThis.setTimeout = ((fn: () => void, ms: number, ...args: unknown[]) => {
    if (ms !== 10_000) return nativeTimeout(fn, ms, ...args);
    const id = nextTimer++; timers.set(id, { at: clock + ms, fn, repeat: 0 }); return id;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((id: number) => { if (!timers.delete(id)) nativeClearTimeout(id); }) as typeof clearTimeout;
  globalThis.setInterval = ((fn: () => void, ms: number, ...args: unknown[]) => {
    if (ms !== 2_000) return nativeInterval(fn, ms, ...args);
    const id = nextTimer++; timers.set(id, { at: clock + ms, fn, repeat: ms }); return id;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id: number) => { if (!timers.delete(id)) nativeClearInterval(id); }) as typeof clearInterval;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? "GET", body: init?.body });
    if (init?.method && init.method !== "GET") throw new Error("unexpected mutation");
    if (url.includes("/seat/status")) return Response.json({ project, designated: true, conversationId,
      engine: "claude", model: "opus", liveness: { hostState, lifecycle: "running" } }, { status: statusDown ? 503 : 200 });
    if (url.includes("/orchestrator/seat?")) return Response.json({ seat: seat(), pending: null, exists: true });
    if (url.includes("/runtime/snapshot")) return Response.json(snapshot());
    if (url.includes("/accounts")) return Response.json({ claude: { accounts: [] }, codex: { accounts: [] } });
    return Response.json({});
  }) as typeof fetch;
  const bus = createRuntimeBus({
    fetch: (url, init) => fetch(url, init), now: Date.now,
    createEventSource: () => ({ onopen: null, onerror: null, onmessage: null, addEventListener() {}, close() {} }),
    setTimeout: nativeTimeout, clearTimeout: nativeClearTimeout,
    setInterval: nativeInterval, clearInterval: nativeClearInterval,
  });
  setRuntimeBusForTests(bus);
  dom.addEventListener(FILES_CHANGED_EVENT, catalogListener);
  host = dom.document.createElement("div") as unknown as HTMLElement;
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  setRuntimeBusForTests(null);
  dom.removeEventListener(FILES_CHANGED_EVENT, catalogListener);
  globalThis.fetch = realFetch;
  globalThis.setTimeout = nativeTimeout; globalThis.clearTimeout = nativeClearTimeout;
  globalThis.setInterval = nativeInterval; globalThis.clearInterval = nativeClearInterval;
  dom.document.body.replaceChildren(); dom.localStorage.clear(); dom.sessionStorage.clear();
});

test("actual useSeatPanel and runtime bus clear the same seat only after Re-bind fetches a resolved snapshot", async () => {
  render(); await settle();
  await advance(9_999); expect(rebind()).toBeNull();
  await advance(1); expect(reason()).toBe("surface");
  const before = requests.length;
  flushSync(() => rebind()!.click()); await settle();
  expect(reason()).toBe("surface");
  runtimeReady = true; // No unsolicited response: the next read must fetch it.
  expect(reason()).toBe("surface");
  flushSync(() => rebind()!.click()); await settle();
  expect(reason()).toBeNull(); expect(rebind()).toBeNull();
  expect(host.querySelector('[data-mobile2-sheet="seat"]')).not.toBeNull();
  const reads = requests.slice(before);
  for (const path of ["/seat?", "/seat/status", "/runtime/snapshot"]) {
    expect(reads.filter((r) => r.url.includes(path))).toHaveLength(2);
  }
  expect(catalogReads).toBe(2);
  expect(reads.every((r) => r.method === "GET" && r.body === undefined)).toBe(true);
  expect(dom.localStorage.length).toBe(0); expect(dom.sessionStorage.length).toBe(0);
});

for (const evidence of ["gone", "unknown", "stale", "bound"] as const) {
  test(`${evidence} evidence never offers Re-bind past the bound`, async () => {
    if (evidence === "bound") runtimeReady = true;
    else if (evidence !== "stale") hostState = evidence;
    render(); await settle();
    if (evidence === "stale") {
      statusDown = true;
      // Closing/reopening reacquires status; the retained live reading becomes stale.
      open = false; render(); open = true; render(); await settle();
    }
    await advance(10_000);
    expect(rebind()).toBeNull(); expect(reason()).toBeNull();
  });
}

test("failed status retries every 2s only while open and unresolved, then stops on fresh evidence", async () => {
  statusDown = true; render(); await settle();
  await advance(10_000); expect(rebind()).toBeNull();
  const before = incumbentReads(); statusDown = false;
  await advance(2_000); expect(incumbentReads()).toBeGreaterThan(before);
  expect(reason()).toBe("surface");
  const fresh = incumbentReads(); await advance(4_000); expect(incumbentReads()).toBe(fresh);
});

for (const change of ["project", "seat", "close", "bound"] as const) {
  test(`${change} resets the grace interval and cancels the old timer`, async () => {
    render(); await settle(); await advance(8_000);
    if (change === "project") project = "beacon";
    if (change === "seat") conversationId = "conv_successor";
    if (change === "close") open = false;
    if (change === "bound") { runtimeReady = true; await refreshRuntime(); await settle(); }
    render(); await settle();
    // Update the caller's existing read without remounting useSeatPanel.
    if (change === "seat") { await refreshSeat(); await settle(); }
    await advance(2_000); expect(rebind()).toBeNull();
    if (change === "close") { open = true; render(); await settle(); }
    if (change === "bound") { runtimeReady = false; await refreshRuntime(); await settle(); }
    await advance(7_999); expect(rebind()).toBeNull();
    await advance(change === "project" || change === "seat" ? 1 : 2_001); expect(reason()).toBe("surface");
  });
}

test("unmount removes retry and bound timers", async () => {
  statusDown = true; render(); await settle();
  expect(timers.size).toBeGreaterThan(0);
  flushSync(() => root.render(null));
  expect(timers.size).toBe(0);
  const before = incumbentReads(); await advance(20_000); expect(incumbentReads()).toBe(before);
});

test("a bounded failure that binds gets a new full grace interval on becoming unresolved again", async () => {
  render(); await settle(); await advance(10_000); expect(reason()).toBe("surface");
  runtimeReady = true; await refreshRuntime(); await settle(); expect(reason()).toBeNull();
  runtimeReady = false; await refreshRuntime(); await settle();
  expect(rebind()).toBeNull(); await advance(9_999); expect(rebind()).toBeNull();
  await advance(1); expect(reason()).toBe("surface");
});

test("closing a stale unresolved sheet cancels retries and reopening starts a fresh bound", async () => {
  statusDown = true; render(); await settle(); await advance(10_000);
  open = false; render(); await settle();
  expect(timers.size).toBe(0);
  const closed = incumbentReads(); await advance(20_000); expect(incumbentReads()).toBe(closed);
  statusDown = false; open = true; render(); await settle();
  expect(incumbentReads()).toBeGreaterThan(closed); expect(rebind()).toBeNull();
  await advance(9_999); expect(rebind()).toBeNull(); await advance(1); expect(reason()).toBe("surface");
});

test("the live status sheet budgets its footer above an overlay keyboard", async () => {
  render(); await settle(); await advance(10_000);
  const viewport = new dom.EventTarget();
  Object.assign(viewport, { height: 524, offsetTop: 0, scale: 1 });
  Object.defineProperty(dom, "visualViewport", { configurable: true, value: viewport });
  // Subscribe while the viewport exists, as it does in a browser.
  open = false; render(); open = true; render(); await settle();
  viewport.dispatchEvent(new dom.Event("resize")); await settle();
  const wrapper = host.querySelector<HTMLElement>('[style*="--seat-keyboard-inset"]');
  expect(wrapper?.style.getPropertyValue("--seat-keyboard-inset")).toBe("320px");
  Object.assign(viewport, { height: 844 }); viewport.dispatchEvent(new dom.Event("resize")); await settle();
  expect(wrapper?.style.getPropertyValue("--seat-keyboard-inset")).toBe("0px");
  Object.defineProperty(dom, "visualViewport", { configurable: true, value: undefined });
});
