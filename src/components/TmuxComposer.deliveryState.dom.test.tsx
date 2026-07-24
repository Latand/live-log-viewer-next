/**
 * Issue #264 — delivery state without badge clutter.
 *
 * Successful deliveries render NO persistent chrome (the feed bubble is the
 * receipt, bridged by a quiet self-clearing echo line while the transcript
 * lags), failures render once inline with Retry/Edit/Dismiss, and a dismissal
 * persists per conversation across a composer remount.
 */
import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { act, useSyncExternalStore } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { emptyStore, type RuntimeReceipt } from "@/components/runtime/runtimeModel";
import type { RuntimeSessionView } from "@/hooks/useRuntime";
import type { FileEntry } from "@/lib/types";
import { setLocale, translate } from "@/lib/i18n";

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
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
  FileReader: dom.FileReader,
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

/* The durable receipt stream stands in for the runtime bus, exactly like the
   pendingImages harness: receipts arrive the way production delivers them. */
const actualRuntimeHooks = await import("@/hooks/useRuntime");
const receiptListeners = new Set<() => void>();
const runtimeStore = emptyStore();
let busReceipts: RuntimeReceipt[] = [];
let runtimeView: RuntimeSessionView | null = null;
function publishReceipts(next: RuntimeReceipt[]): void {
  busReceipts = next;
  for (const listener of receiptListeners) listener();
}
function publishRuntimeView(next: RuntimeSessionView | null): void {
  runtimeView = next;
  for (const listener of receiptListeners) listener();
}
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntime: () => ({
    enabled: runtimeView !== null,
    structuredHostsEnabled: runtimeView !== null,
    connection: runtimeView ? "live" : "offline",
    resyncedAt: null,
    store: runtimeStore,
  }),
  useRuntimeSession: () => useSyncExternalStore(
    (listener) => {
      receiptListeners.add(listener);
      return () => receiptListeners.delete(listener);
    },
    () => runtimeView,
    () => runtimeView,
  ),
  useRuntimeSessionByArtifact: () => null,
  useRuntimeReceiptsForArtifact: () => useSyncExternalStore(
    (listener) => {
      receiptListeners.add(listener);
      return () => receiptListeners.delete(listener);
    },
    () => busReceipts,
    () => busReceipts,
  ),
}));
afterAll(() => {
  mock.module("@/hooks/useRuntime", () => actualRuntimeHooks);
});

const {
  enqueueOutbox,
  publishTranscriptEchoes,
  readOutbox,
  resetOutboxForTests,
  updateOutbox,
} = await import("./conversation/outbox");
const { RuntimeComposerReceipts, TmuxComposer } = await import("./TmuxComposer");

const realFetch = globalThis.fetch;

afterEach(() => {
  setLocale("en");
  globalThis.fetch = realFetch;
  publishReceipts([]);
  publishRuntimeView(null);
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  resetOutboxForTests();
});

const receipt = (overrides: Partial<RuntimeReceipt> & { operationId: string }): RuntimeReceipt => ({
  idempotencyKey: `key-${overrides.operationId}`,
  conversationId: "conv-quiet",
  kind: "send",
  status: "delivered",
  text: "message",
  at: new Date().toISOString(),
  revision: 1,
  ...overrides,
});

const structuredRuntimeView = (
  liveTurn: { turnId: string; text: string } | null,
): RuntimeSessionView => ({
  session: {
    conversationId: "conv-quiet",
    sessionKey: { engine: "codex", sessionId: "conv-quiet" },
    hostKind: "codex-app-server",
    host: "hosted",
    turn: liveTurn ? "running" : "idle",
    provenance: "structured",
    revision: 1,
    attentionIds: [],
    recentReceipts: busReceipts,
    accountId: null,
    parentConversationId: null,
    flowId: null,
    workflowId: null,
    cwd: "/repo",
    artifactPath: "/codex-quiet.jsonl",
    capabilities: { steer: true, structuredAttention: true },
    activeTurnId: liveTurn?.turnId ?? null,
    liveTurn,
  },
  uiState: liveTurn ? "working" : "idle",
  attentions: [],
  receipts: busReceipts,
  legacy: false,
  structuredControlsEnabled: true,
});

