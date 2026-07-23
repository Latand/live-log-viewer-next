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
  readOutbox,
  resetOutboxForTests,
  seedLaunchOutbox,
  updateOutbox,
  visibleOutbox,
  type OutboxEntry,
} from "./outbox";

const dom = new Window();
Object.assign(globalThis, { window: dom, sessionStorage: dom.sessionStorage });

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
  expect(visibleOutbox([entry], new Set(["a reply from an earlier turn"]), at + 3_000)).toHaveLength(1);
  /* This bubble's OWN text lands in the transcript → it retires. */
  expect(visibleOutbox([entry], new Set(["my message"]), at + 3_000)).toHaveLength(0);
  /* Trimming is applied so whitespace differences still match the echo. */
  expect(visibleOutbox([{ ...entry, text: "  my message  " }], new Set(["my message"]), at + 3_000)).toHaveLength(0);
});

test("a delivered bubble whose echo never arrives still retires at the hard TTL", () => {
  const at = 1_000_000;
  const entry: OutboxEntry = { id: "k1", text: "done", images: 0, at, state: "delivered", settledAt: at };
  expect(visibleOutbox([entry], new Set<string>(), at + 3_000)).toHaveLength(1);
  expect(visibleOutbox([entry], new Set<string>(), at + OUTBOX_DELIVERED_TTL_MS + 1)).toHaveLength(0);
});

test("queued / delivering / launch-owned bubbles stay until their echo lands, never by TTL", () => {
  const queued: OutboxEntry = { id: "k1", text: "waiting", images: 0, at: 1_000, state: "queued" };
  const delivering: OutboxEntry = { id: "k2", text: "in flight", images: 0, at: 1_000, state: "delivering" };
  const launch: OutboxEntry = { id: "k3", text: "the launch prompt", images: 0, at: 1_000, state: "delivering", launchOwned: true };
  const far = 1_000 + OUTBOX_DELIVERED_TTL_MS * 10;
  expect(visibleOutbox([queued, delivering, launch], new Set<string>(), far)).toHaveLength(3);
  /* Each retires only on its own echo. */
  expect(visibleOutbox([queued, delivering, launch], new Set(["the launch prompt"]), far).map((e) => e.id)).toEqual(["k1", "k2"]);
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
