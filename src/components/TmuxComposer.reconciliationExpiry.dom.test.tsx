import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { useLayoutEffect, useSyncExternalStore } from "react";
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
  COMPOSER_ADMISSION_DEADLINE_MS: 8,
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

function IdentityCommitHarness({ file, onCommit }: { file: FileEntry; onCommit?: () => void }) {
  useLayoutEffect(() => {
    onCommit?.();
  }, [file.conversationId, onCommit]);
  return <TmuxComposer file={file} />;
}

function PresenceCommitHarness({ file, visible, onHiddenCommit }: {
  file: FileEntry;
  visible: boolean;
  onHiddenCommit?: () => void;
}) {
  useLayoutEffect(() => {
    if (!visible) onHiddenCommit?.();
  }, [onHiddenCommit, visible]);
  return visible ? <TmuxComposer file={file} /> : null;
}

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

test("late receipt-free legacy success settles live-pane and resume generations once", async () => {
  setLocale("en");
  mobileViewport = false;
  for (const scenario of [
    { name: "pane", target: "agents:1.0", outcome: "delivered-to-live" },
    { name: "resume", target: null, outcome: "resumed" },
  ] as const) {
    const conversationId = `conv-expiry-legacy-${scenario.name}`;
    const original = `send through delayed ${scenario.name}`;
    const later = `keep this ${scenario.name} draft`;
    const attempts: { key: string; text: string }[] = [];
    globalThis.fetch = (async (input, init) => {
      if (String(input) === "/api/tmux/targets") {
        return { ok: true, json: async () => ({ targets: { "0": scenario.target } }) } as Response;
      }
      if (String(input) !== "/api/tmux") throw new Error(`unexpected request: ${String(input)}`);
      const body = JSON.parse(String(init?.body)) as { clientMessageId: string; text: string };
      attempts.push({ key: body.clientMessageId, text: body.text });
      await sleep(75);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          outcome: scenario.outcome,
          ...(scenario.name === "resume" ? { spawned: true, target: "agents:2.0" } : {}),
        }),
      } as Response;
    }) as typeof fetch;
    refreshRuntimeImpl = async () => false;
    sessionStorage.setItem(`llvDraft:${conversationId}`, original);

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    flushSync(() => root.render(<TmuxComposer file={fileFor(conversationId)} />));
    const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
    const form = textarea.closest("form")!;
    const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
    const textareaProps = (textarea as unknown as Record<string, { onChange(event: unknown): void }>)[propsKey]!;
    try {
      await sleep(5);
      flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
      await sleep(10);
      flushSync(() => textareaProps.onChange({ target: { value: later } }));
      await sleep(50);
      expect(host.querySelectorAll('[data-receipt-status="uncertain"]')).toHaveLength(1);
      for (let attempt = 0; attempt < 50 && sessionStorage.getItem(`llvPendingSend:${conversationId}`); attempt += 1) {
        await sleep(3);
      }
      for (let attempt = 0; attempt < 50 && host.querySelectorAll('[data-receipt-status="uncertain"]').length; attempt += 1) {
        await sleep(3);
      }

      expect(attempts).toEqual([{ key: attempts[0]!.key, text: original }]);
      expect(textarea.value).toBe(later);
      expect(sessionStorage.getItem(`llvPendingSend:${conversationId}`)).toBeNull();
      expect(host.querySelectorAll('[data-receipt-status="uncertain"]')).toHaveLength(0);
      expect(submitButton(host).disabled).toBe(false);
    } finally {
      flushSync(() => root.unmount());
      publishReceipts([]);
      refreshRuntimeImpl = async () => false;
      sessionStorage.clear();
      host.remove();
    }
  }
});