const file = (mtimeSeconds: number): FileEntry => ({
  path: "/codex-quiet.jsonl", root: "codex-sessions", name: "codex-quiet.jsonl", project: "viewer",
  title: "Codex", engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: mtimeSeconds,
  size: 1, activity: "idle", proc: "running", pid: null, conversationId: "conv-quiet",
  pendingQuestion: null, waitingInput: null,
} as FileEntry);

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

function mockTargets(): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input) === "/api/tmux/targets") return { ok: true, json: async () => ({ targets: { "0": "%1" } }) } as Response;
    return { ok: true, json: async () => ({ ok: true }) } as Response;
  }) as typeof fetch;
}

test("every successful delivery state renders zero persistent chrome in both locales", () => {
  for (const locale of ["en", "uk"] as const) {
    setLocale(locale);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    flushSync(() => root.render(
      <RuntimeComposerReceipts
        receipts={[
          receipt({ operationId: "op-delivered", status: "delivered", text: "one" }),
          receipt({ operationId: "op-answered", status: "answered", text: "two" }),
          receipt({ operationId: "op-steered", kind: "steer", status: "steered", text: "three" }),
          receipt({ operationId: "op-started", status: "turn-started", text: "four" }),
          // the interrupt succeeded — no green «доставлено» pill may pile up
          receipt({ operationId: "op-interrupt", kind: "interrupt", status: "delivered", text: null }),
          receipt({ operationId: "op-interrupted", kind: "interrupt", status: "interrupted", text: null }),
        ]}
        onRetry={() => {}}
        onEdit={() => {}}
        onDismiss={() => {}}
      />,
    ));
    expect(host.querySelector("details")).toBeNull();
    expect(host.querySelector("[data-receipt-status]")).toBeNull();
    expect(host.textContent).toBe("");
    flushSync(() => root.unmount());
  }
});

test("a failure renders once with retry, edit, and dismiss, and dismissal reports every settled attempt", () => {
  setLocale("uk");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const dismissedBatches: string[][] = [];
  const text = "не доставлене повідомлення";
  flushSync(() => root.render(
    <RuntimeComposerReceipts
      receipts={[
        receipt({ operationId: "op-fail-now", status: "failed", reason: "dead-host", text, at: "2026-07-18T10:00:01.000Z" }),
        receipt({ operationId: "op-fail-then", status: "rejected", reason: "dead-host", text, at: "2026-07-18T10:00:00.000Z" }),
      ]}
      onRetry={() => {}}
      onEdit={() => {}}
      onDismiss={(ids) => dismissedBatches.push(ids)}
    />,
  ));

  // One row for the grouped attempts, with the full action set.
  expect(host.querySelectorAll("[data-receipt-message]")).toHaveLength(1);
  const labels = [...host.querySelectorAll("button")].map((b) => b.textContent || b.getAttribute("aria-label"));
  expect(labels).toContain(translate("uk", "runtime.receipt.retry"));
  expect(labels).toContain(translate("uk", "runtime.receipt.edit"));
  const dismiss = host.querySelector("[data-receipt-dismiss]") as HTMLButtonElement;
  expect(dismiss.getAttribute("aria-label")).toBe(translate("uk", "runtime.receipt.dismiss"));
  flushSync(() => dismiss.click());
  expect(dismissedBatches).toEqual([["op-fail-now", "op-fail-then"]]);

  // With the dismissal recorded the row is gone for good.
  flushSync(() => root.render(
    <RuntimeComposerReceipts
      receipts={[
        receipt({ operationId: "op-fail-now", status: "failed", reason: "dead-host", text, at: "2026-07-18T10:00:01.000Z" }),
        receipt({ operationId: "op-fail-then", status: "rejected", reason: "dead-host", text, at: "2026-07-18T10:00:00.000Z" }),
      ]}
      dismissed={new Set(dismissedBatches.flat())}
      onRetry={() => {}}
      onEdit={() => {}}
      onDismiss={() => {}}
    />,
  ));
  expect(host.textContent).toBe("");
  flushSync(() => root.unmount());
});

