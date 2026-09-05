/** Mounted composer/feed regression and original-operation action proof for #1538. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import { useRuntimeReceiptsForArtifact, type RuntimeSessionView } from "@/hooks/useRuntime";
import { setRuntimeUiEnabledForTests } from "@/hooks/runtimeBus";
import type { FileEntry } from "@/lib/types";
import { setLocale, translate } from "@/lib/i18n";
import { attachModeFor, capabilitiesFor } from "./agentCapabilities";
import { setTmuxComposerRuntimeDependenciesForTests } from "./tmuxComposerRuntime";
import { useAgentCapabilities } from "./useAgentCapabilities";
import { runtimeReceiptForSend } from "@/lib/runtime/sendSettlement";
import type { SendReceipt } from "@/lib/runtime/sendSettlement";
import type { RuntimeReceipt } from "./runtime/runtimeModel";

const dom = new Window();
installActEnv();
class ImmediateFileReader {
  result: string | null = null;
  error: null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  readAsDataURL(file: File): void {
    const mime = file.type || "image/png";
    this.result = `data:${mime};base64,${Buffer.from(file.name).toString("base64")}`;
    queueMicrotask(() => this.onload?.());
  }
}
Object.assign(globalThis, {
  ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  File: dom.File,
  FileReader: ImmediateFileReader,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
});
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

/* A live structured codex-app-server host for the conversation: the send path
   must take `sendRuntimeMessage`, not the legacy /api/tmux POST. */
const structuredView: RuntimeSessionView = {
  session: {
    conversationId: "conv-snapshot",
    hostKind: "codex-app-server",
    host: "hosted",
    capabilities: { imageInput: { supported: true }, runtimeSettings: { perTurnEffort: true, perTurnModel: false } },
    recentReceipts: [],
  },
  uiState: {},
  attentions: [],
  receipts: [],
  legacy: false,
  structuredControlsEnabled: true,
} as unknown as RuntimeSessionView;

import { LogFeed } from "./LogFeed";
import { setLogFeedDependenciesForTests } from "./logFeedDependencies";
import { TmuxComposer, RuntimeComposerReceipts } from "./TmuxComposer";
import { writeProfile } from "./runtimeProfile";
import { enqueueOutbox, updateOutbox, visibleOutbox, readOutbox, resetOutboxForTests, retryOutbox, cancelOutbox, publishTranscriptEchoes } from "./conversation/outbox";

let snapshotReceipts: RuntimeReceipt[] = [];
let realReceiptHook = false;

const realFetch = globalThis.fetch;

beforeEach(() => {
  snapshotReceipts = [];
  realReceiptHook = false;
  setLogFeedDependenciesForTests({ useLogTail: () => ({ lines: [], linesStart: 0, size: 0, loading: false, error: null, tickTime: null, paused: false, setPaused() {}, clear() {}, hasMore: false, loadingOlder: false, loadOlder: async () => 0, prependGen: 0 }) });
  setRuntimeUiEnabledForTests(false);
  setTmuxComposerRuntimeDependenciesForTests({
    useAgentCapabilities: (candidate) => {
      const real = useAgentCapabilities(candidate);
      if (candidate.path !== "/codex-snapshot.jsonl" && candidate.conversationId !== "conv-snapshot") return real;
      const options = { runtimeEnabled: true };
      return {
        caps: capabilitiesFor(candidate, structuredView, options),
        runtime: structuredView,
        structuredSession: structuredView,
        runtimeEnabled: true,
        attachMode: attachModeFor(candidate, structuredView, options),
      };
    },
    useRuntimeReceiptsForArtifact: (path, conversationId) => {
      const real = useRuntimeReceiptsForArtifact(path, conversationId);
      return !realReceiptHook && (path === "/codex-snapshot.jsonl" || conversationId === "conv-snapshot") ? snapshotReceipts : real;
    },
  });
});

afterEach(() => {
  setLogFeedDependenciesForTests(null);
  setTmuxComposerRuntimeDependenciesForTests(null);
  setRuntimeUiEnabledForTests(null);
  setLocale("en");
  structuredView.session.host = "hosted";
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  resetOutboxForTests();
});

/** Queue-first retry (round-1 P1#1): the failed bubble re-queues under its
    original idempotency key, so the dispatcher replays it — the queue-first
    equivalent of the old "re-submit the retained draft" retry. */
function retryFailed(conversationId = "conv-snapshot"): void {
  const failed = readOutbox(conversationId).find((entry) => entry.state === "failed");
  if (failed) retryOutbox(conversationId, failed.id);
}

const file: FileEntry = {
  path: "/codex-snapshot.jsonl", root: "codex-sessions", name: "codex-snapshot.jsonl", project: "viewer",
  title: "Codex", engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1,
  size: 1, activity: "idle", proc: "running", pid: null, conversationId: "conv-snapshot",
  model: "gpt-5.6-sol", effort: "high", fast: false, pendingQuestion: null, waitingInput: null,
} as FileEntry;

interface SendBody {
  idempotencyKey: string;
  text: string;
  images?: Array<{ base64: string; mime: string }>;
  runtime?: { model?: string; effort?: string; fast?: boolean };
}

/** Wire mock: records every /api/runtime/send body; `respond` scripts each
    response in order (a 500 keeps the key retryable, a delivered receipt
    settles it). */
function mockWire(sends: SendBody[], respond: Array<(body: SendBody) => { status: number; json: unknown }>): void {
  let call = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: { body?: string }) => {
    const url = String(input);
    if (url === "/api/tmux/targets") return { ok: true, status: 200, json: async () => ({ targets: {} }) } as Response;
    if (url !== "/api/runtime/send") throw new Error(`unexpected request: ${url}`);
    const body = JSON.parse(init?.body ?? "{}") as SendBody;
    sends.push(body);
    const script = respond[Math.min(call++, respond.length - 1)]!(body);
    return { ok: script.status < 400, status: script.status, json: async () => script.json } as Response;
  }) as typeof fetch;
}

async function renderInto(node: React.ReactElement): Promise<{ host: HTMLElement; root: Root }> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
    await new Promise((r) => setTimeout(r, 0));
  });
  return { host, root };
}

const settle = async (fn: () => void) => {
  await act(async () => {
    fn();
    await new Promise((r) => setTimeout(r, 0));
  });
};

/** Type into the composer through its React props (happy-dom input events do
    not reach React's synthetic onChange) and submit the form. */
function composerControls(host: HTMLElement) {
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const form = textarea.closest("form")!;
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const type = (value: string) =>
    (textarea as unknown as Record<string, { onChange: (e: unknown) => void }>)[propsKey]!
      .onChange({ target: { value } });
  const submit = () => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
  return { type, submit };
}


// Sanitized shape of the captured original-operation receipt from #1538.
const captured: RuntimeReceipt = {
  operationId: "operation-uncertain", idempotencyKey: "key-uncertain",
  conversationId: "conv-snapshot", kind: "send", status: "failed",
  at: "2026-09-05T08:00:01.000Z", admittedAt: "2026-09-05T08:00:00.000Z",
  revision: 4, resend: "verify-first",
  reason: "Dispatch began; recipient transcript unavailable; arrival unverified",
  text: "Check the release status",
};
const surface = () => <><LogFeed file={file} showSvc={false} lineFilter="" onStatus={() => {}} paused={false} follow={false} setFollow={() => {}} /><TmuxComposer file={file} /></>;

test("captured verify-first receipt stays unknown in mounted composer and feed without local retry", async () => {
  const sends: SendBody[] = [];
  mockWire(sends, [{ status: 503, json: {} }].map(response => () => response));
  enqueueOutbox(file.conversationId!, { id: captured.idempotencyKey, text: captured.text!, images: 0, at: Date.parse(captured.admittedAt!) });
  updateOutbox(file.conversationId!, captured.idempotencyKey, { state: "delivering" });
  snapshotReceipts = [captured];
  const { host, root } = await renderInto(surface());
  try {
    const bubble = host.querySelector("[data-outbox-entry]")!;
    expect(bubble.textContent).toContain("outcome is unknown");
    expect(host.textContent).not.toMatch(/not delivered/i);
    expect(bubble.querySelector("[data-outbox-retry], [data-outbox-cancel]")).toBeNull();
    retryOutbox(file.conversationId!, captured.idempotencyKey);
    expect(readOutbox(file.conversationId!)[0]?.state).toBe("delivering");
    expect(sends).toHaveLength(0);
  } finally { await act(async () => root.unmount()); }
});


