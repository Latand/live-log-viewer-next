import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";

import { appendComposerDraft, RuntimeComposerReceipts, TmuxComposer } from "./TmuxComposer";

const dom = new Window();
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
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
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
});

/** Render into a fresh root, flushing mount effects (target poll) inside act. */
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

/** Run a DOM interaction and let its async state updates settle inside act. */
const settle = async (fn: () => void) => {
  await act(async () => {
    fn();
    await new Promise((r) => setTimeout(r, 0));
  });
};

test("editing a rejected receipt does not submit the composer form", async () => {
  let edits = 0;
  let submits = 0;
  const { host, root } = await renderInto(
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
  );

  const edit = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Edit"));
  expect(edit).toBeDefined();
  await settle(() => edit!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));

  expect(edits).toBe(1);
  expect(submits).toBe(0);
  expect(edit!.getAttribute("type")).toBe("button");
  await act(async () => root.unmount());
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
  const { host, root } = await renderInto(<TmuxComposer file={file} />);

  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  expect(textarea.value).toBe("try this again");
  await settle(() => textarea.closest("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));

  expect(sentKeys).toHaveLength(1);
  const edit = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Edit"));
  expect(edit).toBeDefined();
  await settle(() => edit!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  await settle(() => textarea.closest("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));

  expect(sentKeys).toHaveLength(2);
  expect(sentKeys[1]).not.toBe(sentKeys[0]);
  await act(async () => root.unmount());
});

test("a dead host leaves the mic and send inert and never POSTs (§5, finding 5)", async () => {
  const posts: string[] = [];
  globalThis.fetch = (async (input: string) => {
    posts.push(String(input));
    return { ok: true, json: async () => ({ targets: {} }) } as Response;
  }) as typeof fetch;
  const file = {
    path: "/codex.jsonl", root: "codex-sessions", name: "codex.jsonl", project: "viewer", title: "Codex",
    engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1, size: 1, activity: "idle",
    proc: "running", pid: null, conversationId: "conv-dead", pendingQuestion: null, waitingInput: null,
  } as FileEntry;
  const { host, root } = await renderInto(<TmuxComposer file={file} deadHost />);

  const buttons = [...host.querySelectorAll("button")];
  const mic = buttons.find((b) => (b.getAttribute("aria-label") ?? "").includes("Dictate")) as HTMLButtonElement;
  const send = host.querySelector('button[type="submit"]') as HTMLButtonElement | null;
  // dictation is disabled — a spoken message could never be delivered
  expect(mic.disabled).toBe(true);
  // send stays present as a draft surface but is inert (aria-disabled), no POST
  expect(send?.getAttribute("aria-disabled")).toBe("true");
  await settle(() => host.querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  expect(posts.some((u) => u === "/api/tmux")).toBe(false);
  await act(async () => root.unmount());
});

test("an unresolved host blocks the send POST with a localized reason (finding 1)", async () => {
  const posts: string[] = [];
  globalThis.fetch = (async (input: string) => {
    posts.push(String(input));
    if (String(input) === "/api/tmux/targets") return { ok: true, json: async () => ({ targets: { "0": "%1" } }) } as Response;
    return { ok: true, json: async () => ({ ok: true }) } as Response;
  }) as typeof fetch;
  const file = {
    path: "/codex.jsonl", root: "codex-sessions", name: "codex.jsonl", project: "viewer", title: "Codex",
    engine: "codex", kind: "session", fmt: "codex", parent: null, mtime: 1, size: 1, activity: "idle",
    proc: "running", pid: null, conversationId: "conv-unresolved", pendingQuestion: null, waitingInput: null,
  } as FileEntry;
  sessionStorage.setItem("llvDraft:conv-unresolved", "hello");
  const { host, root } = await renderInto(<TmuxComposer file={file} sendBlockedReason="resolving the agent host…" />);

  const send = host.querySelector('button[type="submit"]') as HTMLButtonElement | null;
  expect(send?.getAttribute("aria-disabled")).toBe("true");
  await settle(() => host.querySelector("form")!.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  // never messaged the legacy tmux endpoint while the host was unresolved
  expect(posts.some((u) => u === "/api/tmux")).toBe(false);
  await act(async () => root.unmount());
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
  const { host, root } = await renderInto(<TmuxComposer file={file} />);
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const form = textarea.closest("form")!;

  await settle(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  await settle(() => appendComposerDraft("conv-race", "second attempt"));
  expect(textarea.value).toBe("first attempt\n\nsecond attempt");

  await settle(() => form.dispatchEvent(new dom.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
  expect(tmuxRequests).toBe(2);
  const edit = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Edit")) as HTMLButtonElement;
  expect(edit).toBeDefined();
  expect(edit.disabled).toBe(true);
  await settle(() => edit.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  expect(textarea.value).toBe("first attempt\n\nsecond attempt");

  await settle(() => resolveSecond({
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
  } as Response));
  expect(textarea.value).toBe("");
  await act(async () => root.unmount());
});
