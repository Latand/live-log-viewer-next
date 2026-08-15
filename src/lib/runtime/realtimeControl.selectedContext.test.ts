import { beforeEach, expect, test } from "bun:test";

import { captureSelectedContext, type SelectedContextRef } from "@/lib/selection/selectedContext";

import { executeRealtimeControl } from "./realtimeControl";
import { resetVoiceViewBindings, voiceSelectedContext } from "./voiceViewBinding";

/**
 * #844 §2/§4 at the realtime admission boundary: the utterance and the card it
 * points at are admitted together, against the window the call was opened from.
 * The speech is written ONLY if the reference is accepted — an utterance whose
 * "that one" cannot be resolved must not reach the agent pointing at nothing.
 */

/* The admission clock is the SERVER clock (a body-supplied `now` would be an
   untrusted way to defeat the staleness rule), so the fixture captures against
   the same wall clock the control plane reads. */
const NOW = Date.now();
const DESK = { viewSessionId: "vs-desk-1", deviceId: "dev-desk" };
const PHONE = { viewSessionId: "vs-phone-1", deviceId: "dev-phone" };
const ACCEPTED_PERSONA_BOOTSTRAP = {
  receiptId: `voice_persona_${"d".repeat(46)}`,
  itemId: `msg_voice_persona_${"d".repeat(46)}`,
  insertion: "accepted" as const,
};

function reference(identity: { viewSessionId: string; deviceId: string }, card = "conversation_atlas_a"): SelectedContextRef {
  return captureSelectedContext({
    context: { project: "atlas" },
    slice: { focusedPath: "fixtures/projects/atlas/worker-a.jsonl", selectedPaths: [] },
    cards: [{ path: "fixtures/projects/atlas/worker-a.jsonl", conversationId: card, label: "Worker A" }],
    identity,
    revision: 1,
    now: NOW,
  });
}

function hostFor(spoken: string[]) {
  return {
    async startRealtimeWebRtc() {
      return {
        sdp: "v=0\r\nanswer",
        realtimeSessionId: "live-1",
        personaBootstrap: ACCEPTED_PERSONA_BOOTSTRAP,
      };
    },
    async appendRealtimeSpeech(text: string) {
      spoken.push(text);
    },
    async stopRealtime() {},
    currentRealtimeSessionId() {
      return "live-1";
    },
  };
}

const OPERATOR = { operator: true };
const PEER = { caller: { kind: "session" as const, realtimeSessionId: "live-1" }, operator: false };

async function start(host: ReturnType<typeof hostFor>, view: unknown) {
  return executeRealtimeControl(
    { action: "start", conversationId: "conversation_voice", sdp: "v=0\r\noffer\r\n", view },
    () => host,
    OPERATOR,
  );
}

beforeEach(() => resetVoiceViewBindings());

test("starting a call binds it to the window that opened it", async () => {
  const spoken: string[] = [];
  const host = hostFor(spoken);
  expect((await start(host, DESK)).status).toBe(200);

  const result = await executeRealtimeControl(
    { action: "appendSpeech", conversationId: "conversation_voice", text: "look at that one", selectedContext: reference(DESK) },
    () => host,
    PEER,
  );
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ ok: true, selectedContext: { state: "selected", conversationId: "conversation_atlas_a" } });
  expect(spoken).toEqual(["look at that one"]);
  expect(voiceSelectedContext("conversation_voice")?.reference).toMatchObject({ conversationId: "conversation_atlas_a" });
});

test("an utterance from another device is refused with a typed error and never spoken", async () => {
  const spoken: string[] = [];
  const host = hostFor(spoken);
  await start(host, DESK);

  const result = await executeRealtimeControl(
    { action: "appendSpeech", conversationId: "conversation_voice", text: "look at that one", selectedContext: reference(PHONE) },
    () => host,
    PEER,
  );
  expect(result.status).toBe(409);
  expect(result.body).toMatchObject({ error: expect.stringContaining("different device"), code: "ambiguous" });
  expect(spoken).toEqual([]);
  expect(voiceSelectedContext("conversation_voice")).toBeNull();
});

test("an utterance carrying no reference is spoken unchanged — voice without a selection still works", async () => {
  const spoken: string[] = [];
  const host = hostFor(spoken);
  await start(host, DESK);

  const result = await executeRealtimeControl(
    { action: "appendSpeech", conversationId: "conversation_voice", text: "status please" },
    () => host,
    PEER,
  );
  expect(result.status).toBe(200);
  expect(spoken).toEqual(["status please"]);
  expect(voiceSelectedContext("conversation_voice")).toBeNull();
});

test("an explicit empty selection is admitted and readable, distinct from never having spoken one", async () => {
  const spoken: string[] = [];
  const host = hostFor(spoken);
  await start(host, DESK);
  const empty = captureSelectedContext({
    context: { project: "atlas" },
    slice: { focusedPath: null, selectedPaths: [] },
    cards: [],
    identity: DESK,
    revision: 2,
    now: NOW,
  });
  const result = await executeRealtimeControl(
    { action: "appendSpeech", conversationId: "conversation_voice", text: "anything running?", selectedContext: empty },
    () => host,
    PEER,
  );
  expect(result.status).toBe(200);
  expect(voiceSelectedContext("conversation_voice")?.reference.state).toBe("none");
});

test("a live peer records one stable operator event and a recording failure stays retryable", async () => {
  const spoken: string[] = [];
  const host = hostFor(spoken);
  const recorded: unknown[] = [];
  let fail = true;
  await start(host, DESK);
  const body = {
    action: "selectedContext",
    conversationId: "conversation_voice",
    realtimeSessionId: "live-1",
    operatorEventId: "voice-gesture-one",
    selectedContext: reference(DESK),
  };
  const dependencies = {
    recordOperatorActivity(input: unknown) {
      recorded.push(input);
      if (fail) throw new Error("disk unavailable");
      return { key: "a".repeat(64), engine: "codex" as const, project: "atlas", atMs: NOW };
    },
  };

  const failed = await executeRealtimeControl(body, () => host, PEER, dependencies);
  fail = false;
  const retried = await executeRealtimeControl(body, () => host, PEER, dependencies);
  const anonymous = await executeRealtimeControl(body, () => host, { operator: false }, dependencies);

  expect(failed.status).toBe(503);
  expect(retried.status).toBe(200);
  expect(anonymous.status).toBe(403);
  expect(recorded).toEqual([
    { conversationId: "conversation_voice", idempotencyKey: "realtime:voice-gesture-one" },
    { conversationId: "conversation_voice", idempotencyKey: "realtime:voice-gesture-one" },
  ]);
});

test("a call opened with no window binding refuses every reference", async () => {
  const spoken: string[] = [];
  const host = hostFor(spoken);
  await start(host, undefined);
  const result = await executeRealtimeControl(
    { action: "appendSpeech", conversationId: "conversation_voice", text: "look at that one", selectedContext: reference(DESK) },
    () => host,
    PEER,
  );
  expect(result.status).toBe(409);
  expect(result.body).toMatchObject({ code: "unbound" });
  expect(spoken).toEqual([]);
});

test("hanging up releases the binding, so a later utterance cannot ride the dead call", async () => {
  const spoken: string[] = [];
  const host = hostFor(spoken);
  await start(host, DESK);
  await executeRealtimeControl(
    { action: "appendSpeech", conversationId: "conversation_voice", text: "look at that one", selectedContext: reference(DESK) },
    () => host,
    PEER,
  );
  await executeRealtimeControl({ action: "stop", conversationId: "conversation_voice" }, () => host, OPERATOR);
  expect(voiceSelectedContext("conversation_voice")).toBeNull();
});
