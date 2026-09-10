import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { installActEnv } from "@/test-helpers/actEnv";
import { Window } from "happy-dom";
import { createRoot, type Root } from "react-dom/client";

import type { FileEntry } from "@/lib/types";
import { setLocale } from "@/lib/i18n";
import { setRuntimeUiEnabledForTests } from "@/hooks/runtimeBus";
import type { NativeQueueDependencies } from "@/hooks/useNativeQueue";
import type { NativeQueueRecord } from "@/lib/runtime/nativeQueueContracts";

import type { RuntimeSessionView } from "@/hooks/useRuntime";

import { agentCapabilitiesFromViews } from "./useAgentCapabilities";
import { writeProfile } from "./runtimeProfile";
import { appendComposerDraft, TmuxComposer } from "./TmuxComposer";
import { readOutbox, resetOutboxForTests } from "./conversation/outbox";
import { setTmuxComposerRuntimeDependenciesForTests } from "./tmuxComposerRuntime";

/**
 * The composer's two submissions, on a Codex conversation that can queue
 * (#1629).
 *
 * The operator asked for native queue behaviour AND for the default to stay what
 * it is. Both halves are asserted here, on the real composer:
 *
 * - Enter and Send still take the ordinary path, whose policy is `interrupt-active`;
 * - Alt+Enter and the send-menu entry hand the draft to Codex's own queue, which
 *   is a different route entirely — one admission on the queue endpoint, and no
 *   entry in the composer's own outbox, because the queue has exactly one
 *   dispatch owner and it is not the composer;
 * - an explicit steer is refused BEFORE anything is admitted when the host
 *   cannot steer or nothing is running.
 */

/** The composer decodes a staged attachment through a FileReader; this is the
    same queued stand-in the draft-attachment suite uses. */
class QueuedReader {
  static queue: QueuedReader[] = [];
  result: string | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  readAsDataURL() { QueuedReader.queue.push(this); }
  static settleAll(dataUrl: string) {
    for (const reader of QueuedReader.queue.splice(0, QueuedReader.queue.length)) {
      reader.result = dataUrl;
      reader.onload?.();
    }
  }
}

const dom = new Window();
installActEnv();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLTextAreaElement: dom.HTMLTextAreaElement,
  Event: dom.Event,
  CustomEvent: dom.CustomEvent,
  MouseEvent: dom.MouseEvent,
  KeyboardEvent: dom.KeyboardEvent,
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
  cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  localStorage: dom.localStorage,
  sessionStorage: dom.sessionStorage,
  File: dom.File,
  FileReader: QueuedReader,
  URL: dom.URL,
});
(dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
  matches: false, media: query, addEventListener() {}, removeEventListener() {},
});

const CARD = "conv-native-queue";
const realFetch = globalThis.fetch;

let queueWrites: Record<string, unknown>[] = [];
let queueEntries: NativeQueueRecord[] = [];
let sends: Record<string, unknown>[] = [];
let steerSupported = true;
let turn: "running" | "idle" = "idle";
let nativeQueueCapable = true;

const queueTransport: NativeQueueDependencies = {
  read: async () => ({ entries: queueEntries, native: { threadId: "thread-1", items: [], stale: false } }),
  write: async (body) => {
    queueWrites.push(body);
    return { status: 202, body: { operationId: "op-1", receipt: { status: "queued" } } };
  },
};

/** A real runtime session view, so the REAL capability rules decide what the
    composer renders. A hand-built `caps` object would only be testing itself. */
function sessionView(): RuntimeSessionView {
  return {
    session: {
      conversationId: CARD,
      sessionKey: { engine: "codex", sessionId: "thread-1" },
      hostKind: "codex-app-server",
      host: "hosted",
      turn,
      provenance: "structured",
      accountId: "acct-1",
      parentConversationId: null,
      cwd: null,
      artifactPath: "/codex.jsonl",
      capabilities: {
        steer: steerSupported,
        structuredAttention: true,
        nativeQueue: nativeQueueCapable,
        /* A host that negotiated image input, so the composer's own attachment
           gate is open and what is under test is the queue path rather than the
           gate. */
        imageInput: { supported: true, mimes: ["image/png"] },
      },
      activeTurnId: turn === "running" ? "turn-live" : null,
      nativeQueueRevision: 0,
      attentionIds: [],
      recentReceipts: [],
      revision: 1,
    } as never,
    uiState: turn === "running" ? "working" : "idle",
    attentions: [],
    receipts: [],
    legacy: false,
    structuredControlsEnabled: true,
  } as never;
}

