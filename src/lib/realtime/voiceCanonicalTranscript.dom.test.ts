import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { Window } from "happy-dom";
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { applyEvent, emptyStore, type RuntimeStore } from "@/components/runtime/runtimeModel";
import { VoiceConversationPanel } from "@/components/VoiceConversation";
import { translate, type TFunction } from "@/lib/i18n";
import { CodexRealtimeTranscript } from "@/lib/runtime/codexRealtimeTranscript";
import { projectEngineHostEvent } from "@/lib/runtime/engineHostEvents";
import type { RuntimeEvent } from "@/lib/runtime/engineHost";

import { codexRealtimeClient, type CodexRealtimeRole } from "./codexRealtimeClient";

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
 * 5. `VoiceConversationPanel` renders those lines, and every assertion reads
 *    what it rendered.
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
  Node: dom.Node,
  Element: dom.Element,
  HTMLElement: dom.HTMLElement,
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
/** The realtime session the next call's answer names, as the host would. */
let callSession = "realtime-1";

beforeEach(() => {
  callSession = "realtime-1";
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
    json: async () => ({ ok: true, sdp: "v=0\r\nanswer", realtimeSessionId: callSession }),
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

async function panel(session = "realtime-1") {
  const client = codexRealtimeClient(conversationId);
  await call(client, session);
  return client;
}

/** Start a call on this client, with the host beginning the same session. */
async function call(client: ReturnType<typeof codexRealtimeClient>, session: string): Promise<void> {
  callSession = session;
  reducer.begin(session);
  await client.start();
  StubPeerConnection.latest!.channel.onopen?.();
}

const t: TFunction = (key, params) => translate("en", key, params);
const ROLE_BY_LABEL = new Map<string, CodexRealtimeRole>(
  (["user", "assistant", "progress"] as const).map((role) => [
    t(role === "user" ? "voice.you" : role === "assistant" ? "voice.agent" : "voice.progress"),
    role,
  ]),
);
const mounts = new Map<Client, { host: HTMLElement; root: Root }>();

afterEach(() => {
  for (const { host, root } of mounts.values()) {
    flushSync(() => root.unmount());
    host.remove();
  }
  mounts.clear();
});

interface Shown {
  role: CodexRealtimeRole;
  text: string;
  final: boolean;
}

/**
 * What the operator reads: the client's lines rendered by the real panel.
 *
 * Read off the DOM rather than the snapshot, so a line the panel draws twice or
 * not at all fails here. A speaker's label opens each run of that speaker's
 * lines, and an unfinished line carries the caret.
 */
function shown(client: Client): Shown[] {
  let mount = mounts.get(client);
  if (!mount) {
    const host = document.createElement("div");
    document.body.append(host);
    mount = { host, root: createRoot(host) };
    mounts.set(client, mount);
  }
  const { phase, lines, error } = client.getSnapshot();
  const { root, host } = mount;
  flushSync(() => root.render(createElement(VoiceConversationPanel, { phase, lines, error, t })));
  let role: CodexRealtimeRole | null = null;
  return [...host.querySelectorAll("section [aria-live] > div")].map((row) => {
    const label = row.querySelector("span.uppercase")?.textContent;
    if (label) role = ROLE_BY_LABEL.get(label) ?? null;
    const text = row.querySelector("span.text-label")!;
    if (!role) throw new Error("the panel drew a line with no speaker");
    return { role, text: text.textContent ?? "", final: !text.querySelector("[aria-hidden]") };
  });
}

const spoken = (client: Client) => shown(client).map((line) => `${line.role}:${line.text}`);

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
  expect(shown(client)).toEqual([
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
  expect(shown(client)).toHaveLength(1);

  notified("thread/realtime/item/completed", {
    threadId: THREAD,
    item: { id: "seg-2", realtimeSessionId: "realtime-1", type: "transcriptSegment", role: "assistant", text: "The build is green." },
  });
  client.reconcileCanonicalTranscript(carried());

  expect(shown(client)).toEqual([
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
  expect(shown(client)).toHaveLength(1);
  await client.stop();
});

test("barge-in keeps the two speakers on their own lines", async () => {
  const client = await panel();
  notified("thread/realtime/transcript/delta", { threadId: THREAD, role: "assistant", delta: "I am looking at" });
  notified("thread/realtime/transcript/delta", { threadId: THREAD, role: "user", delta: "no, stop" });
  notified("thread/realtime/transcript/done", { threadId: THREAD, role: "user", text: "no, stop" });
  client.reconcileCanonicalTranscript(carried());

  expect(spoken(client)).toEqual([
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

  expect(spoken(client)).toEqual([
    "user:read that one",
    "assistant:Reading.",
  ]);
  await client.stop();
});

/* ------------------------------------------------------------------------ *
 * ONE LINE PER SPOKEN TURN (#1658).
 *
 * A live call rendered the same sentence three times — the data-channel caption,
 * a line for native's item, and a line for native's flat mirror of that item —
 * and the two speakers' overlapping words left the caption in fragments with the
 * whole sentence repeated underneath. What follows replays captured calls
 * through every production link above, and reads what the panel shows.
 * ------------------------------------------------------------------------ */

interface Recorded {
  source: "data-channel" | "app-server";
  call?: string;
  method?: string;
  params?: Record<string, unknown>;
  event?: Record<string, unknown>;
}

function recorded(file: string): Recorded[] {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Recorded);
}

/** Recorded in a live call: both speakers talking over each other, word by word. */
const DUPLEX_CALL = recorded(path.join(import.meta.dir, "fixtures/voice-duplex-call.jsonl"));
/** Native 0.154.0's own notifications for known provider events. */
const NATIVE_WIRE = recorded(path.join(import.meta.dir, "../runtime/fixtures/codex-realtime-transcript-v0.154.0.jsonl"));

type Client = ReturnType<typeof codexRealtimeClient>;

function channel(event: Record<string, unknown>): void {
  StubPeerConnection.latest!.channel.onmessage?.({ data: JSON.stringify(event) });
}

/** One notification reaching the store, and the composer's effect handing the
    store's tail to the client, as `useCodexRealtime` does on every change. */
function canonical(client: Client, method: string, params: Record<string, unknown>): void {
  notified(method, params);
  client.reconcileCanonicalTranscript(carried());
}

function replay(client: Client, records: readonly Recorded[]): void {
  for (const record of records) {
    if (record.source === "data-channel") channel(record.event!);
    else canonical(client, record.method!, record.params!);
  }
}

const DUPLEX_TURNS: Shown[] = [
  { role: "user", text: " Please repeat the read-only", final: true },
  { role: "assistant", text: " I'm the dedicated Voice regression", final: true },
  { role: "user", text: " status check from our setup using the tool again now Tell me your role in this", final: true },
  { role: "assistant", text: " QA orchestrator, Checking it now.", final: true },
  { role: "user", text: " conversation Do not change anything or launch any agents", final: true },
  { role: "assistant", text: " One sec. Still looking.", final: true },
  /* Still being spoken when the recording stopped. */
  { role: "assistant", text: " Let me check that again.", final: false },
];

test("the recorded duplex call shows each spoken turn once", async () => {
  const client = await panel("call-live");
  replay(client, DUPLEX_CALL);
  expect(shown(client)).toEqual(DUPLEX_TURNS);
  await client.stop();
});

test("the recorded call reads the same when the committed transcript lands in one batch", async () => {
  /* The store coalesces, and the effect can run once for many notifications. */
  const client = await panel("call-live");
  for (const record of DUPLEX_CALL) if (record.source === "data-channel") channel(record.event!);
  for (const record of DUPLEX_CALL) if (record.source === "app-server") notified(record.method!, record.params!);
  client.reconcileCanonicalTranscript(carried());
  expect(shown(client)).toEqual(DUPLEX_TURNS);
  await client.stop();
});

test("the recorded call reads the same when the committed transcript arrives first", async () => {
  const client = await panel("call-live");
  for (const record of DUPLEX_CALL) if (record.source === "app-server") canonical(client, record.method!, record.params!);
  for (const record of DUPLEX_CALL) if (record.source === "data-channel") channel(record.event!);
  expect(shown(client)).toEqual(DUPLEX_TURNS);
  await client.stop();
});

const NATIVE_TURNS: Shown[] = [
  { role: "user", text: " Please repeat the read-only", final: true },
  { role: "assistant", text: " I'm the dedicated Voice regression", final: true },
  { role: "user", text: " status check from our", final: true },
  { role: "assistant", text: " QA orchestrator,", final: true },
  { role: "user", text: " yes", final: true },
  { role: "assistant", text: " ok", final: true },
  { role: "user", text: " yes", final: true },
  { role: "assistant", text: " Unstreamed answer.", final: true },
  { role: "assistant", text: " Hello big world", final: true },
  { role: "assistant", text: " Resumed", final: true },
  { role: "user", text: " wait", final: true },
];

const sources = (call: string, source: Recorded["source"]) =>
  NATIVE_WIRE.filter((record) => record.call === call && record.source === source);

for (const order of ["caption", "canonical"] as const) {
  test(`native's own events show each turn once when the ${order} arrives first`, async () => {
    /* Both sources carry the SAME provider events here, so this is the claim
       the join rests on: the two describe one turn order. The same words said
       twice are two turns and stay two lines. */
    const client = await panel("call-one");
    const captions = sources("call-one", "data-channel");
    const committed = sources("call-one", "app-server");
    replay(client, order === "caption" ? [...captions, ...committed] : [...committed, ...captions]);
    expect(shown(client)).toEqual(NATIVE_TURNS);
    await client.stop();
  });
}

test("a new call starts its own turn order and leaves the last call's lines alone", async () => {
  const client = await panel("call-one");
  replay(client, [...sources("call-one", "data-channel"), ...sources("call-one", "app-server")]);
  await client.stop();

  /* The store still carries the first call's segments into the second, and the
     second's committed transcript arrives before its captions. */
  await call(client, "call-two");
  replay(client, [...sources("call-two", "app-server"), ...sources("call-two", "data-channel")]);
  /* A segment the first call's backend commits late belongs to the first call. */
  const late = new CodexRealtimeTranscript();
  late.begin("call-one");
  const stray = late.observe("thread/realtime/item/completed", {
    threadId: THREAD,
    item: { id: "segment-late", realtimeSessionId: "call-one", type: "transcriptSegment", role: "user", text: " late words" },
  })!;
  store = applied({
    seq: ++hostSequence,
    ...projectEngineHostEvent(conversationId, `codex:${THREAD}`, {
      kind: "voice-transcript",
      realtimeSessionId: stray.realtimeSessionId,
      segmentId: stray.id,
      role: stray.role,
      text: stray.text,
      final: stray.final,
      seq: hostSequence,
    })!,
    recordedAt: new Date().toISOString(),
  });
  client.reconcileCanonicalTranscript(carried());

  expect(shown(client)).toEqual([
    ...NATIVE_TURNS,
    { role: "user", text: " second call", final: true },
    { role: "assistant", text: " reply", final: true },
  ]);
  await client.stop();
});

test("an empty canonical segment takes no line ahead of the caption with its words", async () => {
  const client = await panel();
  channel({ type: "input_transcript.added", item: { id: "chunk-a", type: "input_transcript", text: " Please" } });
  /* What an empty `item/started` looked like to the client before the host
     stopped publishing it. */
  client.reconcileCanonicalTranscript([
    { segmentId: "segment-empty", realtimeSessionId: "realtime-1", role: "user", text: "", final: false },
  ]);
  expect(shown(client)).toEqual([{ role: "user", text: " Please", final: false }]);

  client.reconcileCanonicalTranscript([
    { segmentId: "segment-empty", realtimeSessionId: "realtime-1", role: "user", text: " Please repeat", final: false },
  ]);
  channel({ type: "input_transcript.added", item: { id: "chunk-b", type: "input_transcript", text: " repeat that" } });
  expect(shown(client)).toEqual([{ role: "user", text: " Please repeat that", final: false }]);
  await client.stop();
});

for (const first of ["caption", "canonical"] as const) {
  test(`whichever source finishes the turn first, the other finishes the same line (${first} first)`, async () => {
    const client = await panel();
    channel({ type: "output_transcript.added", item: { id: "chunk-1", type: "output_transcript", text: "The build" } });
    canonical(client, "thread/realtime/item/started", {
      threadId: THREAD, item: { id: "segment-done", realtimeSessionId: "realtime-1", type: "transcriptSegment", role: "assistant", text: "" },
    });
    canonical(client, "thread/realtime/item/transcript/delta", { threadId: THREAD, itemId: "segment-done", delta: "The build" });
    const captionDone = () => channel({ type: "turn.done", turn: { id: "turn-1", role: "assistant", transcript: "The build is green." } });
    const canonicalDone = () => {
      canonical(client, "thread/realtime/item/completed", {
        threadId: THREAD,
        item: { id: "segment-done", realtimeSessionId: "realtime-1", type: "transcriptSegment", role: "assistant", text: "The build" },
      });
      canonical(client, "thread/realtime/transcript/done", { threadId: THREAD, role: "assistant", text: "The build is green." });
    };
    if (first === "caption") {
      captionDone();
      expect(shown(client)).toEqual([{ role: "assistant", text: "The build is green.", final: true }]);
      canonicalDone();
    } else {
      canonicalDone();
      expect(shown(client)).toEqual([{ role: "assistant", text: "The build is green.", final: true }]);
      captionDone();
    }
    expect(shown(client)).toEqual([{ role: "assistant", text: "The build is green.", final: true }]);
    await client.stop();
  });
}

test("a replayed fragment and a replayed canonical tail change nothing", async () => {
  const client = await panel();
  channel({ type: "input_transcript.added", item: { id: "chunk-w", type: "input_transcript", text: " can" } });
  const fragment = { type: "input_transcript.added", item: { id: "chunk-x", type: "input_transcript", text: " you check" } };
  channel(fragment);
  channel(fragment);
  expect(shown(client)).toEqual([{ role: "user", text: " can you check", final: false }]);

  const completed = {
    threadId: THREAD,
    item: { id: "segment-x", realtimeSessionId: "realtime-1", type: "transcriptSegment", role: "user", text: " can you check" },
  };
  canonical(client, "thread/realtime/item/completed", completed);
  canonical(client, "thread/realtime/item/completed", completed);
  client.reconcileCanonicalTranscript(carried());
  client.reconcileCanonicalTranscript(carried());
  expect(shown(client)).toEqual([{ role: "user", text: " can you check", final: true }]);
  await client.stop();
});

test("the committed transcript two turns behind still lands on the right lines", async () => {
  /* Two identical answers, then a different one, all captioned before any of
     them is committed. Words would pair the first commit with the wrong "yes". */
  const client = await panel();
  for (const [index, text] of [" yes", " yes", " no"].entries()) {
    channel({ type: "output_transcript.added", item: { id: `chunk-${index}`, type: "output_transcript", text } });
    channel({ type: "turn.done", turn: { id: `turn-${index}`, role: "assistant", transcript: text } });
  }
  expect(shown(client).map((line) => line.text)).toEqual([" yes", " yes", " no"]);
  for (const [index, text] of [" yes", " yes", " no"].entries()) {
    canonical(client, "thread/realtime/item/completed", {
      threadId: THREAD,
      item: { id: `segment-${index}`, realtimeSessionId: "realtime-1", type: "transcriptSegment", role: "assistant", text },
    });
  }
  expect(shown(client)).toEqual([
    { role: "assistant", text: " yes", final: true },
    { role: "assistant", text: " yes", final: true },
    { role: "assistant", text: " no", final: true },
  ]);
  await client.stop();
});

test("both speakers talking at once keep one line each", async () => {
  const client = await panel();
  const words: [string, string][] = [
    ["input", " can"], ["output", " Sure,"], ["input", " you"], ["output", " one"], ["input", " check"], ["output", " moment."],
  ];
  for (const [index, [kind, text]] of words.entries()) {
    channel({ type: `${kind}_transcript.added`, item: { id: `chunk-${index}`, type: `${kind}_transcript`, text } });
  }
  expect(shown(client)).toEqual([
    { role: "user", text: " can you check", final: false },
    { role: "assistant", text: " Sure, one moment.", final: false },
  ]);
  channel({ type: "turn.done", turn: { id: "turn-u", role: "user", transcript: " can you check" } });
  channel({ type: "output_transcript.added", item: { id: "chunk-late", type: "output_transcript", text: " Looking" } });
  channel({ type: "turn.done", turn: { id: "turn-a", role: "assistant", transcript: " Sure, one moment. Looking" } });
  expect(shown(client)).toEqual([
    { role: "user", text: " can you check", final: true },
    { role: "assistant", text: " Sure, one moment. Looking", final: true },
  ]);
  await client.stop();
});

/* ------------------------------------------------------------------------ *
 * A TURN ONE SOURCE MISSED (#1658).
 *
 * The two sources share no identifier, only the order a speaker takes turns in
 * and the provider's own fragments and final text. Pairing the k-th caption with
 * the k-th segment shifted every later turn onto its neighbour's line as soon as
 * either source missed one: the earlier answer was overwritten and the later one
 * shown twice.
 * ------------------------------------------------------------------------ */

function completedSegment(client: Client, id: string, role: "user" | "assistant", text: string): void {
  canonical(client, "thread/realtime/item/started", {
    threadId: THREAD, item: { id, realtimeSessionId: "realtime-1", type: "transcriptSegment", role, text: "" },
  });
  canonical(client, "thread/realtime/item/transcript/delta", { threadId: THREAD, itemId: id, delta: text });
  canonical(client, "thread/realtime/item/completed", {
    threadId: THREAD, item: { id, realtimeSessionId: "realtime-1", type: "transcriptSegment", role, text },
  });
  canonical(client, "thread/realtime/transcript/done", { threadId: THREAD, role, text });
}

for (const first of ["caption", "canonical"] as const) {
  test(`a turn the data channel never captioned keeps its line, and the next turn pairs with its own (${first} first)`, async () => {
    const client = await panel();
    completedSegment(client, "segment-first", "assistant", " First answer.");
    const caption = () => {
      channel({ type: "output_transcript.added", item: { id: "chunk-second", type: "output_transcript", text: " Second answer." } });
      channel({ type: "turn.done", turn: { id: "turn-second", role: "assistant", transcript: " Second answer." } });
    };
    if (first === "caption") caption();
    completedSegment(client, "segment-second", "assistant", " Second answer.");
    if (first === "canonical") caption();
    expect(spoken(client)).toEqual(["assistant: First answer.", "assistant: Second answer."]);
    await client.stop();
  });
}

/** The recorded native events with one of `call-one`'s turns taken out of one source. */
function withoutTurn(source: Recorded["source"], matches: (record: Recorded) => boolean): Recorded[] {
  return NATIVE_WIRE.filter((record) => record.call === "call-one" && !(record.source === source && matches(record)));
}

const captionOf = (chunks: string[], turn: string) => (record: Recorded) => {
  const event = record.event as { item?: { id?: string }; turn?: { id?: string } };
  return chunks.includes(event.item?.id ?? "") || event.turn?.id === turn;
};

test("native's events with one assistant turn never captioned still show every turn once", async () => {
  const records = withoutTurn("data-channel", captionOf(["chunk-003", "chunk-005", "chunk-006"], "bidi-a1"));
  const committedFirst = await panel("call-one");
  replay(committedFirst, [...records.filter((r) => r.source === "app-server"), ...records.filter((r) => r.source === "data-channel")]);
  expect(shown(committedFirst)).toEqual(NATIVE_TURNS);
  await committedFirst.stop();

  const captionFirst = codexRealtimeClient(`${conversationId}-caption-first`);
  await call(captionFirst, "call-one");
  for (const record of records.filter((r) => r.source === "data-channel")) channel(record.event!);
  reducer.begin("call-one");
  for (const record of records.filter((r) => r.source === "app-server")) notified(record.method!, record.params!);
  captionFirst.reconcileCanonicalTranscript(carried());
  /* Each turn once. The uncaptioned one arrives after everything the channel
     said, and takes its place ahead of the next answer the channel did caption. */
  expect(shown(captionFirst)).toEqual([
    NATIVE_TURNS[0]!, NATIVE_TURNS[2]!, NATIVE_TURNS[1]!, ...NATIVE_TURNS.slice(3),
  ]);
  await captionFirst.stop();
});

test("the recorded duplex call with one answer never captioned still shows every turn once", async () => {
  const records = DUPLEX_CALL.filter((record) => {
    const event = record.event as { type?: string; item?: { text?: string }; turn?: { id?: string } } | undefined;
    if (record.source !== "data-channel") return true;
    if (event?.turn?.id === "turn-02") return false;
    return !(event?.type === "output_transcript.added"
      && [" I'm the", " dedicated", " Voice", " regression"].includes(event.item?.text ?? ""));
  });
  const client = await panel("call-live");
  replay(client, records);
  expect(shown(client)).toEqual(DUPLEX_TURNS);
  await client.stop();
});

test("the recorded duplex call with one answer never committed still shows every turn once", async () => {
  const records = DUPLEX_CALL.filter((record) => {
    const params = record.params as { itemId?: string; item?: { id?: string }; role?: string; text?: string; delta?: string } | undefined;
    if (record.source !== "app-server") return true;
    if (params?.itemId === "segment-02" || params?.item?.id === "segment-02") return false;
    /* Its flat mirror goes with it. */
    return !(params?.role === "assistant"
      && [" I'm the", " dedicated", " Voice", " regression", " I'm the dedicated Voice regression"]
        .includes(params.delta ?? params.text ?? ""));
  });
  const client = await panel("call-live");
  replay(client, records);
  expect(shown(client)).toEqual(DUPLEX_TURNS);
  await client.stop();
});

for (const missing of ["caption", "canonical"] as const) {
  test(`a missed turn that opens with the same words is not given the next turn's line (${missing} missed)`, async () => {
    /* The first fragment alone cannot tell these two turns apart; what follows
       it can, and the pairing follows the evidence as it arrives. */
    const client = await panel();
    const said = [
      { turn: "turn-a", chunks: [" Okay", "."], done: " Okay." },
      { turn: "turn-b", chunks: [" Okay", ", go."], done: " Okay, go." },
    ];
    for (const [index, { turn, chunks, done }] of said.entries()) {
      if (missing === "canonical" || index > 0) {
        for (const [part, text] of chunks.entries()) {
          channel({ type: "output_transcript.added", item: { id: `${turn}-${part}`, type: "output_transcript", text } });
        }
        channel({ type: "turn.done", turn: { id: turn, role: "assistant", transcript: done } });
      }
      if (missing === "caption" || index > 0) {
        const id = `segment-${turn}`;
        canonical(client, "thread/realtime/item/started", {
          threadId: THREAD, item: { id, realtimeSessionId: "realtime-1", type: "transcriptSegment", role: "assistant", text: "" },
        });
        for (const text of chunks) canonical(client, "thread/realtime/item/transcript/delta", { threadId: THREAD, itemId: id, delta: text });
        canonical(client, "thread/realtime/item/completed", {
          threadId: THREAD, item: { id, realtimeSessionId: "realtime-1", type: "transcriptSegment", role: "assistant", text: done },
        });
        canonical(client, "thread/realtime/transcript/done", { threadId: THREAD, role: "assistant", text: done });
      }
    }
    expect(shown(client)).toEqual([
      { role: "assistant", text: " Okay.", final: true },
      { role: "assistant", text: " Okay, go.", final: true },
    ]);
    await client.stop();
  });
}

for (const first of ["caption", "canonical"] as const) {
  test(`an empty caption done does not hold back the committed repair of a word never streamed (${first} first)`, async () => {
    const client = await panel();
    const caption = () => {
      channel({ type: "output_transcript.added", item: { id: "chunk-hello", type: "output_transcript", text: " Hello" } });
      channel({ type: "output_transcript.added", item: { id: "chunk-world", type: "output_transcript", text: " world" } });
      channel({ type: "turn.done", turn: { id: "turn-hello", role: "assistant", transcript: "" } });
    };
    const committed = () => {
      canonical(client, "thread/realtime/item/started", {
        threadId: THREAD, item: { id: "segment-hello", realtimeSessionId: "realtime-1", type: "transcriptSegment", role: "assistant", text: "" },
      });
      canonical(client, "thread/realtime/item/transcript/delta", { threadId: THREAD, itemId: "segment-hello", delta: " Hello" });
      canonical(client, "thread/realtime/item/transcript/delta", { threadId: THREAD, itemId: "segment-hello", delta: " world" });
      canonical(client, "thread/realtime/item/completed", {
        threadId: THREAD, item: { id: "segment-hello", realtimeSessionId: "realtime-1", type: "transcriptSegment", role: "assistant", text: " Hello world" },
      });
      canonical(client, "thread/realtime/transcript/done", { threadId: THREAD, role: "assistant", text: " Hello big world" });
    };
    if (first === "caption") { caption(); committed(); } else { committed(); caption(); }
    expect(shown(client)).toEqual([{ role: "assistant", text: " Hello big world", final: true }]);
    await client.stop();
  });
}

test("a completion its mirrored done has not repaired yet never takes the caption's final words away", async () => {
  const client = await panel();
  const seen: string[] = [];
  const unsubscribe = client.subscribe(() => seen.push(shown(client).map((line) => line.text).join(" | ")));
  channel({ type: "output_transcript.added", item: { id: "chunk-hello", type: "output_transcript", text: " Hello" } });
  channel({ type: "output_transcript.added", item: { id: "chunk-world", type: "output_transcript", text: " world" } });
  channel({ type: "turn.done", turn: { id: "turn-hello", role: "assistant", transcript: " Hello big world" } });
  const repaired = seen.length;
  completedSegment(client, "segment-hello", "assistant", " Hello world");
  canonical(client, "thread/realtime/transcript/done", { threadId: THREAD, role: "assistant", text: " Hello big world" });
  unsubscribe();
  expect(seen.slice(repaired - 1).every((line) => line === " Hello big world")).toBe(true);
  expect(shown(client)).toEqual([{ role: "assistant", text: " Hello big world", final: true }]);
  await client.stop();
});

test("a fragment or done delivered again after its turn ended changes nothing, and the same words said again are a new turn", async () => {
  const client = await panel();
  const fragment = { type: "input_transcript.added", item: { id: "chunk-yes", type: "input_transcript", text: " yes" } };
  const done = { type: "turn.done", turn: { id: "turn-yes", role: "user", transcript: " yes" } };
  channel(fragment);
  channel(done);
  completedSegment(client, "segment-yes", "user", " yes");
  channel(fragment);
  channel(done);
  expect(spoken(client)).toEqual(["user: yes"]);

  channel({ type: "input_transcript.added", item: { id: "chunk-yes-again", type: "input_transcript", text: " yes" } });
  channel({ type: "turn.done", turn: { id: "turn-yes-again", role: "user", transcript: " yes" } });
  completedSegment(client, "segment-yes-again", "user", " yes");
  channel(fragment);
  expect(spoken(client)).toEqual(["user: yes", "user: yes"]);
  await client.stop();
});

/* ------------------------------------------------------------------------ *
 * A DONE DELIVERED AGAIN, A REPAIR OF THE OPENING WORDS, A WORD SAID TWICE.
 *
 * A turn id names the turn its `turn.done` closed, so the same done delivered
 * again is that finished turn, never the one streaming now. A repair may rewrite
 * how a turn began, and the caption whose done had no words is still that turn.
 * A fragment with its own id is one delta, whatever words it repeats.
 * ------------------------------------------------------------------------ */

test("an earlier turn's done delivered again neither ends the turn streaming now nor adds a line", async () => {
  const client = await panel();
  const firstDone = { type: "turn.done", turn: { id: "turn-first", role: "assistant", transcript: " First answer." } };
  channel({ type: "output_transcript.added", item: { id: "chunk-first", type: "output_transcript", text: " First answer." } });
  channel(firstDone);
  completedSegment(client, "segment-first", "assistant", " First answer.");

  channel({ type: "output_transcript.added", item: { id: "chunk-second", type: "output_transcript", text: " Second" } });
  channel(firstDone);
  channel({ type: "output_transcript.added", item: { id: "chunk-second-more", type: "output_transcript", text: " answer." } });
  expect(shown(client)).toEqual([
    { role: "assistant", text: " First answer.", final: true },
    { role: "assistant", text: " Second answer.", final: false },
  ]);

  channel({ type: "turn.done", turn: { id: "turn-second", role: "assistant", transcript: " Second answer." } });
  completedSegment(client, "segment-second", "assistant", " Second answer.");
  channel(firstDone);
  expect(shown(client)).toEqual([
    { role: "assistant", text: " First answer.", final: true },
    { role: "assistant", text: " Second answer.", final: true },
  ]);
  await client.stop();
});

for (const order of ["caption", "canonical"] as const) {
  test(`native's events with an answer's done delivered again mid-turn and after the call still show every turn once (${order} first)`, async () => {
    const captions = sources("call-one", "data-channel");
    const again = captions.find((record) => (record.event as { turn?: { id?: string } }).turn?.id === "bidi-a1")!;
    /* Redelivered while " Interrupted" is still being said, and once more at the end. */
    const streaming = captions.findIndex((record) => (record.event as { item?: { id?: string } }).item?.id === "chunk-017");
    const redelivered = [...captions.slice(0, streaming + 1), again, ...captions.slice(streaming + 1), again];
    const committed = sources("call-one", "app-server");
    const client = await panel("call-one");
    replay(client, order === "caption" ? [...redelivered, ...committed] : [...committed, ...redelivered]);
    expect(shown(client)).toEqual(NATIVE_TURNS);
    await client.stop();
  });
}

for (const first of ["caption", "canonical"] as const) {
  for (const delivery of ["event by event", "in one batch"] as const) {
    test(`a repair that rewrote the opening words stays the captioned turn's one line (${first} first, ${delivery})`, async () => {
      const client = await panel();
      const caption = () => {
        channel({ type: "output_transcript.added", item: { id: "chunk-their", type: "output_transcript", text: " Their answer" } });
        channel({ type: "turn.done", turn: { id: "turn-their", role: "assistant", transcript: "" } });
      };
      const committed = () => {
        const deliver = delivery === "event by event"
          ? (method: string, params: Record<string, unknown>) => canonical(client, method, params)
          : notified;
        deliver("thread/realtime/item/started", {
          threadId: THREAD, item: { id: "segment-their", realtimeSessionId: "realtime-1", type: "transcriptSegment", role: "assistant", text: "" },
        });
        deliver("thread/realtime/item/transcript/delta", { threadId: THREAD, itemId: "segment-their", delta: " Their answer" });
        deliver("thread/realtime/item/completed", {
          threadId: THREAD, item: { id: "segment-their", realtimeSessionId: "realtime-1", type: "transcriptSegment", role: "assistant", text: " Their answer" },
        });
        deliver("thread/realtime/transcript/done", { threadId: THREAD, role: "assistant", text: " The answer." });
        client.reconcileCanonicalTranscript(carried());
      };
      if (first === "caption") { caption(); committed(); } else { committed(); caption(); }
      expect(shown(client)).toEqual([{ role: "assistant", text: " The answer.", final: true }]);
      await client.stop();
    });
  }
}

test("a repair that rewrote the opening words does not join a different turn missed by the other source", async () => {
  /* The caption's done kept its words, and they are not the repair's. The
     segment no caption is takes its place ahead of the caption turn. */
  const client = await panel();
  channel({ type: "output_transcript.added", item: { id: "chunk-their", type: "output_transcript", text: " Their answer" } });
  channel({ type: "turn.done", turn: { id: "turn-their", role: "assistant", transcript: " Their answer" } });
  for (const [method, params] of [
    ["thread/realtime/item/completed", {
      threadId: THREAD, item: { id: "segment-other", realtimeSessionId: "realtime-1", type: "transcriptSegment", role: "assistant", text: " Other answer" },
    }],
    ["thread/realtime/transcript/done", { threadId: THREAD, role: "assistant", text: " The answer." }],
  ] as const) notified(method, params);
  client.reconcileCanonicalTranscript(carried());
  expect(spoken(client)).toEqual(["assistant: The answer.", "assistant: Their answer"]);
  await client.stop();
});

test("a word said twice in a row keeps both, one fragment each", async () => {
  const client = await panel();
  for (const [index, text] of [" very", " very", " good"].entries()) {
    channel({ type: "output_transcript.added", item: { id: `chunk-word-${index}`, type: "output_transcript", text } });
  }
  expect(shown(client)).toEqual([{ role: "assistant", text: " very very good", final: false }]);
  channel({ type: "output_transcript.added", item: { id: "chunk-word-1", type: "output_transcript", text: " very" } });
  channel({ type: "turn.done", turn: { id: "turn-very", role: "assistant", transcript: "" } });
  completedSegment(client, "segment-very", "assistant", " very very good");
  expect(shown(client)).toEqual([{ role: "assistant", text: " very very good", final: true }]);
  await client.stop();
});