test("identity commit invalidates a delayed legacy success before passive cleanup", async () => {
  setLocale("en");
  mobileViewport = false;
  const originalId = "conv-expiry-identity-original";
  const successorId = "conv-expiry-identity-successor";
  const original = "original identity payload";
  let resolveResponse!: (response: Response) => void;
  globalThis.fetch = (async (input) => {
    if (String(input) === "/api/tmux/targets") {
      return { ok: true, json: async () => ({ targets: { "0": "agents:1.0" } }) } as Response;
    }
    if (String(input) !== "/api/tmux") throw new Error(`unexpected request: ${String(input)}`);
    return new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
  }) as typeof fetch;
  refreshRuntimeImpl = async () => false;
  sessionStorage.setItem(`llvDraft:${originalId}`, original);

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<IdentityCommitHarness file={fileFor(originalId)} />));
  try {
    await sleep(5);
    const form = (host.querySelector("textarea") as HTMLTextAreaElement).closest("form")!;
    flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    for (let attempt = 0; attempt < 50 && !host.querySelector('[data-receipt-status="uncertain"]'); attempt += 1) {
      await sleep(3);
    }
    const pendingBefore = sessionStorage.getItem(`llvPendingSend:${originalId}`);
    expect(pendingBefore).not.toBeNull();

    const enrichedFile = { ...fileFor(successorId), path: fileFor(originalId).path };
    flushSync(() => root.render(
      <IdentityCommitHarness
        file={enrichedFile}
        onCommit={() => resolveResponse({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, outcome: "delivered-to-live" }),
        } as Response)}
      />,
    ));
    await sleep(30);

    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe(original);
    expect(sessionStorage.getItem(`llvDraft:${successorId}`)).toBe(original);
    expect(sessionStorage.getItem(`llvPendingSend:${successorId}`)).not.toBeNull();
  } finally {
    flushSync(() => root.unmount());
    publishReceipts([]);
    refreshRuntimeImpl = async () => false;
    sessionStorage.clear();
    host.remove();
  }
});

test("unmount commit invalidates a delayed legacy success before passive cleanup", async () => {
  setLocale("en");
  mobileViewport = false;
  const conversationId = "conv-expiry-unmount";
  const prompt = "keep the unmounted generation";
  let resolveResponse!: (response: Response) => void;
  globalThis.fetch = (async (input) => {
    if (String(input) === "/api/tmux/targets") {
      return { ok: true, json: async () => ({ targets: { "0": "agents:1.0" } }) } as Response;
    }
    if (String(input) !== "/api/tmux") throw new Error(`unexpected request: ${String(input)}`);
    return new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
  }) as typeof fetch;
  refreshRuntimeImpl = async () => false;
  sessionStorage.setItem(`llvDraft:${conversationId}`, prompt);

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<PresenceCommitHarness file={fileFor(conversationId)} visible />));
  try {
    await sleep(5);
    const form = (host.querySelector("textarea") as HTMLTextAreaElement).closest("form")!;
    flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    for (let attempt = 0; attempt < 50 && !host.querySelector('[data-receipt-status="uncertain"]'); attempt += 1) {
      await sleep(3);
    }
    const pendingBefore = sessionStorage.getItem(`llvPendingSend:${conversationId}`);
    expect(pendingBefore).not.toBeNull();

    flushSync(() => root.render(
      <PresenceCommitHarness
        file={fileFor(conversationId)}
        visible={false}
        onHiddenCommit={() => resolveResponse({
          ok: true,
          status: 200,
          json: async () => ({ ok: true, outcome: "delivered-to-live" }),
        } as Response)}
      />,
    ));
    await sleep(10);

    const pendingAfter = JSON.parse(sessionStorage.getItem(`llvPendingSend:${conversationId}`) ?? "[]") as Array<{ key: string; text: string }>;
    expect(pendingAfter).toHaveLength(1);
    expect(pendingAfter[0]).toMatchObject({ text: prompt });
    expect(sessionStorage.getItem(`llvDraft:${conversationId}`)).toBe(prompt);
  } finally {
    flushSync(() => root.unmount());
    publishReceipts([]);
    refreshRuntimeImpl = async () => false;
    sessionStorage.clear();
    host.remove();
  }
});

