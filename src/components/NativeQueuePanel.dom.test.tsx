import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import { translate, type TFunction } from "@/lib/i18n";
import { parseRuntimeCommand } from "@/lib/runtime/commands";
import { useNativeQueue, type NativeQueueDependencies } from "@/hooks/useNativeQueue";
import type { NativeQueuedSubmission } from "@/lib/runtime/nativeCodexQueue";
import type { NativeQueueRecord } from "@/lib/runtime/nativeQueueContracts";

import { NativeQueuePanel, type NativeQueueUnresolvedAdmission } from "./NativeQueuePanel";
import { resetRetainedQueueAdmissionsForTests } from "./retainedQueueAdmissions";

/**
 * The queue the operator actually touches (#1629).
 *
 * The real hook and the real panel, over an injected transport: what is under
 * test is the whole loop the operator sees — a control press becomes one
 * admission with its own immutable key, the row it belongs to goes busy at once,
 * the queue is re-read, and a refusal is shown in the runtime's own words with
 * nothing retried behind it.
 *
 * AND THE TRANSPORT RUNS THE REAL PARSER. Every press is handed to
 * `parseRuntimeCommand` exactly as the route hands it, and its refusal is this
 * transport's 400. A stub that answered 202 to anything let the header's own
 * "send the queue now" pass here for as long as the parser had been rejecting
 * it with `entryId is invalid` — a control that could never be admitted, green
 * in CI.
 */

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  MouseEvent: dom.MouseEvent,
  sessionStorage: dom.sessionStorage,
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
/**
 * The journal's own answer, in the shape the route actually returns: the
 * operation it committed, and a receipt carrying that operation's identity —
 * which conversation, which idempotency key, which kind of command.
 *
 * The hook checks every one of those against what it submitted BEFORE reading
 * the verdict, so a stub that answers less than this is testing a contract the
 * server does not have. `null` fields let a test withhold exactly one of them.
 */
function journalReceipt(
  body: Record<string, unknown>,
  overrides: { status?: string; conversationId?: string | null; idempotencyKey?: string | null; kind?: string | null; operationId?: string | null } = {},
): { status: number; body: Record<string, unknown> } {
  const operationId = overrides.operationId === undefined ? `op-${String(body.idempotencyKey)}` : overrides.operationId;
  const receipt: Record<string, unknown> = {
    status: overrides.status ?? "queued",
    revision: 1,
    at: "2026-09-10T11:00:00.000Z",
    admittedAt: "2026-09-10T11:00:00.000Z",
  };
  if (operationId !== null) receipt.operationId = operationId;
  const conversationId = overrides.conversationId === undefined ? body.conversationId : overrides.conversationId;
  if (conversationId !== null) receipt.conversationId = conversationId;
  const idempotencyKey = overrides.idempotencyKey === undefined ? body.idempotencyKey : overrides.idempotencyKey;
  if (idempotencyKey !== null) receipt.idempotencyKey = idempotencyKey;
  const kind = overrides.kind === undefined ? "native-queue" : overrides.kind;
  if (kind !== null) receipt.kind = kind;
  return {
    status: (overrides.status ?? "queued") === "rejected" ? 409 : 202,
    body: { ...(operationId === null ? {} : { operationId: `op-${String(body.idempotencyKey)}` }), receipt },
  };
}

/** Replaced per test; by default the journal's honest answer for the request. */
let writeAnswer: ((body: Record<string, unknown>) => { status: number; body: Record<string, unknown> }) | { status: number; body: Record<string, unknown> } =
  (body) => journalReceipt(body);
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
    try { parseRuntimeCommand("native-queue", body); }
    catch (error) { return { status: 400, body: { error: error instanceof Error ? error.message : "invalid" } }; }
    return typeof writeAnswer === "function" ? writeAnswer(body) : writeAnswer;
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
      cardId="conversation_queue"
      mintKey={() => `key-${++keySequence}`}
      submit={queue.submit}
      onRefresh={queue.refresh}
      t={t}
    />
  );
}