test("retry appears once only after an authoritative retryable terminal failure", async () => {
  setLocale("en");
  const retryLabel = translate("en", "runtime.receipt.retry");
  const view = (status: RuntimeReceipt["status"]) => (
    <RuntimeComposerReceipts
      receipts={[receipt({ operationId: `op-${status}`, status, text: "preserved generation" })]}
      onRetry={() => {}}
      onEdit={() => {}}
      onDismiss={() => {}}
    />
  );
  const { host, root } = await renderInto(view("uncertain"));
  const retries = () => [...host.querySelectorAll("button")]
    .filter((button) => button.textContent === retryLabel);

  expect(retries()).toHaveLength(0);
  await settle(() => root.render(view("rejected")));
  expect(retries()).toHaveLength(0);
  await settle(() => root.render(view("failed")));
  expect(retries()).toHaveLength(1);

  await act(async () => root.unmount());
});

test("a dismissed failure stays dismissed across a composer remount", async () => {
  mockTargets();
  publishReceipts([receipt({ operationId: "op-persist", status: "failed", reason: "dead-host", text: "retry або ні" })]);

  const first = await renderInto(<TmuxComposer file={file(1)} />);
  expect(first.host.querySelector("[data-runtime-receipt-stack]")).toBeTruthy();
  const dismiss = first.host.querySelector("[data-receipt-dismiss]") as HTMLButtonElement;
  await settle(() => dismiss.click());
  expect(first.host.querySelector("[data-runtime-receipt-stack]")).toBeNull();
  await act(async () => first.root.unmount());

  // The same receipt is still on the bus after the remount — the persisted
  // dismissal (sessionStorage, conversation identity) keeps it quiet.
  const second = await renderInto(<TmuxComposer file={file(1)} />);
  expect(second.host.querySelector("[data-runtime-receipt-stack]")).toBeNull();
  expect(second.host.querySelector("[data-receipt-dismiss]")).toBeNull();
  await act(async () => second.root.unmount());
});

test("a delivered send shows one quiet echo line that clears when the exact bubble lands in the feed", async () => {
  setLocale("uk");
  mockTargets();
  const delivered = receipt({ operationId: "op-echo", status: "delivered", text: "я хочу стрілочками переміщатися" });
  publishReceipts([delivered]);

  // Transcript older than the delivery: the echo bridges the feed lag.
  const { host, root } = await renderInto(<TmuxComposer file={file(1)} />);
  const echo = host.querySelector("[data-delivery-echo]") as HTMLElement;
  expect(echo).toBeTruthy();
  expect(echo.textContent).toContain("я хочу стрілочками переміщатися");
  expect(echo.textContent).toContain(translate("uk", "composer.deliveredEcho"));
  // No green pill anywhere: the delivered state renders no Badge chrome.
  expect(host.querySelector("[data-receipt-status]")).toBeNull();
  expect(host.querySelector("[data-runtime-receipt-stack]")).toBeNull();

  // The exact transcript bubble is authoritative even when its mtime predates
  // the final delivered receipt.
  await settle(() => publishTranscriptEchoes("conv-quiet", new Map([[delivered.text!, 1]])));
  expect(host.querySelector("[data-delivery-echo]")).toBeNull();
  await act(async () => root.unmount());
});

