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
 * The composer's injection action, driven through the real component (#1560).
 *
 * The operator asked for a discoverable control that adds to the thread without
 * interrupting it, and asked for the existing submissions to stay exactly as
 * they are. Both halves are asserted here against the rendered composer rather
 * than against a hand-built capability object, so the REAL capability rules
 * decide what appears:
 *
 * - the action shows only when the host has advertised injection;
 * - choosing it posts to the injection endpoint and to nothing else — no send,
 *   no queue write, so no interrupt and no new turn can come from it;
 * - it stays available while the thread is idle, where a steer is refused,
 *   because idle injection is a supported outcome rather than a no-op;
 * - Enter and Alt+Enter keep their meanings.
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


const textarea = (host: HTMLElement) => host.querySelector("textarea")!;

async function type(host: HTMLElement, value: string): Promise<void> {
  const field = textarea(host);
  const propsKey = Object.keys(field).find((candidate) => candidate.startsWith("__reactProps$"))!;
  const props = (field as unknown as Record<string, { onChange(event: unknown): void }>)[propsKey]!;
  await settle(() => props.onChange({ target: { value }, currentTarget: { value } }));
}

test("the injection action is offered, and choosing it posts only to the injection endpoint", async () => {
  turn = "running";
  const { host, root } = await mount();
  await type(host, "also read the migration notes");
  await openSendMenu(host);

  const action = menuAction(host, "Add to context");
  expect(action).toBeDefined();
  expect(action!.hasAttribute("disabled")).toBe(false);
  /* While a turn is running the hint says what actually happens to it. */
  expect(action!.textContent).toContain("without interrupting");

  await settle(() => action!.click());
  await settle(() => {});

  expect(injections).toHaveLength(1);
  expect(injections[0]).toMatchObject({
    conversationId: CARD,
    text: "also read the migration notes",
  });
  /* NOTHING ELSE WAS TOUCHED. A send here would interrupt the turn and a queue
     write would park the words until it ended; the action promises neither. */
  expect(sends).toEqual([]);
  expect(queueWrites).toEqual([]);
  /* The draft is cleared, exactly as the other submissions clear it. */
  expect(textarea(host).value).toBe("");
  root.unmount();
});

test("the action stays available while the thread is idle, where a steer is not", async () => {
  turn = "idle";
  const { host, root } = await mount();
  await type(host, "background material");
  await openSendMenu(host);

  const inject = menuAction(host, "Add to context");
  expect(inject!.hasAttribute("disabled")).toBe(false);
  /* Idle injection has its own honest description: it stores rather than joins. */
  expect(inject!.textContent).toContain("Stores it in the conversation");

  /* The steer action is the contrast: nothing is running, so it is refused. */
  const steer = menuAction(host, "Steer the running turn");
  expect(steer!.hasAttribute("disabled")).toBe(true);

  await settle(() => inject!.click());
  await settle(() => {});
  expect(injections).toHaveLength(1);
  expect(sends).toEqual([]);
  root.unmount();
});

test("a host that has not advertised injection offers no action at all", async () => {
  injectCapable = false;
  const { host, root } = await mount();
  await type(host, "nowhere to go");
  await openSendMenu(host);

  /* Not a disabled row: the capability was never observed, so the composer
     makes no offer it cannot keep. */
  expect(menuAction(host, "Add to context")).toBeUndefined();
  expect(menuAction(host, "Queue")).toBeDefined();
  root.unmount();
});

test("the existing submissions keep their meanings beside the new action", async () => {
  turn = "running";
  const { host, root } = await mount();
  await type(host, "answer me");

  /* Enter still sends, and a send still interrupts the running turn. */
  await settle(() => press(textarea(host), "Enter"));
  await settle(() => {});
  expect(sends).toHaveLength(1);
  expect(sends[0]).toMatchObject({ policy: "interrupt-active" });
  expect(injections).toEqual([]);

  /* Alt+Enter still hands the draft to Codex's own queue. */
  await type(host, "later please");
  await settle(() => press(textarea(host), "Enter", { altKey: true }));
  await settle(() => {});
  expect(queueWrites).toHaveLength(1);
  expect(injections).toEqual([]);
  root.unmount();
});

/** Reaches the picker the composer renders and hands it a real document, the
    way the attachment suites do, so the staged state is the composer's own. */
async function stageFile(host: HTMLElement, name: string, body: string, finishRead = true): Promise<void> {
  let onFiles: ((files: File[]) => void) | null = null;
  for (const node of host.querySelectorAll("input")) {
    const propsKey = Object.keys(node).find((candidate) => candidate.startsWith("__reactProps$"));
    const props = propsKey ? (node as unknown as Record<string, { onChange?: (event: unknown) => void; type?: string }>)[propsKey] : null;
    if (node.getAttribute("type") !== "file" || typeof props?.onChange !== "function") continue;
    const handler = props.onChange;
    await settle(() => handler({ target: { files: [new File([body], name, { type: "text/markdown" })], value: "" } }));
    if (finishRead) QueuedReader.settleAll(`data:text/markdown;base64,${Buffer.from(body).toString("base64")}`);
    await settle(() => {});
    return;
  }
  if (!onFiles) throw new Error("the composer rendered no file input");
}

