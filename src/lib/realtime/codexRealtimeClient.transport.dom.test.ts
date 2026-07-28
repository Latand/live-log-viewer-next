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
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push(body);
    if (body.action === "deliverWorkerResponse") {
      const delivery = body.delivery as { deliveryId: string };
      return jsonResponse(200, {
        ok: true,
        deliveryId: delivery.deliveryId,
        acknowledged: true,
      });
    }
    return jsonResponse(200, { ok: true, sdp: "v=0\r\nanswer" });
  }) as unknown as typeof fetch;

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
  for (let step = 0; step < 50; step += 1) {
    produced += segment(step, 300);
    client.updateWorkerProgress("turn-live-call", produced, true);
  }
  expect(client.getSnapshot().lines.at(-1)).toMatchObject({
    role: "progress",
    text: produced.slice(-12_000),
    final: false,
  });

  client.updateWorkerProgress("turn-live-call", produced, false);
  const delivery = voiceDelivery("turn-live-call", [
    { responseId: "response-one", text: produced },
    { responseId: "response-two", text: "second item 🫶🏽" },
  ]);
  client.reconcileWorkerDeliveries([delivery]);
  client.reconcileWorkerDeliveries([delivery]);
  await flushAsync();

  const delivered = requests.filter((request) =>
    request.action === "deliverWorkerResponse");
  /* #691 §6: the write carries this call's credential. Injection is authorized
     against the live session id, so a delivery that omitted it would be refused —
     absence of evidence grants nothing. */
  expect(delivered).toEqual([{
    action: "deliverWorkerResponse",
    conversationId: "conversation_live_call",
    realtimeSessionId: null,
    delivery,
  }]);
  expect(peer.channel.sent).toEqual([]);

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

/** Varied filler of an exact length, so no accidental prefix coincidences make
    a duplicate look like new content. */
function segment(step: number, size: number): string {
  return `«${step}» ${"worker progress — reading agents ".repeat(size)}`.slice(0, size);
}

function voiceDelivery(
  turnId: string,
  responses: Array<{ responseId: string; text: string }>,
) {
  return {
    deliveryId: `voice:${JSON.stringify([turnId, responses.map((response) => response.responseId)])}`,
    turnId,
    responses,
    ready: true,
  };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test("explicit stop retains an unacknowledged response and retries the same delivery id", async () => {
  const delivered: unknown[] = [];
  let attempts = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (body.action === "deliverWorkerResponse") {
      delivered.push(body.delivery);
      attempts += 1;
      if (attempts === 1) return jsonResponse(409, { error: "realtime channel replaced" });
      return jsonResponse(200, {
        ok: true,
        deliveryId: (body.delivery as { deliveryId: string }).deliveryId,
        acknowledged: true,
      });
    }
    if (body.action === "stop") return jsonResponse(200, { ok: true });
    return jsonResponse(200, { ok: true, sdp: "v=0\r\nanswer" });
  }) as unknown as typeof fetch;
  const client = codexRealtimeClient("conversation_progress_retry");
  await client.start();
  StubPeerConnection.latest?.channel.onopen?.();
  const delivery = voiceDelivery("turn-retry", [{
    responseId: "response-retry",
    text: "retained response",
  }]);
  client.reconcileWorkerDeliveries([delivery]);
  await flushAsync();

  await client.stop();
  await client.start();
  StubPeerConnection.latest?.channel.onopen?.();
  await flushAsync();

  expect(delivered).toEqual([delivery, delivery]);
  await client.stop();
});

test("channel replacement retries before acknowledgement and never repeats after acknowledgement", async () => {
  const delivered: unknown[] = [];
  let rejectFirstDelivery!: () => void;
  const firstDelivery = new Promise<Response>((resolve) => {
    rejectFirstDelivery = () => resolve(jsonResponse(409, { error: "channel unavailable" }));
  });
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (body.action === "deliverWorkerResponse") {
      delivered.push(body.delivery);
      if (delivered.length === 1) return firstDelivery;
      return jsonResponse(200, {
        ok: true,
        deliveryId: (body.delivery as { deliveryId: string }).deliveryId,
        acknowledged: true,
      });
    }
    if (body.action === "status") return jsonResponse(200, { ok: true, failure: null });
    return jsonResponse(200, { ok: true, sdp: "v=0\r\nanswer" });
  }) as unknown as typeof fetch;
  const client = codexRealtimeClient("conversation_progress_reconnect");
  const delivery = voiceDelivery("turn-reconnect", [{
    responseId: "response-reconnect",
    text: "Response retained across transport replacement",
  }]);
  await client.start();
  StubPeerConnection.latest?.channel.onopen?.();
  client.reconcileWorkerDeliveries([delivery]);
  await flushAsync();

  const failedPeer = StubPeerConnection.latest!;
  failedPeer.connectionState = "failed";
  failedPeer.onconnectionstatechange?.();
  await flushAsync();
  await client.start();
  StubPeerConnection.latest?.channel.onopen?.();
  rejectFirstDelivery();
  await flushAsync();
  client.reconcileWorkerDeliveries([delivery]);
  await flushAsync();

  const acknowledgedPeer = StubPeerConnection.latest!;
  acknowledgedPeer.connectionState = "failed";
  acknowledgedPeer.onconnectionstatechange?.();
  await flushAsync();
  await client.start();
  StubPeerConnection.latest?.channel.onopen?.();
  client.reconcileWorkerDeliveries([delivery]);
  await flushAsync();

  expect(delivered).toEqual([delivery, delivery]);
  await client.stop();
});