test("no receipt within the local window recovers the composer for an exactly-once same-key retry", async () => {
  setLocale("en");
  mobileViewport = false;
  const conversationId = "conv-expiry-recover";
  const prompt = "confirm the deploy went out";
  const sentKeys: string[] = [];
  const sentRuntimes: { model?: string; effort?: string; fast?: boolean }[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/tmux/targets") {
      return { ok: true, json: async () => ({ targets: { "0": null } }) } as Response;
    }
    if (String(input) !== "/api/tmux") throw new Error(`unexpected request: ${String(input)}`);
    const body = JSON.parse(String(init?.body)) as { clientMessageId: string; model?: string; effort?: string; fast?: boolean };
    sentKeys.push(body.clientMessageId);
    sentRuntimes.push({ model: body.model, effort: body.effort, fast: body.fast });
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
  localStorage.setItem(`llvAgentRuntime:${conversationId}:resume`, JSON.stringify({
    model: "gpt-5.6-sol",
    effort: "high",
    fast: false,
  }));
  const host = document.createElement("div");
  document.body.append(host);
  let root = createRoot(host);
  flushSync(() => root.render(<TmuxComposer file={fileFor(conversationId)} />));
  let textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  let form = textarea.closest("form")!;
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
    flushSync(() => {
      const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
      const props = (textarea as unknown as Record<string, { onChange(event: unknown): void }>)[propsKey]!;
      props.onChange({ target: { value: "" } });
    });
    flushSync(() => root.unmount());
    root = createRoot(host);
    flushSync(() => root.render(<TmuxComposer file={fileFor(conversationId)} />));
    await untilSendEnabled(host);
    textarea = host.querySelector("textarea") as HTMLTextAreaElement;
    localStorage.setItem(`llvAgentRuntime:${conversationId}:resume`, JSON.stringify({
      model: "gpt-5.6-sol",
      effort: "low",
      fast: true,
    }));
    form = textarea.closest("form")!;
    flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    await sleep(0);
    expect(sentKeys).toHaveLength(2);
    expect(sentKeys[1]).toBe(sentKeys[0]);
    expect(sentRuntimes[1]).toEqual(sentRuntimes[0]);
    expect(textarea.value).toBe("");
    expect(host.querySelectorAll('[data-receipt-status="queued"]')).toHaveLength(1);
  } finally {
    flushSync(() => root.unmount());
    publishReceipts([]);
    refreshRuntimeImpl = async () => false;
    sessionStorage.clear();
    localStorage.clear();
    host.remove();
  }
});

test("editing after expiry retries the immutable generation and preserves the later draft", async () => {
  setLocale("en");
  mobileViewport = false;
  const conversationId = "conv-expiry-edited-draft";
  const original = "confirm the original deployment";
  const laterDraft = "inspect the follow-up metrics";
  const attempts: { key: string; text: string }[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/tmux/targets") {
      return { ok: true, json: async () => ({ targets: { "0": null } }) } as Response;
    }
    if (String(input) !== "/api/tmux") throw new Error(`unexpected request: ${String(input)}`);
    const body = JSON.parse(String(init?.body)) as { clientMessageId: string; text: string };
    attempts.push({ key: body.clientMessageId, text: body.text });
    if (attempts.length === 1) throw new ComposerAdmissionTimeoutError();
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        structured: true,
        receipt: {
          operationId: "op-expiry-edited-draft",
          idempotencyKey: body.clientMessageId,
          conversationId,
          kind: "send",
          status: "queued",
          text: original,
          at: "2026-07-20T09:00:30.000Z",
          revision: 1,
        },
      }),
    } as Response;
  }) as typeof fetch;
  refreshRuntimeImpl = async () => false;

  sessionStorage.setItem(`llvDraft:${conversationId}`, original);
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
    flushSync(() => textareaProps.onChange({ target: { value: laterDraft } }));

    flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    await sleep(0);

    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual({ key: attempts[0]!.key, text: original });
    expect(textarea.value).toBe(laterDraft);
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

