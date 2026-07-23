import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

import {
  adoptOutbox,
  cancelOutbox,
  enqueueOutbox,
  markOutboxResponded,
  nextDispatch,
  outboxHistory,
  OUTBOX_DELIVERED_TTL_MS,
  outboxStateForReceiptStatus,
  publishTranscriptEchoes,
  readOutbox,
  resetOutboxForTests,
  seedLaunchOutbox,
  transcriptEchoCount,
  updateOutbox,
  visibleOutbox,
  type OutboxEntry,
} from "./outbox";

const dom = new Window();
Object.assign(globalThis, { window: dom, sessionStorage: dom.sessionStorage });

/** Build a transcript-echo count map (finding 2): each listed text counted once,
    or with an explicit [text, count] pair for identical-message occurrences. */
function echoes(...entries: (string | [string, number])[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const [text, count] = typeof entry === "string" ? [entry, 1] : entry;
    counts.set(text, (counts.get(text) ?? 0) + count);
  }
  return counts;
}

beforeEach(() => {
  dom.sessionStorage.clear();
  resetOutboxForTests();
});
afterEach(() => {
  dom.sessionStorage.clear();
  resetOutboxForTests();
});

const submit = (cardId: string, id: string, text: string, images = 0) =>
  enqueueOutbox(cardId, { id, text, images, at: Date.now() });

test("a submitted draft becomes a queued entry immediately and survives a reload", () => {
  submit("conv", "k1", "first message");
  const queue = readOutbox("conv");
  expect(queue.map((entry) => [entry.id, entry.state])).toEqual([["k1", "queued"]]);

  /* A fresh module state (a page refresh) rehydrates the same queue. */
  resetOutboxForTests();
  expect(readOutbox("conv").map((entry) => entry.text)).toEqual(["first message"]);
});

test("the dispatcher is serial: one delivering entry at a time, oldest first", () => {
  submit("conv", "k1", "one");
  submit("conv", "k2", "two");
  submit("conv", "k3", "three");

  /* Nothing is on the wire yet → the oldest is next. */
  expect(nextDispatch(readOutbox("conv"))?.id).toBe("k1");

  updateOutbox("conv", "k1", { state: "delivering" });
  /* While one is delivering, the dispatcher yields nothing — no double-send. */
  expect(nextDispatch(readOutbox("conv"))).toBeNull();

  updateOutbox("conv", "k1", { state: "delivered", settledAt: Date.now() });
  expect(nextDispatch(readOutbox("conv"))?.id).toBe("k2");
});

test("cancel removes a queued or failed message but the model never removes a delivering one", () => {
  submit("conv", "k1", "cancel me");
  cancelOutbox("conv", "k1");
  expect(readOutbox("conv")).toHaveLength(0);
});

test("empty-composer history lists queued messages ahead of sent, newest first, de-duped", () => {
  const t0 = Date.now();
  enqueueOutbox("conv", { id: "s1", text: "old sent", images: 0, at: t0 });
  updateOutbox("conv", "s1", { state: "delivered", settledAt: t0 });
  enqueueOutbox("conv", { id: "s2", text: "newer sent", images: 0, at: t0 + 10 });
  updateOutbox("conv", "s2", { state: "delivered", settledAt: t0 + 10 });
  enqueueOutbox("conv", { id: "q1", text: "still queued", images: 0, at: t0 + 20 });
  enqueueOutbox("conv", { id: "q2", text: "still queued", images: 0, at: t0 + 30 }); // consecutive dup

  expect(outboxHistory(readOutbox("conv"))).toEqual(["still queued", "newer sent", "old sent"]);
});

