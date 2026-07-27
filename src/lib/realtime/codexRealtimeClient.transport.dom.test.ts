import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";

import { codexRealtimeClient } from "./codexRealtimeClient";

const dom = new Window();
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  Audio: dom.Audio,
  MediaStream: dom.MediaStream ?? class {},
});

class StubDataChannel {
  readyState = "open";
  sent: string[] = [];
  sendAttempts = 0;
  /** One send attempt to reject, standing in for a transport that drops
      mid-response; a rejected chunk is never recorded as delivered. */
  failOnAttempt: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  send(payload: string): void {
    this.sendAttempts += 1;
    if (this.sendAttempts === this.failOnAttempt) {
      throw new Error("data channel send failed");
    }
    this.sent.push(payload);
  }
  close(): void {
    this.readyState = "closed";
  }
}

class StubPeerConnection {
  static latest: StubPeerConnection | null = null;
  iceGatheringState = "complete";
  connectionState = "connected";
  localDescription: { sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
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
  async setRemoteDescription(answer: { type: string; sdp: string }): Promise<void> {
    this.remoteDescription = answer;
  }
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
  Object.assign(globalThis, {
    fetch: originalFetch,
    RTCPeerConnection: originalRtc,
    navigator: originalNavigator,
  });
});

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

test("a rejected admission surfaces the backend error and leaves restart available", async () => {
  const requests: { action: unknown }[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { action: unknown };
    requests.push(body);
    return jsonResponse(409, { error: "AVAS 404" });
  }) as typeof fetch;

  const client = codexRealtimeClient("conversation_admission_denied");
  await client.start();

  expect(requests).toEqual([{ action: "start", conversationId: "conversation_admission_denied", sdp: "v=0\r\noffer" } as never]);
  expect(client.getSnapshot().phase).toBe("error");
  expect(client.getSnapshot().error).toBe("AVAS 404");

  // The error phase keeps start available; a second attempt reconnects.
  globalThis.fetch = (async () => jsonResponse(200, { ok: true, sdp: "v=0\r\nanswer" })) as unknown as typeof fetch;
  await client.start();
  expect(client.getSnapshot().phase).toBe("connecting");
  StubPeerConnection.latest?.channel.onopen?.();
  expect(client.getSnapshot().phase).toBe("live");
  await client.stop();
});

test("barge-in mid-answer interleaves transcripts, keeps the mic live, and never reconfigures server VAD", async () => {
  globalThis.fetch = (async () => jsonResponse(200, { ok: true, sdp: "v=0\r\nanswer" })) as unknown as typeof fetch;
  let stoppedTracks = 0;
  const mediaDevices = (globalThis.navigator as unknown as { mediaDevices: { getUserMedia: unknown } }).mediaDevices;
  const originalGetUserMedia = mediaDevices.getUserMedia;
  const track = { stop: () => { stoppedTracks += 1; } };
  mediaDevices.getUserMedia = async () => ({
    getAudioTracks: () => [track],
    getTracks: () => [track],
  });
  try {
    const client = codexRealtimeClient("conversation_barge_in");
    await client.start();
    const peer = StubPeerConnection.latest!;
    peer.channel.onopen?.();
    expect(client.getSnapshot().phase).toBe("live");

    // The agent is mid-answer when server VAD detects operator speech: the
    // truncated agent line stays visible, the operator turn opens a new line,
    // and the post-interruption answer never glues onto the abandoned one.
    peer.channel.onmessage?.({ data: JSON.stringify({ type: "output_transcript.added", item: { text: "The build is" } }) });
    peer.channel.onmessage?.({ data: JSON.stringify({ type: "input_transcript.added", item: { text: "Stop — check the tests instead" } }) });
    peer.channel.onmessage?.({ data: JSON.stringify({ type: "output_transcript.added", item: { text: "Checking the tests" } }) });
    peer.channel.onmessage?.({ data: JSON.stringify({ type: "turn.done", turn: { role: "assistant", transcript: "Checking the tests now" } }) });
    expect(client.getSnapshot().lines.map((line) => [line.role, line.text, line.final])).toEqual([
      ["assistant", "The build is", false],
      ["user", "Stop — check the tests instead", false],
      ["assistant", "Checking the tests now", true],
    ]);

    // Barge-in works only while the mic stays on the wire: no track stops
    // before hangup, and the client sends nothing that could override the
    // server-side VAD/turn-detection config.
    expect(stoppedTracks).toBe(0);
    expect(peer.channel.sent).toEqual([]);
    expect(client.getSnapshot().phase).toBe("live");

    await client.stop();
    expect(client.getSnapshot().phase).toBe("idle");
    expect(stoppedTracks).toBe(1);
  } finally {
    mediaDevices.getUserMedia = originalGetUserMedia;
  }
});

