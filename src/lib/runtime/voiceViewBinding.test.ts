import { beforeEach, expect, test } from "bun:test";

import { SELECTED_CONTEXT_MAX_AGE_MS } from "@/lib/realtime/selectedContextBinding";
import { captureSelectedContext, type SelectedContextRef } from "@/lib/selection/selectedContext";

import {
  admitVoiceSelectedContext,
  bindVoiceSession,
  recordVoiceHandoff,
  releaseVoiceSession,
  resetVoiceViewBindings,
  voiceSelectedContext,
  voiceUtteranceContext,
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

function reference(
  identity: { viewSessionId: string; deviceId: string },
  card = "conversation_atlas_a",
  now = NOW,
  revision = 1,
): SelectedContextRef {
  return captureSelectedContext({
    context: { project: "atlas" },
    slice: { focusedPath: "fixtures/projects/atlas/worker-a.jsonl", selectedPaths: [] },
    cards: [{ path: "fixtures/projects/atlas/worker-a.jsonl", conversationId: card, label: "Worker A" }],
    identity,
    revision,
    now,
  });
}

/** One utterance's identity, as the browser mints it. */
function utterance(sequence: number, id = `${sequence}`.padStart(32, "f")): { id: string; sequence: number } {
  return { id, sequence };
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


/* ------------------------------------------------------------------ *
 * Ordering: publishing is asynchronous, retried, and out of order (#1629).
 * ------------------------------------------------------------------ */

test("a late publication for an earlier utterance cannot replace a newer one", () => {
  /* The reproduced defect. Both publications are the bound window's and both
     pass the freshness window, so nothing in the binding check can separate
     them — the ledger used to take whichever arrived last, and a slow POST for
     the previous utterance dragged the call back to the previous card. */
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  const older = reference(DESK, "conversation_atlas_a", NOW, 1);
  const newer = reference(DESK, "conversation_atlas_b", NOW + 1_000, 2);

  expect(admitVoiceSelectedContext({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    reference: newer, utterance: utterance(2), now: NOW + 1_000,
  }).ok).toBe(true);

  const late = admitVoiceSelectedContext({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    reference: older, utterance: utterance(1), now: NOW + 1_200,
  });
  expect(late.ok).toBe(false);
  expect(late.ok || late.failure.code).toBe("superseded");

  /* A refusal changes nothing: the newer reference still stands, and the
     boundary counter still says two utterances have been published for. */
  expect(voiceSelectedContext(CONVERSATION)?.reference).toEqual(newer);
  expect(voiceSelectedContext(CONVERSATION)?.sequence).toBe(1);
});

test("without an utterance identity the reference's own revision decides", () => {
  /* A client that carries no utterance identity still cannot go backwards:
     `revision` is monotonic within a view session, and a call is bound to
     exactly one. */
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  const newer = reference(DESK, "conversation_atlas_b", NOW + 1_000, 7);
  const older = reference(DESK, "conversation_atlas_a", NOW, 3);
  admitVoiceSelectedContext({ conversationId: CONVERSATION, realtimeSessionId: "rt-1", reference: newer, now: NOW + 1_000 });
  const late = admitVoiceSelectedContext({ conversationId: CONVERSATION, realtimeSessionId: "rt-1", reference: older, now: NOW + 1_200 });
  expect(late.ok).toBe(false);
  expect(voiceSelectedContext(CONVERSATION)?.reference).toEqual(newer);
});

test("a retried publication stays one utterance", () => {
  /* The publish path is fire-and-forget with one retry, so a POST that timed
     out on the client and succeeded on the server arrives twice. Counting that
     as two utterances would make the boundary sequence describe the network. */
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  const ref = reference(DESK, "conversation_atlas_a", NOW, 4);
  const first = admitVoiceSelectedContext({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    reference: ref, utterance: utterance(1), now: NOW,
  });
  const replay = admitVoiceSelectedContext({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    reference: ref, utterance: utterance(1), now: NOW + 50,
  });
  expect(first.ok && replay.ok).toBe(true);
  if (!first.ok || !replay.ok) throw new Error("both admissions were expected to succeed");
  expect(replay.admission).toEqual(first.admission);
  expect(voiceSelectedContext(CONVERSATION)?.sequence).toBe(1);
});

test("a later utterance still admits after a refused earlier one", () => {
  /* The refusal is about ordering alone — the window is still the bound one, so the call keeps
     working, and the next thing the operator says lands normally. */
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  admitVoiceSelectedContext({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    reference: reference(DESK, "conversation_atlas_b", NOW + 1_000, 2), utterance: utterance(2), now: NOW + 1_000,
  });
  admitVoiceSelectedContext({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    reference: reference(DESK, "conversation_atlas_a", NOW, 1), utterance: utterance(1), now: NOW + 1_200,
  });
  const third = reference(DESK, "conversation_atlas_c", NOW + 2_000, 3);
  const admitted = admitVoiceSelectedContext({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    reference: third, utterance: utterance(3), now: NOW + 2_000,
  });
  expect(admitted.ok).toBe(true);
  expect(voiceSelectedContext(CONVERSATION)?.reference).toEqual(third);
  expect(voiceSelectedContext(CONVERSATION)?.sequence).toBe(2);
});

test("a new call starts its own utterance ledger", () => {
  /* Rebinding is a new call. If the previous call's utterance sequence carried
     over, the first utterance of the new one would be refused as superseded by
     the last of the old one. */
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  admitVoiceSelectedContext({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    reference: reference(DESK, "conversation_atlas_b", NOW, 9), utterance: utterance(9), now: NOW,
  });
  bindVoiceSession(CONVERSATION, "rt-2", DESK);
  const first = reference(DESK, "conversation_atlas_a", NOW + 1_000, 1);
  const admitted = admitVoiceSelectedContext({
    conversationId: CONVERSATION, realtimeSessionId: "rt-2",
    reference: first, utterance: utterance(1), now: NOW + 1_000,
  });
  expect(admitted.ok).toBe(true);
  expect(voiceSelectedContext(CONVERSATION)?.reference).toEqual(first);
});


/* ------------------------------------------------------------------ *
 * The join: what was on screen, what was said, what was handed off.
 * ------------------------------------------------------------------ */

const HANDOFF = { handoffId: "handoff-1", itemId: "item-1", userBidiTurnId: "bidi-1" };

test("a handoff completes the standing admission without minting an utterance", () => {
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  const ref = reference(DESK, "conversation_atlas_a", NOW, 1);
  admitVoiceSelectedContext({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    reference: ref, utterance: utterance(1), now: NOW,
  });
  const recorded = recordVoiceHandoff({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    utterance: utterance(1), handoff: HANDOFF,
  });
  expect(recorded.ok).toBe(true);
  /* The reference and the boundary counter are untouched: this reports what the
     utterance became, it does not claim a new one happened. */
  expect(voiceSelectedContext(CONVERSATION)?.reference).toEqual(ref);
  expect(voiceSelectedContext(CONVERSATION)?.sequence).toBe(1);
  expect(voiceSelectedContext(CONVERSATION)?.handoff).toEqual(HANDOFF);
});

test("a handoff for an utterance the call has moved past is dropped", () => {
  /* Handoff events are asynchronous like everything else on this leg. One that
     names a superseded utterance must not reopen it and attach itself to the
     reference that replaced it — that would join the operator's newest card to
     an older spoken turn's work. */
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  admitVoiceSelectedContext({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    reference: reference(DESK, "conversation_atlas_a", NOW, 1), utterance: utterance(1), now: NOW,
  });
  admitVoiceSelectedContext({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    reference: reference(DESK, "conversation_atlas_b", NOW + 1_000, 2), utterance: utterance(2), now: NOW + 1_000,
  });
  const late = recordVoiceHandoff({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    utterance: utterance(1), handoff: HANDOFF,
  });
  expect(late.ok).toBe(false);
  expect(late.ok || late.failure.code).toBe("superseded");
  expect(voiceSelectedContext(CONVERSATION)?.handoff).toBeNull();
});

test("a handoff presented with another call's session id is refused", () => {
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  admitVoiceSelectedContext({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    reference: reference(DESK), utterance: utterance(1), now: NOW,
  });
  const impostor = recordVoiceHandoff({
    conversationId: CONVERSATION, realtimeSessionId: "rt-2",
    utterance: utterance(1), handoff: HANDOFF,
  });
  expect(impostor.ok).toBe(false);
  expect(impostor.ok || impostor.failure.code).toBe("unbound");
  expect(voiceSelectedContext(CONVERSATION)?.handoff).toBeNull();
});


/* ------------------------------------------------------------------ *
 * After the hangup: what the work the call started may still read.
 * ------------------------------------------------------------------ */

test("an accepted join survives the hangup, because the work it started does", () => {
  /* The operator asks for something, hangs up, and the agent is still working
     when it reaches for the card they were pointing at. */
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  const ref = reference(DESK, "conversation_atlas_a", NOW, 1);
  admitVoiceSelectedContext({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    reference: ref, utterance: utterance(1), now: NOW,
  });
  recordVoiceHandoff({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    utterance: utterance(1), handoff: HANDOFF,
  });
  releaseVoiceSession(CONVERSATION, NOW + 1_000);

  const retained = voiceUtteranceContext(CONVERSATION, NOW + 2_000);
  expect(retained.state).toBe("joined");
  expect(retained.state === "joined" && retained.reference).toEqual(ref);
  /* And it says what it is, so a reader can tell live context from a legacy. */
  expect(retained.state === "joined" && retained.callEnded).toBe(true);
});

test("a hangup with no accepted join leaves nothing behind", () => {
  /* An utterance that never became work has nothing running that could need it,
     and keeping its card would leave one standing for a later turn to pick up. */
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  admitVoiceSelectedContext({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    reference: reference(DESK), utterance: utterance(1), now: NOW,
  });
  releaseVoiceSession(CONVERSATION, NOW + 1_000);
  expect(voiceUtteranceContext(CONVERSATION, NOW + 2_000)).toEqual({ state: "no-call" });
  expect(voiceSelectedContext(CONVERSATION)).toBeNull();
});

test("what a finished call left ages out of the window a capture may steer from", () => {
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  admitVoiceSelectedContext({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    reference: reference(DESK, "conversation_atlas_a", NOW, 1), utterance: utterance(1), now: NOW,
  });
  recordVoiceHandoff({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    utterance: utterance(1), handoff: HANDOFF,
  });
  releaseVoiceSession(CONVERSATION, NOW + 1_000);

  expect(voiceUtteranceContext(CONVERSATION, NOW + SELECTED_CONTEXT_MAX_AGE_MS - 1).state).toBe("joined");
  expect(voiceUtteranceContext(CONVERSATION, NOW + SELECTED_CONTEXT_MAX_AGE_MS + 1)).toEqual({ state: "no-call" });
});

test("a hung-up call admits nothing further", () => {
  /* The transport is gone, so there is no window speaking for it. What it left
     is a record of work already started, never a channel still open. */
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  admitVoiceSelectedContext({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    reference: reference(DESK, "conversation_atlas_a", NOW, 1), utterance: utterance(1), now: NOW,
  });
  recordVoiceHandoff({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    utterance: utterance(1), handoff: HANDOFF,
  });
  releaseVoiceSession(CONVERSATION, NOW + 1_000);

  const later = admitVoiceSelectedContext({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    reference: reference(DESK, "conversation_atlas_b", NOW + 2_000, 2), utterance: utterance(2), now: NOW + 2_000,
  });
  expect(later.ok).toBe(false);
  expect(later.ok || later.failure.code).toBe("unbound");
  const standing = voiceUtteranceContext(CONVERSATION, NOW + 2_000);
  expect(standing.state === "joined" && standing.reference.state === "selected"
    && standing.reference.conversationId).toBe("conversation_atlas_a");
});

test("a new call replaces what the last one left", () => {
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  admitVoiceSelectedContext({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    reference: reference(DESK, "conversation_atlas_a", NOW, 1), utterance: utterance(1), now: NOW,
  });
  recordVoiceHandoff({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    utterance: utterance(1), handoff: HANDOFF,
  });
  releaseVoiceSession(CONVERSATION, NOW + 1_000);

  bindVoiceSession(CONVERSATION, "rt-2", DESK);
  expect(voiceUtteranceContext(CONVERSATION, NOW + 2_000)).toEqual({ state: "no-reference" });
});
