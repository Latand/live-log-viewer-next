import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import type { RuntimeReceipt } from "@/components/runtime/runtimeModel";
import { setLocale, translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

const dom = new Window();
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
let mobileViewport = false;
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: mobileViewport && query.includes("max-width"),
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

/* The local reconciliation window is a product-real 30s. These tests exercise
   its EXPIRY, so the module is mocked to a few tens of milliseconds while every
   reconciliation primitive stays the real implementation — the component reads
   the window/poll constants and threads them through, so shrinking them here
   drives the production code path. bun runs each test file in its own module
   graph, so this override stays isolated from the 30s tests next door. */
const actualDeadline = await import("./composerAdmissionDeadline");
mock.module("./composerAdmissionDeadline", () => ({
  ...actualDeadline,
  COMPOSER_RECEIPT_RECONCILIATION_MS: 40,
  COMPOSER_RECEIPT_POLL_INTERVAL_MS: 5,
}));
const { ComposerAdmissionTimeoutError } = actualDeadline;

/* A controllable durable-receipt stream stands in for the runtime bus (see the
   sibling reconciliation test for the rationale). */
const actualRuntimeHooks = await import("@/hooks/useRuntime");
const receiptListeners = new Set<() => void>();
let busReceipts: RuntimeReceipt[] = [];
let refreshRuntimeImpl: () => Promise<boolean> = async () => false;
function publishReceipts(next: RuntimeReceipt[]): void {
  busReceipts = next;
  for (const listener of receiptListeners) listener();
}
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeSession: () => null,
  refreshRuntime: () => refreshRuntimeImpl(),
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
  mock.module("./composerAdmissionDeadline", () => actualDeadline);
});

const { TmuxComposer } = await import("./TmuxComposer");

function fileFor(conversationId: string): FileEntry {
  return {
    path: `/${conversationId}.jsonl`,
    root: "codex-sessions",
    name: `${conversationId}.jsonl`,
    project: "viewer",
    title: conversationId,
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "idle",
    proc: "running",
    pid: null,
    conversationId,
    pendingQuestion: null,
    waitingInput: null,
  } as FileEntry;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const submitButton = (host: HTMLElement) => host.querySelector('button[type="submit"]') as HTMLButtonElement;
async function untilSendEnabled(host: HTMLElement): Promise<void> {
  for (let attempt = 0; attempt < 100 && submitButton(host).disabled; attempt += 1) await sleep(3);
  expect(submitButton(host).disabled).toBe(false);
}

test("no receipt within the local window recovers the composer for an exactly-once same-key retry", async () => {
  setLocale("en");
  mobileViewport = false;
  const conversationId = "conv-expiry-recover";
  const prompt = "confirm the deploy went out";
  const sentKeys: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/tmux/targets") {
      return { ok: true, json: async () => ({ targets: { "0": null } }) } as Response;
    }
    if (String(input) !== "/api/tmux") throw new Error(`unexpected request: ${String(input)}`);
    const body = JSON.parse(String(init?.body)) as { clientMessageId: string };
    sentKeys.push(body.clientMessageId);
    if (sentKeys.length === 1) throw new ComposerAdmissionTimeoutError();
    /* The explicit retry replays the SAME key and this time is admitted. */
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        structured: true,
        receipt: {
          operationId: "op-expiry-retry",
          idempotencyKey: body.clientMessageId,
          conversationId,
          kind: "send",
          status: "queued",
          text: prompt,
          at: "2026-07-20T09:00:00.000Z",
          revision: 1,
        },
      }),
    } as Response;
  }) as typeof fetch;
  refreshRuntimeImpl = async () => false;

  sessionStorage.setItem(`llvDraft:${conversationId}`, prompt);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<TmuxComposer file={fileFor(conversationId)} />));
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const form = textarea.closest("form")!;

  try {
    flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    /* The window expires with no receipt; the composer must NOT stay disabled. */
    await untilSendEnabled(host);
    expect(sentKeys).toHaveLength(1);
    expect(textarea.value).toBe(prompt);
    /* Accurate, recoverable wording for the expired-window state. */
    expect(host.textContent).toContain(translate("en", "composer.deliveryUnconfirmed"));
    /* One durable, honest receipt row for the preserved generation. */
    expect(host.querySelectorAll('[data-receipt-status="uncertain"]')).toHaveLength(1);
    expect(host.querySelector("[data-receipt-preview]")?.textContent).toBe(prompt);
    /* The reconciliation loop never actuates a second send on its own. */
    await sleep(60);
    expect(sentKeys).toHaveLength(1);
    expect(sessionStorage.getItem(`llvPendingSend:${conversationId}`)).toContain(sentKeys[0]!);

    /* The operator explicitly retries: the ORIGINAL key replays idempotently. */
    flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    await sleep(0);
    expect(sentKeys).toHaveLength(2);
    expect(sentKeys[1]).toBe(sentKeys[0]);
    expect(textarea.value).toBe("");
    expect(host.querySelectorAll('[data-receipt-status="queued"]')).toHaveLength(1);
  } finally {
    flushSync(() => root.unmount());
    publishReceipts([]);
    refreshRuntimeImpl = async () => false;
    sessionStorage.clear();
    host.remove();
  }
});

