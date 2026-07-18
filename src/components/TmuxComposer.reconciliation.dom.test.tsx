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
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false,
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

/* A controllable durable-receipt stream stands in for the runtime bus: the
   tests push admission receipts the way production does — through the
   receipts hook — while the send response is still in flight or after a
   remount. The actual hooks are restored in afterAll (mock.module is
   process-global). */
const actualRuntimeHooks = await import("@/hooks/useRuntime");
const receiptListeners = new Set<() => void>();
let busReceipts: RuntimeReceipt[] = [];
function publishReceipts(next: RuntimeReceipt[]): void {
  busReceipts = next;
  for (const listener of receiptListeners) listener();
}
mock.module("@/hooks/useRuntime", () => ({
  ...actualRuntimeHooks,
  useRuntimeSession: () => null,
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

const { appendComposerDraft, TmuxComposer } = await import("./TmuxComposer");

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

test("a mid-flight queued admission settles the generation and the stale timeout cannot resurrect it", async () => {
  setLocale("en");
  const conversationId = "conv-hang-admission";
  const prompt = "annotate the production screenshot";
  const sentKeys: string[] = [];
  const sentImageCounts: number[] = [];
  let resolveHung!: (response: Response) => void;
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/tmux/targets") {
      return { ok: true, json: async () => ({ targets: { "0": null } }) } as Response;
    }
    if (String(input) !== "/api/tmux") throw new Error(`unexpected request: ${String(input)}`);
    const body = JSON.parse(String(init?.body)) as { clientMessageId: string; images?: unknown[] };
    sentKeys.push(body.clientMessageId);
    sentImageCounts.push(body.images?.length ?? 0);
    if (sentKeys.length === 1) {
      /* The runtime host hangs: the response settles long after the durable
         admission has already reached the client on the receipt stream. */
      return new Promise<Response>((resolve) => { resolveHung = resolve; });
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        structured: true,
        receipt: {
          operationId: "op-next-generation",
          idempotencyKey: body.clientMessageId,
          conversationId,
          kind: "send",
          status: "queued",
          text: "next ask",
          at: "2026-07-18T00:01:00.000Z",
          revision: 1,
        },
      }),
    } as Response;
  }) as typeof fetch;

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
    for (let attempt = 0; attempt < 50 && previews().length !== count; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(previews()).toHaveLength(count);
  };
  const admission = (status: RuntimeReceipt["status"], revision: number): RuntimeReceipt => ({
    operationId: "ac0223c0-2bef-46dd-a26e-143b758f66dc",
    idempotencyKey: sentKeys[0]!,
    conversationId: "conversation_bus-session",
    kind: "send",
    status,
    text: prompt,
    at: `2026-07-18T00:00:0${revision}.000Z`,
    revision,
  });

  try {
    pasteImage("sent-with-attempt");
    await untilPreviews(1);
    flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sentImageCounts).toEqual([1]);
    expect(textarea.value).toBe(prompt);

    /* An image attached while the send hangs belongs to the NEXT generation. */
    pasteImage("attached-mid-flight");
    await untilPreviews(2);
    const laterPreview = previews()[1];

    /* The durable queued admission arrives on the receipt stream while the
       response is still hanging: exactly the submitted generation leaves the
       composer — its text and its attachment snapshot, nothing newer. */
    flushSync(() => publishReceipts([admission("queued", 1)]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(textarea.value).toBe("");
    expect(previews()).toEqual([laterPreview]);
    expect(sessionStorage.getItem(`llvDraft:${conversationId}`)).toBe(null);
    expect(sessionStorage.getItem(`llvPendingSend:${conversationId}`)).toBe(null);

    /* The operator drafts the next ask before the hung response dies. */
    flushSync(() => appendComposerDraft(conversationId, "next ask"));
    expect(textarea.value).toBe("next ask");

    /* The stale timeout finally settles: no false failure, no resurrected
       text, no re-armed pending generation. */
    resolveHung({
      ok: false,
      status: 503,
      json: async () => ({ ok: false, error: "runtime host request timed out" }),
    } as Response);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(textarea.value).toBe("next ask");
    expect(host.textContent).not.toContain("runtime host request timed out");
    expect(host.textContent).not.toContain(translate("en", "common.failedSend"));
    expect(host.textContent).not.toContain(translate("en", "common.serverUnavailable"));
    expect(sessionStorage.getItem(`llvPendingSend:${conversationId}`)).toBe(null);

    /* A later delivered replay of the settled generation is a no-op: accepted
       text never resurrects and the next draft is never wiped. */
    flushSync(() => publishReceipts([admission("delivered", 2)]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(textarea.value).toBe("next ask");

    /* The next generation goes out under a fresh key with only its own image. */
    flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sentKeys).toHaveLength(2);
    expect(sentKeys[1]).not.toBe(sentKeys[0]);
    expect(sentImageCounts[1]).toBe(1);
    expect(textarea.value).toBe("");
  } finally {
    flushSync(() => root.unmount());
    publishReceipts([]);
    sessionStorage.clear();
    host.remove();
  }
});