test("a bubble retires only on ITS OWN transcript echo, not on an unrelated mtime bump (P1#4)", () => {
  const at = 1_000_000;
  const entry: OutboxEntry = { id: "k1", text: "my message", images: 0, at, state: "delivered", settledAt: at };
  /* An unrelated earlier turn wrote to the transcript — the echo set carries
     someone else's text, NOT this bubble's. The bubble must stay. This is the
     exact premature-removal the mtime rule caused. */
  expect(visibleOutbox([entry], echoes("a reply from an earlier turn"), at + 3_000)).toHaveLength(1);
  /* This bubble's OWN text lands in the transcript → it retires. */
  expect(visibleOutbox([entry], echoes("my message"), at + 3_000)).toHaveLength(0);
  /* Trimming is applied so whitespace differences still match the echo. */
  expect(visibleOutbox([{ ...entry, text: "  my message  " }], echoes("my message"), at + 3_000)).toHaveLength(0);
});

test("a delivered bubble whose echo never arrives still retires at the hard TTL", () => {
  const at = 1_000_000;
  const entry: OutboxEntry = { id: "k1", text: "done", images: 0, at, state: "delivered", settledAt: at };
  expect(visibleOutbox([entry], echoes(), at + 3_000)).toHaveLength(1);
  expect(visibleOutbox([entry], echoes(), at + OUTBOX_DELIVERED_TTL_MS + 1)).toHaveLength(0);
});

test("queued / delivering / launch-owned bubbles stay until their echo lands, never by TTL", () => {
  const queued: OutboxEntry = { id: "k1", text: "waiting", images: 0, at: 1_000, state: "queued" };
  const delivering: OutboxEntry = { id: "k2", text: "in flight", images: 0, at: 1_000, state: "delivering" };
  const launch: OutboxEntry = { id: "k3", text: "the launch prompt", images: 0, at: 1_000, state: "delivering", launchOwned: true };
  const far = 1_000 + OUTBOX_DELIVERED_TTL_MS * 10;
  expect(visibleOutbox([queued, delivering, launch], echoes(), far)).toHaveLength(3);
  /* Each retires only on its own echo. */
  expect(visibleOutbox([queued, delivering, launch], echoes("the launch prompt"), far).map((e) => e.id)).toEqual(["k1", "k2"]);
});

test("assistant reply evidence settles and retires its delivering outbox bubble", () => {
  const submittedAt = 1_000_000;
  enqueueOutbox("conv", { id: "key-replied", text: "please inspect this", images: 0, at: submittedAt });
  updateOutbox("conv", "key-replied", { state: "delivering" });

  markOutboxResponded("conv", "key-replied", submittedAt + 2_000);

  const [responded] = readOutbox("conv");
  expect(responded).toMatchObject({
    id: "key-replied",
    state: "delivered",
    settledAt: submittedAt + 2_000,
    responseStartedAt: submittedAt + 2_000,
  });
  expect(visibleOutbox([responded!], echoes(), submittedAt + 2_001)).toEqual([]);
});

test("assistant reply evidence leaves an unrelated pending outbox bubble visible", () => {
  const submittedAt = 1_000_000;
  enqueueOutbox("conv", { id: "key-replied", text: "first turn", images: 0, at: submittedAt });
  updateOutbox("conv", "key-replied", { state: "delivering" });
  enqueueOutbox("conv", { id: "key-pending", text: "still waiting", images: 0, at: submittedAt + 1 });

  markOutboxResponded("conv", "key-replied", submittedAt + 2_000);

  expect(visibleOutbox(readOutbox("conv"), echoes(), submittedAt + 2_001).map((entry) => entry.id))
    .toEqual(["key-pending"]);
  expect(readOutbox("conv").find((entry) => entry.id === "key-pending")).toMatchObject({ state: "queued" });
});

test("finding 2: a pre-existing identical user message leaves a freshly queued bubble visible", () => {
  const at = 1_000_000;
  /* The operator earlier said "yes"; it is already an echo in the transcript.
     Now they queue a NEW "yes" — its baseline records that one pre-existing
     echo, so the new bubble (and its cancel affordance) must stay visible. */
  const fresh: OutboxEntry = { id: "k1", text: "yes", images: 0, at, state: "queued", echoBaseline: 1 };
  expect(visibleOutbox([fresh], echoes(["yes", 1]), at + 1_000)).toHaveLength(1);
  /* When the new message's OWN echo lands (a second occurrence), it retires. */
  expect(visibleOutbox([fresh], echoes(["yes", 2]), at + 1_000)).toHaveLength(0);
});