test("a late receipt after the window still settles the preserved generation with no resend", async () => {
  setLocale("en");
  mobileViewport = false;
  const conversationId = "conv-expiry-late";
  const prompt = "did the migration finish";
  const sentKeys: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/tmux/targets") {
      return { ok: true, json: async () => ({ targets: { "0": null } }) } as Response;
    }
    if (String(input) !== "/api/tmux") throw new Error(`unexpected request: ${String(input)}`);
    const body = JSON.parse(String(init?.body)) as { clientMessageId: string };
    sentKeys.push(body.clientMessageId);
    throw new ComposerAdmissionTimeoutError();
  }) as typeof fetch;
  refreshRuntimeImpl = async () => false;

  sessionStorage.setItem(`llvDraft:${conversationId}`, prompt);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<TmuxComposer file={fileFor(conversationId)} />));
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const form = textarea.closest("form")!;

  try {
    flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    await untilSendEnabled(host);
    expect(host.querySelectorAll('[data-receipt-status="uncertain"]')).toHaveLength(1);

    /* The durable admission finally lands, well after the local window closed. */
    flushSync(() => publishReceipts([{
      operationId: "op-expiry-late",
      idempotencyKey: sentKeys[0]!,
      conversationId,
      kind: "send",
      status: "queued",
      text: prompt,
      at: "2026-07-20T09:01:00.000Z",
      revision: 1,
    }]));
    await sleep(0);

    expect(textarea.value).toBe("");
    expect(sentKeys).toHaveLength(1);
    /* The uncertain row is superseded — exactly one durable receipt remains. */
    expect(host.querySelectorAll('[data-receipt-status="uncertain"]')).toHaveLength(0);
    expect(host.querySelectorAll('[data-receipt-status="queued"]')).toHaveLength(1);
    expect(sessionStorage.getItem(`llvPendingSend:${conversationId}`)).toBe(null);
  } finally {
    flushSync(() => root.unmount());
    publishReceipts([]);
    refreshRuntimeImpl = async () => false;
    sessionStorage.clear();
    host.remove();
  }
});

test("the recovered generation survives a remount and keeps its original key", async () => {
  setLocale("en");
  mobileViewport = false;
  const conversationId = "conv-expiry-remount";
  const prompt = "still preserved across a refresh";
  const sentKeys: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/tmux/targets") {
      return { ok: true, json: async () => ({ targets: { "0": null } }) } as Response;
    }
    if (String(input) !== "/api/tmux") throw new Error(`unexpected request: ${String(input)}`);
    const body = JSON.parse(String(init?.body)) as { clientMessageId: string };
    sentKeys.push(body.clientMessageId);
    throw new ComposerAdmissionTimeoutError();
  }) as typeof fetch;
  refreshRuntimeImpl = async () => false;

  sessionStorage.setItem(`llvDraft:${conversationId}`, prompt);
  const host = document.createElement("div");
  document.body.append(host);
  let root = createRoot(host);
  flushSync(() => root.render(<TmuxComposer file={fileFor(conversationId)} />));

  try {
    flushSync(() => (host.querySelector("textarea") as HTMLTextAreaElement)
      .closest("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    await untilSendEnabled(host);
    expect(sentKeys).toHaveLength(1);
    /* The released marker must not re-arm the disabled window on remount. */
    expect(sessionStorage.getItem(`llvPendingSend:${conversationId}`)).not.toContain('"reconciling":true');

    flushSync(() => root.unmount());
    root = createRoot(host);
    flushSync(() => root.render(<TmuxComposer file={fileFor(conversationId)} />));
    await sleep(10);

    const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
    const form = textarea.closest("form")!;
    /* The composer accepts input again after the refresh. */
    expect(submitButton(host).disabled).toBe(false);
    expect(textarea.value).toBe(prompt);

    /* The explicit retry replays the ORIGINAL key across the remount. */
    flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    await sleep(0);
    expect(sentKeys).toHaveLength(2);
    expect(sentKeys[1]).toBe(sentKeys[0]);
  } finally {
    flushSync(() => root.unmount());
    publishReceipts([]);
    refreshRuntimeImpl = async () => false;
    sessionStorage.clear();
    host.remove();
  }
});