test("a streaming assistant reply retires its delivering outbox bubble", async () => {
  mockTargets();
  const responding = receipt({
    operationId: "turn-replied",
    idempotencyKey: "key-replied",
    status: "delivering",
    turnId: null,
    text: "the assistant is answering this",
  });
  enqueueOutbox("conv-quiet", {
    id: responding.idempotencyKey,
    text: responding.text!,
    images: 0,
    at: Date.parse(responding.at),
  });
  updateOutbox("conv-quiet", responding.idempotencyKey, { state: "delivering" });
  publishReceipts([responding]);
  publishRuntimeView(structuredRuntimeView(null));

  const { root } = await renderInto(<TmuxComposer file={file(1)} />);
  expect(readOutbox("conv-quiet")[0]).toMatchObject({ state: "delivering" });

  await settle(() => publishRuntimeView(structuredRuntimeView({
    turnId: responding.operationId,
    text: "streaming reply",
  })));
  expect(readOutbox("conv-quiet")[0]).toMatchObject({
    id: responding.idempotencyKey,
    state: "delivered",
  });
  expect(readOutbox("conv-quiet")[0]!.responseStartedAt).toBeNumber();
  await act(async () => root.unmount());
});

test("dismissing the echo hides it immediately and persistently", async () => {
  mockTargets();
  publishReceipts([receipt({ operationId: "op-echo-dismiss", status: "delivered", text: "quiet now" })]);

  const { host, root } = await renderInto(<TmuxComposer file={file(1)} />);
  const echo = host.querySelector("[data-delivery-echo]") as HTMLElement;
  const dismiss = echo.querySelector("button") as HTMLButtonElement;
  expect(dismiss.getAttribute("aria-label")).toBe(translate("en", "runtime.receipt.dismiss"));
  await settle(() => dismiss.click());
  expect(host.querySelector("[data-delivery-echo]")).toBeNull();
  await act(async () => root.unmount());

  const again = await renderInto(<TmuxComposer file={file(1)} />);
  expect(again.host.querySelector("[data-delivery-echo]")).toBeNull();
  await act(async () => again.root.unmount());
});

test("visual acceptance: the delivery surfaces hold at desktop and 390px in both locales", async () => {
  /* No pixel browser in CI — acceptance is structural: the classes that carry
     the layout contract (truncation, wrap, touch hit areas) must be present at
     both widths, and success must stay quiet at both. */
  for (const [width, mobile] of [[1280, false], [390, true]] as const) {
    (dom as unknown as { innerWidth: number }).innerWidth = width;
    (dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
      matches: mobile && query.includes("max-width"),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    });
    for (const locale of ["en", "uk"] as const) {
      setLocale(locale);
      mockTargets();
      publishReceipts([
        receipt({ operationId: `op-ok-${width}-${locale}`, status: "delivered", text: "довге доставлене повідомлення, яке мусить обрізатися крапками на вузькому екрані" }),
        receipt({ operationId: `op-bad-${width}-${locale}`, status: "failed", reason: "dead-host", text: "повідомлення, що не доїхало" }),
      ]);
      const { host, root } = await renderInto(<TmuxComposer file={file(1)} />);

      // Success: one quiet echo line, truncated, never a Badge pill.
      const echo = host.querySelector("[data-delivery-echo]") as HTMLElement;
      const echoText = echo.querySelector("span[title]") as HTMLElement;
      expect(echoText.className).toContain("truncate");
      expect(echoText.className).toContain("max-w-[85%]");
      const echoDismiss = echo.querySelector("button") as HTMLElement;
      if (mobile) expect(echoDismiss.className).toContain("h-11 w-11");

      // Failure: one disclosure whose row wraps actions under the text at 390px.
      const stack = host.querySelector("[data-runtime-receipt-stack]") as HTMLElement;
      const row = stack.querySelector("[data-receipt-message]")!.parentElement as HTMLElement;
      expect(row.className).toContain("flex-wrap");
      const preview = stack.querySelector("[data-receipt-preview]") as HTMLElement;
      expect(preview.className).toContain("truncate");
      const dismiss = stack.querySelector("[data-receipt-dismiss]") as HTMLElement;
      expect(dismiss.className).toContain("min-h-11");
      expect(dismiss.className).toContain("min-w-11");

      // The failed text renders exactly once — no duplicated badge layer.
      const failedMatches = host.querySelectorAll("[data-receipt-message]");
      expect(failedMatches).toHaveLength(1);
      await act(async () => root.unmount());
      sessionStorage.clear();
    }
  }
  // restore the shared harness matchMedia (desktop default)
  (dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  });
});