test("finding 2: each later echo retires exactly one matching queued entry, oldest first", () => {
  const at = 1_000_000;
  /* Two identical messages queued back-to-back, both watermarked at 0 echoes. */
  const first: OutboxEntry = { id: "k1", text: "go", images: 0, at, state: "delivering", echoBaseline: 0 };
  const second: OutboxEntry = { id: "k2", text: "go", images: 0, at: at + 1, state: "queued", echoBaseline: 0 };
  /* No echoes yet → both bubbles visible. */
  expect(visibleOutbox([first, second], echoes(), at + 1_000).map((e) => e.id)).toEqual(["k1", "k2"]);
  /* One echo lands → exactly the oldest retires, the newer stays. */
  expect(visibleOutbox([first, second], echoes(["go", 1]), at + 1_000).map((e) => e.id)).toEqual(["k2"]);
  /* A second echo lands → the second retires too. */
  expect(visibleOutbox([first, second], echoes(["go", 2]), at + 1_000)).toHaveLength(0);
});

test("finding 2: a reloaded entry with no watermark still retires once its text is present", () => {
  const at = 1_000_000;
  /* Legacy/reloaded entry — no echoBaseline field — preserves the prior reload
     retirement: the moment its text is in the transcript it is gone. */
  const legacy: OutboxEntry = { id: "k1", text: "done", images: 0, at, state: "delivered", settledAt: at };
  expect(visibleOutbox([legacy], echoes("done"), at + 1_000)).toHaveLength(0);
});

test("finding 2: the composer watermark reads the feed-published echo count", () => {
  /* The feed publishes the transcript's user-echo counts; the composer stamps a
     new submission's baseline from them, so occurrence consumption is causal. */
  publishTranscriptEchoes("conv-wm", echoes(["ping", 2], "other"));
  expect(transcriptEchoCount("conv-wm", "ping")).toBe(2);
  expect(transcriptEchoCount("conv-wm", "  ping  ")).toBe(2); // trimmed key
  expect(transcriptEchoCount("conv-wm", "other")).toBe(1);
  expect(transcriptEchoCount("conv-wm", "absent")).toBe(0);
  expect(transcriptEchoCount("unknown-conv", "ping")).toBe(0);
});

test("issue 626: canonical echo retirement survives eviction, filters, identity adoption, refresh, and repeated text", () => {
  const launch = "spawn:launch_626";
  const conversation = "conversation_626";
  const repeated = "repeat this prompt";

  /* One historical occurrence is visible before the next identical submission.
     Its stable feed anchor becomes the new entry's occurrence baseline. */
  publishTranscriptEchoes(launch, [{ id: "row:4:0", text: repeated }]);
  enqueueOutbox(launch, {
    id: "repeat-1",
    text: repeated,
    images: 0,
    at: 1_000,
    echoBaseline: transcriptEchoCount(launch, repeated),
  });
  enqueueOutbox(launch, {
    id: "unrelated",
    text: "keep me queued",
    images: 0,
    at: 1_001,
    echoBaseline: transcriptEchoCount(launch, "keep me queued"),
  });

  /* Re-publishing the historical row after a filter toggle cannot retire the
     fresh occurrence. Its later canonical echo retires only that entry. */
  publishTranscriptEchoes(launch, [{ id: "row:4:0", text: repeated }]);
  expect(visibleOutbox(readOutbox(launch), echoes([repeated, 1]), 2_000).map((entry) => entry.id))
    .toEqual(["repeat-1", "unrelated"]);
  publishTranscriptEchoes(launch, [
    { id: "row:4:0", text: repeated },
    { id: "row:40:0", text: repeated },
  ]);
  expect(readOutbox(launch).find((entry) => entry.id === "repeat-1")).toMatchObject({
    retiredEchoId: "row:40:0",
  });

  /* The first echo leaves the capped tail, the filter temporarily hides every
     user row, and the launch adopts its canonical identity. Retirement remains
     monotonic while the unrelated queued entry stays visible. */
  publishTranscriptEchoes(launch, []);
  adoptOutbox(launch, conversation);
  resetOutboxForTests();
  expect(visibleOutbox(readOutbox(conversation), echoes(), 3_000).map((entry) => entry.id))
    .toEqual(["unrelated"]);
  expect(transcriptEchoCount(conversation, repeated)).toBe(2);
});

