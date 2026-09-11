import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
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
import { readRetainedQueueAdmissions, resetRetainedQueueAdmissionsForTests } from "./retainedQueueAdmissions";
import { readOutbox, resetOutboxForTests } from "./conversation/outbox";
import { setTmuxComposerRuntimeDependenciesForTests } from "./tmuxComposerRuntime";
import { accessoryReserve, mobileComposerCeiling, mobileComposerUnitMax } from "@/lib/composerScroll";
import { composerSubmissionPayloads, composerSubmissionSaving } from "@/lib/composerSubmissionPayloads";
import { installComposerStorageForTests } from "@/test-helpers/composerStorage";

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

/** The journal's own answer, in the shape the route actually returns: the
    operation it committed, and a receipt carrying that operation's identity —
    which conversation, which idempotency key, which kind of command. The hook
    checks all of it before reading the verdict, so a stub that answers less than
    this is testing a contract the server does not have. */
function journalReceipt(body: Record<string, unknown>, status = "queued"): { status: number; body: Record<string, unknown> } {
  const operationId = `op-${String(body.idempotencyKey)}`;
  return {
    status: status === "rejected" ? 409 : 202,
    body: {
      operationId,
      receipt: {
        operationId,
        conversationId: body.conversationId,
        idempotencyKey: body.idempotencyKey,
        kind: "native-queue",
        status,
        revision: 1,
        at: "2026-09-10T11:00:00.000Z",
        admittedAt: "2026-09-10T11:00:00.000Z",
      },
    },
  };
}

