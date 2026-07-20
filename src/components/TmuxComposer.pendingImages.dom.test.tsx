import { afterAll, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import type { RuntimeReceipt } from "@/components/runtime/runtimeModel";
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
  matches: query.includes("max-width"),
  media: query,
  addEventListener() {},
  removeEventListener() {},
});

/* A controllable durable-receipt stream stands in for the runtime bus: the
   test pushes the late `delivered` receipt the way production does — through
   the receipts hook — instead of smuggling it into a send response. The
   actual hooks are restored in afterAll (mock.module is process-global). */
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

test("a lost image send keeps its earliest snapshot through a conflicting retry until the late delivery settles it", async () => {
  const sentKeys: string[] = [];
  const sentImageCounts: number[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/tmux/targets") {
      return { ok: true, json: async () => ({ targets: { "0": null } }) } as Response;
    }
    if (String(input) !== "/api/tmux") throw new Error(`unexpected request: ${String(input)}`);
    const body = JSON.parse(String(init?.body)) as { clientMessageId: string; text: string; images?: unknown[] };
    sentKeys.push(body.clientMessageId);
    sentImageCounts.push(body.images?.length ?? 0);
    if (sentKeys.length === 1) {
      /* The server accepted and delivers, yet the response is lost. */
      return { ok: false, status: 503, json: async () => ({ ok: false, error: "runtime host request timed out" }) } as Response;
    }
    if (sentKeys.length === 2) {
      /* The retry replays the key with a CHANGED image set: a reservation
         conflict, typed 409, and — crucially — no delivered receipt. */
      return {
        ok: false,
        status: 409,
        json: async () => ({
          ok: false,
          structured: true,
          error: "client message id is already reserved for another request",
        }),
      } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, outcome: "delivered-to-live" }) } as Response;
  }) as typeof fetch;

  const file = {
    path: "/codex-pending-images.jsonl",
    root: "codex-sessions",
    name: "codex-pending-images.jsonl",
    project: "viewer",
    title: "Codex pending images",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "idle",
    proc: "running",
    pid: null,
    conversationId: "conv-pending-images",
    pendingQuestion: null,
    waitingInput: null,
  } as FileEntry;
  sessionStorage.setItem("llvDraft:conv-pending-images", "annotate the screenshot");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<TmuxComposer file={file} />));
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const form = textarea.closest("form")!;
  expect(form.getAttribute("data-testid")).toBe("bounded-mobile-composer");
  expect(form.className).toContain("max-h-[min(38dvh,20rem)]");
  expect(form.className).toContain("overflow-y-auto");
  expect(form.className).toContain("overflow-x-clip");
  expect(form.className).toContain("overscroll-y-contain");
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
  const lateReceipt = (revision: number): RuntimeReceipt => ({
    operationId: "op-late-delivery",
    idempotencyKey: sentKeys[0]!,
    conversationId: "conversation_bus-session",
    kind: "send",
    status: "delivered",
    text: "annotate the screenshot",
    at: "2026-07-17T00:00:01.000Z",
    revision,
  });

  try {
    pasteImage("sent-with-first-attempt");
    await untilPreviews(1);
    const sentPreview = previews()[0];
    flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sentImageCounts).toEqual([1]);
    expect(textarea.value).toBe("annotate the screenshot");

    /* An image attached while the first attempt's fate is unknown. */
    pasteImage("attached-after-loss");
    await untilPreviews(2);
    const laterPreview = previews()[1];
    expect(laterPreview).not.toBe(sentPreview);

    /* The retry (same key, now two images) is a changed payload: the server
       rejects it 409 with no receipt, the composer keeps everything attached,
       and the FIRST attempt's snapshot stays the immutable record. */
    flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sentKeys).toHaveLength(2);
    expect(sentKeys[1]).toBe(sentKeys[0]);
    expect(previews()).toHaveLength(2);
    expect(textarea.value).toBe("annotate the screenshot");

    /* The late delivered receipt for the FIRST attempt arrives on the durable
       receipt stream: it clears exactly the sent text and image A, keeps the
       later image B, and rotates the consumed key. */
    flushSync(() => publishReceipts([lateReceipt(2)]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(textarea.value).toBe("");
    expect(previews()).toEqual([laterPreview]);

    /* Re-publishing the same delivered receipt is idempotent: nothing further
       clears and the key rotation below stays exactly once. */
    flushSync(() => publishReceipts([lateReceipt(3)]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(previews()).toEqual([laterPreview]);

    flushSync(() => appendComposerDraft("conv-pending-images", "next ask"));
    flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sentKeys).toHaveLength(3);
    expect(sentKeys[2]).not.toBe(sentKeys[0]);
    expect(sentImageCounts[2]).toBe(1);
  } finally {
    flushSync(() => root.unmount());
    publishReceipts([]);
    sessionStorage.clear();
  }
});
