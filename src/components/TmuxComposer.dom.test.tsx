import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { setLocale, translate } from "@/lib/i18n";
import type { FileEntry } from "@/lib/types";

import { appendComposerDraft, RuntimeComposerReceipts, TmuxComposer } from "./TmuxComposer";

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
  setLocale("en");
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
});

function renderInterruptAutoRetry(locale: "en" | "uk") {
  setLocale(locale);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);

  flushSync(() => root.render(
    <RuntimeComposerReceipts
      receipts={[{
        operationId: `op-interrupt-auto-retry-${locale}`,
        idempotencyKey: `key-interrupt-auto-retry-${locale}`,
        conversationId: "conv-one",
        kind: "send",
        status: "queued",
        reason: "interrupt-auto-retry",
        text: "keep going",
        at: "2026-07-13T00:00:00.000Z",
        revision: 3,
      }]}
      onRetry={() => {}}
      onEdit={() => {}}
    />,
  ));
  return { host, root };
}

function expectTransportDetailsHidden(host: HTMLElement) {
  for (const transportText of ["thread/read", "interrupt-auto-retry", "delivery-auto-retry"]) {
    expect(host.textContent).not.toContain(transportText);
  }
}

test("interrupt automatic retry shows visible busy feedback in English", () => {
  const { host, root } = renderInterruptAutoRetry("en");

  const status = host.querySelector('[role="status"]');
  expect(status?.textContent).toContain(translate("en", "runtime.receipt.busyRetry"));
  expect(status?.querySelector(".sr-only")).toBeNull();
  expectTransportDetailsHidden(host);
  flushSync(() => root.unmount());
});

test("interrupt automatic retry shows visible busy feedback in Ukrainian", () => {
  const { host, root } = renderInterruptAutoRetry("uk");

  const status = host.querySelector('[role="status"]');
  expect(status?.textContent).toContain(translate("uk", "runtime.receipt.busyRetry"));
  expect(status?.querySelector(".sr-only")).toBeNull();
  expectTransportDetailsHidden(host);
  flushSync(() => root.unmount());
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
  expect(host.textContent).not.toContain("Queued for durable delivery");
  expect(host.querySelector('[data-optimistic-message="true"]')?.textContent).toContain("try this again");
  flushSync(() => root.unmount());
});

test("receipt editing stays disabled while a newer send is in flight", async () => {
  let tmuxRequests = 0;
  let resolveSecond!: (response: Response) => void;
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "/api/tmux/targets") {
      return { ok: true, json: async () => ({ targets: { "0": null } }) } as Response;
    }
    if (String(input) !== "/api/tmux") throw new Error(`unexpected request: ${String(input)}`);
    tmuxRequests += 1;
    const body = JSON.parse(String(init?.body)) as { clientMessageId: string };
    if (tmuxRequests === 1) {
      return {
        ok: false,
        status: 409,
        json: async () => ({
          ok: false,
          structured: true,
          error: "delivery key was rejected",
          receipt: {
            operationId: "op-rejected-race",
            idempotencyKey: body.clientMessageId,
            conversationId: "conv-race",
            kind: "send",
            status: "rejected",
            reason: "delivery key was rejected",
            text: "first attempt",
            at: "2026-07-13T00:00:00.000Z",
            revision: 1,
          },
        }),
      } as Response;
    }
    return new Promise<Response>((resolve) => { resolveSecond = resolve; });
  }) as typeof fetch;

  const file = {
    path: "/codex-race.jsonl",
    root: "codex-sessions",
    name: "codex-race.jsonl",
    project: "viewer",
    title: "Codex race",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "idle",
    proc: "running",
    pid: null,
    conversationId: "conv-race",
    pendingQuestion: null,
    waitingInput: null,
  } as FileEntry;
  sessionStorage.setItem("llvDraft:conv-race", "first attempt");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<TmuxComposer file={file} />));
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const form = textarea.closest("form")!;

  flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  await new Promise((resolve) => setTimeout(resolve, 0));
  flushSync(() => appendComposerDraft("conv-race", "second attempt"));
  expect(textarea.value).toBe("first attempt\n\nsecond attempt");

  flushSync(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(tmuxRequests).toBe(2);
  const edit = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Edit")) as HTMLButtonElement;
  expect(edit).toBeDefined();
  expect(edit.disabled).toBe(true);
  flushSync(() => edit.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  expect(textarea.value).toBe("first attempt\n\nsecond attempt");

  resolveSecond({
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      structured: true,
      receipt: {
        operationId: "op-race-delivered",
        idempotencyKey: "key-race-delivered",
        conversationId: "conv-race",
        kind: "send",
        status: "queued",
        text: "first attempt\n\nsecond attempt",
        at: "2026-07-13T00:00:01.000Z",
        revision: 1,
      },
    }),
  } as Response);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(textarea.value).toBe("");
  flushSync(() => root.unmount());
});
