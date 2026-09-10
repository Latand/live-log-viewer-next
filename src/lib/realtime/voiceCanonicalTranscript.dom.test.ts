import { afterAll, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

import { applyEvent, emptyStore, type RuntimeStore } from "@/components/runtime/runtimeModel";
import { CodexRealtimeTranscript } from "@/lib/runtime/codexRealtimeTranscript";
import { projectEngineHostEvent } from "@/lib/runtime/engineHostEvents";
import type { RuntimeEvent } from "@/lib/runtime/engineHost";

import { codexRealtimeClient } from "./codexRealtimeClient";

/**
 * The canonical transcript's whole path to the panel (#1629).
 *
 * The review's standing objection to the component branch was that a parser test
 * proves nothing about delivery, and it was right: the app-server's own
 * `thread/realtime/*` notifications were parsed nowhere and carried nowhere, so
 * a call whose WebRTC data channel dropped showed the operator an empty panel
 * while the backend went on committing transcript.
 *
 * Every link here is the production module:
 *
 * 1. `CodexRealtimeTranscript` reduces the real notification shapes,
 * 2. `projectEngineHostEvent` turns the host event into the runtime envelope
 *    that actually crosses the bus,
 * 3. `applyRuntimeEvent` folds it into the browser's session store,
 * 4. the real `CodexRealtimeClient` merges what the store carries into its lines.
 *
 * The one seam is the socket between 2 and 3, which is the same transport every
 * other runtime event uses and is covered by the runtime bus's own suite. The
 * host's own emission of step 1's output is pinned in
 * `codexAppServerHost.test.ts`.
 */

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  Audio: dom.Audio,
  MediaStream: dom.MediaStream ?? class {},
});

class StubDataChannel {
  readyState = "open";
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  send(): void {}
  close(): void { this.readyState = "closed"; }
}

class StubPeerConnection {
  static latest: StubPeerConnection | null = null;
  iceGatheringState = "complete";
  connectionState = "connected";
  localDescription: { sdp: string } | null = null;
  channel = new StubDataChannel();
  ontrack: ((event: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor() { StubPeerConnection.latest = this; }
  createDataChannel(): StubDataChannel { return this.channel; }
  addTrack(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  async createOffer(): Promise<{ sdp: string }> { return { sdp: "v=0\r\noffer\r\n" }; }
  async setLocalDescription(offer: { sdp: string }): Promise<void> { this.localDescription = offer; }
  async setRemoteDescription(): Promise<void> {}
  close(): void {}
}

const originalFetch = globalThis.fetch;
const originalRtc = (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
const originalNavigator = globalThis.navigator;

Object.assign(globalThis, {
  RTCPeerConnection: StubPeerConnection,
  navigator: {
    mediaDevices: {
      getUserMedia: async () => ({
        getAudioTracks: () => [{ stop() {} }],
        getTracks: () => [{ stop() {} }],
      }),
    },
  },
});

afterAll(() => {
  Object.assign(globalThis, { fetch: originalFetch, RTCPeerConnection: originalRtc, navigator: originalNavigator });
});

const THREAD = "voice-thread";
let conversationSequence = 0;
let conversationId = "";
let store: RuntimeStore;
let reducer: CodexRealtimeTranscript;
let hostSequence = 0;

beforeEach(() => {
  conversationSequence += 1;
  conversationId = `conversation_canonical_${conversationSequence}`;
  hostSequence = 0;
  store = emptyStore();
  reducer = new CodexRealtimeTranscript();
  reducer.begin("realtime-1");
  /* The session the projection folds into has to exist first, exactly as the
     host's own status projection creates it. */
  store = applied({
    seq: ++hostSequence,
    scope: { type: "session", id: conversationId },
    kind: "session-status",
    payload: {
      conversationId,
      sessionKey: { engine: "codex", sessionId: THREAD },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      accountId: null,
      parentConversationId: null,
      cwd: null,
      artifactPath: null,
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: null,
    },
    recordedAt: new Date().toISOString(),
  });
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, sdp: "v=0\r\nanswer", realtimeSessionId: "realtime-1" }),
  })) as unknown as typeof fetch;
});

/** One app-server notification, carried all the way to the browser's store. */
function notified(method: string, params: Record<string, unknown>): void {
  const segment = reducer.observe(method, params);
  if (!segment) return;
  const event: RuntimeEvent = {
    kind: "voice-transcript",
    realtimeSessionId: segment.realtimeSessionId,
    segmentId: segment.id,
    role: segment.role,
    text: segment.text,
    final: segment.final,
    seq: ++hostSequence,
  };
  const projected = projectEngineHostEvent(conversationId, `codex:${THREAD}`, event);
  if (!projected) throw new Error("the host event did not project onto the runtime bus");
  store = applied({
    seq: ++hostSequence,
    scope: projected.scope,
    kind: projected.kind,
    payload: projected.payload,
    recordedAt: new Date().toISOString(),
  });
}

/** Apply one envelope to the store, refusing anything the reducer rejected —
    a silently dropped event would make every assertion below meaningless. */
