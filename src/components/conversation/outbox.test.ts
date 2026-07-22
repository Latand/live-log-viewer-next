import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

import {
  adoptOutbox,
  cancelOutbox,
  enqueueOutbox,
  nextDispatch,
  outboxHistory,
  OUTBOX_DELIVERED_TTL_MS,
  OUTBOX_MTIME_GRACE_MS,
  readOutbox,
  resetOutboxForTests,
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

test("a delivered bubble retires once the transcript grows past it", () => {
  const at = 1_000_000;
  const entry: OutboxEntry = { id: "k1", text: "done", images: 0, at, state: "delivered", settledAt: at };
  /* Transcript mtime still behind the delivery → the optimistic bubble stays. */
  expect(visibleOutbox([entry], at - 5_000, at + 1_000)).toHaveLength(1);
  /* Transcript grew past the grace window → the real bubble owns it now. */
  expect(visibleOutbox([entry], at + OUTBOX_MTIME_GRACE_MS + 1, at + 3_000)).toHaveLength(0);
  /* A conversation whose transcript never grows still retires by the TTL. */
  expect(visibleOutbox([entry], 0, at + OUTBOX_DELIVERED_TTL_MS + 1)).toHaveLength(0);
});

test("a queued or delivering entry is always visible regardless of transcript mtime", () => {
  const queued: OutboxEntry = { id: "k1", text: "waiting", images: 0, at: 1_000, state: "queued" };
  expect(visibleOutbox([queued], 9_999_999, 9_999_999)).toHaveLength(1);
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