test("typing after the window survives; a late admission clears only the sent prefix", async () => {
  setLocale("en");
  mobileViewport = false;
  const conversationId = "conv-expiry-typing";
  const prompt = "check the logs";
  const sentKeys: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/tmux/targets") {
      return { ok: true, json: async () => ({ targets: { "0": null } }) } as Response;
    }
    if (String(input) !== "/api/tmux") throw new Error(`unexpected request: ${String(input)}`);
    const body = JSON.parse(String(init?.body)) as { clientMessageId: string };
    sentKeys.push(body.clientMessageId);
    throw new ComposerAdmissionTimeoutError();
  }) as typeof fetch;
  refreshRuntimeImpl = async () => false;

  sessionStorage.setItem(`llvDraft:${conversationId}`, prompt);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<TmuxComposer file={fileFor(conversationId)} />));
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const form = textarea.closest("form")!;
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const textareaProps = (textarea as unknown as Record<string, { onChange(event: unknown): void }>)[propsKey]!;

  try {
    flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    await untilSendEnabled(host);

    flushSync(() => textareaProps.onChange({ target: { value: `${prompt}\nand the metrics` } }));
    expect(textarea.value).toBe(`${prompt}\nand the metrics`);

    flushSync(() => publishReceipts([{
      operationId: "op-expiry-typing",
      idempotencyKey: sentKeys[0]!,
      conversationId,
      kind: "send",
      status: "queued",
      text: prompt,
      at: "2026-07-20T09:02:00.000Z",
      revision: 1,
    }]));
    await sleep(0);
    /* The admitted prefix leaves; the typing added after the window survives. */
    expect(textarea.value).toBe("and the metrics");
    expect(sentKeys).toHaveLength(1);
  } finally {
    flushSync(() => root.unmount());
    publishReceipts([]);
    refreshRuntimeImpl = async () => false;
    sessionStorage.clear();
    host.remove();
  }
});

test("a terminal failure after the window exposes Retry and re-enables the composer", async () => {
  setLocale("en");
  mobileViewport = false;
  const conversationId = "conv-expiry-terminal";
  const prompt = "keep this exact after it fails";
  const sentKeys: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/tmux/targets") {
      return { ok: true, json: async () => ({ targets: { "0": null } }) } as Response;
    }
    if (String(input) !== "/api/tmux") throw new Error(`unexpected request: ${String(input)}`);
    const body = JSON.parse(String(init?.body)) as { clientMessageId: string };
    sentKeys.push(body.clientMessageId);
    throw new ComposerAdmissionTimeoutError();
  }) as typeof fetch;
  refreshRuntimeImpl = async () => false;

  sessionStorage.setItem(`llvDraft:${conversationId}`, prompt);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<TmuxComposer file={fileFor(conversationId)} />));
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const form = textarea.closest("form")!;
  const retries = () => [...host.querySelectorAll("button")]
    .filter((button) => button.textContent === translate("en", "runtime.receipt.retry"));

  try {
    flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    await untilSendEnabled(host);
    expect(host.querySelectorAll('[data-receipt-status="uncertain"]')).toHaveLength(1);
    expect(retries()).toHaveLength(0);

    flushSync(() => publishReceipts([{
      operationId: "op-expiry-terminal",
      idempotencyKey: sentKeys[0]!,
      conversationId,
      kind: "send",
      status: "failed",
      reason: "dead-host",
      text: prompt,
      at: "2026-07-20T09:03:00.000Z",
      revision: 1,
    }]));
    await sleep(0);

    /* The failure supersedes the uncertain row and offers Retry; the composer
       stays usable and the payload stays exact. */
    expect(submitButton(host).disabled).toBe(false);
    expect(host.querySelectorAll('[data-receipt-status="uncertain"]')).toHaveLength(0);
    expect(retries()).toHaveLength(1);
    expect(textarea.value).toBe(prompt);
    expect(sentKeys).toHaveLength(1);
  } finally {
    flushSync(() => root.unmount());
    publishReceipts([]);
    refreshRuntimeImpl = async () => false;
    sessionStorage.clear();
    host.remove();
  }
});

