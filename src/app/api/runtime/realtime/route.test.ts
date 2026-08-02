import { expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { executeRealtimeControl } from "@/lib/runtime/realtimeControl";

import { POST } from "./route";

const ACCEPTED_PERSONA_BOOTSTRAP = {
  receiptId: `voice_persona_${"c".repeat(64)}`,
  itemId: `msg_voice_persona_${"c".repeat(64)}`,
  insertion: "accepted" as const,
};

function request(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://127.0.0.1/api/runtime/realtime", {
    method: "POST",
    headers: { host: "127.0.0.1", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("starts V3 WebRTC through the active hosted conversation", async () => {
  const calls: unknown[] = [];
  const host = {
    async startRealtimeWebRtc(sdp: string) {
      calls.push(["start", sdp]);
      return {
        sdp: "v=0\r\nanswer",
        realtimeSessionId: "live-1",
        personaBootstrap: ACCEPTED_PERSONA_BOOTSTRAP,
      };
    },
    async appendRealtimeSpeech(text: string) {
      calls.push(["speech", text]);
    },
    async stopRealtime() {
      calls.push(["stop"]);
    },
    /* The credential the backend minted during the exchange above. Injection is
       authorized against THIS and nothing else, so a test that drives the
       injection plumbing has to present it exactly as the live peer does. */
    currentRealtimeSessionId() {
      return "live-1";
    },
  };
  /* The browser's own control path: it opened this call, so it is BOTH the operator
     (transport) and the peer holding the minted session id (injection). The two are
     separate authorities and are passed separately. */
  const operator = { operator: true };
  const peer = { caller: { kind: "session" as const, realtimeSessionId: "live-1" }, operator: false };

  // The trailing CRLF is part of the SDP payload and must survive untrimmed
  // (issue #621: a trimmed offer dies upstream with "unmarshal SDP: EOF").
  const started = await executeRealtimeControl(
    { action: "start", conversationId: "conversation_voice", sdp: "v=0\r\noffer\r\n" },
    () => host,
    operator,
  );
  expect(started).toEqual({
    status: 200,
    body: {
      ok: true,
      sdp: "v=0\r\nanswer",
      realtimeSessionId: "live-1",
      personaBootstrap: ACCEPTED_PERSONA_BOOTSTRAP,
    },
  });
  await executeRealtimeControl(
    { action: "appendSpeech", conversationId: "conversation_voice", text: "progress" },
    () => host,
    peer,
  );
  await executeRealtimeControl(
    { action: "stop", conversationId: "conversation_voice" },
    () => host,
    operator,
  );
  expect(calls).toEqual([
    ["start", "v=0\r\noffer\r\n"],
    ["speech", "progress"],
    ["stop"],
  ]);
});

test("acknowledges a stable completed-response delivery through the hosted receiver", async () => {
  const calls: unknown[] = [];
  const delivery = {
    deliveryId: 'voice:["turn-one",["response-one"]]',
    turnId: "turn-one",
    responses: [{ responseId: "response-one", text: "full response 🙂" }],
    ready: true,
  };
  const result = await executeRealtimeControl({
    action: "deliverWorkerResponse",
    conversationId: "conversation_voice",
    delivery,
  }, () => ({
    async startRealtimeWebRtc() {
      return { sdp: "v=0\r\nanswer", realtimeSessionId: null };
    },
    async appendRealtimeSpeech() {},
    async deliverRealtimeWorkerResponse(value: unknown) {
      calls.push(value);
      return { deliveryId: delivery.deliveryId, acknowledged: true as const };
    },
    async stopRealtime() {},
    currentRealtimeSessionId() { return "live-delivery"; },
    /* `operator: false` on purpose: injection is the PEER's right, and proving it
       does not ride on being the operator is the point of passing both. */
  }), { caller: { kind: "session", realtimeSessionId: "live-delivery" }, operator: false });

  expect(calls).toEqual([delivery]);
  expect(result).toEqual({
    status: 200,
    body: { ok: true, deliveryId: delivery.deliveryId, acknowledged: true },
  });
});

test("keeps validation and backend admission errors bounded", async () => {
  expect((await executeRealtimeControl(
    { action: "start", conversationId: "other", sdp: "v=0" },
    undefined,
    { operator: true },
  )).status).toBe(400);
  expect((await executeRealtimeControl({
    action: "start",
    conversationId: "conversation_voice",
    sdp: "broken",
  }, () => ({}), { operator: true })).status).toBe(409);

  const result = await executeRealtimeControl({
    action: "start",
    conversationId: "conversation_voice",
    sdp: "v=0\r\noffer",
  }, () => ({
    async startRealtimeWebRtc() { throw new Error("AVAS 404"); },
    async appendRealtimeSpeech() {},
    async stopRealtime() {},
  }), { operator: true });
  expect(result).toEqual({ status: 409, body: { error: "AVAS 404" } });
});

test("returns the canonical persona insertion outcome and rejects a call whose bootstrap was refused", async () => {
  const acceptedBootstrap = {
    receiptId: `voice_persona_${"b".repeat(64)}`,
    itemId: `msg_voice_persona_${"b".repeat(64)}`,
    insertion: "accepted" as const,
  };
  const accepted = await executeRealtimeControl({
    action: "start",
    conversationId: "conversation_voice",
    sdp: "v=0\r\noffer",
  }, () => ({
    async startRealtimeWebRtc() {
      return { sdp: "v=0\r\nanswer", realtimeSessionId: "live-bootstrap", personaBootstrap: acceptedBootstrap };
    },
    async appendRealtimeSpeech() {},
    async stopRealtime() {},
  }), { operator: true });
  expect(accepted).toEqual({
    status: 200,
    body: {
      ok: true,
      sdp: "v=0\r\nanswer",
      realtimeSessionId: "live-bootstrap",
      personaBootstrap: acceptedBootstrap,
    },
  });

  const personaBootstrap = {
    receiptId: `voice_persona_${"a".repeat(64)}`,
    itemId: `msg_voice_persona_${"a".repeat(64)}`,
    insertion: "rejected" as const,
    diagnostic: "Codex app-server request failed: invalid developer item",
  };
  const result = await executeRealtimeControl({
    action: "start",
    conversationId: "conversation_voice",
    sdp: "v=0\r\noffer",
  }, () => ({
    async startRealtimeWebRtc() {
      return { sdp: null, realtimeSessionId: null, personaBootstrap };
    },
    async appendRealtimeSpeech() {},
    async stopRealtime() {},
  }), { operator: true });

  expect(result).toEqual({
    status: 409,
    body: {
      error: "Voice persona could not be recorded: Codex app-server request failed: invalid developer item",
      personaBootstrap,
    },
  });
});

test("refuses a realtime answer that omits the mandatory persona bootstrap receipt", async () => {
  const result = await executeRealtimeControl({
    action: "start",
    conversationId: "conversation_voice",
    sdp: "v=0\r\noffer",
  }, () => ({
    async startRealtimeWebRtc() {
      return { sdp: "v=0\r\nanswer", realtimeSessionId: "live-without-bootstrap" };
    },
    async appendRealtimeSpeech() {},
    async stopRealtime() {},
  }), { operator: true });

  expect(result).toEqual({
    status: 409,
    body: { error: "Codex returned no voice persona bootstrap receipt" },
  });
});

test("refuses malformed persona bootstrap receipts before binding the realtime session", async () => {
  const digest = "d".repeat(64);
  const malformedReceipts = [
    { itemId: `msg_voice_persona_${digest}`, insertion: "accepted" },
    { receiptId: `voice_persona_${digest}`, insertion: "accepted" },
    { receiptId: `voice_persona_${digest}`, itemId: `msg_voice_persona_${digest}` },
    { receiptId: `voice_persona_${digest}`, itemId: `msg_voice_persona_${digest}`, insertion: "pending" },
  ];
  for (const personaBootstrap of malformedReceipts) {
    const result = await executeRealtimeControl({
      action: "start",
      conversationId: "conversation_voice",
      sdp: "v=0\r\noffer",
    }, () => ({
      async startRealtimeWebRtc() {
        return { sdp: "v=0\r\nanswer", realtimeSessionId: "live-malformed", personaBootstrap };
      },
      async appendRealtimeSpeech() {},
      async stopRealtime() {},
    }), { operator: true });

    expect(result).toEqual({
      status: 409,
      body: { error: "Codex returned an invalid voice persona bootstrap receipt" },
    });
  }
});

test("POST rejects a cross-origin browser before realtime admission", async () => {
  const response = await POST(request(
    { action: "stop", conversationId: "conversation_voice" },
    { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
  ));
  expect(response.status).toBe(403);
});

test("issue 664: status reports the backend's own reason for a call that died after start", async () => {
  /* The browser owns the WebRTC leg and sees only a dead peer connection. The
     reason arrived on the app-server's sideband channel, so it has to be
     readable back or the operator reads a backend cutoff as a viewer bug. */
  const host = {
    async startRealtimeWebRtc() {
      return { sdp: "v=0\r\nanswer", realtimeSessionId: "live-1" };
    },
    async appendRealtimeSpeech() {},
    async stopRealtime() {},
    lastRealtimeFailure() {
      return {
        message: "You have reached your usage limit.",
        at: "2026-07-24T18:16:25.750Z",
        realtimeSessionId: "rtc_u2_live",
      };
    },
  };
  const status = await executeRealtimeControl(
    { action: "status", conversationId: "conversation_voice" },
    () => host,
    { operator: true },
  );
  expect(status.status).toBe(200);
  expect(status.body).toEqual({
    ok: true,
    failure: {
      message: "You have reached your usage limit.",
      at: "2026-07-24T18:16:25.750Z",
      realtimeSessionId: "rtc_u2_live",
    },
  });
});

test("issue 664: a host with no recorded failure, or none at all, reports none", async () => {
  const bare = {
    async startRealtimeWebRtc() {
      return { sdp: "v=0\r\nanswer", realtimeSessionId: null };
    },
    async appendRealtimeSpeech() {},
    async stopRealtime() {},
  };
  expect(await executeRealtimeControl(
    { action: "status", conversationId: "conversation_voice" },
    () => bare,
    { operator: true },
  )).toEqual({ status: 200, body: { ok: true, failure: null } });
  expect(await executeRealtimeControl(
    { action: "status", conversationId: "conversation_voice" },
    () => ({ ...bare, lastRealtimeFailure: () => null }),
    { operator: true },
  )).toEqual({ status: 200, body: { ok: true, failure: null } });
});

test("issue 664: status on a conversation with no hosted realtime thread stays a 409", async () => {
  expect(await executeRealtimeControl(
    { action: "status", conversationId: "conversation_cold" },
    () => null,
    { operator: true },
  ))
    .toEqual({
      status: 409,
      body: { error: "the active conversation has no hosted Codex realtime thread" },
    });
});

test("the transport authority is required, and an unasked question fails closed", async () => {
  /* `operator` used to default. Either default is a bug: `true` opens the transport
     to any future call site that forgets to ask, `false` refuses the browser's own
     one-click start. It is required now, so forgetting is a type error — and a call
     site that passes the honest answer for "nobody asked" gets a refusal, never an
     open door. */
  const host = {
    async startRealtimeWebRtc() {
      return {
        sdp: "v=0\r\nanswer",
        realtimeSessionId: "live-x",
        personaBootstrap: ACCEPTED_PERSONA_BOOTSTRAP,
      };
    },
    async appendRealtimeSpeech() {},
    async stopRealtime() {},
  };
  for (const action of ["start", "stop"]) {
    const refused = await executeRealtimeControl(
      { action, conversationId: "conversation_voice", sdp: "v=0\r\noffer\r\n" },
      () => host,
      { operator: false },
    );
    expect(refused.status).toBe(403);
    expect(String(refused.body.error)).toContain("transport");

    /* And the operator's own request, the one gesture this must never break. */
    const admitted = await executeRealtimeControl(
      { action, conversationId: "conversation_voice", sdp: "v=0\r\noffer\r\n" },
      () => host,
      { operator: true },
    );
    expect(admitted.status).toBe(200);
  }
});