function BindingHarness({ threadId, accountId }: { threadId: string; accountId: string }) {
  const queue = useNativeQueue("conversation_queue", {
    enabled: true, threadId, accountId, turn: "idle", activeTurnId: null, changeRevision: 0,
  }, dependencies);
  return (
    <NativeQueuePanel
      view={queue.view}
      loading={queue.loading}
      error={queue.error}
      thread={{ model: "gpt-6-astra", effort: "high" }}
      cardId="conversation_queue"
      mintKey={() => `key-${++keySequence}`}
      submit={queue.submit}
      onRefresh={queue.refresh}
      t={t}
    />
  );
}

function UnresolvedHarness(props: {
  unresolved: NativeQueueUnresolvedAdmission[];
  onReplay(key: string): void;
}) {
  const queue = useNativeQueue("conversation_queue", {
    enabled: true, threadId: "thread-1", accountId: "acct-1", turn: "idle", activeTurnId: null, changeRevision: 0,
  }, dependencies);
  return (
    <NativeQueuePanel
      view={queue.view}
      loading={queue.loading}
      error={queue.error}
      thread={{ model: "gpt-6-astra", effort: "high" }}
      unresolved={props.unresolved}
      onReplay={props.onReplay}
      cardId="conversation_queue"
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
  /* The retained keys are module-scoped and durable ON PURPOSE (a poll-driven
     remount must not lose them), so each test starts from an empty store and an
     empty tab rather than inheriting the previous one's unanswered presses. */
  resetRetainedQueueAdmissionsForTests();
  sessionStorage.clear();
  readFails = null;
  writeAnswer = (body) => journalReceipt(body);
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
  /* The queue-level form native's own protocol has: `queuedSubmissionId` is
     nullable, so a start that names no entry dispatches the head of the queue.
     The real parser is what says whether the header's control is admissible. */
  expect(writes[0]).toMatchObject({ action: "start", turnId: null });
  expect(writes[0]).not.toHaveProperty("entryId");
  expect(host.querySelector('[data-testid="native-queue-failure"]')).toBeNull();
});

test("a withdrawn message goes back through the one action the runtime admits", async () => {
  /* The payload survived a send-now whose steer did not land. The journal takes
     only a `start` for it, so the row offers a start naming the entry and its
     revision — a `send-now` here was refused every time, which left the
     operator's words visible in the panel and unreachable from it. */
  entries = [record("stuck", { state: "withdrawn" })];
  items = [];
  await mount({ turn: "idle" });
  expect(rows()[0]!.querySelector('[data-testid="native-queue-send-now"]')).toBeNull();
  /* And it says what it is. Codex no longer holds it, so the unobserved row's
     ordinary "waiting for Codex to acknowledge it" described the opposite. */
  expect(rows()[0]!.querySelector('[data-testid="native-queue-row-status"]')?.textContent)
    .toContain("no longer holds it");
  await click(rows()[0]!.querySelector('[data-testid="native-queue-row-start"]'));
  expect(writes[0]).toMatchObject({ action: "start", entryId: "stuck", expectedRevision: 1, turnId: null });
  expect(host.querySelector('[data-testid="native-queue-failure"]')).toBeNull();
});

test("editing the words of a message with attachments keeps them", async () => {
  /* An update replaces the version wholesale and its digest is computed over
     what the command carries, so a Save that named no images admitted a
     revision with none: a text edit that silently threw the pictures away. */
  const image = { sha256: "c".repeat(64), mime: "image/png" as const, bytes: 64 };
  entries = [record("a", { versions: [{
    revision: 1, operationId: "op-a", text: "message a", images: [image], contentDigest: "d-a",
  }] })];
  items = [submission("a")];
  await mount();
  await click(rows()[0]!.querySelector('[data-testid="native-queue-edit"]'));
  (host.querySelector('[data-testid="native-queue-edit-field"]') as HTMLTextAreaElement).value = "new words";
  await click(host.querySelector('[data-testid="native-queue-save"]'));
  expect(writes[0]).toMatchObject({ action: "update", entryId: "a", text: "new words", images: [image] });
});

test("an attachment-only message is editable, and its Save is not swallowed", async () => {
  /* Its text is empty and always was. Refusing an empty box made the one message
     whose words the operator most likely wanted to ADD the only one they could
     not save at all — the press did nothing and said nothing. */
  const image = { sha256: "d".repeat(64), mime: "image/png" as const, bytes: 64 };
  entries = [record("pic", { versions: [{
    revision: 1, operationId: "op-pic", text: "", images: [image], contentDigest: "d-pic",
  }] })];
  items = [submission("pic")];
  await mount();
  await click(rows()[0]!.querySelector('[data-testid="native-queue-edit"]'));
  (host.querySelector('[data-testid="native-queue-edit-field"]') as HTMLTextAreaElement).value = "a caption at last";
  await click(host.querySelector('[data-testid="native-queue-save"]'));
  expect(writes[0]).toMatchObject({ action: "update", entryId: "pic", text: "a caption at last", images: [image] });
});

