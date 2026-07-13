import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import type { FileEntry } from "@/lib/types";

import { RuntimeComposerReceipts, TmuxComposer } from "./TmuxComposer";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
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

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
});

test("editing a rejected receipt does not submit the composer form", () => {
  let edits = 0;
  let submits = 0;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);

  flushSync(() => root.render(
    <form onSubmit={(event) => { event.preventDefault(); submits += 1; }}>
      <RuntimeComposerReceipts
        receipts={[{
          operationId: "op-rejected",
          idempotencyKey: "key-rejected",
          conversationId: "conv-one",
          kind: "send",
          status: "rejected",
          reason: "stale delivery key",
          text: "try this again",
          at: "2026-07-13T00:00:00.000Z",
          revision: 3,
        }]}
        onRetry={() => {}}
        onEdit={() => { edits += 1; }}
      />
    </form>,
  ));

  const edit = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Edit"));
  expect(edit).toBeDefined();
  flushSync(() => edit!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));

  expect(edits).toBe(1);
  expect(submits).toBe(0);
  expect(edit!.getAttribute("type")).toBe("button");
  flushSync(() => root.unmount());
});

test("editing and resending a rejected receipt uses a fresh delivery key", async () => {
  const sentKeys: string[] = [];
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/tmux/targets") {
      return { ok: true, json: async () => ({ targets: { "0": null } }) } as Response;
    }
    if (String(input) !== "/api/tmux") throw new Error(`unexpected request: ${String(input)}`);
    const body = JSON.parse(String(init?.body)) as { clientMessageId: string };
    sentKeys.push(body.clientMessageId);
    if (sentKeys.length === 1) {
      return {
        ok: false,
        status: 409,
        json: async () => ({
          ok: false,
          structured: true,
          error: "delivery key was rejected",
          receipt: {
            operationId: "op-rejected",
            idempotencyKey: body.clientMessageId,
            conversationId: "conv-one",
            kind: "send",
            status: "rejected",
            reason: "delivery key was rejected",
            text: "try this again",
            at: "2026-07-13T00:00:00.000Z",
            revision: 1,
          },
        }),
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        structured: true,
        receipt: {
          operationId: "op-queued",
          idempotencyKey: body.clientMessageId,
          conversationId: "conv-one",
          kind: "send",
          status: "queued",
          text: "try this again",
          at: "2026-07-13T00:00:01.000Z",
          revision: 1,
        },
      }),
    } as Response;
  }) as typeof fetch;

  const file = {
    path: "/codex.jsonl",
    root: "codex-sessions",
    name: "codex.jsonl",
    project: "viewer",
    title: "Codex",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "idle",
    proc: "running",
    pid: null,
    conversationId: "conv-one",
    pendingQuestion: null,
    waitingInput: null,
  } as FileEntry;
  sessionStorage.setItem("llvDraft:conv-one", "try this again");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<TmuxComposer file={file} />));

  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  expect(textarea.value).toBe("try this again");
  flushSync(() => textarea.closest("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(sentKeys).toHaveLength(1);
  const edit = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Edit"));
  expect(edit).toBeDefined();
  flushSync(() => edit!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  flushSync(() => textarea.closest("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(sentKeys).toHaveLength(2);
  expect(sentKeys[1]).not.toBe(sentKeys[0]);
  flushSync(() => root.unmount());
});
