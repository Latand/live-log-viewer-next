import { expect, test } from "bun:test";
import { NextRequest } from "next/server";

import { executeRealtimeControl } from "@/lib/runtime/realtimeControl";

import { POST } from "./route";

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
      return { sdp: "v=0\r\nanswer", realtimeSessionId: "live-1" };
    },
    async appendRealtimeSpeech(text: string) {
      calls.push(["speech", text]);
    },
    async stopRealtime() {
      calls.push(["stop"]);
    },
  };

  // The trailing CRLF is part of the SDP payload and must survive untrimmed
  // (issue #621: a trimmed offer dies upstream with "unmarshal SDP: EOF").
  const started = await executeRealtimeControl(
    { action: "start", conversationId: "conversation_voice", sdp: "v=0\r\noffer\r\n" },
    () => host,
  );
  expect(started).toEqual({
    status: 200,
    body: { ok: true, sdp: "v=0\r\nanswer", realtimeSessionId: "live-1" },
  });
  await executeRealtimeControl(
    { action: "appendSpeech", conversationId: "conversation_voice", text: "progress" },
    () => host,
  );
  await executeRealtimeControl(
    { action: "stop", conversationId: "conversation_voice" },
    () => host,
  );
  expect(calls).toEqual([
    ["start", "v=0\r\noffer\r\n"],
    ["speech", "progress"],
    ["stop"],
  ]);
});

test("keeps validation and backend admission errors bounded", async () => {
  expect((await executeRealtimeControl({ action: "start", conversationId: "other", sdp: "v=0" })).status).toBe(400);
  expect((await executeRealtimeControl({
    action: "start",
    conversationId: "conversation_voice",
    sdp: "broken",
  }, () => ({}))).status).toBe(409);

  const result = await executeRealtimeControl({
    action: "start",
    conversationId: "conversation_voice",
    sdp: "v=0\r\noffer",
  }, () => ({
    async startRealtimeWebRtc() { throw new Error("AVAS 404"); },
    async appendRealtimeSpeech() {},
    async stopRealtime() {},
  }));
  expect(result).toEqual({ status: 409, body: { error: "AVAS 404" } });
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
  expect(await executeRealtimeControl({ action: "status", conversationId: "conversation_voice" }, () => bare))
    .toEqual({ status: 200, body: { ok: true, failure: null } });
  expect(await executeRealtimeControl(
    { action: "status", conversationId: "conversation_voice" },
    () => ({ ...bare, lastRealtimeFailure: () => null }),
  )).toEqual({ status: 200, body: { ok: true, failure: null } });
});

test("issue 664: status on a conversation with no hosted realtime thread stays a 409", async () => {
  expect(await executeRealtimeControl({ action: "status", conversationId: "conversation_cold" }, () => null))
    .toEqual({
      status: 409,
      body: { error: "the active conversation has no hosted Codex realtime thread" },
    });
});