function applied(envelope: Record<string, unknown>): RuntimeStore {
  const result = applyEvent(store, {
    schemaVersion: 1,
    eventId: `event-${envelope.seq}`,
    ...envelope,
  } as never);
  if (result.outcome !== "applied") throw new Error(`the runtime bus rejected the event: ${result.outcome}`);
  return result.store;
}

/** What the browser's session projection now carries for this conversation. */
const carried = () => store.sessions[conversationId]?.voiceTranscript ?? [];

async function panel() {
  const client = codexRealtimeClient(conversationId);
  await client.start();
  StubPeerConnection.latest!.channel.onopen?.();
  return client;
}

test("a call whose data channel says nothing still shows what the backend committed", async () => {
  /* The failure this closes. Nothing arrives on the data channel at all, and the
     panel used to stay empty for the whole call. */
  const client = await panel();
  notified("thread/realtime/transcript/delta", { threadId: THREAD, role: "user", delta: "look at that card" });
  notified("thread/realtime/transcript/done", { threadId: THREAD, role: "user", text: "look at that card" });
  notified("thread/realtime/item/completed", {
    threadId: THREAD,
    item: { id: "seg-1", realtimeSessionId: "realtime-1", type: "transcriptSegment", role: "assistant", text: "Reading it now." },
  });

  client.reconcileCanonicalTranscript(carried());
  expect(client.getSnapshot().lines.map((line) => ({ role: line.role, text: line.text, final: line.final }))).toEqual([
    { role: "user", text: "look at that card", final: true },
    { role: "assistant", text: "Reading it now.", final: true },
  ]);
  await client.stop();
});

test("the same sentence from both sources is one line, not two", async () => {
  /* OUTPUT DEDUPLICATION. The data channel streams it first and the app-server
     commits it after; the operator must see one line whose text ends up being
     the committed one. */
  const client = await panel();
  const peer = StubPeerConnection.latest!;
  peer.channel.onmessage?.({
    data: JSON.stringify({ type: "output_transcript.added", item: { text: "The build " } }),
  });
  peer.channel.onmessage?.({
    data: JSON.stringify({ type: "output_transcript.added", item: { text: "is gre" } }),
  });
  expect(client.getSnapshot().lines).toHaveLength(1);

  notified("thread/realtime/item/completed", {
    threadId: THREAD,
    item: { id: "seg-2", realtimeSessionId: "realtime-1", type: "transcriptSegment", role: "assistant", text: "The build is green." },
  });
  client.reconcileCanonicalTranscript(carried());

  expect(client.getSnapshot().lines.map((line) => ({ role: line.role, text: line.text, final: line.final }))).toEqual([
    { role: "assistant", text: "The build is green.", final: true },
  ]);
  await client.stop();
});

test("a redelivered segment updates its own line rather than repeating it", async () => {
  /* A reconnect replays what the store already carries, and the store itself
     folds a repeat in place. Neither may produce a second copy in the panel. */
  const client = await panel();
  notified("thread/realtime/item/completed", {
    threadId: THREAD,
    item: { id: "seg-3", realtimeSessionId: "realtime-1", type: "transcriptSegment", role: "assistant", text: "Once." },
  });
  client.reconcileCanonicalTranscript(carried());
  notified("thread/realtime/item/completed", {
    threadId: THREAD,
    item: { id: "seg-3", realtimeSessionId: "realtime-1", type: "transcriptSegment", role: "assistant", text: "Once." },
  });
  client.reconcileCanonicalTranscript(carried());
  client.reconcileCanonicalTranscript(carried());

  expect(carried()).toHaveLength(1);
  expect(client.getSnapshot().lines).toHaveLength(1);
  await client.stop();
});

test("barge-in keeps the two speakers on their own lines", async () => {
  const client = await panel();
  notified("thread/realtime/transcript/delta", { threadId: THREAD, role: "assistant", delta: "I am looking at" });
  notified("thread/realtime/transcript/delta", { threadId: THREAD, role: "user", delta: "no, stop" });
  notified("thread/realtime/transcript/done", { threadId: THREAD, role: "user", text: "no, stop" });
  client.reconcileCanonicalTranscript(carried());

  expect(client.getSnapshot().lines.map((line) => `${line.role}:${line.text}`)).toEqual([
    "assistant:I am looking at",
    "user:no, stop",
  ]);
  await client.stop();
});

test("a segment the panel never saw is appended, and one it did is adopted", async () => {
  const client = await panel();
  const peer = StubPeerConnection.latest!;
  peer.channel.onmessage?.({
    data: JSON.stringify({ type: "turn.done", role: "user", item: { text: "read that one" } }),
  });
  notified("thread/realtime/transcript/done", { threadId: THREAD, role: "user", text: "read that one" });
  notified("thread/realtime/item/completed", {
    threadId: THREAD,
    item: { id: "seg-4", realtimeSessionId: "realtime-1", type: "transcriptSegment", role: "assistant", text: "Reading." },
  });
  client.reconcileCanonicalTranscript(carried());

  expect(client.getSnapshot().lines.map((line) => `${line.role}:${line.text}`)).toEqual([
    "user:read that one",
    "assistant:Reading.",
  ]);
  await client.stop();
});
