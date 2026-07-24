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
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  send(payload: string): void {
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

test("a live call renders both transcripts and streams delegation handoffs with a final message", async () => {
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

  // Delegation: worker progress flows as targeted context appends (~200ms
  // cadence), and completion carries the Agent Final Message on speakable.
  peer.channel.onmessage?.({ data: JSON.stringify({ type: "delegation.created", item: { id: "delegation-9" } }) });
  client.queueWorkerProgress("Reading current agents");
  await new Promise((resolve) => setTimeout(resolve, 250));
  client.finishWorkerProgress("Reading current agents — done");

  const events = peer.channel.sent.map((payload) => JSON.parse(payload) as {
    type: string;
    delegation_item_id: string;
    channel: string;
    content: { text: string }[];
  });
  expect(events.every((event) => event.type === "delegation.context.append" && event.delegation_item_id === "delegation-9")).toBe(true);
  expect(events.filter((event) => event.channel === "commentary").length).toBeGreaterThanOrEqual(1);
  expect(events.at(-1)?.channel).toBe("speakable");
  expect(events.at(-1)?.content[0]?.text).toStartWith("Agent Final Message:");

  const progress = client.getSnapshot().lines.filter((line) => line.role === "progress");
  expect(progress.at(-1)?.text).toBe("Reading current agents — done");
  expect(progress.at(-1)?.final).toBe(true);

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