test.each(["failed", "uncertain"] as const)("textless %s receipt polling and remount retain unknown history, announcement and original controls", async status => {
  const calls: { url: string; method?: string; body?: string }[] = [];
  let receipt: RuntimeReceipt = { ...captured, status, text: undefined };
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/api/runtime/operations/")) {
      calls.push({ url, method: init?.method, body: init?.body as string });
      return Response.json({ receipt });
    }
    if (init?.method === "POST" && (url === "/api/runtime/send" || url === "/api/tmux")) calls.push({ url, method: init.method, body: init.body as string });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const { createRuntimeBus, setRuntimeBusForTests } = await import("@/hooks/runtimeBus");
  let snapshotSeq = 1;
  let polls = 0;
  const bus = createRuntimeBus({
    fetch: async () => {
      polls++;
      return Response.json({ schemaVersion: 1, snapshotSeq, retentionFloorSeq: 0,
        runtime: { hostEpoch: 1, health: "ready" }, filesRevision: 1, sessions: [{ ...structuredView.session, artifactPath: file.path, attentionIds: [], revision: snapshotSeq, turn: "idle", recentReceipts: [receipt] }], attentions: [],
        recentOperations: [receipt], edges: [], flows: [], workflows: [], tasks: [] });
    },
    createEventSource: () => ({ onopen: null, onerror: null, onmessage: null, close() {}, addEventListener() {} }),
    now: Date.now, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  realReceiptHook = true;
  setRuntimeBusForTests(bus);
  bus.start();
  await settle(() => {});
  let mounted = await renderInto(surface());
  const check = () => {

    expect(mounted.host.textContent).not.toMatch(/not delivered/i);
    expect(mounted.host.querySelector("[data-runtime-receipt-status]")?.textContent).toMatch(/outcome is unknown/i);
    const row = mounted.host.querySelector("[data-receipt-standalone-row]")!;
    expect(row.textContent).toMatch(/outcome is unknown/i);
    expect(row.textContent).toContain(captured.reason!);
    expect(row.querySelector("[data-receipt-discard]")?.textContent).toBe("Discard");
    expect(row.querySelector("[data-operation]")?.getAttribute("data-operation")).toBe(captured.operationId);
    expect(row.querySelector("[data-receipt-edit], [data-outbox-retry], [data-outbox-cancel]")).toBeNull();
  };
  try {
    check();
    // A new receipt snapshot from polling keeps the optional echo absent.
    receipt = { ...receipt, revision: 5 };
    snapshotSeq++;
    await act(async () => { expect(await bus.refresh()).toBe(true); });
    expect(polls).toBeGreaterThanOrEqual(2);
    check();
    await act(async () => mounted.root.unmount());
    resetOutboxForTests();
    mounted = await renderInto(surface());
    check();
    const details = mounted.host.querySelector<HTMLDetailsElement>("details[data-runtime-receipt-stack]")!;
    await settle(() => { details.open = true; details.dispatchEvent(new dom.Event("toggle") as unknown as Event); });
    await settle(() => mounted.host.querySelector<HTMLButtonElement>("[data-receipt-uncertain-retry]")!.click());
    expect(calls).toEqual([{ url: `/api/runtime/operations/${captured.operationId}`, method: "POST", body: JSON.stringify({ action: "retry-uncertain" }) }]);
    receipt = { ...receipt, status: "failed", revision: 6, reason: "delivery-discarded", resend: "not-needed" };
    await settle(() => mounted.host.querySelector<HTMLButtonElement>("[data-receipt-discard]")!.click());
    expect(Boolean(mounted.host.querySelector("[data-receipt-uncertain-retry], [data-receipt-discard]"))).toBe(false);
    expect(calls[1]).toEqual({ url: `/api/runtime/operations/${captured.operationId}`, method: "DELETE", body: undefined });
    expect(mounted.host.querySelector("[data-receipt-discard], [data-receipt-uncertain-retry]")).toBeNull();
    expect(calls).toHaveLength(2);
  } finally { await act(async () => mounted.root.unmount()); bus.stop(); }
});

test("repeated operation records share one recovery row across text changes and stale dismissals", async () => {
  const actions: string[] = [];
  let receipts: RuntimeReceipt[] = [
    { ...captured, revision: 2, text: "older summary" },
    { ...captured, revision: 4, text: undefined },
    { ...captured, revision: 3, text: "" },
  ];
  const render = () => <RuntimeComposerReceipts receipts={receipts} dismissed={new Set([captured.operationId])}
    onRetry={(receipt, mode) => actions.push(`${receipt.operationId}:${mode}`)}
    onDiscard={receipt => actions.push(`${receipt.operationId}:discard`)} onEdit={() => actions.push("edit")}
    onDismiss={() => actions.push("dismiss")} />;
  const mounted = await renderInto(render());
  try {
    expect(mounted.host.querySelectorAll("[data-receipt-uncertain-retry]")).toHaveLength(1);
    expect(mounted.host.querySelectorAll("[data-receipt-discard]")).toHaveLength(1);
    expect(mounted.host.querySelectorAll("[data-receipt-dismiss], [data-delivery-notice-dismiss]")).toHaveLength(0);
    await settle(() => mounted.host.querySelector<HTMLButtonElement>("[data-receipt-uncertain-retry]")!.click());
    await settle(() => mounted.host.querySelector<HTMLButtonElement>("[data-receipt-discard]")!.click());
    expect(actions).toEqual([`${captured.operationId}:uncertain`, `${captured.operationId}:discard`]);
    receipts = [{ ...captured, revision: 5, status: "delivered", resend: "not-needed" }, ...receipts];
    await settle(() => mounted.root.render(render()));
    expect(mounted.host.querySelectorAll("[data-receipt-uncertain-retry], [data-receipt-discard]")).toHaveLength(0);
  } finally { await act(async () => mounted.root.unmount()); }
});

test.each([captured.text, "", undefined].flatMap(text => ["delivered", "discarded"].map(terminal => ({ text, terminal }))))("each original operation keeps one recovery row through polling and remount (%j)", async ({ text, terminal }) => {
  const original = { ...captured, text };
  const sibling = { ...original, operationId: "independent-operation", idempotencyKey: "independent-key", at: "2026-09-05T08:01:00.000Z" };
  let receipts: RuntimeReceipt[] = [original, sibling, { ...original, revision: 3, status: "delivering" }];
  const calls: { url: string; method?: string; body?: string }[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url === "/api/tmux/targets") return Response.json({ targets: {} });
    if (init?.method === "POST" || init?.method === "DELETE") {
      calls.push({ url, method: init.method, body: init.body as string });
      const current = receipts.find(receipt => url.endsWith(receipt.operationId))!;
      return Response.json({ receipt: init.method === "DELETE"
        ? { ...current, revision: 8, status: "failed", reason: "delivery-discarded", resend: "not-needed" }
        : current });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const { createRuntimeBus, setRuntimeBusForTests } = await import("@/hooks/runtimeBus");
  let seq = 1;
  const bus = createRuntimeBus({
    fetch: async () => Response.json({ schemaVersion: 1, snapshotSeq: seq, retentionFloorSeq: 0,
      runtime: { hostEpoch: 1, health: "ready" }, filesRevision: 1,
      sessions: [{ ...structuredView.session, artifactPath: file.path, attentionIds: [], revision: seq, turn: "idle", recentReceipts: receipts }],
      attentions: [], recentOperations: receipts, edges: [], flows: [], workflows: [], tasks: [] }),
    createEventSource: () => ({ onopen: null, onerror: null, onmessage: null, close() {}, addEventListener() {} }),
    now: Date.now, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  realReceiptHook = true;
  setRuntimeBusForTests(bus);
  bus.start();
  await settle(() => {});
  for (const receipt of [original, sibling]) {
    enqueueOutbox(file.conversationId!, { id: receipt.idempotencyKey, text: text ?? "", images: 0, at: Date.parse(receipt.admittedAt!) });
    updateOutbox(file.conversationId!, receipt.idempotencyKey, { state: "delivering", deliveryUncertain: true, deliveryReceipt: receipt });
  }
  let mounted = await renderInto(surface());
  const check = (ids: string[]) => {
    const controls = [...mounted.host.querySelectorAll("[data-operation]:has([data-receipt-uncertain-retry])")];
    expect(controls.map(node => node.getAttribute("data-operation")).sort()).toEqual([...ids].sort());
    for (const control of controls) {
      expect(control.textContent).toMatch(/outcome is unknown/i);
      expect(control.querySelector("[data-receipt-uncertain-retry]")).not.toBeNull();
      expect(control.querySelector("[data-receipt-discard]")?.textContent).toBe("Discard");
    }
    for (const bubble of mounted.host.querySelectorAll('[data-outbox-wait="uncertain"]')) {
      expect(bubble.querySelectorAll("[data-outbox-retry], [data-outbox-cancel]")).toHaveLength(0);
    }
    expect(mounted.host.querySelector("[data-runtime-receipt-status]")?.textContent).toMatch(/outcome is unknown/i);
  };
  try {
    check([original.operationId, sibling.operationId]);
    for (const receipt of [original, sibling]) {
      await settle(() => mounted.host.querySelector<HTMLButtonElement>(`[data-operation="${receipt.operationId}"] [data-receipt-uncertain-retry]`)!.click());
    }
    expect(calls).toEqual([original, sibling].map(receipt => ({ url: `/api/runtime/operations/${receipt.operationId}`, method: "POST", body: JSON.stringify({ action: "retry-uncertain" }) })));
    receipts = [{ ...sibling, revision: 6, status: terminal === "delivered" ? "delivered" : "failed", resend: "not-needed", reason: terminal === "discarded" ? "delivery-discarded" : undefined }, original, { ...original, revision: 2, status: "pending" }];
    seq++;
    await act(async () => { await bus.refresh(); await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(bus.getState().store.sessions[file.conversationId!]?.recentReceipts[0]?.revision).toBe(6);
    await settle(() => {});
    check([original.operationId]);
    if (text && terminal === "delivered") {
      await settle(() => publishTranscriptEchoes(file.conversationId!, [{ id: "independent-native-echo", text }]));
      expect(visibleOutbox(readOutbox(file.conversationId!), new Map([[text, 1]]), Date.now()).some(entry => entry.id === original.idempotencyKey)).toBe(true);
    }
    await act(async () => mounted.root.unmount());
    resetOutboxForTests();
    mounted = await renderInto(surface());
    check([original.operationId]);
    await settle(() => mounted.host.querySelector<HTMLButtonElement>(`[data-operation="${original.operationId}"] [data-receipt-discard]`)!.click());
    expect(calls[2]).toEqual({ url: `/api/runtime/operations/${original.operationId}`, method: "DELETE", body: undefined });
    expect(mounted.host.querySelectorAll("[data-receipt-uncertain-retry], [data-receipt-discard]")).toHaveLength(0);
    seq++;
    await act(async () => { await bus.refresh(); await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(mounted.host.querySelectorAll("[data-receipt-uncertain-retry], [data-receipt-discard]")).toHaveLength(0);
    expect(calls).toHaveLength(3);
  } finally { await act(async () => mounted.root.unmount()); bus.stop(); }
});

test("uncertainty survives reload, conversation switches, and late errors; actions use the original operation", async () => {
  const calls: { url: string; method?: string; body?: string }[] = [];
  let actionReceipt = { ...captured, revision: 5 };
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/api/runtime/operations/")) {
      calls.push({ url, method: init?.method, body: init?.body as string });
      return new Response(JSON.stringify({ receipt: actionReceipt }), { status: 200 });
    }
    if (init?.method === "POST" && (url === "/api/runtime/send" || url === "/api/tmux")) calls.push({ url, method: init.method, body: init.body as string });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  enqueueOutbox(file.conversationId!, { id: captured.idempotencyKey, text: captured.text!, images: 0, at: Date.parse(captured.admittedAt!) });
  updateOutbox(file.conversationId!, captured.idempotencyKey, { state: "delivering" });
  snapshotReceipts = [captured];
  let mounted = await renderInto(surface());
  await act(async () => mounted.root.unmount());
  resetOutboxForTests();
  snapshotReceipts = [];
  mounted = await renderInto(surface());
  try {
    expect(mounted.host.textContent).toContain("outcome is unknown");
    expect(readOutbox(file.conversationId!)[0]?.deliveryReceipt?.operationId).toBe(captured.operationId);
    expect(mounted.host.textContent).not.toMatch(/not delivered/i);
    expect(mounted.host.querySelector("[data-runtime-receipt-status]")?.textContent).toMatch(/outcome is unknown/i);
    await settle(() => { retryOutbox(file.conversationId!, captured.idempotencyKey); cancelOutbox(file.conversationId!, captured.idempotencyKey); });
    expect(calls).toHaveLength(0);
    const other = { ...file, path: "/other.jsonl", conversationId: "other-conversation" };
    await settle(() => mounted.root.render(<TmuxComposer file={other} />));
    expect(mounted.host.textContent).not.toContain(captured.text!);
    await settle(() => mounted.root.render(surface()));
    for (const status of ["queued", "delivering", "pending", "failed"] as const) {
      snapshotReceipts = [{ ...captured, status, resend: undefined, revision: ++actionReceipt.revision }];
      await settle(() => mounted.root.render(surface()));
      expect(mounted.host.querySelector("[data-outbox-entry]")?.textContent).toContain("outcome is unknown");
      expect(mounted.host.querySelector("[data-outbox-retry]")).toBeNull();
    }
    const details = mounted.host.querySelector<HTMLDetailsElement>("details[data-runtime-receipt-stack]")!;
    await settle(() => { details.open = true; details.dispatchEvent(new dom.Event("toggle") as unknown as Event); });
    const retry = mounted.host.querySelector<HTMLButtonElement>("[data-receipt-uncertain-retry]")!;
    expect(retry).not.toBeNull();
    actionReceipt = { ...captured, revision: 20 };
    await settle(() => retry.click());
    expect(calls).toEqual([{ url: `/api/runtime/operations/${captured.operationId}`, method: "POST", body: JSON.stringify({ action: "retry-uncertain" }) }]);
    actionReceipt = runtimeReceiptForSend({ operationId: captured.operationId,
      clientMessageId: captured.idempotencyKey, conversationId: captured.conversationId,
      kind: "send", state: "failed", reason: "delivery-discarded", resend: "not-needed",
      acceptedAt: captured.admittedAt, settledAt: captured.at } as SendReceipt);
    await settle(() => mounted.host.querySelector<HTMLButtonElement>("[data-receipt-discard]")!.click());
    expect(Boolean(mounted.host.querySelector("[data-receipt-uncertain-retry], [data-receipt-discard]"))).toBe(false);
    expect(readOutbox(file.conversationId!)[0]?.deliveryReceipt?.reason).toBe("delivery-discarded");
    await act(async () => mounted.root.unmount());
    resetOutboxForTests();
    mounted = await renderInto(surface());
    expect(Boolean(mounted.host.querySelector("[data-receipt-uncertain-retry], [data-receipt-discard]"))).toBe(false);
    expect(calls[1]).toEqual({ url: `/api/runtime/operations/${captured.operationId}`, method: "DELETE", body: undefined });
    expect(mounted.host.querySelector("[data-outbox-retry]")).toBeNull();
    await settle(() => retryOutbox(file.conversationId!, captured.idempotencyKey));
    expect(calls).toHaveLength(2);
  } finally { await act(async () => mounted.root.unmount()); }
});

test.each(["network", "503", "malformed", "null"])("%s after possible dispatch stays visible without dispatch on remount", async mode => {
  const sends: SendBody[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/runtime/send") {
      sends.push(JSON.parse(init?.body as string));
      if (mode === "network") throw new Error("lost response");
      return new Response(mode === "malformed" ? "invalid-json" : mode === "null" ? "null" : "{}", { status: 503 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  let mounted = await renderInto(surface());
  await settle(() => composerControls(mounted.host).type("Keep the submitted message"));
  await settle(() => composerControls(mounted.host).submit());
  expect(sends).toHaveLength(1);
  expect(mounted.host.querySelector("[data-outbox-entry]")?.textContent).toContain("outcome is unknown");
  await act(async () => mounted.root.unmount());
  resetOutboxForTests();
  mounted = await renderInto(surface());
  try {
    expect(sends).toHaveLength(1);
    expect(mounted.host.querySelector("[data-outbox-retry], [data-outbox-cancel]")).toBeNull();
    expect(readOutbox(file.conversationId!)[0]?.id).toBe(sends[0]!.idempotencyKey);
  } finally { await act(async () => mounted.root.unmount()); }
});


test.each([
  ["failed", "safe", undefined, "failed"],
  ["rejected", "safe", undefined, "failed"],
  ["failed", "not-needed", "delivery-discarded", "failed"],
  ["delivered", "not-needed", undefined, "delivered"],
] as const)("authoritative %s/%s resolves unknown without dispatch", async (status, resend, reason, expected) => {
  const sends: SendBody[] = [];
  mockWire(sends, [() => ({ status: 503, json: {} })]);
  enqueueOutbox(file.conversationId!, { id: captured.idempotencyKey, text: captured.text!, images: 0, at: Date.parse(captured.admittedAt!) });
  updateOutbox(file.conversationId!, captured.idempotencyKey, { state: "delivering" });
  snapshotReceipts = [captured];
  const mounted = await renderInto(surface());
  try {
    snapshotReceipts = [{ ...captured, status, resend, reason, revision: 5 }];
    await settle(() => mounted.root.render(surface()));
    expect(readOutbox(file.conversationId!)[0]?.state).toBe(expected);
    expect(readOutbox(file.conversationId!)[0]?.deliveryUncertain).toBeUndefined();
    if (expected === "delivered") {
      expect(readOutbox(file.conversationId!)[0]?.settledAt).toBe(Date.parse(captured.at));
      expect(mounted.host.querySelector("[data-outbox-entry]")).toBeNull();
    } else if (resend === "safe") expect(mounted.host.querySelector("[data-outbox-retry]")).not.toBeNull();
    else expect(mounted.host.querySelector("[data-outbox-retry]")).toBeNull();
    expect(sends).toHaveLength(0);
  } finally { await act(async () => mounted.root.unmount()); }
});

test("real runtime bus ingestion refuses an older receipt after authoritative delivery", async () => {
  const { createRuntimeBus } = await import("@/hooks/runtimeBus");
  const listeners = new Map<string, (event: { data: string }) => void>();
  const source = { onopen: null, onerror: null, onmessage: null, close() {}, addEventListener(type: string, listener: (event: { data: string }) => void) { listeners.set(type, listener); } };
  const bus = createRuntimeBus({
    fetch: async () => new Response(JSON.stringify({ schemaVersion: 1, snapshotSeq: 1, retentionFloorSeq: 0,
      runtime: { hostEpoch: 1, health: "ready" }, filesRevision: 1, sessions: [], attentions: [],
      recentOperations: [captured], edges: [], flows: [], workflows: [], tasks: [] })),
    createEventSource: () => source, now: Date.now, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  enqueueOutbox(file.conversationId!, { id: captured.idempotencyKey, text: captured.text!, images: 0, at: Date.parse(captured.admittedAt!) });
  updateOutbox(file.conversationId!, captured.idempotencyKey, { state: "delivering" });
  bus.start();
  await settle(() => {});
  snapshotReceipts = Object.values(bus.getState().store.operations);
  const mounted = await renderInto(surface());
  try {
    const receive = listeners.get("runtime") ?? source.onmessage;
    expect(receive).toBeFunction();
    const ingest = async (seq: number, receipt: RuntimeReceipt) => {
      receive!({ data: JSON.stringify({ schemaVersion: 1, seq, eventId: `event-${seq}`, scope: { type: "operation", id: receipt.operationId }, revision: receipt.revision, kind: "receipt", payload: receipt }) });
      snapshotReceipts = Object.values(bus.getState().store.operations);
      await settle(() => mounted.root.render(surface()));
    };
    await ingest(2, { ...captured, status: "delivered", resend: "not-needed", revision: 5 });
    expect(readOutbox(file.conversationId!)[0]?.state).toBe("delivered");
    await ingest(3, { ...captured, status: "queued", revision: 4 });
    expect(bus.getState().store.operations[captured.operationId]?.status).toBe("delivered");
    expect(mounted.host.querySelector("[data-outbox-entry]")).toBeNull();
  } finally { bus.stop(); await act(async () => mounted.root.unmount()); }
});


test.skipIf(!process.env.LLV_UNCERTAINTY_BROWSER)("390/430 mounted uncertainty has accessible original-operation actions and no overflow", async () => {
  const { chromium } = await import("playwright-core");
  const { default: postcss } = await import("postcss");
  const { default: tailwind } = await import("@tailwindcss/postcss");
  const source = `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {LogFeed} from './src/components/LogFeed';
    import {TmuxComposer} from './src/components/TmuxComposer';
    import {setLogFeedDependenciesForTests} from './src/components/logFeedDependencies';
    import {setTmuxComposerRuntimeDependenciesForTests} from './src/components/tmuxComposerRuntime';
    import {capabilitiesFor,attachModeFor} from './src/components/agentCapabilities';
    import {setRuntimeUiEnabledForTests} from './src/hooks/runtimeBus';
    import {enqueueOutbox,updateOutbox} from './src/components/conversation/outbox';
    const file=${JSON.stringify(file)}, receipt=${JSON.stringify(captured)}, view=${JSON.stringify(structuredView)};
    setRuntimeUiEnabledForTests(false);
    setTmuxComposerRuntimeDependenciesForTests({useAgentCapabilities:()=>({caps:capabilitiesFor(file,view,{runtimeEnabled:true}),runtime:view,structuredSession:view,runtimeEnabled:true,attachMode:attachModeFor(file,view,{runtimeEnabled:true})}),useRuntimeReceiptsForArtifact:()=>[
      {...receipt,text:undefined},
      {...receipt,operationId:'same-text-a',idempotencyKey:'same-key-a'},
      {...receipt,operationId:'same-text-b',idempotencyKey:'same-key-b'},
      {...receipt,operationId:'later-success',idempotencyKey:'later-key',status:'delivered',resend:'not-needed',at:'2026-09-05T08:02:00.000Z'}
    ]});
    setLogFeedDependenciesForTests({useLogTail:()=>({lines:[],linesStart:0,size:0,loading:false,error:null,tickTime:null,paused:false,setPaused(){},clear(){},hasMore:false,loadingOlder:false,loadOlder:async()=>0,prependGen:0})});
    enqueueOutbox(file.conversationId,{id:receipt.idempotencyKey,text:receipt.text,images:0,at:Date.parse(receipt.admittedAt)});
    updateOutbox(file.conversationId,receipt.idempotencyKey,{state:'delivering'});
    createRoot(document.getElementById('root')).render(<><LogFeed file={file} showSvc={false} lineFilter='' onStatus={()=>{}} paused={false} follow={false} setFollow={()=>{}}/><TmuxComposer file={file}/></>);
  `;
  const build = await Bun.build({ entrypoints: ["uncertainty-fixture"], target: "browser",
    define: { "process.env.NODE_ENV": JSON.stringify("development"), "process.env": "{}" },
    plugins: [{ name: "fixture", setup(builder) {
      builder.onResolve({ filter: /^uncertainty-fixture$/ }, () => ({ path: "fixture", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: source, loader: "tsx", resolveDir: process.cwd() }));
    } }],
  });
  expect(build.success).toBe(true);
  const bundle = await build.outputs[0]!.text();
  const css = (await postcss([tailwind()]).process(await Bun.file("src/app/globals.css").text(), { from: `${process.cwd()}/src/app/globals.css` })).css;
  const actions: { method: string; path: string; body: string }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/bundle.js") return new Response(bundle, { headers: { "Content-Type": "application/javascript" } });
    if (path === "/style.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
    if (path.startsWith("/api/runtime/operations/")) {
      actions.push({ method: request.method, path, body: await request.text() });
      return Response.json({ receipt: { ...captured, revision: 5 } });
    }
    if (path.startsWith("/api/")) {
      if (path === "/api/runtime/send" || path === "/api/tmux") actions.push({ method: request.method, path, body: await request.text() });
      return new Response("{}", { status: 404 });
    }
    return new Response('<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root" style="height:844px;display:flex;flex-direction:column"></div><script src="/bundle.js"></script>', { headers: { "Content-Type": "text/html" } });
  } });
  const browser = await chromium.launch({ executablePath: process.env.LLV_UNCERTAINTY_BROWSER, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    for (const width of [390, 430]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
      await page.goto(`http://127.0.0.1:${server.port}`);
      await page.locator('[data-outbox-wait="uncertain"]').waitFor();
      expect(await page.locator('[data-outbox-retry], [data-outbox-cancel]').count()).toBe(0);
      await page.locator('details[data-runtime-receipt-stack] > summary').click();
      expect(await page.locator('[data-receipt-uncertain-retry]').count()).toBe(3);
      expect(await page.locator('[data-receipt-discard]').count()).toBe(3);
      const retry = page.locator(`[data-operation="${captured.operationId}"] [data-receipt-uncertain-retry]`);
      await retry.waitFor();
      expect(await retry.innerText()).toBe("Retry");
      expect(await page.locator('[data-runtime-receipt-status]').textContent()).toMatch(/outcome is unknown/i);
      expect(await page.locator('body').textContent()).not.toMatch(/not delivered/i);
      const discard = page.locator(`[data-operation="${captured.operationId}"] [data-receipt-discard]`);
      expect(await discard.innerText()).toBe("Discard");
      expect((await discard.boundingBox())!.height).toBeGreaterThanOrEqual(43.99);
      await discard.focus();
      expect(await discard.evaluate(el => document.activeElement === el)).toBe(true);
      const bounds = await retry.boundingBox();
      expect(bounds!.height).toBeGreaterThanOrEqual(43.99);
      await retry.focus();
      expect(await retry.evaluate(el => document.activeElement === el)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.locator('[data-outbox]').getAttribute('aria-live')).toBe('polite');
      if (process.env.LLV_UNCERTAINTY_EVIDENCE) await page.screenshot({ path: `${process.env.LLV_UNCERTAINTY_EVIDENCE}/uncertainty-${width}.png`, fullPage: true });
      await retry.click();
      await page.waitForTimeout(50);
      expect(actions.at(-1)).toEqual({ method: "POST", path: `/api/runtime/operations/${captured.operationId}`, body: JSON.stringify({ action: "retry-uncertain" }) });
      await discard.click();
      await page.waitForTimeout(50);
      expect(actions.at(-1)).toEqual({ method: "DELETE", path: `/api/runtime/operations/${captured.operationId}`, body: "" });
      await page.close();
    }
    expect(actions).toHaveLength(4);
  } finally { await browser.close(); server.stop(true); }
});


test("non-2xx original receipt retains identity and verify-first evidence through the send normalizer", async () => {
  const sends: SendBody[] = [];
  mockWire(sends, [(body) => ({ status: 503, json: { receipt: { ...captured, idempotencyKey: body.idempotencyKey }, operationId: captured.operationId, error: "recipient evidence unavailable" } })]);
  let mounted = await renderInto(surface());
  try {
    await settle(() => composerControls(mounted.host).type(captured.text!));
    await settle(() => composerControls(mounted.host).submit());
    expect(sends).toHaveLength(1);
    expect(readOutbox(file.conversationId!)[0]?.deliveryReceipt?.operationId).toBe(captured.operationId);
    expect(mounted.host.textContent).not.toMatch(/not delivered/i);
    expect(mounted.host.querySelector("[data-runtime-receipt-status]")?.textContent).toMatch(/outcome is unknown/i);
    expect(readOutbox(file.conversationId!)[0]?.deliveryReceipt?.resend).toBe("verify-first");
    expect(mounted.host.querySelector("[data-outbox-entry]")?.textContent).toContain("outcome is unknown");
    expect(readOutbox(file.conversationId!)[0]?.deliveryReceipt?.reason).toBe(captured.reason);
    await act(async () => mounted.root.unmount());
    resetOutboxForTests();
    mounted = await renderInto(surface());
    expect(readOutbox(file.conversationId!)[0]?.deliveryReceipt?.operationId).toBe(captured.operationId);
    expect(mounted.host.textContent).not.toMatch(/not delivered/i);
    expect(mounted.host.querySelector("[data-runtime-receipt-status]")?.textContent).toMatch(/outcome is unknown/i);
    await settle(() => {
      retryOutbox(file.conversationId!, sends[0]!.idempotencyKey);
      cancelOutbox(file.conversationId!, sends[0]!.idempotencyKey);
    });
    expect(sends).toHaveLength(1);
    expect(mounted.host.querySelector("[data-outbox-retry], [data-outbox-cancel]")).toBeNull();
  } finally { await act(async () => mounted.root.unmount()); }
});

test.each(["queued", "failed", "network"])("late %s send callback cannot reverse authoritative success", async outcome => {
  const sends: SendBody[] = [];
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/runtime/send") {
      sends.push(JSON.parse(init?.body as string));
      return new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const mounted = await renderInto(surface());
  try {
    await settle(() => composerControls(mounted.host).type(captured.text!));
    await settle(() => composerControls(mounted.host).submit());
    expect(sends).toHaveLength(1);
    const delivered: RuntimeReceipt = { ...captured, idempotencyKey: sends[0]!.idempotencyKey, status: "delivered", resend: "not-needed", revision: 8, at: new Date().toISOString() };
    snapshotReceipts = [delivered];
    await settle(() => mounted.root.render(surface()));
    expect(readOutbox(file.conversationId!)[0]?.state).toBe("delivered");
    await settle(() => {
      if (outcome === "network") reject(new Error("late connection loss"));
      else resolve(Response.json({ operationId: captured.operationId, receipt: { ...delivered, status: outcome, revision: 4, resend: "verify-first" }, error: "late evidence unavailable" }, { status: 503 }));
    });
    expect(readOutbox(file.conversationId!)[0]?.state).toBe("delivered");
    expect(readOutbox(file.conversationId!)[0]?.settledAt).toBe(Date.parse(delivered.at));
    expect(mounted.host.querySelector("[data-outbox-entry]")?.textContent).toContain("Delivered");
    expect(mounted.host.querySelector("[data-outbox-entry]")?.textContent).not.toContain("unknown");
    expect(sends).toHaveLength(1);
  } finally { await act(async () => mounted.root.unmount()); }
});

test("non-2xx definitive pre-dispatch failure keeps safe retry controls", async () => {
  const sends: SendBody[] = [];
  mockWire(sends, [
    body => ({ status: 400, json: { receipt: { ...captured, idempotencyKey: body.idempotencyKey, status: "rejected", resend: "safe", reason: "Rejected before dispatch" }, error: "Rejected before dispatch" } }),
    body => ({ status: 200, json: { receipt: { ...captured, idempotencyKey: body.idempotencyKey, status: "queued", resend: undefined, reason: undefined, revision: 5 } } }),
  ]);
  const mounted = await renderInto(surface());
  try {
    await settle(() => composerControls(mounted.host).type(captured.text!));
    await settle(() => composerControls(mounted.host).submit());
    expect(readOutbox(file.conversationId!)[0]?.state).toBe("failed");
    expect(readOutbox(file.conversationId!)[0]?.deliveryUncertain).toBeUndefined();
    expect(mounted.host.querySelector("[data-outbox-retry]")).not.toBeNull();
    expect(sends).toHaveLength(1);
    await settle(() => mounted.host.querySelector<HTMLButtonElement>("[data-outbox-retry]")!.click());
    expect(sends).toHaveLength(2);
    expect(sends[1]).toEqual(sends[0]);
    expect(readOutbox(file.conversationId!)[0]?.state).toBe("delivering");
  } finally { await act(async () => mounted.root.unmount()); }
});


test.each(["reservation", "idempotency"])("ambiguous %s conflict retains unknown identity across remount", async conflict => {
  const sends: SendBody[] = [];
  mockWire(sends, [() => ({ status: 409, json: { error: `${conflict} conflict`, operationId: captured.operationId } })]);
  let mounted = await renderInto(surface());
  try {
    await settle(() => composerControls(mounted.host).type(captured.text!));
    await settle(() => composerControls(mounted.host).submit());
    expect(readOutbox(file.conversationId!)[0]?.deliveryUncertain).toBe(true);
    expect(readOutbox(file.conversationId!)[0]?.operationId).toBe(captured.operationId);
    await act(async () => mounted.root.unmount());
    resetOutboxForTests();
    mounted = await renderInto(surface());
    await settle(() => { retryOutbox(file.conversationId!, sends[0]!.idempotencyKey); cancelOutbox(file.conversationId!, sends[0]!.idempotencyKey); });
    expect(mounted.host.querySelector("[data-outbox-entry]")?.textContent).toContain("outcome is unknown");
    expect(mounted.host.querySelector("[data-outbox-retry], [data-outbox-cancel]")).toBeNull();
    expect(sends).toHaveLength(1);
  } finally { await act(async () => mounted.root.unmount()); }
});

test("accepted held response persists identity and settles by original operation without resend", async () => {
  const sends: SendBody[] = [];
  mockWire(sends, [() => ({ status: 202, json: { held: true, operationId: captured.operationId } })]);
  let mounted = await renderInto(surface());
  try {
    await settle(() => composerControls(mounted.host).type(captured.text!));
    await settle(() => composerControls(mounted.host).submit());
    expect(readOutbox(file.conversationId!)[0]?.acceptedHeld).toBe(true);
    expect(readOutbox(file.conversationId!)[0]?.operationId).toBe(captured.operationId);
    await act(async () => mounted.root.unmount());
    resetOutboxForTests();
    mounted = await renderInto(surface());
    expect(mounted.host.querySelector("[data-outbox-entry]")?.textContent).toContain("Held");
    expect(mounted.host.querySelector("[data-outbox-entry]")?.textContent).not.toContain("unknown");
    expect(mounted.host.querySelector("[data-outbox-retry], [data-outbox-cancel]")).toBeNull();
    snapshotReceipts = [{ ...captured, idempotencyKey: sends[0]!.idempotencyKey, status: "delivered", resend: "not-needed", revision: 8, at: new Date().toISOString() }];
    await settle(() => mounted.root.render(surface()));
    expect(readOutbox(file.conversationId!)[0]?.state).toBe("delivered");
    expect(readOutbox(file.conversationId!)[0]?.acceptedHeld).toBeUndefined();
    expect(sends).toHaveLength(1);
  } finally { await act(async () => mounted.root.unmount()); }
});

test.each(["network", "503", "malformed"])("safe retry followed by %s becomes unknown despite cached rejection", async mode => {
  const sends: SendBody[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input) !== "/api/runtime/send") return new Response("{}", { status: 404 });
    sends.push(JSON.parse(init?.body as string));
    if (sends.length === 1) return Response.json({ receipt: { ...captured, idempotencyKey: sends[0]!.idempotencyKey, status: "rejected", resend: "safe", reason: "Rejected before dispatch" } }, { status: 400 });
    if (mode === "network") throw new Error("lost retry response");
    return new Response(mode === "malformed" ? "bad-json" : "{}", { status: 503 });
  }) as typeof fetch;
  let mounted = await renderInto(surface());
  try {
    await settle(() => composerControls(mounted.host).type(captured.text!));
    await settle(() => composerControls(mounted.host).submit());
    await settle(() => mounted.host.querySelector<HTMLButtonElement>("[data-outbox-retry]")!.click());
    expect(sends).toHaveLength(2);
    expect(sends[1]).toEqual(sends[0]);
    expect(readOutbox(file.conversationId!)[0]?.deliveryUncertain).toBe(true);
    await act(async () => mounted.root.unmount());
    resetOutboxForTests();
    mounted = await renderInto(surface());
    expect(readOutbox(file.conversationId!)[0]?.deliveryUncertain).toBe(true);
    expect(mounted.host.querySelector("[data-outbox-retry], [data-outbox-cancel]")).toBeNull();
    await settle(() => mounted.host.querySelector<HTMLDetailsElement>("details[data-runtime-receipt-stack]")?.setAttribute("open", ""));
    expect(mounted.host.querySelector("[data-receipt-uncertain-retry]")).not.toBeNull();
    expect(sends).toHaveLength(2);
  } finally { await act(async () => mounted.root.unmount()); }
});


test.each([200, 503].flatMap(httpStatus => ["conversation", "key", "operation"].flatMap(mismatch => ["delivered", "uncertain"].map(status => ({ mismatch, status, httpStatus })))) )("foreign response remains unknown without foreign actions (%j)", async ({ mismatch, status, httpStatus }) => {
  const sends: SendBody[] = [];
  mockWire(sends, [body => ({ status: httpStatus, json: {
    operationId: mismatch === "operation" ? "contradictory-operation" : captured.operationId,
    receipt: { ...captured, status, resend: status === "uncertain" ? "verify-first" : "not-needed",
      conversationId: mismatch === "conversation" ? "foreign-conversation" : captured.conversationId,
      idempotencyKey: mismatch === "key" ? "foreign-key" : body.idempotencyKey },
  } })]);
  let mounted = await renderInto(surface());
  try {
    await settle(() => composerControls(mounted.host).type(captured.text!));
    await settle(() => composerControls(mounted.host).submit());
    for (let attempt = 0; attempt < 2; attempt++) {
      const entry = readOutbox(file.conversationId!)[0]!;
      expect(entry.deliveryUncertain).toBe(true);
      expect(entry.deliveryReceipt).toBeUndefined();
      expect(entry.operationId).toBeUndefined();
      expect(mounted.host.querySelector("[data-receipt-uncertain-retry], [data-receipt-discard], [data-outbox-retry], [data-outbox-cancel]")).toBeNull();
      expect(mounted.host.querySelector("[data-outbox-entry]")?.textContent).toMatch(/outcome is unknown/i);
      if (!attempt) {
        await act(async () => mounted.root.unmount());
        resetOutboxForTests();
        mounted = await renderInto(surface());
      }
    }
    expect(sends).toHaveLength(1);
  } finally { await act(async () => mounted.root.unmount()); }
});


test.each(["POST", "DELETE"].flatMap(method => ["conversation", "key", "operation", "envelope"].map(mismatch => ({ method, mismatch }))))("recovery response must name the original operation (%j)", async ({ method, mismatch }) => {
  snapshotReceipts = [captured];
  const calls: { url: string; method?: string; body?: string }[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    if (url.includes("/api/runtime/operations/")) {
      calls.push({ url, method: init?.method, body: init?.body as string });
      return Response.json({ operationId: mismatch === "envelope" ? "foreign-envelope" : mismatch === "operation" ? "foreign-operation" : captured.operationId,
        receipt: { ...captured, status: "delivered", resend: "not-needed",
          conversationId: mismatch === "conversation" ? "foreign-conversation" : captured.conversationId,
          idempotencyKey: mismatch === "key" ? "foreign-key" : captured.idempotencyKey,
          operationId: mismatch === "operation" ? "foreign-operation" : captured.operationId } });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const mounted = await renderInto(surface());
  try {
    const selector = method === "DELETE" ? "[data-receipt-discard]" : "[data-receipt-uncertain-retry]";
    await settle(() => mounted.host.querySelector<HTMLButtonElement>(selector)!.click());
    expect(calls).toEqual([{ url: `/api/runtime/operations/${captured.operationId}`, method,
      body: method === "POST" ? JSON.stringify({ action: "retry-uncertain" }) : undefined }]);
    expect(mounted.host.querySelectorAll("[data-receipt-uncertain-retry]")).toHaveLength(1);
    expect(mounted.host.querySelectorAll('[data-operation="foreign-operation"]')).toHaveLength(0);
    expect(mounted.host.textContent).toMatch(/outcome is unknown/i);
  } finally { await act(async () => mounted.root.unmount()); }
});


test.each(["delivered", "discarded"])("producer settlement %s survives real journal ingestion and remount", async outcome => {
  const { createRuntimeBus } = await import("@/hooks/runtimeBus");
  const listeners = new Map<string, (event: { data: string }) => void>();
  const source = { onopen: null, onerror: null, onmessage: null, close() {}, addEventListener(type: string, listener: (event: { data: string }) => void) { listeners.set(type, listener); } };
  const bus = createRuntimeBus({
    fetch: async () => Response.json({ schemaVersion: 1, snapshotSeq: 1, retentionFloorSeq: 0,
      runtime: { hostEpoch: 1, health: "ready" }, filesRevision: 1, sessions: [], attentions: [],
      recentOperations: [captured], edges: [], flows: [], workflows: [], tasks: [] }),
    createEventSource: () => source, now: Date.now, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  const settlement = runtimeReceiptForSend({ operationId: captured.operationId,
    conversationId: captured.conversationId, clientMessageId: captured.idempotencyKey, kind: "send",
    state: outcome === "delivered" ? "delivered" : "failed", reason: outcome === "discarded" ? "delivery-discarded" : null,
    acceptedAt: captured.admittedAt!, settledAt: captured.at, duplicateRisk: false,
    resend: "not-needed", evidence: "delivery-record" });
  expect(settlement.revision).toBe(1);
  const calls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input) === `/api/runtime/operations/${captured.operationId}`) {
      calls.push(init?.method ?? "GET");
      return Response.json({ operationId: captured.operationId, receipt: settlement });
    }
    if (init?.method === "POST" && ["/api/runtime/send", "/api/tmux"].includes(String(input))) calls.push(`unexpected:${String(input)}`);
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  enqueueOutbox(file.conversationId!, { id: captured.idempotencyKey, text: captured.text!, images: 0, at: Date.parse(captured.admittedAt!) });
  updateOutbox(file.conversationId!, captured.idempotencyKey, { state: "delivering" });
  bus.start();
  await settle(() => {});
  snapshotReceipts = Object.values(bus.getState().store.operations);
  let mounted = await renderInto(surface());
  try {
    const selector = outcome === "discarded" ? "[data-receipt-discard]" : "[data-receipt-uncertain-retry]";
    await settle(() => mounted.host.querySelector<HTMLButtonElement>(selector)!.click());
    const assertSettled = () => {
      expect(readOutbox(file.conversationId!)[0]?.state).toBe(outcome === "delivered" ? "delivered" : "failed");
      expect(readOutbox(file.conversationId!)[0]?.deliveryUncertain).toBeUndefined();
      expect(Boolean(mounted.host.querySelector("[data-receipt-uncertain-retry], [data-receipt-discard], [data-outbox-retry]"))).toBe(false);
    };
    assertSettled();
    const receive = (listeners.get("runtime") ?? source.onmessage)!;
    for (const [seq, revision] of [[2, 3], [3, 5]]) {
      receive({ data: JSON.stringify({ schemaVersion: 1, seq, eventId: `settlement-event-${seq}`,
        scope: { type: "operation", id: captured.operationId }, revision, kind: "receipt",
        payload: { ...captured, revision, status: "queued" } }) });
      snapshotReceipts = Object.values(bus.getState().store.operations);
      await settle(() => mounted.root.render(surface()));
      expect(bus.getState().store.operations[captured.operationId]?.revision).toBe(revision === 3 ? 4 : 5);
      assertSettled();
    }
    await act(async () => mounted.root.unmount());
    resetOutboxForTests();
    mounted = await renderInto(surface());
    assertSettled();
    expect(calls).toEqual([outcome === "discarded" ? "DELETE" : "POST"]);
  } finally { bus.stop(); await act(async () => mounted.root.unmount()); }
});


test("safe recovery accepts the producer's linked retry projection and settles only its parent", async () => {
  const { runtimePresentationReceipt } = await import("@/lib/runtime/contracts");
  const original = { ...captured, resend: "safe" as const, reason: "pre-dispatch rejection" };
  const retry = runtimePresentationReceipt({ ...original, operationId: "safe-retry-leaf", idempotencyKey: "safe-retry-key",
    retryOfOperationId: original.operationId, presentationOperationId: original.operationId, presentationRevision: 5,
    revision: 1, status: "delivered", resend: "not-needed" });
  snapshotReceipts = [original];
  enqueueOutbox(file.conversationId!, { id: original.idempotencyKey, text: original.text!, images: 0, at: Date.parse(original.admittedAt!) });
  updateOutbox(file.conversationId!, original.idempotencyKey, { state: "delivering" });
  const calls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input) === `/api/runtime/operations/${original.operationId}`) {
      calls.push(init?.method ?? "GET");
      return Response.json({ operationId: "safe-retry-leaf", receipt: retry }, { status: 202 });
    }
    if (init?.method === "POST" && ["/api/runtime/send", "/api/tmux"].includes(String(input))) calls.push("ordinary-send");
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  let mounted = await renderInto(surface());
  try {
    await settle(() => mounted.host.querySelector<HTMLButtonElement>("[data-delivery-notice-retry]")!.click());
    expect(readOutbox(file.conversationId!)[0]?.state).toBe("delivered");
    await act(async () => mounted.root.unmount());
    resetOutboxForTests();
    mounted = await renderInto(surface());
    expect(readOutbox(file.conversationId!)[0]?.state).toBe("delivered");
    expect(calls).toEqual(["POST"]);
  } finally { await act(async () => mounted.root.unmount()); }
});

test.each([
  { outcome: "delivered", local: false, text: undefined },
  { outcome: "discarded", local: false, text: "" },
  { outcome: "delivered", local: false, text: undefined, churn: true },
  { outcome: "safe", local: false, text: undefined },
  { outcome: "safe", local: true, text: captured.text },
  { outcome: "safe", local: false, text: undefined, newerJournal: true },
])("producer recovery persists across journal polling, switches and remount (%j)", async ({ outcome, local, text, newerJournal = false, churn = false }) => {
  const { createRuntimeBus, setRuntimeBusForTests } = await import("@/hooks/runtimeBus");
  const original = { ...captured, text };
  const listeners = new Map<string, (event: { data: string }) => void>();
  const source = { onopen: null, onerror: null, onmessage: null as null | ((event: { data: string }) => void), close() {},
    addEventListener(name: string, listener: (event: { data: string }) => void) { listeners.set(name, listener); } };
  const bus = createRuntimeBus({
    fetch: async () => Response.json({ schemaVersion: 1, snapshotSeq: 1, retentionFloorSeq: 0,
      runtime: { hostEpoch: 1, health: "ready" }, filesRevision: 1,
      sessions: [{ ...structuredView.session, artifactPath: file.path, attentionIds: [], revision: 1,
        turn: "idle", recentReceipts: [original] }],
      attentions: [], recentOperations: [original], edges: [], flows: [], workflows: [], tasks: [] }),
    createEventSource: () => source,
    now: Date.now, setTimeout, clearTimeout, setInterval, clearInterval,
  });
  realReceiptHook = true;
  setRuntimeBusForTests(bus);
  bus.start();
  await settle(() => {});
  const settlement = runtimeReceiptForSend({ operationId: original.operationId, conversationId: original.conversationId,
    clientMessageId: original.idempotencyKey, kind: "send", state: outcome === "delivered" ? "delivered" : "failed",
    reason: outcome === "discarded" ? "delivery-discarded" : null, acceptedAt: original.admittedAt!,
    settledAt: original.at, duplicateRisk: false, resend: outcome === "safe" ? "safe" : "not-needed", evidence: "delivery-record" });
  expect(settlement.revision).toBe(1);
  expect(original.revision).toBe(4);
  const calls: string[] = [];
  const newSends: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input) === `/api/runtime/operations/${original.operationId}`) {
      calls.push(init?.method ?? "GET");
      if (calls.length > 1) throw new Error("Response lost after retry dispatch");
      return Response.json({ operationId: original.operationId, receipt: settlement });
    }
    if (churn && String(input) === "/api/runtime/send") {
      const body = JSON.parse(String(init?.body));
      newSends.push(body.idempotencyKey);
      const operationId = `later-operation-${newSends.length}`;
      return Response.json({ operationId, receipt: { ...settlement, operationId, idempotencyKey: body.idempotencyKey, text: body.text } });
    }
    if (init?.method === "POST" && ["/api/runtime/send", "/api/tmux"].includes(String(input))) calls.push(`unexpected:${String(input)}`);
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  if (local) {
    enqueueOutbox(file.conversationId!, { id: original.idempotencyKey, text: text!, images: 0, at: Date.parse(original.admittedAt!) });
    updateOutbox(file.conversationId!, original.idempotencyKey, { state: "delivering" });
  }
  let mounted = await renderInto(surface());
  const assertSettled = () => {
    expect(Boolean(mounted.host.querySelector("[data-receipt-uncertain-retry], [data-receipt-discard]"))).toBe(false);
    if (local) {
      expect(readOutbox(file.conversationId!)[0]?.state).toBe("failed");
      expect(readOutbox(file.conversationId!)[0]?.deliveryUncertain).toBeUndefined();
      expect(readOutbox(file.conversationId!)[0]?.deliveryReceipt?.revision).toBe(1);
    } else expect(readOutbox(file.conversationId!)).toHaveLength(0);
  };
  try {
    await settle(() => mounted.host.querySelector<HTMLButtonElement>(outcome === "discarded"
      ? "[data-receipt-discard]" : "[data-receipt-uncertain-retry]")!.click());
    assertSettled();
    // An older journal event is rejected by real ingestion, not a mocked hook.
    (listeners.get("runtime") ?? source.onmessage)!({ data: JSON.stringify({ schemaVersion: 1, seq: 2, eventId: "older-recovery-event",
      scope: { type: "operation", id: original.operationId }, revision: 3, kind: "receipt", payload: { ...original, revision: 3 } }) });
    await settle(() => {});
    expect(bus.getState().store.operations[original.operationId]?.revision).toBe(4);
    assertSettled();
    await settle(() => mounted.root.render(<TmuxComposer file={{ ...file, path: "/other.jsonl", conversationId: "other-conversation" }} />));
    expect(mounted.host.querySelector(`[data-operation="${original.operationId}"]`)).toBeNull();
    await settle(() => mounted.root.render(surface()));
    assertSettled();
    await act(async () => mounted.root.unmount());
    resetOutboxForTests();
    mounted = await renderInto(surface());
    assertSettled();
    if (churn) {
      for (let index = 0; index < 9; index++) {
        const controls = composerControls(mounted.host);
        await settle(() => controls.type(`Independent later submission ${index}`));
        await settle(() => controls.submit());
        await settle(() => {});
      }
      expect(newSends).toHaveLength(9);
      expect(new Set(newSends).size).toBe(9);
      expect(newSends).not.toContain(original.idempotencyKey);
      expect(Boolean(mounted.host.querySelector(`[data-operation="${original.operationId}"] [data-receipt-uncertain-retry]`))).toBe(false);
    }
    if (newerJournal) {
      (listeners.get("runtime") ?? source.onmessage)!({ data: JSON.stringify({ schemaVersion: 1, seq: 3, eventId: "newer-attempt-event",
        scope: { type: "operation", id: original.operationId }, revision: 5, kind: "receipt", payload: { ...original, revision: 5 } }) });
      expect(bus.getState().store.operations[original.operationId]?.revision).toBe(5);
      // The real bus batches subscriber notifications over one 16ms frame.
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 16)); });
      expect(Boolean(mounted.host.querySelector("[data-receipt-uncertain-retry]"))).toBe(true);
      await act(async () => mounted.root.unmount());
      mounted = await renderInto(surface());
      expect(Boolean(mounted.host.querySelector("[data-receipt-uncertain-retry]"))).toBe(true);
    } else if (outcome === "safe") {
      // Explicitly starting another attempt consumes the safe proof. Its lost
      // response cannot restore ordinary retry, including after remount.
      await settle(() => mounted.host.querySelector<HTMLButtonElement>("[data-delivery-notice-retry]")!.click());
      expect(mounted.host.querySelector("[data-receipt-uncertain-retry]")).not.toBeNull();
      expect(mounted.host.querySelector("[data-outbox-retry]")).toBeNull();
      await act(async () => mounted.root.unmount());
      resetOutboxForTests();
      mounted = await renderInto(surface());
      expect(mounted.host.querySelector("[data-receipt-uncertain-retry]")).not.toBeNull();
      expect(mounted.host.querySelector("[data-outbox-retry]")).toBeNull();
    }
    expect(calls).toEqual(outcome === "safe" && !newerJournal ? ["POST", "POST"] : [outcome === "discarded" ? "DELETE" : "POST"]);
  } finally { bus.stop(); await act(async () => mounted.root.unmount()); }
});

/* #1538 capacity: the 32-entry queue compacts settled history only and keeps
   every unresolved operation. Both cases cross the real boundary through the mounted
   form and the real serial dispatcher; the wire is the only mock. An unknown
   original keeps the drain closed (nothing else may go on the wire while one
   submission's fate is unknown), so everything submitted after it stays queued. */
const deliveredResponse = (body: SendBody, index: number) => ({ status: 200, json: { operationId: `operation-delivered-${index}`, receipt: {
  ...captured, operationId: `operation-delivered-${index}`, idempotencyKey: body.idempotencyKey, status: "delivered", resend: "not-needed", reason: undefined, revision: 1,
  at: new Date().toISOString(), admittedAt: new Date().toISOString(), text: body.text } } });
const uncertainResponse = (body: SendBody) => ({ status: 503, json: { receipt: { ...captured, idempotencyKey: body.idempotencyKey }, operationId: captured.operationId, error: "recipient evidence unavailable" } });
const heldResponse = (_body: SendBody, index: number) => ({ status: 202, json: { held: true, operationId: `operation-held-${index}` } });

function capacityWire(sends: SendBody[], respond: (body: SendBody, index: number) => { status: number; json: unknown }, calls: { url: string; method?: string }[] = [], discardReceipt?: () => RuntimeReceipt): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: { method?: string; body?: string }) => {
    const url = String(input);
    if (url.includes("/api/runtime/operations/")) {
      calls.push({ url, method: init?.method });
      return Response.json({ operationId: captured.operationId, receipt: discardReceipt!() }, { status: 200 });
    }
    if (url !== "/api/runtime/send") return new Response("{}", { status: 404 });
    const body = JSON.parse(init?.body ?? "{}") as SendBody;
    sends.push(body);
    const script = respond(body, sends.length - 1);
    return { ok: script.status < 400, status: script.status, json: async () => script.json } as Response;
  }) as typeof fetch;
}