test("a data channel lost before opening surfaces the error state instead of connecting forever", async () => {
  globalThis.fetch = (async () => jsonResponse(200, { ok: true, sdp: "v=0\r\nanswer" })) as unknown as typeof fetch;
  const client = codexRealtimeClient("conversation_channel_lost");
  await client.start();
  expect(client.getSnapshot().phase).toBe("connecting");

  StubPeerConnection.latest?.channel.onclose?.();
  expect(client.getSnapshot().phase).toBe("error");
  expect(client.getSnapshot().error).toBe("Realtime connection closed");
});

test("a live call keeps worker progress local and sends one completed response to voice", async () => {
  globalThis.fetch = (async () => jsonResponse(200, { ok: true, sdp: "v=0\r\nanswer" })) as unknown as typeof fetch;

  const client = codexRealtimeClient("conversation_live_call");
  await client.start();
  const peer = StubPeerConnection.latest!;
  expect(peer.remoteDescription).toEqual({ type: "answer", sdp: "v=0\r\nanswer" });

  peer.channel.onopen?.();
  expect(client.getSnapshot().phase).toBe("live");

  // Wire events observed on the real oai-events channel (probe 2026-07-24).
  peer.channel.onmessage?.({ data: JSON.stringify({ type: "input_transcript.added", item: { text: "Inspect the board" } }) });
  peer.channel.onmessage?.({ data: JSON.stringify({ type: "output_transcript.added", item: { text: "On it" } }) });
  peer.channel.onmessage?.({ data: JSON.stringify({ type: "turn.done", turn: { role: "assistant", transcript: "On it — three agents are active" } }) });
  const lines = client.getSnapshot().lines;
  expect(lines.map((line) => [line.role, line.text, line.final])).toEqual([
    ["user", "Inspect the board", false],
    ["assistant", "On it — three agents are active", true],
  ]);

  // Delegation: accumulated progress remains local while the worker runs.
  peer.channel.onmessage?.({ data: JSON.stringify({ type: "delegation.created", item: { id: "delegation-9" } }) });
  let produced = "";
  for (let step = 0; step < 40; step += 1) {
    produced += segment(step, 300);
    client.queueWorkerProgress("turn-live-call", produced);
  }
  expect(client.getSnapshot().lines.at(-1)).toMatchObject({
    role: "progress",
    text: produced.slice(-12_000),
    final: false,
  });

  client.finishWorkerProgress("turn-live-call", produced);
  // A repeated completion render describes the same worker response.
  client.finishWorkerProgress("turn-live-call", produced);
  // A replay can surface the completed turn's progress before completion again.
  client.queueWorkerProgress("turn-live-call", produced);
  client.finishWorkerProgress("turn-live-call", produced);

  const events = peer.channel.sent.map((payload) => JSON.parse(payload) as {
    type: string;
    delegation_item_id: string;
    channel: string;
    content: { text: string }[];
  });
  expect(events.every((event) => event.type === "delegation.context.append" && event.delegation_item_id === "delegation-9")).toBe(true);
  expect(events.filter((event) => event.channel === "commentary")).toEqual([]);
  expect(sentOn(peer.channel, "speakable")).toBe(`Agent Final Message:\n\n${produced.slice(-12_000)}`);

  const progress = client.getSnapshot().lines.filter((line) => line.role === "progress");
  expect(progress).toHaveLength(1);
  expect(progress[0]).toMatchObject({ text: produced.slice(-12_000), final: true });

  await client.stop();
  expect(client.getSnapshot().phase).toBe("idle");
});

test("issue 664: a call cut down mid-flight reports the backend's reason, not the transport symptom", async () => {
  /* The 9-second backend cutoff reached the operator as "Realtime connection
     was interrupted", which reads as a viewer bug. The reason lives on the
     app-server's sideband channel, so the client asks for it and shows it. */
  const actions: unknown[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { action?: string };
    actions.push(body.action);
    return body.action === "status"
      ? jsonResponse(200, { ok: true, failure: { message: "You have reached your usage limit.", at: "t", realtimeSessionId: "rtc_1" } })
      : jsonResponse(200, { ok: true, sdp: "v=0\r\nanswer" });
  }) as unknown as typeof fetch;

  const client = codexRealtimeClient("conversation_cutoff");
  await client.start();
  StubPeerConnection.latest?.channel.onopen?.();
  expect(client.getSnapshot().phase).toBe("live");

  const peer = StubPeerConnection.latest!;
  peer.connectionState = "failed";
  peer.onconnectionstatechange?.();
  // The transport reason shows immediately, so the pane never sits silent.
  expect(client.getSnapshot().error).toBe("Realtime connection was interrupted");

  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(client.getSnapshot().error).toBe("You have reached your usage limit.");
  expect(client.getSnapshot().phase).toBe("error");
  expect(actions).toContain("status");
});

test("issue 664: the transport reason stands when the host has no failure to report", async () => {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { action?: string };
    return body.action === "status"
      ? jsonResponse(200, { ok: true, failure: null })
      : jsonResponse(200, { ok: true, sdp: "v=0\r\nanswer" });
  }) as unknown as typeof fetch;

  const client = codexRealtimeClient("conversation_no_reason");
  await client.start();
  StubPeerConnection.latest?.channel.onopen?.();
  const peer = StubPeerConnection.latest!;
  peer.connectionState = "failed";
  peer.onconnectionstatechange?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(client.getSnapshot().error).toBe("Realtime connection was interrupted");
});

