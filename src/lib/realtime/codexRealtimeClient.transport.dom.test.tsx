import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";

/**
 * REGRESSION: ONE CLICK STARTS THE CALL, AND THE CLICK IS NOT AN AGENT.
 *
 * The operator's screenshot: pressing the voice control on a conversation card
 * answered 403. Two things could produce that, and both are pinned here.
 *
 * The route half lives in `route.injection.test.ts` (a browser presenting nothing
 * reaches the host). This is the CLIENT half: the transport request must carry no
 * conversation capability, because presenting one is exactly how an agent names
 * itself — `voiceTransportOperator` refuses the caller it can map to a conversation,
 * so a card capability riding along on the operator's own click would classify that
 * click as a worker and refuse the operator their own call.
 *
 * Asserted against the whole header set rather than one name, so a future round that
 * attaches some other bearer to the transport has to make this fail.
 */

const dom = new Window({ url: "http://127.0.0.1:8898/" });
const G = globalThis as Record<string, unknown>;
const SAVED: Record<string, unknown> = {};
const HAS: Record<string, boolean> = {};

let requests: { url: string; init: RequestInit }[] = [];

class StubPeerConnection {
  ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState = "connecting";
  localDescription = { sdp: "v=0\r\noffer\r\n" };
  iceGatheringState = "complete";
  createDataChannel() {
    return { onmessage: null, onopen: null, onclose: null, send() {}, close() {} };
  }
  addTrack() {}
  async createOffer() { return { type: "offer", sdp: "v=0\r\noffer\r\n" }; }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

beforeEach(() => {
  requests = [];
  const overrides: Record<string, unknown> = {
    window: dom,
    document: dom.document,
    navigator: {
      mediaDevices: {
        getUserMedia: async () => ({ getAudioTracks: () => [], getTracks: () => [] }),
      },
    },
    Audio: class {
      autoplay = false;
      hidden = false;
      muted = false;
      srcObject: unknown = null;
      async play() {}
      remove() {}
    },
    RTCPeerConnection: StubPeerConnection,
    fetch: (async (input: unknown, init: RequestInit = {}) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ ok: true, sdp: "v=0\r\nanswer\r\n", realtimeSessionId: "rt_live" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch,
  };
  for (const key of Object.keys(overrides)) {
    HAS[key] = key in G;
    SAVED[key] = G[key];
    G[key] = overrides[key];
  }
});

afterEach(() => {
  for (const key of Object.keys(HAS)) {
    if (HAS[key]) G[key] = SAVED[key];
    else delete G[key];
  }
  dom.document.body.replaceChildren();
});

const { codexRealtimeClient } = await import("./codexRealtimeClient");

/** Every header the transport request actually sent. */
function headersOf(index: number): Headers {
  return new Headers(requests[index]!.init.headers ?? {});
}

test("starting a call presents no capability, no bearer, no cookie — only its content type", async () => {
  const client = codexRealtimeClient("conversation_one_click_voice");
  await client.start();

  const start = requests.find((request) => String(request.init.body).includes('"start"'));
  expect(start).toBeDefined();
  expect(start!.url).toBe("/api/runtime/realtime");

  const headers = new Headers(start!.init.headers ?? {});
  /* THE ONE THAT MATTERS: a conversation capability here is what made the server
     read the operator's own click as an agent. */
  expect(headers.get("x-viewer-spawn-capability")).toBeNull();
  expect(headers.get("authorization")).toBeNull();
  expect(headers.get("cookie")).toBeNull();
  expect([...headers.keys()]).toEqual(["content-type"]);
});

test("hanging up presents nothing either, and proves ownership with the minted session id", async () => {
  const client = codexRealtimeClient("conversation_one_click_voice");
  await client.start();
  await client.stop();

  const stop = requests.find((request) => String(request.init.body).includes('"stop"'));
  expect(stop).toBeDefined();
  expect([...new Headers(stop!.init.headers ?? {}).keys()]).toEqual(["content-type"]);
  /* Ownership rides in the BODY, as the session id the backend minted for this
     peer — the credential injection is authorized against, and the only one the
     transport has ever needed. */
  expect(JSON.parse(String(stop!.init.body))).toMatchObject({
    action: "stop",
    realtimeSessionId: "rt_live",
  });
});

test("the start request carries the card's conversation in the body, never as authority", async () => {
  const client = codexRealtimeClient("conversation_one_click_voice");
  await client.start();

  const start = requests.find((request) => String(request.init.body).includes('"start"'))!;
  expect(JSON.parse(String(start.init.body))).toMatchObject({ conversationId: "conversation_one_click_voice" });
  /* The conversation id is what the call is FOR, and saying it is not claiming to
     be it: the server resolves callers from the capability header alone. */
  expect(headersOf(requests.indexOf(start)).get("x-viewer-spawn-capability")).toBeNull();
});