test("an image-bearing generation restores exact bytes across a remount on desktop and 390px", async () => {
  setLocale("en");
  for (const [width, mobile] of [[1440, false], [390, true]] as const) {
    mobileViewport = mobile;
    Object.defineProperty(dom, "innerWidth", { configurable: true, value: width });
    const conversationId = `conv-expiry-image-remount-${width}`;
    const prompt = `restore the screenshot at ${width}`;
    const attempts: { key: string; images: string[] }[] = [];
    globalThis.fetch = (async (input, init) => {
      if (String(input) === "/api/tmux/targets") {
        return { ok: true, json: async () => ({ targets: { "0": null } }) } as Response;
      }
      if (String(input) !== "/api/tmux") throw new Error(`unexpected request: ${String(input)}`);
      const body = JSON.parse(String(init?.body)) as { clientMessageId: string; images?: { base64: string }[] };
      attempts.push({ key: body.clientMessageId, images: body.images?.map((image) => image.base64) ?? [] });
      if (attempts.length === 1) throw new ComposerAdmissionTimeoutError();
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          structured: true,
          receipt: {
            operationId: `op-expiry-image-remount-${width}`,
            idempotencyKey: body.clientMessageId,
            conversationId,
            kind: "send",
            status: "queued",
            text: prompt,
            at: "2026-07-20T09:01:30.000Z",
            revision: 1,
          },
        }),
      } as Response;
    }) as typeof fetch;
    refreshRuntimeImpl = async () => false;

    sessionStorage.setItem(`llvDraft:${conversationId}`, prompt);
    const host = document.createElement("div");
    document.body.append(host);
    let root = createRoot(host);
    flushSync(() => root.render(<TmuxComposer file={fileFor(conversationId)} />));
    let textarea = host.querySelector("textarea") as HTMLTextAreaElement;
    let form = textarea.closest("form")!;
    const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
    const textareaProps = (textarea as unknown as Record<string, {
      onPaste(event: unknown): void;
      onChange(event: unknown): void;
    }>)[propsKey]!;
    const image = new TextEncoder().encode(`remount-image-${width}`);

    try {
      textareaProps.onPaste({
        clipboardData: { items: [{ type: "image/png", getAsFile: () => new dom.File([image], `remount-${width}.png`, { type: "image/png" }) }] },
        preventDefault() {},
      });
      for (let attempt = 0; attempt < 50 && host.querySelectorAll('[data-testid="attachment-tile"][data-status="ready"]').length !== 1; attempt += 1) {
        await sleep(2);
      }
      expect(host.querySelectorAll('[data-testid="attachment-tile"][data-status="ready"]')).toHaveLength(1);

      flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
      await untilSendEnabled(host);
      expect(attempts[0]?.images).toHaveLength(1);

      flushSync(() => textareaProps.onChange({ target: { value: `later draft ${width}` } }));
      flushSync(() => (host.querySelector('[data-testid="attachment-tile"] button') as HTMLButtonElement).click());
      textareaProps.onPaste({
        clipboardData: { items: [{ type: "image/png", getAsFile: () => new dom.File([`later-${width}`], `later-${width}.png`, { type: "image/png" }) }] },
        preventDefault() {},
      });
      for (let attempt = 0; attempt < 50 && host.querySelectorAll('[data-testid="attachment-tile"][data-status="ready"]').length !== 1; attempt += 1) {
        await sleep(2);
      }
      const laterPreview = (host.querySelector('[data-testid="attachment-tile"] img') as HTMLImageElement).src;
      await sleep(0);

      flushSync(() => root.unmount());
      root = createRoot(host);
      flushSync(() => root.render(<TmuxComposer file={fileFor(conversationId)} />));
      for (let attempt = 0; attempt < 50 && host.querySelectorAll('[data-testid="attachment-tile"][data-status="ready"]').length !== 1; attempt += 1) {
        await sleep(2);
      }
      expect(host.querySelectorAll('[data-testid="attachment-tile"][data-status="ready"]')).toHaveLength(1);

      textarea = host.querySelector("textarea") as HTMLTextAreaElement;
      form = textarea.closest("form")!;
      flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
      await sleep(0);

      expect(attempts).toHaveLength(2);
      expect(attempts[1]).toEqual(attempts[0]);
      expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe(`later draft ${width}`);
      expect(host.querySelectorAll('[data-testid="attachment-tile"]')).toHaveLength(1);
      expect((host.querySelector('[data-testid="attachment-tile"] img') as HTMLImageElement).src).toBe(laterPreview);
      if (mobile) expect(form.getAttribute("data-testid")).toBe("bounded-mobile-composer");
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
    if (String(input) === "/api/runtime/operations/op-expiry-terminal") {
      return {
        ok: true,
        status: 202,
        json: async () => ({
          receipt: {
            operationId: "op-expiry-terminal-retry",
            idempotencyKey: "key-expiry-terminal-retry",
            retryOfOperationId: "op-expiry-terminal",
            conversationId,
            kind: "send",
            status: "queued",
            text: prompt,
            at: "2026-07-20T09:03:30.000Z",
            revision: 1,
          },
        }),
      } as Response;
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
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const form = textarea.closest("form")!;
  const terminalPropsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const terminalTextareaProps = (textarea as unknown as Record<string, { onChange(event: unknown): void }>)[terminalPropsKey]!;
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

    flushSync(() => terminalTextareaProps.onChange({ target: { value: `${prompt}\nlater turn` } }));
    flushSync(() => (retries()[0] as HTMLButtonElement).click());
    for (let attempt = 0; attempt < 50 && textarea.value !== "later turn"; attempt += 1) await sleep(2);
    expect(textarea.value).toBe("later turn");
    expect(sessionStorage.getItem(`llvPendingSend:${conversationId}`)).toBeNull();

    flushSync(() => root.unmount());
    root = createRoot(host);
    flushSync(() => root.render(<TmuxComposer file={fileFor(conversationId)} />));
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("later turn");
    expect(sessionStorage.getItem(`llvPendingSend:${conversationId}`)).toBeNull();
  } finally {
    flushSync(() => root.unmount());
    publishReceipts([]);
    refreshRuntimeImpl = async () => false;
    sessionStorage.clear();
    host.remove();
  }
});

