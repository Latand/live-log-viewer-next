import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { CodexRealtimeTranscript, type CanonicalVoiceSegment } from "./codexRealtimeTranscript";

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
  /* Native opens every segment empty. Nothing is published until it has words:
     an empty segment used to take a line before the caption with those words
     could be joined to it (#1658). */
  expect(reducer.observe("thread/realtime/item/started", {
    threadId: THREAD, item: { id: "item-7", realtimeSessionId: "rt-1", type: "transcriptSegment", role: "assistant", text: "" },
  })).toBeNull();
  expect(reducer.observe("thread/realtime/item/transcript/delta", { threadId: THREAD, itemId: "item-7", delta: "half " }))
    .toMatchObject({ id: "item-7", role: "assistant", text: "half ", final: false });
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

/**
 * NATIVE'S OWN WIRE (#1658). Captured from the installed app-server 0.154.0
 * driven by a credential-free loopback realtime fixture: the `data-channel`
 * records are the provider events the fixture sent, the `app-server` records
 * the notifications native published for them. Identifiers are invented; the
 * order and the texts are native's.
 *
 * What it established: every segment is published on BOTH families, each
 * per-item event followed at once by its flat mirror, and each speaker's
 * segment stays open until that speaker's `turn.done` — both speakers at once
 * in a duplex exchange.
 */
interface FixtureRecord {
  source: "data-channel" | "app-server";
  call: string;
  method?: string;
  params?: Record<string, unknown>;
  event?: Record<string, unknown>;
}

