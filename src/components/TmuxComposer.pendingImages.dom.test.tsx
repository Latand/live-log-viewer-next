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
const { readOutbox, retryOutbox, resetOutboxForTests } = await import("./conversation/outbox");

test("queue-first: a lost image send keeps its own immutable snapshot through a retry until the late delivery settles it", async () => {
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
    /* Queue-first (round-1 P1#1/#4): submitting snapshots this generation's one
       image into the durable outbox entry and clears the composer + tray
       immediately. The lost first attempt (503) marks the bubble failed while
       preserving its immutable image snapshot. */
    flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sentImageCounts).toEqual([1]);
    expect(textarea.value).toBe("");
    await untilPreviews(0);
    const failed = readOutbox("conv-pending-images").find((entry) => entry.text === "annotate the screenshot")!;
    expect(failed.state).toBe("failed");
    expect(failed.images).toBe(1);

    /* An image attached AFTER the submit belongs to the NEXT message — it never
       joins the failed entry's immutable snapshot. */
    pasteImage("attached-after-loss");
    await untilPreviews(1);
    const laterPreview = previews()[0];
    expect(laterPreview).not.toBe(sentPreview);

    /* Retrying the failed bubble replays the SAME key with the SAME one-image
       snapshot — never the two images now on screen. */
    flushSync(() => retryOutbox("conv-pending-images", failed.id));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sentKeys).toHaveLength(2);
    expect(sentKeys[1]).toBe(sentKeys[0]);
    expect(sentImageCounts[1]).toBe(1);
    /* The later image B still sits in the tray for the next message. */
    expect(previews()).toEqual([laterPreview]);

    /* The late delivered receipt for the FIRST attempt arrives on the durable
       receipt stream: it settles exactly that bubble to delivered and rotates
       the consumed key, without touching image B or the composer. */
    flushSync(() => publishReceipts([lateReceipt(2)]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readOutbox("conv-pending-images").find((entry) => entry.id === failed.id)!.state).toBe("delivered");
    expect(previews()).toEqual([laterPreview]);

    /* The next message sends image B under a fresh key — proof the snapshots
       never crossed generations. */
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
    resetOutboxForTests();
  }
});