beforeEach(() => {
  observed = {};
  queueWrites = [];
  queueEntries = [];
  sends = [];
  steerSupported = true;
  turn = "idle";
  nativeQueueCapable = true;
  setRuntimeUiEnabledForTests(false);
  setTmuxComposerRuntimeDependenciesForTests({
    nativeQueue: queueTransport,
    useAgentCapabilities: ((entry: FileEntry) =>
      agentCapabilitiesFromViews(entry, sessionView(), null, true)) as never,
    sendRuntimeMessage: (async (options: Record<string, unknown>) => {
      sends.push(options);
      return { ok: true, status: 202, receipt: { status: "queued" }, operationId: "send-1" };
    }) as never,
  });
});

afterEach(() => {
  setTmuxComposerRuntimeDependenciesForTests(null);
  setRuntimeUiEnabledForTests(null);
  setLocale("en");
  globalThis.fetch = realFetch;
  document.body.replaceChildren();
  localStorage.clear();
  sessionStorage.clear();
  resetOutboxForTests();
});

/** Per-test fields of the conversation the board actually observed. */
let observed: Partial<FileEntry> = {};

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
  conversationId: CARD,
  pendingQuestion: null,
  waitingInput: null,
} as FileEntry;

async function mount(): Promise<{ host: HTMLElement; root: Root }> {
  globalThis.fetch = (async (input: string) => {
    if (String(input) === "/api/tmux/targets") return { ok: true, json: async () => ({ targets: {} }) } as Response;
    return new Promise(() => {}) as unknown as Response;
  }) as unknown as typeof fetch;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<TmuxComposer file={{ ...file, ...observed }} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { host, root };
}