test("issue 626: a refresh that observes the launch echo before seeding persists retirement", () => {
  const conversation = "conversation_626_refresh";
  const text = "canonical launch prompt";
  publishTranscriptEchoes(conversation, [{ id: "row:12:0", text }]);
  seedLaunchOutbox(conversation, {
    id: "launch_626_refresh",
    text,
    images: 0,
    at: 1_000,
  });
  expect(readOutbox(conversation)[0]).toMatchObject({ retiredEchoId: "row:12:0" });

  publishTranscriptEchoes(conversation, []);
  resetOutboxForTests();
  expect(visibleOutbox(readOutbox(conversation), echoes(), 2_000)).toEqual([]);
});

test("issue 626: adopting an echo ledger immediately retires a queue already on the canonical identity", () => {
  const provisional = "spawn:launch_626_split";
  const conversation = "conversation_626_split";
  const text = "queue and transcript began on different identities";

  enqueueOutbox(conversation, {
    id: "split-identity-entry",
    text,
    images: 0,
    at: 1_000,
  });
  publishTranscriptEchoes(provisional, [{ id: "row:18:0", text }]);

  adoptOutbox(provisional, conversation);

  expect(readOutbox(conversation)[0]).toMatchObject({
    retiredEchoId: "row:18:0",
  });
  expect(visibleOutbox(readOutbox(conversation), echoes(), 2_000)).toEqual([]);
});

describe("outboxStateForReceiptStatus (P1#4)", () => {
  test("admitted-but-not-delivered stays delivering; only a delivered receipt reads delivered", () => {
    expect(outboxStateForReceiptStatus("queued")).toBe("delivering");
    expect(outboxStateForReceiptStatus("delivering")).toBe("delivering");
    expect(outboxStateForReceiptStatus("delivered")).toBe("delivered");
    expect(outboxStateForReceiptStatus("applied")).toBe("delivered");
    expect(outboxStateForReceiptStatus("rejected")).toBe("failed");
    expect(outboxStateForReceiptStatus("failed")).toBe("failed");
  });
});

