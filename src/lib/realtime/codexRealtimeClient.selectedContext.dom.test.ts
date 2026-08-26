import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

import { viewBus } from "@/hooks/viewPresenceBus";
import type { SelectedContextRef } from "@/lib/selection/selectedContext";

import { codexRealtimeClient } from "./codexRealtimeClient";

/**
 * The browser end of #844 §2/§4.
 *
 * The operator's speech never reaches our server — it rides the WebRTC leg
 * straight to the model — so the browser is the only place that can pair a
 * spoken turn with the card the operator had selected. It does that at exactly
 * two moments: it binds the call to this window when the call opens, and it
 * reports the reference when its own transcript goes FINAL. Anything else (a
 * streaming fragment, the agent talking) must publish nothing at all.
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
  close(): void {
    this.readyState = "closed";
  }
}

class StubPeerConnection {
  static latest: StubPeerConnection | null = null;
  iceGatheringState = "complete";
  connectionState = "connected";
  localDescription: { sdp: string } | null = null;
  channel = new StubDataChannel();
  ontrack: ((event: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor() {
    StubPeerConnection.latest = this;
  }
  createDataChannel(): StubDataChannel {
    return this.channel;
  }
  addTrack(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  async createOffer(): Promise<{ sdp: string }> {
    return { sdp: "v=0\r\noffer" };
  }
  async setLocalDescription(offer: { sdp: string }): Promise<void> {
    this.localDescription = offer;
  }
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

interface ControlRequest {
  action?: string;
  view?: { viewSessionId: string; deviceId: string };
  realtimeSessionId?: string;
  selectedContext?: SelectedContextRef;
  operatorEventId?: string;
}

let requests: ControlRequest[] = [];

const PATH = "fixtures/projects/atlas/worker-a.jsonl";

beforeEach(() => {
  requests = [];
  dom.localStorage.clear();
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as ControlRequest);
    return { ok: true, status: 200, json: async () => ({ ok: true, sdp: "v=0\r\nanswer", realtimeSessionId: "live-1" }) } as unknown as Response;
  }) as typeof fetch;
  viewBus.reportIdentity({ viewSessionId: "vs-synthetic-1", deviceId: "dev-synthetic-1" });
  viewBus.reportCards([{ path: PATH, conversationId: "conversation_atlas_a", project: "atlas", label: "Worker A" }]);
  viewBus.reportSlice({ mode: "list", focusedPath: PATH, selectedPaths: [PATH], visiblePaths: [], camera: null });
});

afterEach(() => {
  viewBus.reportIdentity(null);
  viewBus.reportCards([]);
  viewBus.reportSlice({ mode: "list", focusedPath: null, selectedPaths: [], visiblePaths: [], camera: null });
});

async function liveCall(conversationId: string): Promise<StubPeerConnection> {
  const client = codexRealtimeClient(conversationId);
  await client.start();
  const peer = StubPeerConnection.latest!;
  peer.channel.onopen?.();
  return peer;
}

/* The real wire shapes: a streaming fragment is `*_transcript.added`, and the
   turn closes with one `turn.done` carrying the role it belonged to. */
const fragment = (peer: StubPeerConnection, role: "user" | "assistant", text: string) =>
  peer.channel.onmessage?.({
    data: JSON.stringify({ type: role === "user" ? "input_transcript.added" : "output_transcript.added", item: { text } }),
  });
const finished = (peer: StubPeerConnection, role: "user" | "assistant", text: string) =>
  peer.channel.onmessage?.({ data: JSON.stringify({ type: "turn.done", role, item: { text } }) });

test("the call binds itself to this window when it opens", async () => {
  await liveCall("conversation_voice_bind");
  expect(requests[0]).toMatchObject({
    action: "start",
    view: { viewSessionId: "vs-synthetic-1", deviceId: "dev-synthetic-1" },
  });
});

