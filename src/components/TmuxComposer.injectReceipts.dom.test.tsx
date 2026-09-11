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
import { resetRetainedQueueAdmissionsForTests } from "./retainedQueueAdmissions";
import { readOutbox, resetOutboxForTests } from "./conversation/outbox";
import { setTmuxComposerRuntimeDependenciesForTests } from "./tmuxComposerRuntime";
import { accessoryReserve, mobileComposerCeiling, mobileComposerUnitMax } from "@/lib/composerScroll";

/**
 * What the operator sees when an injection does not simply work (#1560).
 *
 * Separate from the action suite because it exercises the other half: the
 * durable receipt, after the fact. The composer answers an accepted injection
 * with "Accepted — the receipt confirms when it reaches the thread", so the
 * receipt is the only thing that can ever say it did not. Three of its outcomes
 * are reachable and none of them is a send:
 *
 * - `failed`, from a stale turn, a retired capability or a waiting approval;
 * - `uncertain`, from an acknowledgement the transcript never corroborated —
 *   the outcome this whole operation exists to report honestly, and so the one
 *   it would be worst to hide;
 * - and neither of them may offer Retry, which the journal refuses for this
 *   kind because the engine does not deduplicate a second insertion.
 *
 * Every composer surface that renders a receipt requires `receipt.text`, which
 * is why the journal projects the operator's words onto an inject receipt.
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

const CARD = "conv-inject";
const realFetch = globalThis.fetch;

let queueWrites: Record<string, unknown>[] = [];
let queueEntries: NativeQueueRecord[] = [];
let sends: Record<string, unknown>[] = [];
let steerSupported = true;
let turn: "running" | "idle" = "idle";
let nativeQueueCapable = true;
let injectCapable = true;
let injections: Record<string, unknown>[] = [];
let durableReceipts: Record<string, unknown>[] = [];
let injectAnswer: Record<string, unknown> = { ok: true, status: 202, receipt: { status: "queued" }, operationId: "inject-1" };
let holdInjection = false;
let releaseInjection: (() => void) | null = null;

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
        inject: injectCapable,
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
  injectCapable = true;
  injections = [];
  durableReceipts = [];
  injectAnswer = { ok: true, status: 202, receipt: { status: "queued" }, operationId: "inject-1" };
  holdInjection = false;
  releaseInjection = null;
  setRuntimeUiEnabledForTests(false);
  setTmuxComposerRuntimeDependenciesForTests({
    nativeQueue: queueTransport,
    useAgentCapabilities: ((entry: FileEntry) =>
      agentCapabilitiesFromViews(entry, sessionView(), null, true)) as never,
    /* The DURABLE receipts the runtime has published for this card. This is how
       an injection's eventual fate reaches the composer — the POST answer only
       ever says it was admitted. */
    useRuntimeReceiptsForArtifact: (() => durableReceipts) as never,
    sendRuntimeMessage: (async (options: Record<string, unknown>) => {
      sends.push(options);
      return { ok: true, status: 202, receipt: { status: "queued" }, operationId: "send-1" };
    }) as never,
    injectRuntimeContext: (async (options: Record<string, unknown>) => {
      injections.push(options);
      /* A test may HOLD the answer, so the in-flight state of the composer is
         actually observable. A stub that resolves in the same tick would make
         "what does it say before the answer" untestable — and that window is
         exactly where an optimistic claim would live. */
      if (holdInjection) await new Promise<void>((resolve) => { releaseInjection = resolve; });
      return injectAnswer;
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


function injectReceipt(status: string, reason: string): Record<string, unknown> {
  return {
    operationId: `op-inject-${status}`,
    conversationId: CARD,
    idempotencyKey: `key-inject-${status}`,
    kind: "inject",
    status,
    reason,
    /* The journal projects the operator's own words onto an inject receipt.
       Every composer surface that renders a receipt requires text, so a null
       here is the difference between the outcome being visible and not. */
    text: "context the operator added",
    revision: 1,
    at: new Date().toISOString(),
    admittedAt: new Date().toISOString(),
  };
}

test("a failed injection is visible to the operator", async () => {
  durableReceipts = [injectReceipt("failed", "unsupported-injection")];
  const { host, root } = await mount();
  const rendered = host.textContent ?? "";
  /* The words are shown, so the operator can see WHICH context did not land. */
  expect(rendered).toContain("context the operator added");
  root.unmount();
});

test("an injection whose fate is unknown is visible to the operator", async () => {
  /* `uncertain` is the outcome this whole operation was designed to report
     honestly — an empty engine acknowledgement proves nothing about the thread.
     It would be the worst one to hide. */
  durableReceipts = [injectReceipt("uncertain", "injection was acknowledged and did not appear in canonical history; whether it reached the thread is unverified")];
  const { host, root } = await mount();
  expect(host.textContent ?? "").toContain("context the operator added");
  root.unmount();
});

test.each([["failed", "stale-turn"], ["uncertain", "acknowledged and not observed"]])(
  "a %s injection offers no Retry, because the journal refuses one",
  async (status, reason) => {
  durableReceipts = [injectReceipt(status, reason)];
  const { host, root } = await mount();
  /* Retry re-arms the ORIGINAL operation and the journal refuses that for an
     injection: the engine does not deduplicate, so it would be a second
     insertion. A control whose only outcome is a refusal must not be offered.
     A failed SEND still has its Retry; this is about the kind, not the state. */
  /* Indexed rather than spread: spreading a happy-dom NodeList here exhausts
     the heap, so the labels are read out by position. */
  const labels: string[] = [];
  const buttons = host.querySelectorAll("button");
  for (let index = 0; index < buttons.length; index += 1) {
    labels.push(buttons[index]?.textContent ?? "");
  }
  expect(labels.filter((label) => /retry/i.test(label))).toEqual([]);
  /* The receipt IS on screen — otherwise this would pass by rendering nothing,
     which is the very defect the two tests above exist to catch. */
  expect(host.textContent ?? "").toContain("context the operator added");
  root.unmount();
});

test("an injection parked past the uncertain wait offers no Discard either", async () => {
  /* The reachable path: admitted while the host was dead, so the row parks at
     `queued` with no unknown fate. Past the uncertain wait threshold the chip
     treats it as exitable — and Discard ends the ORIGINAL operation, which the
     route refuses for this kind exactly as it refuses Retry. */
  const longAgo = new Date(Date.now() - 60 * 60_000).toISOString();
  durableReceipts = [{
    ...injectReceipt("queued", "dead-host"),
    status: "queued",
    reason: "dead-host",
    at: longAgo,
    admittedAt: longAgo,
  }];
  const { host, root } = await mount();

  const labels: string[] = [];
  const buttons = host.querySelectorAll("button");
  for (let index = 0; index < buttons.length; index += 1) labels.push(buttons[index]?.textContent ?? "");
  expect(labels.filter((label) => /discard/i.test(label))).toEqual([]);
  expect(labels.filter((label) => /retry/i.test(label))).toEqual([]);
  /* The row IS rendered — otherwise this passes by showing nothing. */
  expect(host.textContent ?? "").toContain("context the operator added");
  root.unmount();
});