test("hydrated completed responses queue in order before Live Mode opens", async () => {
  const delivered: unknown[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    if (body.action === "deliverWorkerResponse") {
      const delivery = body.delivery as { deliveryId: string };
      delivered.push(delivery);
      return jsonResponse(200, {
        ok: true,
        deliveryId: delivery.deliveryId,
        acknowledged: true,
      });
    }
    return jsonResponse(200, { ok: true, sdp: "v=0\r\nanswer" });
  }) as unknown as typeof fetch;
  const client = codexRealtimeClient("conversation_progress_queue");
  const first = voiceDelivery("turn-first", [{
    responseId: "response-first",
    text: "First completed worker response",
  }]);
  const second = voiceDelivery("turn-second", [{
    responseId: "response-second",
    text: "Second completed worker response",
  }]);
  client.reconcileWorkerDeliveries([first, second]);
  expect(delivered).toEqual([]);

  await client.start();
  StubPeerConnection.latest?.channel.onopen?.();
  await flushAsync();
  expect(delivered).toEqual([first, second]);
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

/**
 * A delegating turn talks and streams worker progress at the same time, so
 * progress ticks and assistant deltas arrive interleaved. Position-based line
 * merging ("update the last line if it has my role and is not final") loses
 * the progress line the moment anything else is appended after it, and the
 * next tick — which carries the WHOLE accumulated text, not a delta — lands as
 * a new line. The operator sees the same answer redrawn once per tick as a
 * ladder of ever-longer prefixes, with the agent's own deltas shredded into
 * one line each between them.
 */
test("interleaved progress and assistant deltas keep one line each", async () => {
  globalThis.fetch = (async () => jsonResponse(200, { ok: true, sdp: "v=0\r\nanswer" })) as unknown as typeof fetch;
  const client = codexRealtimeClient("conversation_interleaved");
  await client.start();
  const peer = StubPeerConnection.latest!;
  peer.channel.onopen?.();
  expect(client.getSnapshot().phase).toBe("live");

  const words = ["Yes", " the", " fix", " works", " well"];
  let spoken = "";
  let progress = "";
  for (const word of words) {
    spoken += word;
    progress += word;
    peer.channel.onmessage?.({ data: JSON.stringify({ type: "output_transcript.added", item: { text: word } }) });
    client.updateWorkerProgress("turn-interleaved", progress, true);
  }
  peer.channel.onmessage?.({ data: JSON.stringify({ type: "turn.done", turn: { role: "assistant", transcript: spoken } }) });

  const lines = client.getSnapshot().lines;
  expect(lines.filter((line) => line.role === "progress")).toHaveLength(1);
  expect(lines.filter((line) => line.role === "assistant")).toHaveLength(1);
  expect(lines.map((line) => [line.role, line.text, line.final])).toEqual([
    ["assistant", spoken, true],
    ["progress", progress, false],
  ]);

  await client.stop();
});

/**
 * `workerRunning` goes false the moment the turn ends while the accumulated
 * text is still on screen, which finalizes the progress line. Any later tick
 * for the SAME turn — a trailing update, or the effect re-firing when the call
 * phase changes — must reuse that turn's line instead of starting a new one.
 */
test("a finalized progress line is reused by later ticks of the same turn", async () => {
  globalThis.fetch = (async () => jsonResponse(200, { ok: true, sdp: "v=0\r\nanswer" })) as unknown as typeof fetch;
  const client = codexRealtimeClient("conversation_progress_refinal");
  await client.start();
  const peer = StubPeerConnection.latest!;
  peer.channel.onopen?.();

  client.updateWorkerProgress("turn-a", "partial answer", true);
  client.updateWorkerProgress("turn-a", "partial answer complete", false);
  // Replay of the same accumulated text (phase change re-fires the effect).
  client.updateWorkerProgress("turn-a", "partial answer complete", false);
  // A different turn is a different line.
  client.updateWorkerProgress("turn-b", "next answer", true);

  expect(client.getSnapshot().lines.map((line) => [line.role, line.text, line.final])).toEqual([
    ["progress", "partial answer complete", true],
    ["progress", "next answer", false],
  ]);

  await client.stop();
});