test("the header counts the queue, leaving the history behind it out", async () => {
  /* The journal keeps up to 128 settled rows so a reader can see what happened.
     Counting them into the panel above the composer read "129 messages" over a
     queue holding one. */
  entries = [
    ...Array.from({ length: 128 }, (_, index) => record(`done-${index}`, { state: "delivered" })),
    record("a"),
  ];
  items = [submission("a")];
  await mount();
  expect(rows()).toHaveLength(1);
  expect(host.querySelector('[data-testid="native-queue-count"]')?.textContent).toContain("1 message");
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
  writeAnswer = (body) => ({ ...journalReceipt(body, { status: "rejected" }), body: { ...journalReceipt(body, { status: "rejected" }).body, error: "expectedRevision is stale" } });
  await mount();
  await click(rows()[0]!.querySelector('[data-testid="native-queue-delete"]'));
  expect(host.querySelector('[data-testid="native-queue-failure"]')?.textContent).toContain("stale");
});

test("a receipt that is not this operation's cannot settle it, whatever it says", async () => {
  /* THE RESPONSE-SCHEMA NEGATIVE, over every way a reply can fail to be about
     this request. HTTP 202 with `{}` was read as success, and a fully-shaped
     receipt naming ANOTHER operation was read as success or as a refusal
     depending only on its status — the verdict path never looked at identity at
     all. Either way the row was released and the next identical press minted a
     second key for an operation that may already exist.

     A receipt is evidence about the operation it names. The reply must name an
     operation, the receipt must name the same one, and its conversation, its
     idempotency key and its kind must be the ones this request submitted. */
  const cases: Array<[string, (body: Record<string, unknown>) => { status: number; body: Record<string, unknown> }]> = [
    ["an empty body", () => ({ status: 202, body: {} })],
    ["a receipt with no operation named beside it", (body) => ({ status: 202, body: { receipt: journalReceipt(body).body.receipt } })],
    ["an operation with no receipt", () => ({ status: 202, body: { operationId: "op-1" } })],
    ["a receipt with no status", (body) => journalReceipt(body, { status: "" })],
    ["a status this build has never heard of", (body) => journalReceipt(body, { status: "teleported" })],
    ["a receipt naming a different operation", (body) => journalReceipt(body, { operationId: "op-someone-else" })],
    ["a receipt with no operation id", (body) => journalReceipt(body, { operationId: null })],
    ["a receipt from another conversation", (body) => journalReceipt(body, { conversationId: "conversation_foreign" })],
    ["a receipt with no conversation", (body) => journalReceipt(body, { conversationId: null })],
    ["a receipt for another request", (body) => journalReceipt(body, { idempotencyKey: "another-request" })],
    ["a receipt with no idempotency key", (body) => journalReceipt(body, { idempotencyKey: null })],
    ["a receipt for a different kind of command", (body) => journalReceipt(body, { kind: "send" })],
    ["a receipt with no kind", (body) => journalReceipt(body, { kind: null })],
    /* AND THE SAME FOREIGN RECEIPT CARRYING A REFUSAL. This is the arm the
       verdict path skipped: `rejected` and `failed` released the operation
       without ever asking whose receipt it was. */
    ["a foreign receipt that says rejected", (body) => ({
      status: 409,
      body: journalReceipt(body, { status: "rejected", conversationId: "conversation_foreign", idempotencyKey: "another-request" }).body,
    })],
    ["a foreign receipt that says failed", (body) => journalReceipt(body, { status: "failed", conversationId: "conversation_foreign", idempotencyKey: "another-request" })],
  ];
  for (const [name, answer] of cases) {
    writes = [];
    writeAnswer = answer;
    await mount();
    await click(rows()[0]!.querySelector('[data-testid="native-queue-delete"]'));
    expect(`${name}: ${host.querySelector('[data-testid="native-queue-failure"]')?.textContent ?? ""}`)
      .toContain("unknown");

    /* And the operation keeps its identity: pressing the same control again
       replays it rather than admitting a second one. */
    await click(rows()[0]!.querySelector('[data-testid="native-queue-delete"]'));
    expect(`${name}: ${writes.length}`).toBe(`${name}: 2`);
    expect(`${name}: ${String(writes[1]!.idempotencyKey)}`).toBe(`${name}: ${String(writes[0]!.idempotencyKey)}`);
    flushSync(() => root.unmount());
    document.body.replaceChildren();
  }
  writeAnswer = (body) => journalReceipt(body);
  await mount();
});