test("multiple images survive the window and ride the same-key retry on desktop and 390px", async () => {
  setLocale("en");
  for (const [width, mobile] of [[1440, false], [390, true]] as const) {
    mobileViewport = mobile;
    Object.defineProperty(dom, "innerWidth", { configurable: true, value: width });
    const conversationId = `conv-expiry-images-${width}`;
    const prompt = `compare both shots at ${width}`;
    const sentKeys: string[] = [];
    const sentImageCounts: number[] = [];
    globalThis.fetch = (async (input, init) => {
      if (String(input) === "/api/tmux/targets") {
        return { ok: true, json: async () => ({ targets: { "0": null } }) } as Response;
      }
      if (String(input) !== "/api/tmux") throw new Error(`unexpected request: ${String(input)}`);
      const body = JSON.parse(String(init?.body)) as { clientMessageId: string; images?: unknown[] };
      sentKeys.push(body.clientMessageId);
      sentImageCounts.push(body.images?.length ?? 0);
      if (sentKeys.length === 1) throw new ComposerAdmissionTimeoutError();
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          structured: true,
          receipt: {
            operationId: `op-expiry-images-${width}`,
            idempotencyKey: body.clientMessageId,
            conversationId,
            kind: "send",
            status: "queued",
            text: prompt,
            at: "2026-07-20T09:04:00.000Z",
            revision: 1,
          },
        }),
      } as Response;
    }) as typeof fetch;
    refreshRuntimeImpl = async () => false;

    sessionStorage.setItem(`llvDraft:${conversationId}`, prompt);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    flushSync(() => root.render(<TmuxComposer file={fileFor(conversationId)} />));
    const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
    const form = textarea.closest("form")!;
    const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
    const textareaProps = (textarea as unknown as Record<string, { onPaste(event: unknown): void }>)[propsKey]!;
    const previews = () => [...host.querySelectorAll("img")].map((image) => image.getAttribute("src"));
    const pasteImage = (tag: string) => {
      const bytes = new TextEncoder().encode(`png-${tag}`);
      textareaProps.onPaste({
        clipboardData: { items: [{ type: "image/png", getAsFile: () => new dom.File([bytes], `${tag}.png`, { type: "image/png" }) }] },
        preventDefault() {},
      });
    };
    const untilPreviews = async (count: number) => {
      for (let attempt = 0; attempt < 50 && previews().length !== count; attempt += 1) await sleep(2);
      expect(previews()).toHaveLength(count);
    };

    try {
      pasteImage(`first-${width}`);
      pasteImage(`second-${width}`);
      await untilPreviews(2);
      const attached = previews();
      flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
      await untilSendEnabled(host);
      expect(sentImageCounts).toEqual([2]);
      /* Both attachments stay through the window — nothing was admitted. */
      expect(previews()).toEqual(attached);
      expect(host.querySelectorAll('[data-receipt-status="uncertain"]')).toHaveLength(1);

      /* The explicit retry replays the same key with the exact same images. */
      flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
      await sleep(0);
      expect(sentKeys).toHaveLength(2);
      expect(sentKeys[1]).toBe(sentKeys[0]);
      expect(sentImageCounts).toEqual([2, 2]);
      expect(previews()).toEqual([]);
      expect(host.querySelectorAll('[data-receipt-status="queued"]')).toHaveLength(1);
      if (mobile) {
        expect(form.getAttribute("data-testid")).toBe("bounded-mobile-composer");
      } else {
        expect(form.getAttribute("data-testid")).toBeNull();
      }
    } finally {
      flushSync(() => root.unmount());
      publishReceipts([]);
      refreshRuntimeImpl = async () => false;
      sessionStorage.clear();
      host.remove();
    }
  }
  mobileViewport = false;
});