describe("seedLaunchOutbox (P1#2)", () => {
  test("seeds the initial launch prompt as a launch-owned delivering bubble, idempotently", () => {
    seedLaunchOutbox("conversation_live", { id: "launch_1", text: "the launch prompt", images: 0, at: 1_000 });
    const queue = readOutbox("conversation_live");
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ id: "launch_1", text: "the launch prompt", state: "delivering", launchOwned: true });
    /* A re-seed (re-render / reload replay) is a no-op — the state is preserved. */
    updateOutbox("conversation_live", "launch_1", { state: "delivered" });
    seedLaunchOutbox("conversation_live", { id: "launch_1", text: "the launch prompt", images: 0, at: 2_000 });
    expect(readOutbox("conversation_live")[0]!.state).toBe("delivered");
  });

  test("a launch-owned bubble never dispatches and never blocks the operator's follow-up messages", () => {
    seedLaunchOutbox("conv", { id: "launch_1", text: "the launch prompt", images: 0, at: 1_000 });
    // The dispatcher ignores the launch-owned entry entirely.
    expect(nextDispatch(readOutbox("conv"))).toBeNull();
    // A follow-up the operator queues dispatches immediately, despite the
    // launch-owned bubble still being "delivering".
    submit("conv", "k2", "follow-up message");
    expect(nextDispatch(readOutbox("conv"))?.id).toBe("k2");
  });

  test("a launch-owned bubble survives a refresh unchanged (never re-queued or re-dispatched)", () => {
    seedLaunchOutbox("conv", { id: "launch_1", text: "the launch prompt", images: 0, at: 1_000 });
    resetOutboxForTests();
    const restored = readOutbox("conv");
    expect(restored[0]).toMatchObject({ state: "delivering", launchOwned: true });
    expect(nextDispatch(restored)).toBeNull();
  });

  test("the seeded launch bubble is adopted into the materialized conversation identity", () => {
    // Seeded under the launch placeholder, then the composer adopts it forward.
    seedLaunchOutbox("spawn:launch_1", { id: "launch_1", text: "the launch prompt", images: 0, at: 1_000 });
    adoptOutbox("spawn:launch_1", "conversation_live");
    expect(readOutbox("spawn:launch_1")).toHaveLength(0);
    expect(readOutbox("conversation_live")[0]).toMatchObject({ id: "launch_1", launchOwned: true });
  });

  test.each([
    ["builder", "You are a Builder in TDD mode.\n\nLLV615_RAW_PROMPT"],
    ["reviewer", "You are a Reviewer.\nSafety fences:\n- stay in scope\n\nLLV615_RAW_PROMPT"],
  ])("issue 615 HIGH2: a %s role launch displays the raw draft but retires on the canonical scaffolded echo", (_role, scaffolded) => {
    const raw = "LLV615_RAW_PROMPT";
    /* The composer seeds the RAW operator draft (no scaffold — the server adds
       it), so the bubble is user-facing. Its canonical echo identity is the
       delivered scaffolded text the transcript will actually record. */
    seedLaunchOutbox("conversation_615", { id: "launch_615", text: raw, images: 1, at: 1_000, echoText: scaffolded });
    const queue = readOutbox("conversation_615");
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ text: raw, echoText: scaffolded, launchOwned: true });

    /* Exact-text matching on the RAW draft can NEVER retire it — the transcript
       echoes the scaffolded text, not the raw draft. The bubble stays visible. */
    expect(visibleOutbox(queue, echoes(raw), 5_000).map((e) => e.id)).toEqual(["launch_615"]);
    /* The canonical scaffolded echo landing in the transcript retires it. */
    expect(visibleOutbox(queue, echoes(scaffolded), 5_000)).toEqual([]);
  });

  test("issue 615 HIGH2: identical launch id reconciliation attaches the canonical echo identity while preserving the raw draft; refresh, images and zero duplicate hold", () => {
    const raw = "LLV615_RAW_PROMPT";
    const scaffolded = "You are a Builder in TDD mode.\n\nLLV615_RAW_PROMPT";
    /* DraftAgentPane seeds first, immediately, with the RAW draft and no echo
       identity (the client never composes the scaffold). */
    seedLaunchOutbox("conversation_615", { id: "launch_615", text: raw, images: 3, at: 1_000 });
    expect(readOutbox("conversation_615")[0]).toMatchObject({ text: raw, images: 3, launchOwned: true });
    /* Exact-text matching cannot retire it yet — this is the reported bug. */
    expect(visibleOutbox(readOutbox("conversation_615"), echoes(scaffolded), 5_000).map((e) => e.id)).toEqual(["launch_615"]);

    /* The next /api/files poll carries the server-projected launch: LogFeed
       re-seeds the SAME launch id WITH the canonical echo identity. Reconciliation
       attaches it to the existing bubble — one bubble, RAW draft preserved. */
    seedLaunchOutbox("conversation_615", { id: "launch_615", text: raw, images: 3, at: 2_000, echoText: scaffolded });
    const merged = readOutbox("conversation_615");
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ text: raw, images: 3, echoText: scaffolded, launchOwned: true });

    /* A refresh rehydrates the one reconciled bubble, echo identity intact. */
    resetOutboxForTests();
    const refreshed = readOutbox("conversation_615");
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]).toMatchObject({ text: raw, images: 3, echoText: scaffolded });

    /* The live scaffolded echo retires it — zero duplicate, zero lingering. */
    expect(visibleOutbox(refreshed, echoes(scaffolded), 5_000)).toEqual([]);
  });

  test("issue 614: a server-projected seed and the composer's own seed (identical launch id and text) are ONE bubble that survives a refresh and retires on its own echo — never a duplicate", () => {
    const identical = "LLV614_CANONICAL_PROBE_20260723";
    /* The board that ran the composer seeds under the canonical identity. */
    seedLaunchOutbox("conversation_614", { id: "launch_614", text: identical, images: 0, at: 1_000 });
    /* A later /api/files poll carries the server-projected launch prompt; LogFeed
       re-seeds by the SAME launch id with the SAME text — idempotent, no second
       bubble. This is also the ONLY seed a surface that never ran the composer
       (an MCP spawn observer, a second tab) receives. */
    seedLaunchOutbox("conversation_614", { id: "launch_614", text: identical, images: 0, at: 2_000 });
    expect(readOutbox("conversation_614")).toHaveLength(1);

    /* A page refresh (fresh module state) rehydrates exactly one launch-owned
       bubble from sessionStorage — the prompt is preserved, never re-queued. */
    resetOutboxForTests();
    const refreshed = readOutbox("conversation_614");
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]).toMatchObject({ id: "launch_614", text: identical, state: "delivering", launchOwned: true });

    /* Before the transcript flush the bubble is the only representation of the
       prompt (visible). */
    expect(visibleOutbox(refreshed, echoes(), 5_000).map((entry) => entry.id)).toEqual(["launch_614"]);
    /* Transcript adoption: the flushed transcript echoes the prompt exactly once,
       which retires the launch-owned bubble — one window, zero duplicate. */
    expect(visibleOutbox(refreshed, echoes(identical), 5_000)).toEqual([]);
  });
});