test("a queued admission after remount still clears the persisted generation exactly", async () => {
  setLocale("en");
  const conversationId = "conv-remount-admission";
  const prompt = "довгий запит that survived a refresh";
  const sentKeys: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/tmux/targets") {
      return { ok: true, json: async () => ({ targets: { "0": null } }) } as Response;
    }
    if (String(input) !== "/api/tmux") throw new Error(`unexpected request: ${String(input)}`);
    const body = JSON.parse(String(init?.body)) as { clientMessageId: string };
    sentKeys.push(body.clientMessageId);
    return { ok: false, status: 503, json: async () => ({ ok: false, error: "runtime host request timed out" }) } as Response;
  }) as typeof fetch;

  sessionStorage.setItem(`llvDraft:${conversationId}`, prompt);
  const host = document.createElement("div");
  document.body.append(host);
  let root = createRoot(host);
  flushSync(() => root.render(<TmuxComposer file={fileFor(conversationId)} />));
  let textarea = host.querySelector("textarea") as HTMLTextAreaElement;

  try {
    flushSync(() => textarea.closest("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sentKeys).toHaveLength(1);
    expect(textarea.value).toBe(prompt);
    /* The unsettled generation is durable client state now. */
    expect(sessionStorage.getItem(`llvPendingSend:${conversationId}`)).toContain(sentKeys[0]!);

    /* The tab refreshes: the composer unmounts and a fresh one mounts over the
       persisted draft, with more typing added after the reload. */
    flushSync(() => root.unmount());
    flushSync(() => appendComposerDraft(conversationId, "after refresh typing"));
    /* The refresh snapshot already carries the durable queued admission. */
    publishReceipts([{
      operationId: "ac0223c0-2bef-46dd-a26e-143b758f66dc",
      idempotencyKey: sentKeys[0]!,
      conversationId: "conversation_bus-session",
      kind: "send",
      status: "queued",
      text: prompt,
      at: "2026-07-18T00:00:05.000Z",
      revision: 1,
    }]);
    root = createRoot(host);
    flushSync(() => root.render(<TmuxComposer file={fileFor(conversationId)} />));
    await new Promise((resolve) => setTimeout(resolve, 0));

    textarea = host.querySelector("textarea") as HTMLTextAreaElement;
    /* The accepted generation is gone; the post-refresh typing survives. */
    expect(textarea.value).toBe("after refresh typing");
    expect(sessionStorage.getItem(`llvDraft:${conversationId}`)).toBe("after refresh typing");
    expect(sessionStorage.getItem(`llvPendingSend:${conversationId}`)).toBe(null);
    /* The receipt stack keeps the truthful queued record with the payload. */
    expect(host.querySelector('[data-receipt-status="queued"]')?.textContent)
      .toBe(translate("en", "runtime.receipt.queued"));
    expect(host.querySelector("[data-receipt-preview]")?.textContent).toBe(prompt);
  } finally {
    flushSync(() => root.unmount());
    publishReceipts([]);
    sessionStorage.clear();
    host.remove();
  }
});
