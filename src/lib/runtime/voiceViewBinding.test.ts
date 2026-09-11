import { beforeEach, expect, test } from "bun:test";

import { captureSelectedContext, type SelectedContextRef } from "@/lib/selection/selectedContext";

import {
  admitVoiceSelectedContext,
  bindVoiceSession,
  recordVoiceHandoff,
  noteVoiceWorkBoundary,
  realtimeBoundConversationIds,
  recordVoiceHandoffAmbiguity,
  releaseVoiceSession,
  resetVoiceViewBindings,
  voiceSelectedContext,
  voiceUtteranceContext,
  type VoiceWorkIdentity,
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

/**
 * The native work identity a tool call arrives with (#1629).
 *
 * `turnTrigger: "realtime"` is what native puts on a backing turn it started
 * from the call; an ordinary later text turn carries none, which is the whole
 * discriminator between "this work belongs to the call" and "this work does
 * not". See `docs/design/native-voice-work-identity.md`.
 */
function work(turnId: string, turnTrigger: string | null = "realtime"): VoiceWorkIdentity {
  return { threadId: "thread-1", turnId, turnTrigger, callId: null, itemId: null };
}

/** Speak once and report the handoff it became. */
function spokenTurn(sequence: number, card: string, handoffId: string, at = NOW + sequence * 1_000) {
  admitVoiceSelectedContext({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    reference: reference(DESK, card, at, sequence), utterance: utterance(sequence), now: at,
  });
  return recordVoiceHandoff({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    utterance: utterance(sequence),
    handoff: { handoffId, itemId: `item-${handoffId}`, userBidiTurnId: `bidi-${handoffId}` },
  });
}

function readCard(turnId: string, options: { trigger?: string | null } = {}) {
  return voiceUtteranceContext(CONVERSATION, {
    work: work(turnId, options.trigger === undefined ? "realtime" : options.trigger),
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
/* ------------------------------------------------------------------ *
 * WHAT A SPOKEN TURN MAY READ: nothing, on this native version.
 *
 * `docs/design/native-voice-work-identity.md` establishes that neither edge
 * automatic selection needs is available on installed Codex 0.154.0, and defers
 * cardinality, arrival order and `turn_trigger` by name as permission. So every
 * one of these is a refusal, and what each asserts is that the refusal NAMES ITS
 * OWN CONDITION and that nothing else the ledger does was lost with the claim.
 * ------------------------------------------------------------------ */

test("a request that cannot say which turn it is gets no card at all", () => {
  /* Conversation identity was once the whole authority, so any call from this
     conversation read whatever it last pointed at. */
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  spokenTurn(1, "conversation_atlas_a", "handoff-a");
  expect(voiceUtteranceContext(CONVERSATION).state).toBe("unidentified-work");
});

test("a sole outstanding utterance is still not evidence that this work is its own", () => {
  /* THE CORRECTION THIS ROUND. One candidate is the one-outstanding-utterance
     ORDER argument with a single element, and the native report defers exactly
     that as permission: a late handoff can still belong to earlier speech, and
     `turn_id` cannot break the tie because native steers more than one handoff
     into one turn. The refusal says which edge is missing. */
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  spokenTurn(1, "conversation_atlas_a", "handoff-a");
  const answered = readCard("turn-a");
  expect(answered.state).toBe("unproven-association");
  expect(answered.state === "unproven-association" && answered.reason).toContain("no edge");
  /* And reading it again does not settle into anything. */
  expect(readCard("turn-a").state).toBe("unproven-association");
});

test("the card is still readable as EVIDENCE, for the panel and the control endpoint", () => {
  /* Refusing to TARGET is not refusing to know. What the call was told is what
     the operator sees on the card, and the bound-view/context surfaces read it
     from here. Only automatic target selection is non-actionable. */
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  spokenTurn(1, "conversation_atlas_a", "handoff-a");
  const evidence = voiceSelectedContext(CONVERSATION);
  expect(evidence?.reference.state).toBe("selected");
  expect(evidence?.reference.state === "selected" && evidence.reference.conversationId)
    .toBe("conversation_atlas_a");
  expect(evidence?.handoff?.handoffId).toBe("handoff-a");
});

test("one backing turn carrying two handoffs answers about neither", () => {
  /* The reviewer's reproduced A -> tool -> B -> tool sequence, on the same
     native turn. It refused at the second read before this round and refuses at
     both now, for the same stated reason. */
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  spokenTurn(1, "conversation_atlas_a", "handoff-a");
  expect(readCard("turn-shared").state).toBe("unproven-association");

  spokenTurn(2, "conversation_atlas_b", "handoff-b");
  const answered = readCard("turn-shared");
  expect(answered.state).toBe("unproven-association");
  expect(answered.state === "unproven-association" && answered.reason).toContain("more than one");
});

test("two distinct native turns get no card either", () => {
  /* Distinct turn ids look like the case the metadata CAN separate, and they
     are not: the turn identifies the work, and which utterance that work came
     from is the edge nobody reports. */
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  spokenTurn(1, "conversation_atlas_a", "handoff-a");
  spokenTurn(2, "conversation_atlas_b", "handoff-b");
  expect(readCard("turn-a").state).toBe("unproven-association");
  expect(readCard("turn-b").state).toBe("unproven-association");
});

test("a call that has reported no card says that, rather than refusing about one", () => {
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  expect(readCard("turn-a").state).toBe("no-reference");
});

test("an unrelated later text turn is not the call's business at all", () => {
  /* The turn native did not start from the call carries no `turn_trigger`, and
     gets "no card here" rather than a refusal about a call it has nothing to do
     with. */
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  spokenTurn(1, "conversation_atlas_a", "handoff-a");
  releaseVoiceSession(CONVERSATION, NOW + 5_000);
  expect(readCard("turn-text", { trigger: null }).state).toBe("unrelated-work");
});

test("the same handoff reported twice cannot claim a second utterance", () => {
  /* A canonical identity is spent once. Still true, and still what stops a
     repeated report from attaching earlier work to later speech. */
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  expect(spokenTurn(1, "conversation_atlas_a", "handoff-a").ok).toBe(true);
  admitVoiceSelectedContext({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    reference: reference(DESK, "conversation_atlas_b", NOW + 2_000, 2), utterance: utterance(2), now: NOW + 2_000,
  });
  const repeated = recordVoiceHandoff({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    utterance: utterance(2),
    handoff: { handoffId: "handoff-a", itemId: "item-handoff-a", userBidiTurnId: "bidi-handoff-a" },
  });
  expect(repeated.ok).toBe(false);
  expect(repeated.ok || repeated.failure.code).toBe("superseded");
  expect(voiceSelectedContext(CONVERSATION)?.handoff).toBeNull();
});

test("the identical report for the utterance it already completed is idempotent", () => {
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  spokenTurn(1, "conversation_atlas_a", "handoff-a");
  const replayed = recordVoiceHandoff({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    utterance: utterance(1),
    handoff: { handoffId: "handoff-a", itemId: "item-handoff-a", userBidiTurnId: "bidi-handoff-a" },
  });
  expect(replayed.ok).toBe(true);
  expect(voiceSelectedContext(CONVERSATION)?.handoff?.handoffId).toBe("handoff-a");
});

test("a reported ambiguity is named as itself, not folded into the general refusal", () => {
  /* The client saw a handoff it could not attribute; the uncertainty stands for
     the rest of the call. Both refuse, and the agent is told which one it is. */
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  recordVoiceHandoffAmbiguity({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    reason: "more than one spoken turn was outstanding when a handoff arrived",
  });
  spokenTurn(3, "conversation_atlas_c", "handoff-c");
  const answered = readCard("turn-c");
  expect(answered.state).toBe("ambiguous");
  expect(answered.state === "ambiguous" && answered.reason).toContain("outstanding");
});

test("an ambiguity report from another call's session id changes nothing", () => {
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  spokenTurn(1, "conversation_atlas_a", "handoff-a");
  const impostor = recordVoiceHandoffAmbiguity({
    conversationId: CONVERSATION, realtimeSessionId: "rt-9", reason: "not this call",
  });
  expect(impostor.ok).toBe(false);
  expect(readCard("turn-a").state).toBe("unproven-association");
});

/* ------------------------------------------------------------------ *
 * After the hangup: bounded by work, never by a clock.
 * ------------------------------------------------------------------ */

test("what the call was told survives the hangup, because the work it started does", () => {
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  spokenTurn(1, "conversation_atlas_a", "handoff-a");
  releaseVoiceSession(CONVERSATION, NOW + 5_000);
  /* The record is still there — a tool call still gets no card from it, and an
     hour of elapsed time changes neither half. */
  expect(readCard("turn-a").state).toBe("unproven-association");
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
  expect(voiceUtteranceContext(CONVERSATION, { work: work("turn-a") })).toEqual({ state: "no-call" });
  expect(voiceSelectedContext(CONVERSATION)).toBeNull();
});

test("a hung-up call admits nothing further", () => {
  /* The transport is gone, so there is no window speaking for it. What it left
     is a record of work already started, never a channel still open. */
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  spokenTurn(1, "conversation_atlas_a", "handoff-a");
  releaseVoiceSession(CONVERSATION, NOW + 5_000);

  const later = admitVoiceSelectedContext({
    conversationId: CONVERSATION, realtimeSessionId: "rt-1",
    reference: reference(DESK, "conversation_atlas_b", NOW + 6_000, 2), utterance: utterance(2), now: NOW + 6_000,
  });
  expect(later.ok).toBe(false);
  expect(later.ok || later.failure.code).toBe("unbound");
});

/* ------------------------------------------------------------------ *
 * Reconnect: a new generation, and what the old one may keep.
 * ------------------------------------------------------------------ */

test("a reconnect while work is running keeps what the call was told", () => {
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  spokenTurn(1, "conversation_atlas_a", "handoff-a");
  releaseVoiceSession(CONVERSATION, NOW + 5_000);
  bindVoiceSession(CONVERSATION, "rt-2", DESK, { activeWork: true });

  /* Carried, and still not a target: the turn started before the reconnect
     makes its first tool call after it and is told which edge is missing. */
  expect(readCard("turn-a").state).toBe("unproven-association");
});

test("a reconnect with nothing running starts clean", () => {
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  spokenTurn(1, "conversation_atlas_a", "handoff-a");
  releaseVoiceSession(CONVERSATION, NOW + 5_000);
  bindVoiceSession(CONVERSATION, "rt-2", DESK, { activeWork: false });

  expect(readCard("turn-later").state).toBe("no-reference");
});

test("a new call's own utterance is the one the panel then shows", () => {
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  spokenTurn(1, "conversation_atlas_a", "handoff-a");
  releaseVoiceSession(CONVERSATION, NOW + 5_000);
  bindVoiceSession(CONVERSATION, "rt-2", DESK, { activeWork: false });
  admitVoiceSelectedContext({
    conversationId: CONVERSATION, realtimeSessionId: "rt-2",
    reference: reference(DESK, "conversation_atlas_z", NOW + 9_000, 9), utterance: utterance(9), now: NOW + 9_000,
  });
  recordVoiceHandoff({
    conversationId: CONVERSATION, realtimeSessionId: "rt-2",
    utterance: utterance(9), handoff: { handoffId: "handoff-z", itemId: null, userBidiTurnId: null },
  });
  const evidence = voiceSelectedContext(CONVERSATION);
  expect(evidence?.reference.state === "selected" && evidence.reference.conversationId)
    .toBe("conversation_atlas_z");
  expect(readCard("turn-z").state).toBe("unproven-association");
});

/* ------------------------------------------------------------------ *
 * Retiring a record no longer described by anything running.
 * ------------------------------------------------------------------ */

test("a spoken turn answered without tools is retired once the host is idle", () => {
  /* The operator asks something the agent answers out loud. Native routes a
     handoff into a running turn, so an idle thread means that work is over and
     the record goes; the call is still live, so what is left is a call pointing
     at nothing rather than no call. */
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  spokenTurn(1, "conversation_atlas_a", "handoff-a");
  noteVoiceWorkBoundary(CONVERSATION, "turn-spoken-a");
  noteVoiceWorkBoundary(CONVERSATION, null);

  expect(readCard("turn-a").state).toBe("no-reference");
});

test("a record stays while its work is still running", () => {
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  spokenTurn(1, "conversation_atlas_a", "handoff-a");
  noteVoiceWorkBoundary(CONVERSATION, "turn-spoken-a");

  /* No idle boundary yet, so nothing has ended. */
  expect(readCard("turn-spoken-a").state).toBe("unproven-association");
});

test("an idle boundary before the handoff retires nothing", () => {
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  noteVoiceWorkBoundary(CONVERSATION, "turn-earlier");
  noteVoiceWorkBoundary(CONVERSATION, null);
  spokenTurn(1, "conversation_atlas_a", "handoff-a");

  expect(readCard("turn-a").state).toBe("unproven-association");
});

/* ------------------------------------------------------------------ *
 * What a finished call may and may not pin.
 * ------------------------------------------------------------------ */

test("a live call is a realtime binding; what a finished one left is not", () => {
  /* Automatic host retirement (#747) refuses a conversation this reports. A call
     in progress holds a transport no transcript can restore, so it must be
     reported — but a record ABOUT WORK is not a transport, and reporting it
     would let one hangup pin a host for as long as the ledger kept anything at
     all. The host's own live realtime session is the other half of that
     predicate and is unaffected by this. */
  bindVoiceSession(CONVERSATION, "rt-1", DESK);
  spokenTurn(1, "conversation_atlas_a", "handoff-a");
  expect(realtimeBoundConversationIds().has(CONVERSATION)).toBeTrue();

  releaseVoiceSession(CONVERSATION, NOW + 5_000);
  expect(realtimeBoundConversationIds().has(CONVERSATION)).toBeFalse();
});