const queueTransport: NativeQueueDependencies = {
  read: async () => ({ entries: queueEntries, native: { threadId: "thread-1", items: [], stale: false } }),
  write: async (body) => {
    queueWrites.push(body);
    return journalReceipt(body);
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
  resetRetainedQueueAdmissionsForTests();
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

/* The send menu renders through a portal into the composer's own document —
   the composer box is bounded and scrolls, and an in-flow menu was clipped by
   it (#1629) — so its actions are looked for in the document, not under the
   mount. */
const menuAction = (host: HTMLElement, label: string) =>
  [...host.ownerDocument.querySelectorAll("button")].find((button) => button.textContent?.includes(label));

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
  expect(status).toContain("The thread is on gpt-6-astra · medium right now");
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

test("a receipt belonging to another request cannot settle this hand-off", async () => {
  /* A FULLY-SHAPED FOREIGN RECEIPT. It names one operation consistently in the
     reply and in the receipt, and carries a status the journal really uses — but
     its conversation and its idempotency key belong to somebody else's request.
     Reading it as this operation's verdict released the recovery record, and the
     next press minted a new key for a message that may already be queued.

     Both verdicts are covered, because the refusal path used to skip identity
     entirely: a foreign `queued` and a foreign `failed` settled this operation
     just as readily as each other. */
  for (const status of ["queued", "failed"] as const) {
    const previous = queueTransport.write;
    (queueTransport as { write: NativeQueueDependencies["write"] }).write = async (body) => {
      queueWrites.push(body);
      return {
        status: 202,
        body: {
          operationId: "foreign-operation",
          receipt: {
            operationId: "foreign-operation",
            conversationId: "conversation_foreign",
            idempotencyKey: "another-request",
            kind: "native-queue",
            status,
            revision: 1,
            at: "2026-09-10T11:00:00.000Z",
            admittedAt: "2026-09-10T11:00:00.000Z",
          },
        },
      };
    };
    const { host, root } = await mount();
    try {
      const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
      await settle(() => appendComposerDraft(CARD, "one operation only"));
      await settle(() => press(textarea, "Enter", { altKey: true }));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      /* The draft comes back, because nothing said this operation was taken. */
      const restored = host.querySelector("textarea") as HTMLTextAreaElement;
      expect(`${status}: ${restored.value}`).toBe(`${status}: one operation only`);

      await settle(() => press(restored, "Enter", { altKey: true }));
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      expect(`${status}: ${String(queueWrites[1]!.idempotencyKey)}`)
        .toBe(`${status}: ${String(queueWrites[0]!.idempotencyKey)}`);
      /* And the panel still offers the one control that resolves it. */
      expect(host.querySelector('[data-testid="native-queue-unresolved-retry"]')).not.toBeNull();
    } finally {
      (queueTransport as { write: NativeQueueDependencies["write"] }).write = previous;
      await act(async () => root.unmount());
    }
    document.body.replaceChildren();
    sessionStorage.clear();
    resetRetainedQueueAdmissionsForTests();
    queueWrites = [];
  }
});

test("this hand-off's own receipt settles it, and the unresolved row goes with it", async () => {
  /* The positive control: a receipt whose operation, conversation, idempotency
     key and kind are all this request's is read as the verdict it carries, the
     recovery record is released, and nothing is left waiting on an answer. */
  const { host, root } = await mount();
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  await settle(() => appendComposerDraft(CARD, "properly acknowledged"));
  await settle(() => press(textarea, "Enter", { altKey: true }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  expect(queueWrites).toHaveLength(1);
  expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
  expect(host.querySelector('[data-testid="native-queue-unresolved"]')).toBeNull();

  /* Settled means settled: the same words again are a second message. */
  await settle(() => appendComposerDraft(CARD, "properly acknowledged"));
  await settle(() => press(host.querySelector("textarea") as HTMLTextAreaElement, "Enter", { altKey: true }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(queueWrites[1]!.idempotencyKey).not.toBe(queueWrites[0]!.idempotencyKey);
  await act(async () => root.unmount());
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
async function stage(host: HTMLElement, file: { name: string; type: string; size: number }, dataUrl = "data:image/png;base64,aW52ZW50ZWQ="): Promise<void> {
  const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
  const propsKey = Object.keys(textarea).find((key) => key.startsWith("__reactProps$"))!;
  const props = (textarea as unknown as Record<string, { onDrop(event: unknown): void }>)[propsKey]!;
  await settle(() => props.onDrop({ dataTransfer: { files: [file] }, preventDefault() {}, stopPropagation() {} }));
  await act(async () => {
    QueuedReader.settleAll(dataUrl);
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

test("a browser that will not store the hand-off keeps the draft and sends nothing", async () => {
  /* The record is written BEFORE the wire because a reply that never arrives is
     what it exists for, so a browser that cannot store it cannot name the
     operation after a reload. Handing the message over anyway would take the
     operator's words away in exchange for an operation nobody could recover, so
     the hand-off is refused where it costs only a press. */
  const real = globalThis.sessionStorage;
  Object.assign(globalThis, {
    sessionStorage: {
      getItem: (key: string) => real.getItem(key),
      removeItem: (key: string) => real.removeItem(key),
      clear: () => real.clear(),
      /* Only the admission slot refuses: its envelope carries the attachment
         bytes, so it is the write that meets a quota first, and scoping it this
         way keeps the case about retention rather than about every other thing
         the composer stores. */
      setItem: (key: string, value: string) => {
        if (key.startsWith("llvQueueAdmission:")) throw new Error("QuotaExceededError");
        real.setItem(key, value);
      },
    },
  });
  try {
    const { host, root } = await mount();
    const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
    await settle(() => appendComposerDraft(CARD, "must not be lost"));
    await settle(() => press(textarea, "Enter", { altKey: true }));

    expect(queueWrites).toEqual([]);
    expect(readOutbox(CARD)).toEqual([]);
    expect(sends).toEqual([]);
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("must not be lost");
    /* And the reason is the true one: nothing is retained on this card, so the
       capacity wording would name a state that does not exist. */
    const said = host.textContent ?? "";
    expect(said).toContain("could not retain its recovery record");
    expect(said).toContain("remain unchanged");
    expect(said).not.toContain("tab");
    await act(async () => root.unmount());
  } finally {
    Object.assign(globalThis, { sessionStorage: real });
  }
});

test("the composer budgets itself against the conversation, so the queue has room to give back", async () => {
  /* THE OTHER HALF of the height repair, on the composer's side. The queue can
     only yield room if something bounds the form it sits in: the phone's form
     has budgeted itself against the viewport since #419 — the conversation IS
     the viewport there — and a card has to budget against the CARD, because a
     680 px card on a 1080 px screen took a viewport-sized queue and had 44 px of
     transcript left.

     happy-dom lays nothing out, so this pins the contract; the measurement is
     `scripts/capture-issue-1629-queue-height.ts`, which mounts the assembled
     conversation in a real browser at the phone's size and the board's own card
     heights. */
  queueEntries = [{
    entryId: "budget-1", conversationId: CARD, binding: { threadId: "thread-1", accountId: "acct-1" },
    clientUserMessageId: "c-budget", nativeSubmissionId: "n-budget", revision: 1,
    versions: [{ revision: 1, operationId: "op-budget", text: "queued", images: [], contentDigest: "d" }],
    profilePolicy: "thread-at-dispatch", state: "queued", mutationOperationId: null,
    dispatchedRevision: null, dispatchedTurnId: null, proof: null, reason: null,
  }];
  const { host, root } = await mount();
  const form = host.querySelector("form") as HTMLFormElement;

  /* A card, so the desktop form: the phone's is `bounded-mobile-composer`. */
  expect(form.getAttribute("data-testid")).toBeNull();
  /* A share of the card, and a floor of it left for the transcript. */
  expect(form.className).toContain("max-h-[min(60%,calc(100%_-_15rem))]");
  /* And the queue is inside that budget, which is what makes it the part that
     gives room back. */
  expect(form.querySelector('[data-testid="native-queue-panel"]')).not.toBeNull();
  await act(async () => root.unmount());
});

test("everything above the input shares ONE region; the input and Send never yield (#1629)", async () => {
  /* WHO GIVES ROOM BACK when the form is at its budget. Not each surface for
     itself — that is what the two repairs before this one did, and each of them
     fixed the sibling it was about and left the next to be squeezed to zero. The
     docked call, the queue, the sends awaiting an answer and the receipts of the
     ones that failed are all in ONE region, which is the part of the box that
     yields (`min-h-0`) and the one scrollport over all of them; the input unit
     is `shrink-0` and pinned to the box's bottom edge, so a composition the
     budget cannot fit is scrolled through rather than laid out past the pane.

     happy-dom lays nothing out, so this pins the contract; the measurement is
     `scripts/capture-issue-1629-queue-height.ts`. */
  observed = { conversationId: "conversation_native_queue" };
  queueEntries = [{
    entryId: "yield-1", conversationId: "conversation_native_queue", binding: { threadId: "thread-1", accountId: "acct-1" },
    clientUserMessageId: "c-yield", nativeSubmissionId: "n-yield", revision: 1,
    versions: [{ revision: 1, operationId: "op-yield", text: "queued", images: [], contentDigest: "d" }],
    profilePolicy: "thread-at-dispatch", state: "queued", mutationOperationId: null,
    dispatchedRevision: null, dispatchedTurnId: null, proof: null, reason: null,
  }];
  const { host, root } = await mount();

  const region = host.querySelector('[data-testid="composer-accessories"]') as HTMLElement;
  expect(region.className).toContain("min-h-0");
  expect(region.className).toContain("overflow-y-auto");
  /* A wheel inside a squeezed region stays in it rather than reaching the board
     behind the card. */
  expect(region.className).toContain("overscroll-contain");
  /* Every surface is IN it, as a grid row: each takes an equal share of the
     region and stops at its own content, rather than shrinking in proportion to
     how much it has to show. */
  expect(region.className).toContain("[&>*]:min-h-0");
  expect(region.className).toContain("grid");
  expect(region.className).toContain("auto-rows-[minmax(0,max-content)]");
  const dock = region.querySelector('[data-testid="voice-dock-slot"]');
  const panel = region.querySelector('[data-testid="native-queue-panel"]') as HTMLElement;
  expect(dock).not.toBeNull();
  expect(panel).not.toBeNull();
  expect(panel.className).toContain("overflow-y-auto");

  /* The input unit is NOT in the region: it is what the yielding is for, and it
     stays against the bottom edge of the box whatever the region holds. */
  const unit = host.querySelector('[data-testid="composer-input-unit"]') as HTMLElement;
  expect(region.contains(unit)).toBe(false);
  expect(unit.className).toContain("shrink-0");
  expect(unit.className).toContain("sticky");
  expect(unit.className).toContain("bottom-0");
  expect(unit.querySelector("textarea")).not.toBeNull();
  expect(unit.querySelector('button[type="submit"]')).not.toBeNull();
  /* And the box itself scrolls its own content, so what the budget could not
     fit is reachable inside the composer rather than clipped by the pane. */
  const form = host.querySelector("form") as HTMLFormElement;
  expect(form.className).toContain("overflow-y-auto");
  expect(form.className).toContain("overscroll-y-contain");
  await act(async () => root.unmount());
});

test("a rendered queue panel takes its room off the phone field's grow ceiling", async () => {
  // This case measures the queue alone. Happy DOM has no IndexedDB, which
  // would otherwise add a separate, correctly visible recovery-error panel.
  // Real storage failures and their compact controls run in Chromium.
  const savedPayloads = spyOn(composerSubmissionPayloads, "list").mockResolvedValue([]);
  /* The other half of the same budget, on the phone, where the form is at its
     `38dvh` cap and the panel is the only part that can shrink: a draft grown to
     the field's old ceiling left the panel a 2px border with nothing inside it,
     so Start, the recovery controls and every row were unreachable. The field
     now stops one accessory window short — and only while a surface is actually
     in the region, which is what this checks by emptying the queue.

     happy-dom measures nothing, so the field is given a content height taller
     than any ceiling and the ceiling is read off the height the hook writes. */
  const tall = 4000;
  const proto = Object.getPrototypeOf(document.createElement("textarea")) as object;
  const original = Object.getOwnPropertyDescriptor(proto, "scrollHeight");
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get: () => tall });
  (dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
    matches: true, media: query, addEventListener() {}, removeEventListener() {},
  });
  try {
    queueEntries = [{
      entryId: "ceiling-1", conversationId: CARD, binding: { threadId: "thread-1", accountId: "acct-1" },
      clientUserMessageId: "c-ceiling", nativeSubmissionId: "n-ceiling", revision: 1,
      versions: [{ revision: 1, operationId: "op-ceiling", text: "queued", images: [], contentDigest: "d" }],
      profilePolicy: "thread-at-dispatch", state: "queued", mutationOperationId: null,
      dispatchedRevision: null, dispatchedTurnId: null, proof: null, reason: null,
    }];
    const withQueue = await mount();
    expect(withQueue.host.querySelector('[data-testid="native-queue-panel"]')).not.toBeNull();
    const ceilingWithQueue = Number.parseInt((withQueue.host.querySelector("textarea") as HTMLTextAreaElement).style.height, 10);
    await act(async () => withQueue.root.unmount());

    queueEntries = [];
    const alone = await mount();
    expect(alone.host.querySelector('[data-testid="native-queue-panel"]')).toBeNull();
    const ceilingAlone = Number.parseInt((alone.host.querySelector("textarea") as HTMLTextAreaElement).style.height, 10);
    await act(async () => alone.root.unmount());

    expect(ceilingWithQueue).toBe(ceilingAlone - accessoryReserve(1, mobileComposerUnitMax(dom.innerHeight)));
    /* And an empty queue reserves nothing: the room goes straight back to the
       draft, exactly as it was before the queue existed. */
    expect(ceilingAlone).toBe(mobileComposerCeiling(dom.innerHeight, dom.innerHeight));
  } finally {
    savedPayloads.mockRestore();
    (dom as unknown as { matchMedia: (query: string) => unknown }).matchMedia = (query: string) => ({
      matches: false, media: query, addEventListener() {}, removeEventListener() {},
    });
    if (original) Object.defineProperty(proto, "scrollHeight", original);
    else Reflect.deleteProperty(proto, "scrollHeight");
  }
});

/* ── A large hand-off whose acknowledgement is held ─────────────────────────
   Its envelope goes to IndexedDB before the wire, and the journal's answer can
   take seconds to come back over a 16 MiB upload. Only that preparation may
   hold the composer: once the operation is durable, Enter is the operator's
   again, and the answer, whenever it lands, settles that one operation and
   nothing the operator has written since. */

const LARGE_IMAGE = `data:image/png;base64,${"A".repeat(400_000)}`;

async function until(check: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function withHeldLargeHandOff(
  run: (context: {
    host: HTMLElement;
    answer: (reply: () => Promise<{ status: number; body: Record<string, unknown> }>) => Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const storage = installComposerStorageForTests();
  const previous = queueTransport.write;
  const held: Array<(reply: () => Promise<{ status: number; body: Record<string, unknown> }>) => void> = [];
  (queueTransport as { write: NativeQueueDependencies["write"] }).write = (body) => {
    queueWrites.push(body);
    return new Promise((resolve, reject) => {
      held.push((reply) => { reply().then(resolve, reject); });
    });
  };
  const { host, root } = await mount();
  try {
    await stage(host, { name: "large.png", type: "image/png", size: 300_000 }, LARGE_IMAGE);
    await settle(() => appendComposerDraft(CARD, "large hand-off"));
    await settle(() => press(host.querySelector("textarea") as HTMLTextAreaElement, "Enter", { altKey: true }));
    await until(() => queueWrites.length === 1, "the large hand-off to reach the wire");
    await run({
      host,
      answer: async (reply) => {
        await act(async () => {
          held.shift()!(reply);
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      },
    });
  } finally {
    (queueTransport as { write: NativeQueueDependencies["write"] }).write = previous;
    await act(async () => root.unmount());
    storage.uninstall();
  }
}

test("a held large acknowledgement leaves Enter working for the next ordinary command", async () => {
  await withHeldLargeHandOff(async ({ host, answer }) => {
    /* The envelope is durable and the composer is the operator's again. */
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
    expect(host.querySelectorAll('[data-testid="attachment-tile"]')).toHaveLength(0);
    const [retained] = readRetainedQueueAdmissions(CARD);
    expect(retained?.key).toBe(queueWrites[0]!.idempotencyKey as string);
    expect(retained?.payload?.images).toBe(1);

    /* An ordinary small command goes at once, without waiting on the answer. */
    await settle(() => appendComposerDraft(CARD, "small command"));
    await settle(() => press(host.querySelector("textarea") as HTMLTextAreaElement, "Enter"));
    expect(readOutbox(CARD).map((entry) => entry.text)).toEqual(["small command"]);
    await until(() => sends.length === 1, "the ordinary command to be sent");
    expect(sends[0]).toMatchObject({ text: "small command", policy: "interrupt-active" });
    expect(queueWrites).toHaveLength(1);
    expect(composerSubmissionSaving(CARD)).toBeFalse();

    /* The held answer settles only its own operation. */
    await answer(async () => journalReceipt(queueWrites[0]!));
    expect(readRetainedQueueAdmissions(CARD)).toEqual([]);
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
    expect(host.querySelector('[data-testid="native-queue-unresolved"]')).toBeNull();
  });
});

test("a held large hand-off still admits one press: a second Alt+Enter during its retention mints nothing", async () => {
  const storage = installComposerStorageForTests();
  const previous = queueTransport.write;
  (queueTransport as { write: NativeQueueDependencies["write"] }).write = async (body) => {
    queueWrites.push(body);
    return new Promise(() => {});
  };
  const { host, root } = await mount();
  try {
    await stage(host, { name: "large.png", type: "image/png", size: 300_000 }, LARGE_IMAGE);
    await settle(() => appendComposerDraft(CARD, "pressed twice"));
    await act(async () => {
      const textarea = host.querySelector("textarea") as HTMLTextAreaElement;
      press(textarea, "Enter", { altKey: true });
      press(textarea, "Enter", { altKey: true });
      /* Words typed while it saves belong to the next message. */
      appendComposerDraft(CARD, "typed while saving");
    });
    await until(() => queueWrites.length === 1, "the one admission");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(queueWrites).toHaveLength(1);
    expect(queueWrites[0]!.text).toBe("pressed twice");
    expect(readRetainedQueueAdmissions(CARD)).toHaveLength(1);
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toContain("typed while saving");
    expect(host.querySelectorAll('[data-testid="attachment-tile"]')).toHaveLength(0);
  } finally {
    (queueTransport as { write: NativeQueueDependencies["write"] }).write = previous;
    await act(async () => root.unmount());
    storage.uninstall();
  }
});

test("a held large refusal never lands on the newer draft, and returns whole to an empty one", async () => {
  const refusal = async () => ({ status: 409, body: { error: "native queue host or account ownership changed" } });
  await withHeldLargeHandOff(async ({ host, answer }) => {
    await settle(() => appendComposerDraft(CARD, "newer words"));
    await stage(host, { name: "newer.png", type: "image/png", size: 12 });
    await answer(refusal);
    expect(host.textContent).toContain("ownership changed");
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("newer words");
    expect(host.querySelectorAll('[data-testid="attachment-tile"]')).toHaveLength(1);
    /* A refusal admitted nothing, so there is nothing left to recover. */
    expect(readRetainedQueueAdmissions(CARD)).toEqual([]);
  });
  document.body.replaceChildren();
  sessionStorage.clear();
  resetRetainedQueueAdmissionsForTests();
  queueWrites = [];
  await withHeldLargeHandOff(async ({ host, answer }) => {
    await answer(refusal);
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("large hand-off");
    expect(host.querySelectorAll('[data-testid="attachment-tile"]')).toHaveLength(1);
  });
});

test("a held large answer that is lost keeps the original operation, and its replay is the same envelope", async () => {
  await withHeldLargeHandOff(async ({ host, answer }) => {
    await settle(() => appendComposerDraft(CARD, "newer words"));
    await answer(async () => { throw new Error("network is unreachable"); });
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("newer words");
    const [retained] = readRetainedQueueAdmissions(CARD);
    expect(retained?.key).toBe(queueWrites[0]!.idempotencyKey as string);

    /* The panel's replay sends the stored envelope: same key, same bytes. */
    const retry = host.querySelector('[data-testid="native-queue-unresolved-retry"]') as HTMLButtonElement;
    await settle(() => retry.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event));
    await until(() => queueWrites.length === 2, "the replay");
    expect(queueWrites[1]!.idempotencyKey).toBe(queueWrites[0]!.idempotencyKey);
    expect(queueWrites[1]!.text).toBe("large hand-off");
    expect(JSON.stringify(queueWrites[1]!.images)).toBe(JSON.stringify(queueWrites[0]!.images));
    expect(JSON.stringify(queueWrites[1]!.binding)).toBe(JSON.stringify(queueWrites[0]!.binding));
    expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("newer words");
    await answer(async () => journalReceipt(queueWrites[1]!));
    expect(readRetainedQueueAdmissions(CARD)).toEqual([]);
  });
});

test("a staged document is never cleared by a queue hand-off that cannot carry it", async () => {
  /* The queue's command has text and images and nothing else. Handing the rest
     over cleared the document from the tray with nothing sent for it, so the
     hand-off is refused whole and Enter, which delivers documents by path,
     stays the way to send it. */
  const { host, root } = await mount();
  await stage(host, { name: "fixture.bin", type: "application/octet-stream", size: 12 });
  await stage(host, { name: "shot.png", type: "image/png", size: 12 });
  await settle(() => appendComposerDraft(CARD, "image and file"));
  await settle(() => press(host.querySelector("textarea") as HTMLTextAreaElement, "Enter", { altKey: true }));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  expect(queueWrites).toEqual([]);
  expect((host.querySelector("textarea") as HTMLTextAreaElement).value).toBe("image and file");
  expect(host.querySelectorAll('[data-testid="attachment-tile"]')).toHaveLength(2);
  expect(host.textContent).toContain("takes text and images only");
  await act(async () => root.unmount());
});