test("this operation's own receipt settles it, on either verdict", async () => {
  /* THE POSITIVE CONTROL for the same check: a receipt whose operation,
     conversation, idempotency key and kind are all this request's is read as the
     verdict it carries — an acceptance releases the key, and so does a refusal,
     because both are the journal speaking about THIS operation. */
  for (const [status, expectRefusal] of [["queued", false], ["applied", false], ["rejected", true], ["failed", true]] as const) {
    writes = [];
    writeAnswer = (body) => journalReceipt(body, { status });
    await mount();
    await click(rows()[0]!.querySelector('[data-testid="native-queue-delete"]'));
    const failure = host.querySelector('[data-testid="native-queue-failure"]')?.textContent ?? "";
    expect(`${status}: ${failure.includes("unknown")}`).toBe(`${status}: false`);
    expect(`${status}: ${failure.length > 0}`).toBe(`${status}: ${expectRefusal}`);

    /* Settled means settled: the next press is a new operation. */
    await click(rows()[0]!.querySelector('[data-testid="native-queue-delete"]'));
    expect(`${status}: ${writes[1]!.idempotencyKey === writes[0]!.idempotencyKey}`).toBe(`${status}: false`);
    flushSync(() => root.unmount());
    document.body.replaceChildren();
  }
  writeAnswer = (body) => journalReceipt(body);
  await mount();
});

test("a verdict the journal did give releases the key, so the next press is a new operation", async () => {
  await mount();
  await click(rows()[0]!.querySelector('[data-testid="native-queue-delete"]'));
  await click(rows()[0]!.querySelector('[data-testid="native-queue-delete"]'));
  expect(writes).toHaveLength(2);
  expect(writes[1]!.idempotencyKey).not.toBe(writes[0]!.idempotencyKey);
});

test("an unresolved hand-off is offered its one recovery control, on an empty queue too", async () => {
  /* It is NOT a queue row: the journal may or may not hold it, which is the
     whole point, so it is counted and presented separately. The panel opens for
     it even when Codex is holding nothing, because that is exactly when the
     operator would otherwise see no sign of it at all. */
  entries = [];
  items = [];
  const replayed: string[] = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <UnresolvedHarness
        unresolved={[{ key: "op-lost", text: "the message with no answer", imageCount: 0 }]}
        onReplay={(key) => replayed.push(key)}
      />,
    );
  });
  await act(async () => { await Promise.resolve(); });

  expect(host.querySelector('[data-testid="native-queue-row"]')).toBeNull();
  const row = host.querySelector('[data-testid="native-queue-unresolved-row"]');
  expect(row?.textContent).toContain("the message with no answer");
  expect(host.querySelector('[data-testid="native-queue-unresolved"]')?.textContent).toContain("no answer yet");
  await click(row?.querySelector('[data-testid="native-queue-unresolved-retry"]'));
  expect(replayed).toEqual(["op-lost"]);
});