test("a staged document rides the injection instead of being silently dropped", async () => {
  const { host, root } = await mount();
  await type(host, "use the attached spec");
  await stageFile(host, "spec.md", "# spec\n");
  await openSendMenu(host);

  const action = menuAction(host, "Add to context");
  /* A DOCUMENT IS NOT AN IMAGE. Images genuinely cannot ride a raw Responses
     item and are refused by name; a file is folded into the text as a path, so
     the action stays available and must actually carry it. */
  expect(action!.hasAttribute("disabled")).toBe(false);
  await settle(() => action!.click());
  await settle(() => {});

  expect(injections).toHaveLength(1);
  expect(injections[0]!.files).toMatchObject([{ name: "spec.md" }]);
  root.unmount();
});

test("an injection never carries images", async () => {
  const { host, root } = await mount();
  await type(host, "with a picture");
  await openSendMenu(host);
  const action = menuAction(host, "Add to context");
  expect(action!.hasAttribute("disabled")).toBe(false);
  await settle(() => action!.click());
  await settle(() => {});
  expect(injections).toHaveLength(1);
  expect(injections[0]!.images).toBeUndefined();
  root.unmount();
});

test("the composer reports a submission, not a placement it has not observed", async () => {
  turn = "running";
  holdInjection = true;
  const { host, root } = await mount();
  await type(host, "context please");
  await openSendMenu(host);
  await settle(() => menuAction(host, "Add to context")!.click());

  /* WHILE THE REQUEST IS IN FLIGHT nothing may claim the text reached the
     thread. "Added to the running turn's input" is a statement about the
     engine, and at this moment the request has not even been answered. */
  const inFlight = host.textContent ?? "";
  expect(inFlight).toContain("Adding to context");
  expect(inFlight).not.toContain("Added to the running turn");

  await settle(() => releaseInjection?.());
  /* AND AFTER A SUCCESSFUL POST it says accepted, not delivered: the operation
     can still settle uncertain, because an empty engine acknowledgement proves
     nothing about the thread. The receipt carries the placement. */
  const settled = host.textContent ?? "";
  expect(settled).toContain("Accepted");
  expect(settled).not.toContain("Stored in the conversation context");
  root.unmount();
});

test("a refusal gives the draft back instead of reporting success", async () => {
  injectAnswer = { ok: false, status: 503, error: "structured delivery ownership is unavailable" };
  const { host, root } = await mount();
  await type(host, "give this back");
  await openSendMenu(host);
  await settle(() => menuAction(host, "Add to context")!.click());
  await settle(() => {});

  expect(textarea(host).value).toBe("give this back");
  expect(host.textContent ?? "").toContain("structured delivery ownership is unavailable");
  root.unmount();
});

test("every send-menu action stays reachable: the menu scrolls instead of overflowing", async () => {
  turn = "running";
  const { host, root } = await mount();
  await type(host, "four actions now");
  await openSendMenu(host);

  const menu = host.ownerDocument.querySelector('[data-testid="composer-send-menu"]') as HTMLElement;
  expect(menu).toBeTruthy();
  const items = [...menu.querySelectorAll('[role="menuitem"]')];
  /* Queue, inject, steer and quick-ack: the most a Codex conversation offers. */
  expect(items.length).toBe(4);
  /* Bounded and scrollable, so the head of the list cannot be pushed past the
     top of a short viewport with no way to reach it. */
  expect(menu.style.maxHeight).toContain("100dvh");
  expect(menu.className).toContain("overflow-y-auto");
  root.unmount();
});

test("injection refuses a still-reading document without sending a reduced payload", async () => {
  const { host, root } = await mount();
  await type(host, "include the whole document");
  await stageFile(host, "reading.md", "content", false);
  await openSendMenu(host);
  const action = menuAction(host, "Add to context")!;
  await settle(() => action.click());
  expect(injections).toEqual([]);
  expect(textarea(host).value).toBe("include the whole document");
  root.unmount();
});

test("an accepted injection removes only its own documents and preserves later intake", async () => {
  holdInjection = true;
  const { host, root } = await mount();
  await type(host, "context");
  await stageFile(host, "first.md", "first");
  await openSendMenu(host);
  await settle(() => menuAction(host, "Add to context")!.click());
  await stageFile(host, "later.md", "later");
  await settle(() => releaseInjection?.());
  expect(host.textContent).toContain("later.md");
  expect(host.textContent).not.toContain("first.md");
  expect(injections[0]!.files).toMatchObject([{ name: "first.md" }]);
  root.unmount();
});