const settle = async (run: () => void) => {
  await act(async () => {
    run();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

/** React's delegated keydown is not delivered by a bare dispatch in happy-dom,
    so the handler is invoked the way a keypress would reach it. */
function press(textarea: HTMLTextAreaElement, key: string, modifiers: { altKey?: boolean; shiftKey?: boolean } = {}): void {
  const propsKey = Object.keys(textarea).find((candidate) => candidate.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onKeyDown(event: unknown): void }>)[propsKey]!;
  props.onKeyDown({
    key,
    shiftKey: modifiers.shiftKey ?? false,
    altKey: modifiers.altKey ?? false,
    metaKey: false,
    ctrlKey: false,
    nativeEvent: { isComposing: false },
    preventDefault() {},
    stopPropagation() {},
  });
}

const menuAction = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find((button) => button.textContent?.includes(label));

/** The send menu opens on the send control's context menu, which is how the
    composer has always exposed its secondary submissions. */
async function openSendMenu(host: HTMLElement): Promise<void> {
  for (const node of host.querySelectorAll("span")) {
    const propsKey = Object.keys(node).find((candidate) => candidate.startsWith("__reactProps$"));
    const props = propsKey
      ? (node as unknown as Record<string, { onContextMenu?: (event: unknown) => void }>)[propsKey]
      : null;
    if (typeof props?.onContextMenu !== "function") continue;
    await settle(() => props.onContextMenu!({ preventDefault() {}, stopPropagation() {} }));
    return;
  }
  throw new Error("the send control exposed no context menu");
}

test("Enter still sends, and a send still interrupts the running turn", async () => {
  /* The default the operator asked to keep. Nothing about the queue changes it. */
  const { host, root } = await mount();
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  await settle(() => appendComposerDraft(CARD, "ordinary send"));
  await settle(() => press(textarea, "Enter"));

  expect(readOutbox(CARD).map((entry) => entry.text)).toEqual(["ordinary send"]);
  expect(queueWrites).toEqual([]);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(sends[0]).toMatchObject({ policy: "interrupt-active", text: "ordinary send" });
  await act(async () => root.unmount());
});

test("Alt+Enter hands the draft to Codex's queue, and clears the composer at once", async () => {
  const { host, root } = await mount();
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  await settle(() => appendComposerDraft(CARD, "queue this one"));
  await settle(() => press(textarea, "Enter", { altKey: true }));

  expect(queueWrites).toHaveLength(1);
  expect(queueWrites[0]).toMatchObject({
    conversationId: CARD,
    action: "add",
    text: "queue this one",
    binding: { threadId: "thread-1", accountId: "acct-1" },
  });
  /* Immediate feedback: the field is empty before the admission answers. */
  expect(textarea.value).toBe("");
  /* And ONE dispatch owner: the composer's own outbox never sees it. */
  expect(readOutbox(CARD)).toEqual([]);
  expect(sends).toEqual([]);
  await act(async () => root.unmount());
});

test("a queued message rides with what the operator had selected, as a request", async () => {
  /* Native's queue carries no per-entry profile, so the settings travel as audit
     and the panel says the thread's own settings are what will run. */
  const { host, root } = await mount();
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  await settle(() => appendComposerDraft(CARD, "with context"));
  await settle(() => press(textarea, "Enter", { altKey: true }));

  expect(queueWrites[0]).toHaveProperty("idempotencyKey");
  expect(String(queueWrites[0]!.idempotencyKey).length).toBeGreaterThan(8);
  await act(async () => root.unmount());
});

test("a queued row names the thread's OBSERVED settings, and the request separately", async () => {
  /* The two lines only mean anything while they come from different places. The
     panel used to be handed `sendRuntimeFrom(file)` for both — the operator's
     pending NEXT-SEND selection. That is the request; the host's own runtime is
     the effective profile — so "Runs on" stated a request as the effective one and the
     "Asked for" line was suppressed for matching it. `profilePolicy:
     "thread-at-dispatch"` exists precisely to keep them apart. */
  observed = { model: "gpt-6-astra", effort: "medium" };
  writeProfile({ ...file, ...observed } as FileEntry, { model: "gpt-6-astra", effort: "low" });
  queueEntries = [{
    entryId: "q1", conversationId: CARD, binding: { threadId: "thread-1", accountId: "acct-1" },
    clientUserMessageId: "c1", nativeSubmissionId: null, revision: 1,
    versions: [{ revision: 1, operationId: "q1", text: "queued", images: [], contentDigest: "d",
      requestedRuntime: { model: "gpt-6-astra", effort: "low" } }],
    profilePolicy: "thread-at-dispatch", state: "queued", mutationOperationId: null,
    dispatchedRevision: null, dispatchedTurnId: null, proof: null, reason: null,
  }];
  const { host, root } = await mount();
  const status = host.querySelector('[data-testid="native-queue-row-status"]')?.textContent ?? "";
  expect(status).toContain("Runs on gpt-6-astra · medium");
  expect(status).toContain("Asked for gpt-6-astra · low");
  await act(async () => root.unmount());
});

test("a refused queue admission gives the draft back rather than losing it", async () => {
  const { host, root } = await mount();
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const previous = queueTransport.write;
  (queueTransport as { write: NativeQueueDependencies["write"] }).write = async (body) => {
    queueWrites.push(body);
    return { status: 409, body: { error: "native queue host or account ownership changed" } };
  };
  try {
    await settle(() => appendComposerDraft(CARD, "will be refused"));
    await settle(() => press(textarea, "Enter", { altKey: true }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(host.textContent).toContain("ownership changed");
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("will be refused");
  } finally {
    (queueTransport as { write: NativeQueueDependencies["write"] }).write = previous;
  }
  await act(async () => root.unmount());
});

test("a hand-off whose reply was lost is replayed under its own identity", async () => {
  /* A queue add is ONE durable operation named by its idempotency key, and the
     journal answers a replay of that key with the operation it already holds. A
     thrown transport is the case where the journal may already have committed
     it, so minting a fresh key for the second press made the two
     indistinguishable operations — Codex could receive the message twice with
     nothing able to reconcile them. */
  const { host, root } = await mount();
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const previous = queueTransport.write;
  (queueTransport as { write: NativeQueueDependencies["write"] }).write = async (body) => {
    queueWrites.push(body);
    throw new Error("network is unreachable");
  };
  try {
    await settle(() => appendComposerDraft(CARD, "queue this once"));
    await settle(() => press(textarea, "Enter", { altKey: true }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    /* The draft is back, exactly as a refusal returns it. */
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("queue this once");

    await settle(() => press(host.querySelector("textarea") as HTMLTextAreaElement, "Enter", { altKey: true }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  } finally {
    (queueTransport as { write: NativeQueueDependencies["write"] }).write = previous;
  }
  expect(queueWrites).toHaveLength(2);
  expect(queueWrites[1]!.idempotencyKey).toBe(queueWrites[0]!.idempotencyKey);
  expect(queueWrites[1]!.text).toBe(queueWrites[0]!.text);
  await act(async () => root.unmount());
});

test("the retained identity survives a reload, and a different message gets its own", async () => {
  /* The request it describes survived the page, so the record does too: an
     operator who comes back to a restored draft and presses again replays the
     same operation. A message that is no longer the same message is genuinely a
     different operation and mints its own key — replaying the retained one there
     would submit words the operator has since changed. */
  const lose = async (body: Record<string, unknown>) => {
    queueWrites.push(body);
    throw new Error("network is unreachable");
  };
  const previous = queueTransport.write;
  (queueTransport as { write: NativeQueueDependencies["write"] }).write = lose;
  try {
    const first = await mount();
    await settle(() => appendComposerDraft(CARD, "survives a reload"));
    await settle(() => press(first.host.querySelector("textarea") as HTMLTextAreaElement, "Enter", { altKey: true }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => first.root.unmount());
    document.body.replaceChildren();

    /* A fresh page: the draft is restored from the same session record the
       composer has always kept, and so is the operation's identity. */
    const second = await mount();
    await settle(() => press(second.host.querySelector("textarea") as HTMLTextAreaElement, "Enter", { altKey: true }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(queueWrites).toHaveLength(2);
    expect(queueWrites[1]!.idempotencyKey).toBe(queueWrites[0]!.idempotencyKey);

    const restored = second.host.querySelector("textarea") as HTMLTextAreaElement;
    await settle(() => appendComposerDraft(CARD, "and something else entirely"));
    await settle(() => press(restored, "Enter", { altKey: true }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(queueWrites).toHaveLength(3);
    expect(queueWrites[2]!.idempotencyKey).not.toBe(queueWrites[0]!.idempotencyKey);
    await act(async () => second.root.unmount());
  } finally {
    (queueTransport as { write: NativeQueueDependencies["write"] }).write = previous;
  }
});

test("an admission the journal answered releases its identity, so the next message is new", async () => {
  const { host, root } = await mount();
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  await settle(() => appendComposerDraft(CARD, "first message"));
  await settle(() => press(textarea, "Enter", { altKey: true }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  await settle(() => appendComposerDraft(CARD, "first message"));
  await settle(() => press(host.querySelector("textarea") as HTMLTextAreaElement, "Enter", { altKey: true }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  /* Same words, deliberately sent twice: the journal gave a verdict on the
     first, so the second is a second message and not a replay of the first. */
  expect(queueWrites).toHaveLength(2);
  expect(queueWrites[1]!.idempotencyKey).not.toBe(queueWrites[0]!.idempotencyKey);
  await act(async () => root.unmount());
});

test("a host that never advertised a queue offers no queue affordance at all", async () => {
  nativeQueueCapable = false;
  const { host, root } = await mount();
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  await settle(() => appendComposerDraft(CARD, "nowhere to queue"));
  await settle(() => press(textarea, "Enter", { altKey: true }));

  /* Alt+Enter is not bound at all, so the draft is untouched and no admission
     was attempted against a capability the host never claimed. */
  expect(queueWrites).toEqual([]);
  expect(textarea.value).toBe("nowhere to queue");
  await act(async () => root.unmount());
});

test("an explicit steer is refused before anything is admitted when nothing is running", async () => {
  const { host, root } = await mount();
  await settle(() => appendComposerDraft(CARD, "steer this"));
  await openSendMenu(host);
  const steer = menuAction(host, "Steer the running turn");
  expect(steer).toBeDefined();
  expect(steer!.hasAttribute("disabled")).toBeTrue();
  expect(readOutbox(CARD)).toEqual([]);
  await act(async () => root.unmount());
});

test("an explicit steer on a running turn asks for steer-if-active, not an interrupt", async () => {
  turn = "running";
  const { host, root } = await mount();
  await settle(() => appendComposerDraft(CARD, "add to the running turn"));
  await openSendMenu(host);
  await settle(() => menuAction(host, "Steer the running turn")
    ?.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  expect(readOutbox(CARD)[0]).toMatchObject({ text: "add to the running turn", policy: "steer-if-active" });
  expect(sends[0]).toMatchObject({ policy: "steer-if-active" });
  await act(async () => root.unmount());
});

test("a host that cannot be steered offers no steer at all", async () => {
  /* The Claude broker. Admitting a durable operation that fails later reads to
     the operator as a message lost rather than never accepted. */
  steerSupported = false;
  turn = "running";
  const { host, root } = await mount();
  await settle(() => appendComposerDraft(CARD, "cannot steer"));
  await openSendMenu(host);
  expect(menuAction(host, "Steer the running turn")).toBeUndefined();
  await act(async () => root.unmount());
});

/** Drop one attachment into the composer, the way the draft-attachment suite
    does, and let its decode settle. */
async function stage(host: HTMLElement, file: { name: string; type: string; size: number }): Promise<void> {
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onDrop(event: unknown): void }>)[propsKey]!;
  await settle(() => props.onDrop({ dataTransfer: { files: [file] }, preventDefault() {}, stopPropagation() {} }));
  await act(async () => {
    QueuedReader.settleAll("data:image/png;base64,aW52ZW50ZWQ=");
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test("a queued message carries its staged attachment, and a refusal gives it back", async () => {
  /* Losing a staged attachment to a refused admission is the failure the outbox
     exists to prevent on the other path; the queue route takes the same bytes,
     so this one must not lose them either. */
  const { host, root } = await mount();
  await stage(host, { name: "shot.png", type: "image/png", size: 12 });
  expect(host.querySelectorAll('[data-testid="attachment-tile"]')).toHaveLength(1);

  const previous = queueTransport.write;
  (queueTransport as { write: NativeQueueDependencies["write"] }).write = async (body) => {
    queueWrites.push(body);
    return { status: 409, body: { error: "native queue host or account ownership changed" } };
  };
  try {
    await settle(() => appendComposerDraft(CARD, "look at this"));
    await settle(() => press(host.querySelector("textarea") as HTMLTextAreaElement, "Enter", { altKey: true }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    /* The bytes went, and the route is what content-addresses them. */
    expect(queueWrites[0]).toMatchObject({ action: "add", text: "look at this" });
    expect((queueWrites[0]!.images as Array<{ mime: string }>)[0]!.mime).toBe("image/png");
    /* And the refusal put both back. */
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("look at this");
    expect(host.querySelectorAll('[data-testid="attachment-tile"]')).toHaveLength(1);
  } finally {
    (queueTransport as { write: NativeQueueDependencies["write"] }).write = previous;
  }
  await act(async () => root.unmount());
});

test("handing a draft to the queue clears the composer inside the feedback deadline", async () => {
  /* The measurement the operator feels. The runtime stage proved the ADMISSION
     does not wait on a native RPC; this is the browser half, on a card whose
     queue is already at the shape a busy thread has. What it catches is a
     submission that awaits the transport before painting, not jitter: the write
     below never resolves inside the window being measured. */
  queueEntries = Array.from({ length: 64 }, (_, index) => ({
    entryId: `e${index}`,
    conversationId: CARD,
    binding: { threadId: "thread-1", accountId: "acct-1" },
    clientUserMessageId: `client-${index}`,
    nativeSubmissionId: `native-${index}`,
    revision: 1,
    versions: [{ revision: 1, operationId: `op-${index}`, text: `queued ${index}`, images: [], contentDigest: `d-${index}` }],
    profilePolicy: "thread-at-dispatch",
    state: "queued",
    mutationOperationId: null,
    dispatchedRevision: null,
    dispatchedTurnId: null,
    proof: null,
    reason: null,
  } as NativeQueueRecord));
  const previous = queueTransport.write;
  (queueTransport as { write: NativeQueueDependencies["write"] }).write = async (body) => {
    queueWrites.push(body);
    return new Promise(() => {});
  };
  try {
    const { host, root } = await mount();
    const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
    await settle(() => appendComposerDraft(CARD, "one more for the queue"));
    const pressedAt = performance.now();
    await act(async () => { press(textarea, "Enter", { altKey: true }); });
    const feedback = performance.now() - pressedAt;

    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
    expect(queueWrites).toHaveLength(1);
    expect(feedback).toBeLessThan(250);
    await act(async () => root.unmount());
  } finally {
    (queueTransport as { write: NativeQueueDependencies["write"] }).write = previous;
  }
});
