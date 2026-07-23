import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";

import {
  adoptOutbox,
  cancelOutbox,
  enqueueOutbox,
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