test("an account or thread change empties the panel before the new queue is read", async () => {
  /* The same card in front of the operator, a different binding behind it. The
     previous conversation's rows are a false statement about what Codex is
     holding, and their controls name a binding the runtime would refuse — so
     they go the moment the binding moves, rather than when a read that may fail
     or never answer eventually replaces them. */
  let resolveRead: null | (() => void) = null;
  const previous = dependencies.read;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root.render(<BindingHarness threadId="thread-1" accountId="acct-1" />); });
  await act(async () => { await Promise.resolve(); });
  expect(rows()).toHaveLength(2);

  try {
    /* The next read never answers, which is the case that used to leave the old
       rows on screen for good. */
    (dependencies as { read: NativeQueueDependencies["read"] }).read = () =>
      new Promise((resolve) => { resolveRead = () => resolve({ entries: [], native: null }); });
    await act(async () => { root.render(<BindingHarness threadId="thread-1" accountId="acct-2" />); });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector('[data-testid="native-queue-row"]')).toBeNull();

    /* And a thread rehost does the same. */
    await act(async () => { root.render(<BindingHarness threadId="thread-2" accountId="acct-2" />); });
    await act(async () => { await Promise.resolve(); });
    expect(host.querySelector('[data-testid="native-queue-row"]')).toBeNull();
  } finally {
    (dependencies as { read: NativeQueueDependencies["read"] }).read = previous;
    (resolveRead as null | (() => void))?.();
  }
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
  expect(status).toContain("The thread is on gpt-6-astra · high right now");
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
    return typeof writeAnswer === "function" ? writeAnswer(body) : writeAnswer;
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

test("a control whose reply never arrived keeps its operation across a remount, and across a reload", async () => {
  /* THE POLL-DRIVEN REMOUNT, which is what a component ref could not survive
     (review finding 7). The composer above this panel remounts on every board
     poll, so a key held in a ref was minted fresh afterwards and the operator's
     second press became a SECOND operation for something the journal may already
     hold. The entry-level fence hides that for a delete or an edit — the journal
     refuses a second mutation while `mutationOperationId` is set — but a
     queue-level `start` names no entry and has no such fence, so it is checked
     here too.

     A reload is the same case with the in-process mirror gone: only what was
     written to storage BEFORE the request left can name the operation. */
  for (const [name, press] of [
    ["a row control", () => rows()[0]!.querySelector('[data-testid="native-queue-delete"]')],
    ["the queue-level start", () => host.querySelector('[data-testid="native-queue-start"]')],
  ] as const) {
    for (const survive of ["remount", "reload"] as const) {
      resetRetainedQueueAdmissionsForTests();
      sessionStorage.clear();
      writes = [];
      writeAnswer = () => ({ status: 503, body: {} });
      await mount({ turn: "idle" });
      await click(press());
      /* A 5xx with no receipt is the journal's answer never arriving: the row
         says so, and the operation stays this browser's to name. */
      expect(`${name}/${survive}: ${host.querySelector('[data-testid="native-queue-failure"]')?.textContent ?? ""}`)
        .toContain("could not answer");

      flushSync(() => root.unmount());
      document.body.replaceChildren();
      /* A reload keeps sessionStorage and loses the module's own mirror. */
      if (survive === "reload") resetRetainedQueueAdmissionsForTests();
      await mount({ turn: "idle" });
      await click(press());

      expect(`${name}/${survive}: ${writes.length}`).toBe(`${name}/${survive}: 2`);
      expect(`${name}/${survive}: ${String(writes[1]!.idempotencyKey)}`)
        .toBe(`${name}/${survive}: ${String(writes[0]!.idempotencyKey)}`);
      /* And the ORIGINAL frozen envelope, not one rebuilt from the second press. */
      expect(`${name}/${survive}: ${JSON.stringify(writes[1]!.action)}`)
        .toBe(`${name}/${survive}: ${JSON.stringify(writes[0]!.action)}`);

      flushSync(() => root.unmount());
      document.body.replaceChildren();
    }
  }
  writeAnswer = (body) => journalReceipt(body);
  await mount();
});

test("a different request after a lost one is still its own operation", async () => {
  /* The other half of the same rule: retention must not collapse two things the
     operator actually asked for into one. A lost delete on row a leaves its key
     retained; deleting row b is a different request and gets its own. */
  writeAnswer = () => ({ status: 503, body: {} });
  await mount();
  await click(rows()[0]!.querySelector('[data-testid="native-queue-delete"]'));
  await click(rows()[1]!.querySelector('[data-testid="native-queue-delete"]'));
  expect(writes).toHaveLength(2);
  expect(writes[1]!.entryId).not.toBe(writes[0]!.entryId);
  expect(writes[1]!.idempotencyKey).not.toBe(writes[0]!.idempotencyKey);

  /* And the first one is still recoverable under its own key. */
  await click(rows()[0]!.querySelector('[data-testid="native-queue-delete"]'));
  expect(writes[2]!.idempotencyKey).toBe(writes[0]!.idempotencyKey);
  writeAnswer = (body) => journalReceipt(body);
});