/** Every character the client actually put on one channel, in wire order. */
function sentOn(channel: StubDataChannel, name: "commentary" | "speakable", from = 0): string {
  return channel.sent
    .slice(from)
    .map((payload) => JSON.parse(payload) as { channel: string; content: { text: string }[] })
    .filter((event) => event.channel === name)
    .map((event) => event.content.map((part) => part.text).join(""))
    .join("");
}

/** Varied filler of an exact length, so no accidental prefix coincidences make
    a duplicate look like new content. */
function segment(step: number, size: number): string {
  return `«${step}» ${"worker progress — reading agents ".repeat(size)}`.slice(0, size);
}

async function liveCall(conversationId: string, delegationId: string) {
  globalThis.fetch = (async () => jsonResponse(200, { ok: true, sdp: "v=0\r\nanswer" })) as unknown as typeof fetch;
  const client = codexRealtimeClient(conversationId);
  await client.start();
  const peer = StubPeerConnection.latest!;
  peer.channel.onopen?.();
  peer.channel.onmessage?.({ data: JSON.stringify({ type: "delegation.created", item: { id: delegationId } }) });
  return { client, channel: peer.channel };
}

test("a rejected completed response waits for the data channel and is delivered exactly once", async () => {
  const { client, channel } = await liveCall("conversation_progress_retry", "delegation-retry");
  const completed = segment(1, 1_200);
  client.queueWorkerProgress("turn-retry", completed);

  channel.failOnAttempt = 2;
  client.finishWorkerProgress("turn-retry", completed);
  client.finishWorkerProgress("turn-retry", completed);
  const expected = `Agent Final Message:\n\n${completed}`;
  const acceptedPrefix = sentOn(channel, "speakable");
  expect(acceptedPrefix.length).toBeGreaterThan(0);
  expect(expected.startsWith(acceptedPrefix)).toBe(true);

  channel.onopen?.();
  channel.onopen?.();
  expect(sentOn(channel, "speakable")).toBe(expected);

  await client.stop();
});

test("a completed response survives replacement of a failed realtime transport", async () => {
  const { client, channel } = await liveCall("conversation_progress_reconnect", "delegation-old");
  const completed = "Response retained across transport replacement";

  channel.readyState = "closed";
  client.queueWorkerProgress("turn-reconnect", completed);
  client.finishWorkerProgress("turn-reconnect", completed);

  const failedPeer = StubPeerConnection.latest!;
  failedPeer.connectionState = "failed";
  failedPeer.onconnectionstatechange?.();
  expect(client.getSnapshot().phase).toBe("error");

  await client.start();
  const replacement = StubPeerConnection.latest!;
  replacement.channel.onopen?.();
  replacement.channel.onmessage?.({
    data: JSON.stringify({ type: "delegation.created", item: { id: "delegation-new" } }),
  });
  replacement.channel.onmessage?.({
    data: JSON.stringify({ type: "delegation.created", item: { id: "delegation-new" } }),
  });

  expect(sentOn(replacement.channel, "speakable")).toBe(`Agent Final Message:\n\n${completed}`);
  await client.stop();
});

test("completed responses queue in order while the data channel is unavailable", async () => {
  const { client, channel } = await liveCall("conversation_progress_queue", "delegation-queue");
  const first = "First completed worker response";
  const second = "Second completed worker response";

  channel.readyState = "closed";
  client.queueWorkerProgress("turn-first", first);
  client.finishWorkerProgress("turn-first", first);
  client.queueWorkerProgress("turn-second", second);
  client.finishWorkerProgress("turn-second", second);
  expect(channel.sent).toEqual([]);

  channel.readyState = "open";
  channel.onopen?.();
  expect(sentOn(channel, "speakable")).toBe(
    `Agent Final Message:\n\n${first}Agent Final Message:\n\n${second}`,
  );

  await client.stop();
});

test("closing the page hangs up so the account's realtime slot is not stranded", async () => {
  /* An orphaned session is indistinguishable from an exhausted window on the
     next call: both come back as "You have reached your usage limit." */
  const posts: { action?: string; keepalive?: boolean }[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit & { keepalive?: boolean }) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { action?: string };
    posts.push({ action: body.action, keepalive: init?.keepalive });
    return jsonResponse(200, { ok: true, sdp: "v=0\r\nanswer" });
  }) as unknown as typeof fetch;

  const client = codexRealtimeClient("conversation_unload");
  await client.start();
  StubPeerConnection.latest?.channel.onopen?.();
  expect(client.getSnapshot().phase).toBe("live");

  window.dispatchEvent(new dom.Event("pagehide") as unknown as Event);
  const hangup = posts.find((post) => post.action === "stop");
  expect(hangup).toBeTruthy();
  expect(hangup?.keepalive).toBe(true);

  await client.stop();
});