const pasteImage = async (host: HTMLElement, tag: string) => {
  const textarea = host.querySelector("textarea")!;
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const textareaProps = (textarea as unknown as Record<string, { onPaste(event: unknown): void }>)[propsKey]!;
  await settle(() => textareaProps.onPaste({
    clipboardData: { items: [{ type: "image/png", getAsFile: () => new dom.File([new TextEncoder().encode(`png-${tag}`)], `${tag}.png`, { type: "image/png" }) }] },
    preventDefault() {},
  }));
  for (let attempt = 0; attempt < 50 && host.querySelectorAll("img").length !== 1; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  expect(host.querySelectorAll("img")).toHaveLength(1);
};

test("issue 1538: delivered history compacts first; an unknown original survives the boundary, remount and recovery, then admission closes", async () => {
  const sends: SendBody[] = [];
  const calls: { url: string; method?: string }[] = [];
  capacityWire(sends, (body, index) => index < 5 ? deliveredResponse(body, index) : index === 5 ? uncertainResponse(body) : heldResponse(body, index), calls,
    () => runtimeReceiptForSend({ operationId: captured.operationId, clientMessageId: sends[5]!.idempotencyKey, conversationId: captured.conversationId,
      kind: "send", state: "failed", reason: "delivery-discarded", resend: "not-needed", acceptedAt: captured.admittedAt, settledAt: captured.at } as SendReceipt));
  let mounted = await renderInto(surface());
  const submit = async (text: string) => {
    await settle(() => composerControls(mounted.host).type(text));
    await settle(() => composerControls(mounted.host).submit());
  };
  const queue = () => readOutbox(file.conversationId!);
  try {
    for (let index = 0; index < 5; index += 1) await submit(index % 2 ? captured.text! : `delivered before ${index}`);
    expect(sends).toHaveLength(5);
    expect(queue().filter((entry) => entry.state === "delivered")).toHaveLength(5);
    await submit(captured.text!);
    const original = sends[5]!.idempotencyKey;
    const originalEntry = () => queue().find((entry) => entry.id === original);
    expect(originalEntry()).toMatchObject({ deliveryUncertain: true, state: "delivering" });
    // 26 later rows fill the queue to 32; each of the next 5 evicts one delivered row, oldest first, never the original.
    for (let index = 0; index < 26; index += 1) await submit(index % 2 ? captured.text! : `later message ${index}`);
    expect(queue()).toHaveLength(32);
    expect(queue().map((entry) => entry.id).slice(0, 6)).toEqual(sends.map((body) => body.idempotencyKey));
    for (let index = 0; index < 5; index += 1) {
      await submit(`boundary message ${index}`);
      expect(mounted.host.querySelector("textarea")?.value).toBe("");
      expect(queue()).toHaveLength(32);
      expect(queue().some((entry) => entry.id === sends[index]!.idempotencyKey)).toBe(false);
      expect(queue().some((entry) => entry.id === sends[index + 1]!.idempotencyKey)).toBe(true);
    }
    expect(queue()[0]?.id).toBe(original);
    expect(queue().filter((entry) => entry.state === "queued")).toHaveLength(31);
    expect(originalEntry()).toMatchObject({ text: captured.text, images: 0, deliveryUncertain: true, state: "delivering" });
    expect(originalEntry()?.deliveryReceipt?.operationId).toBe(captured.operationId);
    expect(sends).toHaveLength(6);

    // Every slot is unresolved now: the next submission is refused with its draft intact.
    await submit("one past capacity");
    expect(mounted.host.querySelector("textarea")?.value).toBe("one past capacity");
    expect(mounted.host.querySelector('[data-testid="composer-status"]')?.textContent).toBe(translate("en", "composer.outboxFull"));
    expect(queue()).toHaveLength(32);
    expect(queue().some((entry) => entry.text === "one past capacity")).toBe(false);
    const ids = queue().map((entry) => entry.id);

    await act(async () => mounted.root.unmount());
    resetOutboxForTests();
    mounted = await renderInto(surface());
    expect(queue().map((entry) => entry.id)).toEqual(ids);
    expect(originalEntry()).toMatchObject({ text: captured.text, deliveryUncertain: true });
    expect(originalEntry()?.deliveryReceipt?.operationId).toBe(captured.operationId);
    const rows = mounted.host.querySelectorAll(`[data-operation="${captured.operationId}"]`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.querySelector("[data-receipt-uncertain-retry]")).not.toBeNull();
    expect(mounted.host.querySelector(`[data-outbox-entry="${original}"]`)?.textContent).toContain("outcome is unknown");
    expect(mounted.host.querySelector(`[data-outbox-retry="${original}"], [data-outbox-cancel="${original}"]`)).toBeNull();
    expect(sends).toHaveLength(6);

    // Original-operation discard at capacity binds to the original, settles it, and reopens admission.
    await settle(() => rows[0]!.querySelector<HTMLButtonElement>("[data-receipt-discard]")!.click());
    expect(calls).toEqual([{ url: `/api/runtime/operations/${captured.operationId}`, method: "DELETE" }]);
    expect(originalEntry()).toMatchObject({ state: "failed", deliveryUncertain: undefined });
    expect(originalEntry()?.deliveryReceipt?.reason).toBe("delivery-discarded");
    await submit("admitted after discard");
    expect(mounted.host.querySelector("textarea")?.value).toBe("");
    expect(queue()).toHaveLength(32);
    expect(queue().at(-1)?.text).toBe("admitted after discard");
    expect(originalEntry()).toBeUndefined();
  } finally { await act(async () => mounted.root.unmount()); }
});

test("issue 1538: exhausted unresolved capacity refuses the new submission before clearing its draft or attachments", async () => {
  const sends: SendBody[] = [];
  capacityWire(sends, (body, index) => index === 0 ? uncertainResponse(body) : heldResponse(body, index));
  let mounted = await renderInto(surface());
  const queue = () => readOutbox(file.conversationId!);
  try {
    await settle(() => composerControls(mounted.host).type(captured.text!));
    await settle(() => composerControls(mounted.host).submit());
    const original = sends[0]!.idempotencyKey;
    for (let index = 0; index < 31; index += 1) {
      await settle(() => composerControls(mounted.host).type(index % 2 ? captured.text! : `queued message ${index}`));
      await settle(() => composerControls(mounted.host).submit());
    }
    expect(sends).toHaveLength(1);
    expect(queue()).toHaveLength(32);
    expect(queue().filter((entry) => entry.state === "queued")).toHaveLength(31);
    expect(mounted.host.querySelector("textarea")?.value).toBe("");

    await settle(() => composerControls(mounted.host).type("the thirty-third message"));
    await pasteImage(mounted.host, "refused");
    const before = queue().map((entry) => entry.id);
    await settle(() => composerControls(mounted.host).submit());
    expect(mounted.host.querySelector('[data-testid="composer-status"]')?.textContent).toBe(translate("en", "composer.outboxFull"));
    expect(mounted.host.querySelector("textarea")?.value).toBe("the thirty-third message");
    expect(mounted.host.querySelectorAll("img")).toHaveLength(1);
    expect(queue().map((entry) => entry.id)).toEqual(before);
    expect(sends).toHaveLength(1);
    expect(queue()[0]?.id).toBe(original);
    expect(queue()[0]?.deliveryReceipt?.operationId).toBe(captured.operationId);

    // Remount keeps every unresolved row; the refusal still holds.
    await act(async () => mounted.root.unmount());
    resetOutboxForTests();
    mounted = await renderInto(surface());
    expect(queue().map((entry) => entry.id)).toEqual(before);
    expect(mounted.host.querySelectorAll(`[data-operation="${captured.operationId}"]`)).toHaveLength(1);
    expect(mounted.host.querySelectorAll("[data-outbox-entry]")).toHaveLength(32);
    await settle(() => composerControls(mounted.host).type("still refused"));
    await settle(() => composerControls(mounted.host).submit());
    expect(mounted.host.querySelector("textarea")?.value).toBe("still refused");
    expect(sends).toHaveLength(1);

    // Removing one queued row through its existing control frees a slot; the same draft is then admitted and waits behind the unknown original.
    const queued = queue().find((entry) => entry.state === "queued")!;
    await settle(() => mounted.host.querySelector<HTMLButtonElement>(`[data-outbox-cancel="${queued.id}"]`)!.click());
    expect(queue()).toHaveLength(31);
    await settle(() => composerControls(mounted.host).submit());
    expect(mounted.host.querySelector("textarea")?.value).toBe("");
    expect(mounted.host.querySelector('[data-testid="composer-status"]')).toBeNull();
    expect(queue()).toHaveLength(32);
    expect(queue().at(-1)).toMatchObject({ text: "still refused", state: "queued" });
    expect(queue()[0]?.id).toBe(original);
    expect(sends).toHaveLength(1);
  } finally { await act(async () => mounted.root.unmount()); }
});


for (const initialState of ["in-flight", "failed"] as const) {
  for (const remount of [false, true]) {
    test(`admitted payload stays server-owned after ${initialState}, safe recovery and remount=${remount}`, async () => {
      const sends: SendBody[] = [];
      const actions: (string | undefined)[] = [];
      const { runtimePresentationReceipt } = await import("@/lib/runtime/contracts");
      let safe: RuntimeReceipt;
      globalThis.fetch = (async (input, init) => {
        const url = String(input);
        if (url === "/api/runtime/send") {
          const body = JSON.parse(String(init?.body)) as SendBody;
          sends.push(body);
          return Response.json({ operationId: captured.operationId, receipt: runtimeReceiptForSend({
            operationId: captured.operationId, clientMessageId: body.idempotencyKey,
            conversationId: file.conversationId!, kind: "send", state: initialState,
            reason: initialState === "failed" ? "recipient evidence unavailable" : "accepted",
            resend: initialState === "failed" ? "verify-first" : null,
            acceptedAt: captured.admittedAt, settledAt: initialState === "failed" ? captured.at : null,
          } as SendReceipt) }, { status: initialState === "failed" ? 200 : 202 });
        }
        if (url === `/api/runtime/operations/${captured.operationId}`) {
          actions.push(init?.body as string | undefined);
          safe = runtimeReceiptForSend({ operationId: captured.operationId,
            clientMessageId: sends[0]!.idempotencyKey, conversationId: file.conversationId!,
            kind: "send", state: "failed", reason: "pre-dispatch rejection", resend: "safe",
            acceptedAt: captured.admittedAt, settledAt: captured.at,
          } as SendReceipt);
          const receipt = actions.length === 1 ? safe : runtimePresentationReceipt({
            ...safe, operationId: "payload-retry-leaf", idempotencyKey: "payload-retry-key",
            retryOfOperationId: safe.operationId, presentationOperationId: safe.operationId,
            presentationRevision: 5, revision: 1, status: "delivered", resend: "not-needed",
          });
          return Response.json({ operationId: receipt.operationId, receipt });
        }
        return new Response("{}", { status: 404 });
      }) as typeof fetch;
      writeProfile(file, { effort: "high", fast: false });
      let mounted = await renderInto(surface());
      try {
        await settle(() => composerControls(mounted.host).type("immutable attachment request"));
        await pasteImage(mounted.host, "original-image");
        const textarea = mounted.host.querySelector("textarea")!;
        const propsKey = Object.keys(textarea).find(key => key.startsWith("__reactProps$"))!;
        const props = (textarea as unknown as Record<string, { onDrop(event: unknown): void }>)[propsKey]!;
        await settle(() => props.onDrop({
          dataTransfer: { files: [new dom.File(["original document"], "original.pdf", { type: "application/pdf" })] },
          preventDefault() {}, stopPropagation() {},
        }));
        await settle(() => composerControls(mounted.host).submit());
        expect(sends).toHaveLength(1);
        expect(sends[0]!.images).toHaveLength(1);
        expect((sends[0] as SendBody & { files: unknown[] }).files).toHaveLength(1);
        const originalWire = structuredClone(sends[0]);
        snapshotReceipts = [{ ...captured, idempotencyKey: sends[0]!.idempotencyKey }];
        await settle(() => mounted.root.render(surface()));
        if (remount) {
          await act(async () => mounted.root.unmount());
          /* Existing sessions were persisted before this fence existed. */
          const storageKey = `llvOutbox:${file.conversationId}`;
          const legacyRows = JSON.parse(sessionStorage.getItem(storageKey)!) as { originalOperationOnly?: true }[];
          for (const row of legacyRows) delete row.originalOperationOnly;
          sessionStorage.setItem(storageKey, JSON.stringify(legacyRows));
          resetOutboxForTests();
          mounted = await renderInto(surface());
        }
        writeProfile(file, { effort: "low", fast: true });
        await settle(() => composerControls(mounted.host).type("later draft"));
        await pasteImage(mounted.host, "later-image");
        await settle(() => mounted.host.querySelector<HTMLButtonElement>("[data-receipt-uncertain-retry]")!.click());
        const safeEntry = readOutbox(file.conversationId!).find(entry => entry.id === sends[0]!.idempotencyKey)!;
        expect(safeEntry.deliveryReceipt?.resend).toBe("safe");
        expect(mounted.host.querySelectorAll("[data-outbox-retry]").length).toBe(0);
        await settle(() => retryOutbox(file.conversationId!, safeEntry.id));
        expect(readOutbox(file.conversationId!).find(entry => entry.id === safeEntry.id)).toEqual(safeEntry);
        expect(sends).toEqual([originalWire]);
        await settle(() => mounted.host.querySelector<HTMLButtonElement>("[data-delivery-notice-retry]")!.click());
        expect(actions).toEqual([JSON.stringify({ action: "retry-uncertain" }), undefined]);
        expect(readOutbox(file.conversationId!).find(entry => entry.id === safeEntry.id)?.state).toBe("delivered");
        expect(sends).toEqual([originalWire]);
        expect(mounted.host.querySelector<HTMLTextAreaElement>("textarea")!.value).toBe("later draft");
        expect(mounted.host.querySelectorAll("img")).toHaveLength(1);
      } finally { await act(async () => mounted.root.unmount()); }
    });
  }
}