function nativeFixture(): FixtureRecord[] {
  return fs.readFileSync(path.join(import.meta.dir, "fixtures/codex-realtime-transcript-v0.154.0.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FixtureRecord);
}

function replayNative(call: string): CanonicalVoiceSegment[] {
  const reducer = new CodexRealtimeTranscript();
  reducer.begin(call);
  const published: CanonicalVoiceSegment[] = [];
  for (const record of nativeFixture()) {
    if (record.source !== "app-server" || record.call !== call) continue;
    const segment = reducer.observe(record.method!, record.params);
    if (segment) published.push(segment);
  }
  return published;
}

/** The last state of each segment, in the order each was first published. */
function settled(published: readonly CanonicalVoiceSegment[]): CanonicalVoiceSegment[] {
  const last = new Map<string, CanonicalVoiceSegment>();
  for (const segment of published) last.set(segment.id, segment);
  return [...last.values()];
}

test("native's two mirrored families reduce to one segment per spoken turn", () => {
  const published = replayNative("call-one");
  const itemIds = new Set(nativeFixture()
    .filter((record) => record.call === "call-one" && record.method === "thread/realtime/item/started")
    .map((record) => (record.params!.item as { id: string }).id));
  /* Every segment is native's own item: the flat mirror minted none of its own,
     which is what used to put each sentence on the panel a second time. */
  expect(published.every((segment) => itemIds.has(segment.id))).toBe(true);
  expect(published.every((segment) => segment.text.length > 0)).toBe(true);
  expect(settled(published).map(({ role, text, final }) => ({ role, text, final }))).toEqual([
    { role: "user", text: " Please repeat the read-only", final: true },
    { role: "assistant", text: " I'm the dedicated Voice regression", final: true },
    { role: "user", text: " status check from our", final: true },
    { role: "assistant", text: " QA orchestrator,", final: true },
    /* The same words twice are two turns, and stay two segments. */
    { role: "user", text: " yes", final: true },
    { role: "assistant", text: " ok", final: true },
    { role: "user", text: " yes", final: true },
    { role: "assistant", text: " Unstreamed answer.", final: true },
    /* The provider streamed " Hello", " world" and finished " Hello big world".
       Native's completion carries only what streamed; the mirrored done repairs it. */
    { role: "assistant", text: " Hello big world", final: true },
    { role: "assistant", text: " Resumed", final: true },
    { role: "user", text: " wait", final: true },
  ]);
});

test("a new call's native segments are its own", () => {
  const published = settled(replayNative("call-two"));
  expect(published.map(({ realtimeSessionId, role, text }) => ({ realtimeSessionId, role, text }))).toEqual([
    { realtimeSessionId: "call-two", role: "user", text: " second call" },
    { realtimeSessionId: "call-two", role: "assistant", text: " reply" },
  ]);
});

test("the mirrored done repairs a completion, and an empty one keeps the words", () => {
  const reducer = transcript();
  const item = (id: string, text: string) => ({ id, realtimeSessionId: "rt-1", type: "transcriptSegment", role: "assistant", text });
  reducer.observe("thread/realtime/item/started", { threadId: THREAD, item: item("seg-a", "") });
  reducer.observe("thread/realtime/item/transcript/delta", { threadId: THREAD, itemId: "seg-a", delta: "Hello world" });
  expect(reducer.observe("thread/realtime/item/completed", { threadId: THREAD, item: item("seg-a", "Hello world") }))
    .toMatchObject({ id: "seg-a", text: "Hello world", final: true });
  expect(reducer.observe("thread/realtime/transcript/done", { threadId: THREAD, role: "assistant", text: "Hello big world" }))
    .toEqual({ id: "seg-a", realtimeSessionId: "rt-1", role: "assistant", text: "Hello big world", final: true });

  reducer.observe("thread/realtime/item/started", { threadId: THREAD, item: item("seg-b", "") });
  reducer.observe("thread/realtime/item/transcript/delta", { threadId: THREAD, itemId: "seg-b", delta: "alpha" });
  reducer.observe("thread/realtime/item/completed", { threadId: THREAD, item: item("seg-b", "alpha") });
  /* Nothing to repair and nothing new to say: the mirror publishes nothing. */
  expect(reducer.observe("thread/realtime/transcript/done", { threadId: THREAD, role: "assistant", text: "" })).toBeNull();
  expect(reducer.observe("thread/realtime/transcript/done", { threadId: THREAD, role: "assistant", text: "alpha" })).toBeNull();
});

test("a flat mirror that arrives first is adopted by the item it mirrors", () => {
  /* The other source order. The item takes over the id already published, so
     the utterance keeps one segment, and its line never shrinks while the item
     catches up with what the mirror already said. */
  const reducer = transcript();
  const first = reducer.observe("thread/realtime/transcript/delta", { threadId: THREAD, role: "user", delta: "look at" });
  expect(first).toMatchObject({ role: "user", text: "look at", final: false });
  const item = (text: string) => ({ id: "seg-c", realtimeSessionId: "rt-1", type: "transcriptSegment", role: "user", text });
  const started = reducer.observe("thread/realtime/item/started", { threadId: THREAD, item: item("") });
  expect(started).toMatchObject({ id: first!.id, text: "look at" });
  expect(reducer.observe("thread/realtime/item/transcript/delta", { threadId: THREAD, itemId: "seg-c", delta: "look at" }))
    .toMatchObject({ id: first!.id, text: "look at" });
  expect(reducer.observe("thread/realtime/transcript/delta", { threadId: THREAD, role: "user", delta: " that" })).toBeNull();
  expect(reducer.observe("thread/realtime/item/transcript/delta", { threadId: THREAD, itemId: "seg-c", delta: " that" }))
    .toMatchObject({ id: first!.id, text: "look at that" });
  expect(reducer.observe("thread/realtime/item/completed", { threadId: THREAD, item: item("look at that") }))
    .toMatchObject({ id: first!.id, text: "look at that", final: true });
  expect(reducer.observe("thread/realtime/transcript/done", { threadId: THREAD, role: "user", text: "look at that" })).toBeNull();
});

test("a replayed completion republishes the same segment, never a second one", () => {
  const reducer = transcript();
  const item = { id: "seg-d", realtimeSessionId: "rt-1", type: "transcriptSegment", role: "assistant", text: "Once." };
  const first = reducer.observe("thread/realtime/item/completed", { threadId: THREAD, item });
  expect(reducer.observe("thread/realtime/item/completed", { threadId: THREAD, item })).toEqual(first);
  expect(reducer.observe("thread/realtime/item/transcript/delta", { threadId: THREAD, itemId: "seg-d", delta: " again" })).toBeNull();
});

test("an item that streams before it is named waits for its speaker", () => {
  /* Guessing a speaker would draw the words on the wrong side of the panel. */
  const reducer = transcript();
  expect(reducer.observe("thread/realtime/item/transcript/delta", { threadId: THREAD, itemId: "seg-e", delta: "early " })).toBeNull();
  expect(reducer.observe("thread/realtime/item/started", {
    threadId: THREAD, item: { id: "seg-e", realtimeSessionId: "rt-1", type: "transcriptSegment", role: "user", text: "" },
  })).toMatchObject({ id: "seg-e", role: "user", text: "early ", final: false });
});

test("a completion after the call ended keeps native's id", () => {
  /* Native publishes the last open segment's completion after the stop reply. */
  const reducer = transcript();
  reducer.observe("thread/realtime/item/started", {
    threadId: THREAD, item: { id: "seg-f", realtimeSessionId: "rt-1", type: "transcriptSegment", role: "assistant", text: "" },
  });
  reducer.observe("thread/realtime/item/transcript/delta", { threadId: THREAD, itemId: "seg-f", delta: "last words" });
  reducer.end();
  expect(reducer.observe("thread/realtime/item/completed", {
    threadId: THREAD, item: { id: "seg-f", realtimeSessionId: "rt-1", type: "transcriptSegment", role: "assistant", text: "last words" },
  })).toEqual({ id: "seg-f", realtimeSessionId: "rt-1", role: "assistant", text: "last words", final: true });
});