test("an incomplete quota snapshot stays fenced through remount until authoritative settlement", async () => {
  setLocale("en");
  for (const [width, mobile] of [[1440, false], [390, true]] as const) {
    mobileViewport = mobile;
    Object.defineProperty(dom, "innerWidth", { configurable: true, value: width });
    const conversationId = `conv-expiry-quota-${width}`;
    const original = `original quota payload ${width}`;
    const later = `later safe payload ${width}`;
    const sent: { key: string; text: string }[] = [];
    globalThis.fetch = (async (input, init) => {
      if (String(input) === "/api/tmux/targets") {
        return { ok: true, json: async () => ({ targets: { "0": null } }) } as Response;
      }
      if (String(input) !== "/api/tmux") throw new Error(`unexpected request: ${String(input)}`);
      const body = JSON.parse(String(init?.body)) as { clientMessageId: string; text: string };
      sent.push({ key: body.clientMessageId, text: body.text });
      return { ok: true, status: 200, json: async () => ({ ok: true, outcome: "delivered-to-live" }) } as Response;
    }) as typeof fetch;
    refreshRuntimeImpl = async () => false;
    sessionStorage.setItem(`llvDraft:${conversationId}`, later);
    sessionStorage.setItem(`llvPendingSend:${conversationId}`, JSON.stringify([{
      key: `key-quota-${width}`,
      text: original,
      images: [],
      payloadComplete: false,
      reconciling: true,
    }]));

    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    flushSync(() => root.render(<TmuxComposer file={fileFor(conversationId)} />));
    const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
    const form = textarea.closest("form")!;
    try {
      await sleep(70);
      expect(submitButton(host).disabled).toBe(true);
      expect(sent).toEqual([]);

      flushSync(() => publishReceipts([{
        operationId: `op-quota-${width}`,
        idempotencyKey: `key-quota-${width}`,
        conversationId,
        kind: "send",
        status: "queued",
        text: original,
        at: "2026-07-20T09:04:00.000Z",
        revision: 1,
      }]));
      await untilSendEnabled(host);
      expect(textarea.value).toBe(later);
      expect(sessionStorage.getItem(`llvPendingSend:${conversationId}`)).toBeNull();

      flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
      await sleep(0);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.text).toBe(later);
      expect(sent[0]?.key).not.toBe(`key-quota-${width}`);
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

test("an edited image tray retries the immutable images and preserves later attachments on desktop and 390px", async () => {
  setLocale("en");
  for (const [width, mobile] of [[1440, false], [390, true]] as const) {
    mobileViewport = mobile;
    Object.defineProperty(dom, "innerWidth", { configurable: true, value: width });
    const conversationId = `conv-expiry-images-${width}`;
    const prompt = `compare both shots at ${width}`;
    const sentKeys: string[] = [];
    const sentImages: string[][] = [];
    globalThis.fetch = (async (input, init) => {
      if (String(input) === "/api/tmux/targets") {
        return { ok: true, json: async () => ({ targets: { "0": null } }) } as Response;
      }
      if (String(input) !== "/api/tmux") throw new Error(`unexpected request: ${String(input)}`);
      const body = JSON.parse(String(init?.body)) as { clientMessageId: string; images?: { base64: string }[] };
      sentKeys.push(body.clientMessageId);
      sentImages.push(body.images?.map((image) => image.base64) ?? []);
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
      expect(sentImages[0]).toHaveLength(2);
      /* Both attachments stay through the window — nothing was admitted. */
      expect(previews()).toEqual(attached);
      expect(host.querySelectorAll('[data-receipt-status="uncertain"]')).toHaveLength(1);

      /* The operator edits the tray before retrying. The removed original and
         newly-added image belong to UI state around the pending generation. */
      const firstTile = host.querySelector('[data-testid="attachment-tile"]') as HTMLElement;
      flushSync(() => (firstTile.querySelector("button") as HTMLButtonElement).click());
      pasteImage(`later-${width}`);
      await untilPreviews(2);
      const editedTray = previews();
      expect(editedTray).not.toEqual(attached);

      /* The retry replays the same key with the original image bytes. */
      flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
      await sleep(0);
      expect(sentKeys).toHaveLength(2);
      expect(sentKeys[1]).toBe(sentKeys[0]);
      expect(sentImages[1]).toEqual(sentImages[0]);
      /* Settlement removes the surviving original image by intake id. The
         attachment added after expiry remains for the following generation. */
      expect(previews()).toEqual([editedTray[1]]);
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