test("adoption moves a queue onto the materialized conversation identity idempotently", () => {
  submit("spawn:launch", "k1", "queued into the launch window");
  /* The launch materializes into its conversation; the queue rides along. */
  adoptOutbox("spawn:launch", "conversation_live");
  expect(readOutbox("spawn:launch")).toHaveLength(0);
  expect(readOutbox("conversation_live").map((entry) => entry.id)).toEqual(["k1"]);
  /* A second adoption is a no-op — records already under the new id win. */
  adoptOutbox("spawn:launch", "conversation_live");
  expect(readOutbox("conversation_live")).toHaveLength(1);
});

test("an image-bearing entry that could not survive a refresh is held for re-attachment, not sent blind", () => {
  enqueueOutbox("conv", { id: "k1", text: "see screenshot", images: 2, at: Date.now() });
  updateOutbox("conv", "k1", { state: "delivering" });
  /* A refresh: module state is gone, only sessionStorage remains. */
  resetOutboxForTests();
  const restored = readOutbox("conv");
  expect(restored[0]!.state).toBe("failed");
  expect(restored[0]!.needsReattach).toBe(true);
  /* It is NOT re-dispatched (that would send text with no image). */
  expect(nextDispatch(restored)).toBeNull();
});

test("a text-only delivering entry returns to the queue for replay after a refresh", () => {
  submit("conv", "k1", "text only");
  updateOutbox("conv", "k1", { state: "delivering" });
  resetOutboxForTests();
  const restored = readOutbox("conv");
  expect(restored[0]!.state).toBe("queued");
  expect(nextDispatch(restored)?.id).toBe("k1");
});