test("a finished utterance reports the selected card against the call's own credential", async () => {
  const peer = await liveCall("conversation_voice_utterance");
  finished(peer, "user", "look at that one");
  await Promise.resolve();

  const operatorActivity = requests.filter((request) => request.action === "operatorActivity");
  expect(operatorActivity).toHaveLength(1);
  expect(operatorActivity[0]!.realtimeSessionId).toBe("live-1");
  expect(operatorActivity[0]!.operatorEventId).toMatch(/^[a-f0-9]{64}$/);
  const selectedContext = requests.filter((request) => request.action === "selectedContext");
  expect(selectedContext).toHaveLength(1);
  expect(selectedContext[0]!.selectedContext).toMatchObject({
    version: 1,
    state: "selected",
    conversationId: "conversation_atlas_a",
    viewSessionId: "vs-synthetic-1",
    deviceId: "dev-synthetic-1",
  });
});

test("operator activity retries network and server failures with one stable event identity", async () => {
  let firstOperatorEventId: string | null = null;
  const attemptsByEventId = new Map<string, number>();
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as ControlRequest;
    requests.push(request);
    if (request.action === "operatorActivity") {
      const operatorEventId = request.operatorEventId!;
      firstOperatorEventId ??= operatorEventId;
      const attempt = (attemptsByEventId.get(operatorEventId) ?? 0) + 1;
      attemptsByEventId.set(operatorEventId, attempt);
      if (attempt === 1 && operatorEventId === firstOperatorEventId) throw new Error("offline");
      if (attempt === 1) {
        return { ok: false, status: 503, json: async () => ({ error: "temporarily unavailable" }) } as Response;
      }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, sdp: "v=0\r\nanswer", realtimeSessionId: "live-1" }) } as unknown as Response;
  }) as typeof fetch;
  const peer = await liveCall("conversation_voice_retry");

  finished(peer, "user", "record after a network failure");
  for (let microtask = 0; microtask < 8; microtask += 1) await Promise.resolve();
  finished(peer, "user", "record after a server failure");
  for (let microtask = 0; microtask < 8; microtask += 1) await Promise.resolve();

  const published = requests.filter((request) => request.action === "operatorActivity");
  expect(published).toHaveLength(4);
  expect(published[0]!.operatorEventId).toBe(published[1]!.operatorEventId);
  expect(published[2]!.operatorEventId).toBe(published[3]!.operatorEventId);
  expect(published[0]!.operatorEventId).not.toBe(published[2]!.operatorEventId);
  expect(dom.localStorage.length).toBe(0);
});

test("a live call reports operator activity without browser storage", async () => {
  const peer = await liveCall("conversation_voice_storage_restricted");
  const originalSetItem = dom.localStorage.setItem.bind(dom.localStorage);
  dom.localStorage.setItem = () => {
    throw new Error("storage is restricted");
  };
  try {
    finished(peer, "user", "record this direct activity");
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
  } finally {
    dom.localStorage.setItem = originalSetItem;
  }

  const published = requests.filter((request) => request.action === "operatorActivity");
  expect(published).toHaveLength(1);
  expect(published[0]!.operatorEventId).toMatch(/^[a-f0-9]{64}$/);
});

test("streaming fragments and the agent's own speech publish nothing", async () => {
  const peer = await liveCall("conversation_voice_quiet");
  fragment(peer, "user", "look at");
  fragment(peer, "assistant", "The build is");
  finished(peer, "assistant", "The build is green.");
  await Promise.resolve();

  expect(requests.filter((request) => request.action === "selectedContext" || request.action === "operatorActivity")).toHaveLength(0);
});

test("each finished utterance reports again, so a mid-call re-selection is honoured", async () => {
  const peer = await liveCall("conversation_voice_two");
  finished(peer, "user", "look at that one");
  viewBus.reportSlice({ mode: "list", focusedPath: null, selectedPaths: [], visiblePaths: [], camera: null });
  finished(peer, "user", "never mind, general status");
  for (let index = 0; index < 4; index += 1) await Promise.resolve();

  const published = requests.filter((request) => request.action === "selectedContext");
  expect(published).toHaveLength(2);
  expect(published[0]!.selectedContext).toMatchObject({ state: "selected" });
  expect(published[1]!.selectedContext).toMatchObject({ state: "none" });
  expect(requests.filter((request) => request.action === "operatorActivity")).toHaveLength(2);
});
