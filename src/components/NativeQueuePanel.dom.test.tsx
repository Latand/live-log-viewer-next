import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { translate, type TFunction } from "@/lib/i18n";
import { useNativeQueue, type NativeQueueDependencies } from "@/hooks/useNativeQueue";
import type { NativeQueuedSubmission } from "@/lib/runtime/nativeCodexQueue";
import type { NativeQueueRecord } from "@/lib/runtime/nativeQueueContracts";

import { NativeQueuePanel } from "./NativeQueuePanel";

/**
 * The queue the operator actually touches (#1629).
 *
 * The real hook and the real panel, over an injected transport: what is under
 * test is the whole loop the operator sees — a control press becomes one
 * admission with its own immutable key, the row it belongs to goes busy at once,
 * the queue is re-read, and a refusal is shown in the runtime's own words with
 * nothing retried behind it.
 */

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  MouseEvent: dom.MouseEvent,
  requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0),
  cancelAnimationFrame: (handle: number) => clearTimeout(handle),
});

/* React's own act environment flag, so a state update inside `act` is not
   reported as an unwrapped one. */
const G = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
G.IS_REACT_ACT_ENVIRONMENT = true;

const t: TFunction = (key, params) => translate("en", key, params);
const BINDING = { threadId: "thread-1", accountId: "acct-1" };

function record(entryId: string, overrides: Partial<NativeQueueRecord> = {}): NativeQueueRecord {
  return {
    entryId,
    conversationId: "conversation_queue",
    binding: BINDING,
    clientUserMessageId: `client-${entryId}`,
    nativeSubmissionId: `native-${entryId}`,
    revision: 1,
    versions: [{ revision: 1, operationId: `op-${entryId}`, text: `message ${entryId}`, images: [], contentDigest: `d-${entryId}` }],
    profilePolicy: "thread-at-dispatch",
    state: "queued",
    mutationOperationId: null,
    dispatchedRevision: null,
    dispatchedTurnId: null,
    proof: null,
    reason: null,
    ...overrides,
  };
}

const submission = (entryId: string): NativeQueuedSubmission =>
  ({ id: `native-${entryId}`, clientUserMessageId: `client-${entryId}`, input: [{ type: "text", text: `message ${entryId}` }] });

let writes: Record<string, unknown>[] = [];
let reads = 0;
let entries: NativeQueueRecord[] = [];
let items: NativeQueuedSubmission[] = [];
let writeAnswer: { status: number; body: Record<string, unknown> } = { status: 202, body: { receipt: { status: "queued" } } };
let readFails: string | null = null;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const dependencies: NativeQueueDependencies = {
  read: async () => {
    reads += 1;
    if (readFails) throw new Error(readFails);
    return { entries, native: { threadId: "thread-1", items, stale: false } };
  },
  write: async (body) => {
    writes.push(body);
    return writeAnswer;
  },
};

let keySequence = 0;

function Harness({ turn = "idle" as "idle" | "running", changeRevision = 0 }) {
  const queue = useNativeQueue("conversation_queue", {
    enabled: true,
    threadId: "thread-1",
    accountId: "acct-1",
    turn,
    activeTurnId: turn === "running" ? "turn-live" : null,
    changeRevision,
  }, dependencies);
  return (
    <NativeQueuePanel
      view={queue.view}
      loading={queue.loading}
      error={queue.error}
      thread={{ model: "gpt-6-astra", effort: "high" }}
      mintKey={() => `key-${++keySequence}`}
      submit={queue.submit}
      onRefresh={queue.refresh}
      t={t}
    />
  );
}

async function mount(props: Parameters<typeof Harness>[0] = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<Harness {...props} />); });
  await act(async () => { await Promise.resolve(); });
}

beforeEach(() => {
  writes = [];
  reads = 0;
  keySequence = 0;
  readFails = null;
  writeAnswer = { status: 202, body: { receipt: { status: "queued" } } };
  entries = [record("a"), record("b")];
  items = [submission("a"), submission("b")];
});

afterEach(() => {
  flushSync(() => root?.unmount());
  document.body.replaceChildren();
});

