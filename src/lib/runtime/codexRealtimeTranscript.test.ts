import { expect, test } from "bun:test";

import { CodexRealtimeTranscript } from "./codexRealtimeTranscript";

/**
 * The canonical transcript reducer (#1629), over the app-server's published
 * notification shapes.
 *
 * The Viewer used to carry none of these, so the panel could show only what one
 * WebRTC data channel delivered. What is under test here is the reduction alone;
 * that it reaches a browser is proved in
 * `voiceCanonicalTranscript.dom.test.ts`, which drives the host, the projection
 * and the client together.
 */

const THREAD = "thread-1";

function transcript(): CodexRealtimeTranscript {
  const reducer = new CodexRealtimeTranscript();
  reducer.begin("rt-1");
  return reducer;
}

test("flat deltas accumulate and the done event carries the whole segment", () => {
  const reducer = transcript();
  expect(reducer.observe("thread/realtime/transcript/delta", { threadId: THREAD, role: "assistant", delta: "The build " }))
    .toMatchObject({ role: "assistant", text: "The build ", final: false });
  const grown = reducer.observe("thread/realtime/transcript/delta", { threadId: THREAD, role: "assistant", delta: "is green." });
  expect(grown).toMatchObject({ text: "The build is green.", final: false });

  const done = reducer.observe("thread/realtime/transcript/done", { threadId: THREAD, role: "assistant", text: "The build is green." });
  expect(done).toMatchObject({ text: "The build is green.", final: true });
  /* Same segment throughout, so a consumer updates one line rather than three. */
  expect(done!.id).toBe(grown!.id);
});

test("each speaker keeps its own segment, so barge-in does not merge two voices", () => {
  const reducer = transcript();
  const assistant = reducer.observe("thread/realtime/transcript/delta", { threadId: THREAD, role: "assistant", delta: "I am" });
  const user = reducer.observe("thread/realtime/transcript/delta", { threadId: THREAD, role: "user", delta: "wait" });
  expect(assistant!.id).not.toBe(user!.id);
  expect(reducer.observe("thread/realtime/transcript/delta", { threadId: THREAD, role: "assistant", delta: " looking" }))
    .toMatchObject({ text: "I am looking" });
  expect(reducer.observe("thread/realtime/transcript/delta", { threadId: THREAD, role: "user", delta: ", stop" }))
    .toMatchObject({ text: "wait, stop" });
});

test("a done event repairs what a dropped delta left out", () => {
  /* It carries the complete text by definition, so it wins over the
     accumulation rather than being appended to it. */
  const reducer = transcript();
  reducer.observe("thread/realtime/transcript/delta", { threadId: THREAD, role: "assistant", delta: "The build " });
  expect(reducer.observe("thread/realtime/transcript/done", {
    threadId: THREAD, role: "assistant", text: "The build finished with two failures.",
  })).toMatchObject({ text: "The build finished with two failures.", final: true });
});

test("a speaker's next segment is a new one, not a continuation of the last", () => {
  const reducer = transcript();
  const first = reducer.observe("thread/realtime/transcript/done", { threadId: THREAD, role: "user", text: "one" });
  const second = reducer.observe("thread/realtime/transcript/delta", { threadId: THREAD, role: "user", delta: "two" });
  expect(second!.id).not.toBe(first!.id);
  expect(second).toMatchObject({ text: "two", final: false });
});

test("a per-item stream keeps native's own item id", () => {
  /* The canonical id is what makes a redelivered or replayed segment converge on
     one line instead of stacking copies. */
  const reducer = transcript();
  const started = reducer.observe("thread/realtime/item/started", {
    threadId: THREAD, item: { id: "item-7", realtimeSessionId: "rt-1", type: "transcriptSegment", role: "assistant", text: "" },
  });
  expect(started).toMatchObject({ id: "item-7", role: "assistant", final: false });
  expect(reducer.observe("thread/realtime/item/transcript/delta", { threadId: THREAD, itemId: "item-7", delta: "half " }))
    .toMatchObject({ id: "item-7", text: "half " });
  expect(reducer.observe("thread/realtime/item/completed", {
    threadId: THREAD, item: { id: "item-7", realtimeSessionId: "rt-1", type: "transcriptSegment", role: "assistant", text: "half a sentence" },
  })).toEqual({ id: "item-7", realtimeSessionId: "rt-1", role: "assistant", text: "half a sentence", final: true });
});

test("a repeated item/started does not restart a segment already streaming", () => {
  const reducer = transcript();
  reducer.observe("thread/realtime/item/started", {
    threadId: THREAD, item: { id: "item-8", type: "transcriptSegment", role: "assistant", text: "" },
  });
  reducer.observe("thread/realtime/item/transcript/delta", { threadId: THREAD, itemId: "item-8", delta: "kept" });
  expect(reducer.observe("thread/realtime/item/started", {
    threadId: THREAD, item: { id: "item-8", type: "transcriptSegment", role: "assistant", text: "" },
  })).toBeNull();
  expect(reducer.observe("thread/realtime/item/completed", {
    threadId: THREAD, item: { id: "item-8", type: "transcriptSegment", role: "assistant", text: "kept" },
  })).toMatchObject({ text: "kept", final: true });
});

test("items that are not transcript segments are left alone", () => {
  /* `bemItemPromoted` and the session markers travel on the same notification;
     they are history, not something anybody said. */
  const reducer = transcript();
  expect(reducer.observe("thread/realtime/item/completed", {
    threadId: THREAD, item: { id: "item-9", type: "bemItemPromoted", turn_id: "turn-1", item_id: "x" },
  })).toBeNull();
  expect(reducer.observe("thread/realtime/item/completed", {
    threadId: THREAD, item: { id: "item-10", type: "realtimeSessionClosed", outcome: "ended" },
  })).toBeNull();
});

test("nothing is produced before a call begins, or after it ends", () => {
  const reducer = new CodexRealtimeTranscript();
  expect(reducer.observe("thread/realtime/transcript/delta", { threadId: THREAD, role: "user", delta: "hello" })).toBeNull();
  reducer.begin("rt-1");
  const first = reducer.observe("thread/realtime/transcript/delta", { threadId: THREAD, role: "user", delta: "hello" });
  expect(first).toMatchObject({ realtimeSessionId: "rt-1" });

  /* A new call cannot extend the last one's open segment. */
  reducer.begin("rt-2");
  const second = reducer.observe("thread/realtime/transcript/delta", { threadId: THREAD, role: "user", delta: "again" });
  expect(second).toMatchObject({ realtimeSessionId: "rt-2", text: "again" });
  expect(second!.id).not.toBe(first!.id);
});

test("a malformed or unrelated notification produces nothing", () => {
  const reducer = transcript();
  expect(reducer.observe("thread/realtime/transcript/delta", { threadId: THREAD, role: "narrator", delta: "x" })).toBeNull();
  expect(reducer.observe("thread/realtime/transcript/delta", { threadId: THREAD, role: "user" })).toBeNull();
  expect(reducer.observe("thread/realtime/started", { threadId: THREAD })).toBeNull();
  expect(reducer.observe("thread/realtime/transcript/delta", "not an object")).toBeNull();
});
