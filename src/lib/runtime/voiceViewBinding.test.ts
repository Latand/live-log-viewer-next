import { beforeEach, expect, test } from "bun:test";

import { captureSelectedContext, type SelectedContextRef } from "@/lib/selection/selectedContext";

import {
  admitVoiceSelectedContext,
  bindVoiceSession,
  releaseVoiceSession,
  resetVoiceViewBindings,
  voiceSelectedContext,
} from "./voiceViewBinding";

/**
 * The realtime half of #844: a voice session is bound to one Viewer window at
 * `start`, and each utterance admits its selected-card reference against that
 * binding. Two devices are two sessions; nothing is ever selected implicitly.
 *
 * Process-scoped state only — no registry, no host, no isolated-state directory
 * needed — so this stays a fast, deterministic unit.
 */

const NOW = Date.parse("2026-07-31T09:00:00.000Z");
const DESK = { viewSessionId: "vs-desk-1", deviceId: "dev-desk" };
const PHONE = { viewSessionId: "vs-phone-1", deviceId: "dev-phone" };
const CONVERSATION = "conversation_orchestrator";

function reference(identity: { viewSessionId: string; deviceId: string }, card = "conversation_atlas_a", now = NOW): SelectedContextRef {
  return captureSelectedContext({
    context: { project: "atlas" },
    slice: { focusedPath: "fixtures/projects/atlas/worker-a.jsonl", selectedPaths: [] },
    cards: [{ path: "fixtures/projects/atlas/worker-a.jsonl", conversationId: card, label: "Worker A" }],
    identity,
    revision: 1,
    now,
  });
}

beforeEach(() => resetVoiceViewBindings());

test("an utterance from the bound window admits and becomes readable by routing", () => {
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  const ref = reference(DESK);
  const admitted = admitVoiceSelectedContext({ conversationId: CONVERSATION, realtimeSessionId: "rt-1", reference: ref, now: NOW });
  expect(admitted.ok).toBe(true);
  expect(voiceSelectedContext(CONVERSATION)?.reference).toEqual(ref);
  expect(voiceSelectedContext(CONVERSATION)?.sequence).toBe(1);
});

test("a second utterance replaces the first and advances the boundary sequence", () => {
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  admitVoiceSelectedContext({ conversationId: CONVERSATION, realtimeSessionId: "rt-1", reference: reference(DESK), now: NOW });
  const second = reference(DESK, "conversation_atlas_b", NOW + 1_000);
  admitVoiceSelectedContext({ conversationId: CONVERSATION, realtimeSessionId: "rt-1", reference: second, now: NOW + 1_000 });
  expect(voiceSelectedContext(CONVERSATION)?.reference).toEqual(second);
  expect(voiceSelectedContext(CONVERSATION)?.sequence).toBe(2);
});

test("the phone cannot steer the desk's call, and the desk's admitted reference is untouched", () => {
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  const desk = reference(DESK);
  admitVoiceSelectedContext({ conversationId: CONVERSATION, realtimeSessionId: "rt-1", reference: desk, now: NOW });
  const intrusion = admitVoiceSelectedContext({
    conversationId: CONVERSATION,
    realtimeSessionId: "rt-1",
    reference: reference(PHONE, "conversation_atlas_b"),
    now: NOW,
  });
  expect(intrusion.ok).toBe(false);
  expect(intrusion.ok === false && intrusion.failure.code).toBe("ambiguous");
  expect(voiceSelectedContext(CONVERSATION)?.reference).toEqual(desk);
});

test("a caller presenting another call's session id cannot admit into this one", () => {
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  const result = admitVoiceSelectedContext({
    conversationId: CONVERSATION,
    realtimeSessionId: "rt-impostor",
    reference: reference(DESK),
    now: NOW,
  });
  expect(result.ok).toBe(false);
  expect(result.ok === false && result.failure.code).toBe("unbound");
  expect(voiceSelectedContext(CONVERSATION)).toBeNull();
});

test("a call started with no view binding refuses every reference", () => {
  bindVoiceSession(CONVERSATION, "rt-1", null);
  const result = admitVoiceSelectedContext({ conversationId: CONVERSATION, realtimeSessionId: "rt-1", reference: reference(DESK), now: NOW });
  expect(result.ok).toBe(false);
  expect(result.ok === false && result.failure.code).toBe("unbound");
});

test("two conversations hold independent bindings and admissions", () => {
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  bindVoiceSession("conversation_second", "rt-2", PHONE);
  admitVoiceSelectedContext({ conversationId: CONVERSATION, realtimeSessionId: "rt-1", reference: reference(DESK), now: NOW });
  admitVoiceSelectedContext({ conversationId: "conversation_second", realtimeSessionId: "rt-2", reference: reference(PHONE, "conversation_atlas_b"), now: NOW });
  expect(voiceSelectedContext(CONVERSATION)?.reference.state === "selected"
    && voiceSelectedContext(CONVERSATION)?.reference).toMatchObject({ conversationId: "conversation_atlas_a" });
  expect(voiceSelectedContext("conversation_second")?.reference).toMatchObject({ conversationId: "conversation_atlas_b" });
});

test("hanging up releases the binding and the admitted reference", () => {
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  admitVoiceSelectedContext({ conversationId: CONVERSATION, realtimeSessionId: "rt-1", reference: reference(DESK), now: NOW });
  releaseVoiceSession(CONVERSATION);
  expect(voiceSelectedContext(CONVERSATION)).toBeNull();
  const afterHangup = admitVoiceSelectedContext({ conversationId: CONVERSATION, realtimeSessionId: "rt-1", reference: reference(DESK), now: NOW });
  expect(afterHangup.ok).toBe(false);
});

test("rebinding the same conversation to a new call drops the previous admission", () => {
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  admitVoiceSelectedContext({ conversationId: CONVERSATION, realtimeSessionId: "rt-1", reference: reference(DESK), now: NOW });
  bindVoiceSession(CONVERSATION, "rt-2", PHONE);
  expect(voiceSelectedContext(CONVERSATION)).toBeNull();
  const admitted = admitVoiceSelectedContext({ conversationId: CONVERSATION, realtimeSessionId: "rt-2", reference: reference(PHONE), now: NOW });
  expect(admitted.ok).toBe(true);
});