const rows = () => [...host.querySelectorAll('[data-testid="native-queue-row"]')];
const click = async (element: Element | null | undefined) => {
  await act(async () => { element?.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
  await act(async () => { await Promise.resolve(); });
};

test("the queue renders in Codex's order with one row per message", async () => {
  items = [submission("b"), submission("a")];
  await mount();
  expect(rows().map((row) => row.getAttribute("data-entry"))).toEqual(["b", "a"]);
  expect(host.querySelector('[data-testid="native-queue-count"]')?.textContent).toContain("2 messages");
});

test("removing a message admits one command with its own key and nothing else", async () => {
  await mount();
  await click(rows()[0]!.querySelector('[data-testid="native-queue-delete"]'));

  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({
    conversationId: "conversation_queue",
    action: "delete",
    entryId: "a",
    expectedRevision: 1,
    binding: BINDING,
    idempotencyKey: "key-1",
  });
  /* And the queue is read again rather than assumed: the reply is a receipt,
     not a result. */
  expect(reads).toBeGreaterThan(1);
});

test("moving a message submits Codex's submission ids in the new order", async () => {
  await mount();
  await click(rows()[1]!.querySelector('[data-testid="native-queue-down"]'));
  expect(writes).toHaveLength(0);

  await click(rows()[1]!.querySelector('[data-testid="native-queue-up"]'));
  expect(writes[0]).toMatchObject({ action: "reorder", queuedSubmissionIds: ["native-b", "native-a"] });
});

test("an edit carries the revision it was made against", async () => {
  /* An entry the runtime has admitted a newer version of is a conflict the
     operator is told about, never a silent overwrite. */
  await mount();
  await click(rows()[0]!.querySelector('[data-testid="native-queue-edit"]'));
  const field = host.querySelector('[data-testid="native-queue-edit-field"]') as HTMLTextAreaElement;
  /* The box is uncontrolled and read at save, so typing into it is exactly
     assigning its value — no synthetic-event round trip to arrange. */
  expect(field.value).toBe("message a");
  field.value = "corrected message";
  await click(host.querySelector('[data-testid="native-queue-save"]'));

  expect(writes[0]).toMatchObject({ action: "update", entryId: "a", expectedRevision: 1, text: "corrected message" });
});

test("send now fences on the running turn, and on an explicit idle otherwise", async () => {
  await mount({ turn: "running" });
  await click(rows()[0]!.querySelector('[data-testid="native-queue-send-now"]'));
  expect(writes[0]).toMatchObject({ action: "send-now", entryId: "a", turnId: "turn-live" });

  writes = [];
  flushSync(() => root.unmount());
  document.body.replaceChildren();
  await mount({ turn: "idle" });
  await click(rows()[0]!.querySelector('[data-testid="native-queue-send-now"]'));
  expect(writes[0]).toMatchObject({ action: "send-now", entryId: "a", turnId: null });
});

test("starting the queue asks for an idle fence, and is offered only when idle", async () => {
  await mount({ turn: "running" });
  expect(host.querySelector('[data-testid="native-queue-start"]')).toBeNull();

  flushSync(() => root.unmount());
  document.body.replaceChildren();
  await mount({ turn: "idle" });
  await click(host.querySelector('[data-testid="native-queue-start"]'));
  expect(writes[0]).toMatchObject({ action: "start", turnId: null });
});

test("a refusal is shown in the runtime's own words and nothing is retried", async () => {
  writeAnswer = { status: 409, body: { error: "native queue host or account ownership changed" } };
  await mount();
  await click(rows()[0]!.querySelector('[data-testid="native-queue-delete"]'));

  expect(host.querySelector('[data-testid="native-queue-failure"]')?.textContent)
    .toContain("ownership changed");
  expect(writes).toHaveLength(1);
});

test("a 202 whose receipt was rejected is a failure, not an acceptance", async () => {
  /* The HTTP code says the request was understood; the journal's own receipt is
     the verdict. */
  writeAnswer = { status: 202, body: { receipt: { status: "rejected" }, error: "expectedRevision is stale" } };
  await mount();
  await click(rows()[0]!.querySelector('[data-testid="native-queue-delete"]'));
  expect(host.querySelector('[data-testid="native-queue-failure"]')?.textContent).toContain("stale");
});

test("a queue that cannot be read says so rather than showing an empty queue", async () => {
  readFails = "native queue history is unavailable";
  await mount();
  expect(host.querySelector('[data-testid="native-queue-panel"]')?.textContent).toContain("could not be read");
  expect(host.querySelector('[data-testid="native-queue-row"]')).toBeNull();

  readFails = null;
  await click(host.querySelector('[data-testid="native-queue-retry"]'));
  expect(rows()).toHaveLength(2);
});

test("every row says what a queued message will run on, and does not promise more", async () => {
  entries = [record("a", { versions: [{
    revision: 1, operationId: "op-a", text: "message a", images: [], contentDigest: "d-a",
    requestedRuntime: { model: "gpt-6-astra", effort: "low" },
  }] })];
  items = [submission("a")];
  await mount();
  const status = rows()[0]!.querySelector('[data-testid="native-queue-row-status"]')?.textContent ?? "";
  expect(status).toContain("Runs on gpt-6-astra · high");
  expect(status).toContain("Asked for gpt-6-astra · low");
});

test("a message Codex has not acknowledged shows why it cannot be changed", async () => {
  entries = [record("new", { nativeSubmissionId: null })];
  items = [];
  await mount();
  expect(rows()[0]!.querySelector('[data-testid="native-queue-delete"]')).toBeNull();
  expect(rows()[0]!.querySelector('[data-testid="native-queue-row-status"]')?.textContent).toContain("acknowledge");
});

test("a change Codex reported re-reads the queue without the operator asking", async () => {
  await mount();
  const before = reads;
  await act(async () => { root.render(<Harness changeRevision={1} />); });
  await act(async () => { await Promise.resolve(); });
  expect(reads).toBeGreaterThan(before);
});

test("the queue survives a reload, because it was never the browser's", async () => {
  /* Codex holds it and the runtime journals it, so a fresh page has the same
     queue — including a message admitted while the last page was still open. */
  await mount();
  expect(rows()).toHaveLength(2);
  flushSync(() => root.unmount());
  document.body.replaceChildren();

  entries = [record("a"), record("b"), record("c")];
  items = [submission("a"), submission("b"), submission("c")];
  await mount();
  expect(rows().map((row) => row.getAttribute("data-entry"))).toEqual(["a", "b", "c"]);
});

test("a full queue stays responsive: a control press paints its own row inside the deadline", async () => {
  /* The production-shaped case. The runtime stage measured that ADMISSION does
     not wait for a native RPC; this measures the half the operator actually
     feels — the press to the row saying it is busy — with the queue at the
     admission bound the panel is expected to hold.

     Deliberately generous (250 ms, the same deadline the server half uses):
     what it catches is a render that went quadratic or an accidental await on
     the transport, not a millisecond of jitter on a loaded machine. */
  entries = Array.from({ length: 128 }, (_, index) => record(`e${index}`));
  items = entries.map((row) => submission(row.entryId.replace("e", "e")));
  const mountedAt = performance.now();
  await mount();
  const paint = performance.now() - mountedAt;
  expect(rows()).toHaveLength(128);

  /* Hold the write open, so what is measured is the paint and not the reply. */
  let release = () => {};
  const previous = dependencies.write;
  (dependencies as { write: NativeQueueDependencies["write"] }).write = async (body) => {
    writes.push(body);
    await new Promise<void>((resolve) => { release = resolve; });
    return writeAnswer;
  };
  try {
    const pressedAt = performance.now();
    const button = rows()[0]!.querySelector('[data-testid="native-queue-delete"]');
    await act(async () => { button?.dispatchEvent(new dom.MouseEvent("click", { bubbles: true }) as unknown as Event); });
    const feedback = performance.now() - pressedAt;
    expect(rows()[0]!.querySelector('[data-testid="native-queue-row-status"]')?.textContent).toContain("waiting");
    expect(feedback).toBeLessThan(250);
    expect(paint).toBeLessThan(2_000);
    release();
    await act(async () => { await Promise.resolve(); });
  } finally {
    (dependencies as { write: NativeQueueDependencies["write"] }).write = previous;
  }
});
