import {
  bindSelectedContextToVoiceSession,
  type SelectedContextBindingFailure,
  type VoiceViewBinding,
} from "@/lib/realtime/selectedContextBinding";
import { parseSelectedContextRef, type SelectedContextRef } from "@/lib/selection/selectedContext";

/**
 * Which Viewer window a live voice call belongs to, and what it last pointed at
 * (#844 §4, §"expose to realtime delegation and tool routing").
 *
 * A typed send carries its selected-card reference inside the same request as
 * its text, so the request IS the atomic unit. A voice call has no such unit: it
 * is one long transport whose utterances are delegated into the thread by the
 * realtime loop, and the operator may have the Viewer open on more than one
 * device. This ledger is the voice equivalent of that atomicity:
 *
 * - `bindVoiceSession` records, at `start`, the window the call belongs to,
 *   keyed by the realtime session id the backend minted for it. That id is
 *   already the credential the browser presents on every write into the call
 *   (see `realtimeInjection`), so admission reuses it rather than inventing a
 *   second notion of who is calling.
 * - `admitVoiceSelectedContext` runs at the utterance/delegation boundary. It
 *   validates the reference against the binding AND against what the call has
 *   already been told, and only then replaces what the call points at. A refusal
 *   changes NOTHING: the previously admitted reference stands, so a phone's
 *   stray publish cannot blank the desk's, and a slow publish for an earlier
 *   utterance cannot drag the call back to an earlier screen.
 * - `voiceSelectedContext` is what realtime delegation and tool routing read.
 *
 * Process-scoped and deliberately not durable: it describes a live transport. A
 * call does not survive the process, so neither should its binding — and a
 * binding that outlived its call would be exactly the stale authority the typed
 * refusals exist to prevent. The durable record of what a TURN pointed at lives
 * on the structured-user record instead.
 */

/**
 * Who published, and which utterance of theirs (#1629).
 *
 * The reference alone cannot answer either question. It says what was on screen,
 * not which spoken turn it belongs to, so two publications from one window are
 * indistinguishable — which is how a retried POST used to count as a second
 * utterance and how a late one used to overwrite a newer one. The browser owns
 * the utterance boundary (it is the peer that sees its own transcript go final),
 * so it is the peer that names it.
 */
export interface VoiceUtteranceIdentity {
  /** Stable for one utterance, including across this publication's retries. */
  id: string;
  /** Monotonic within one call, starting at 1. */
  sequence: number;
}

export interface VoiceSelectedContextAdmission {
  conversationId: string;
  realtimeSessionId: string;
  binding: VoiceViewBinding;
  reference: SelectedContextRef;
  admittedAt: string;
  /** Utterance boundary counter for this call: 1 for the first admission. */
  sequence: number;
  /** The utterance this reference was published for, when the caller named one. */
  utteranceId: string | null;
  /**
   * The handoff this utterance became, once the call reported one (#1629).
   *
   * The join between what the operator was looking at, what they said, and the
   * work the backing model was asked to do. Null until the handoff is reported,
   * and null for an utterance that never produced one.
   */
  handoff: VoiceHandoffIdentity | null;
}

/** The canonical identities a realtime handoff carries. */
export interface VoiceHandoffIdentity {
  handoffId: string | null;
  itemId: string | null;
  userBidiTurnId: string | null;
}

interface VoiceSessionState {
  realtimeSessionId: string;
  binding: VoiceViewBinding | null;
  admission: VoiceSelectedContextAdmission | null;
  sequence: number;
  /** The utterance sequence the standing admission was published for. */
  utteranceSequence: number | null;
}

const store = globalThis as typeof globalThis & {
  __llvVoiceViewBindings?: Map<string, VoiceSessionState>;
};
const sessions = store.__llvVoiceViewBindings ??= new Map<string, VoiceSessionState>();

/** The view/device a browser presented when opening a call, or null when it
    presented nothing usable — which is a refusal to bind, not a wildcard. */
export function parseVoiceViewBinding(value: unknown): VoiceViewBinding | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  /* Reuse the reference validator's own id grammar rather than a second one: a
     token this rejects is a token no reference could ever carry, so binding to
     it would guarantee every later utterance refuses. */
  const probe = parseSelectedContextRef({
    version: 1,
    state: "none",
    capturedAt: new Date(0).toISOString(),
    viewSessionId: body.viewSessionId,
    deviceId: body.deviceId,
  });
  return probe?.viewSessionId && probe.deviceId
    ? { viewSessionId: probe.viewSessionId, deviceId: probe.deviceId }
    : null;
}

/** Bind a call to the window that opened it. Rebinding a conversation is a new
    call: the previous admission is dropped rather than inherited. */
export function bindVoiceSession(conversationId: string, realtimeSessionId: string, binding: VoiceViewBinding | null): void {
  sessions.set(conversationId, {
    realtimeSessionId, binding, admission: null, sequence: 0, utteranceSequence: null,
  });
}

export function releaseVoiceSession(conversationId: string): void {
  sessions.delete(conversationId);
}

/**
 * Conversations a live voice call is bound to right now.
 *
 * Automatic host retirement (#747) reads this: a realtime-bound session holds a
 * transport that no transcript can restore, so it is never a retirement
 * candidate. Process-scoped like the ledger it reads — a call does not survive
 * the process, so a restarted Viewer correctly reports none.
 */
export function realtimeBoundConversationIds(): ReadonlySet<string> {
  return new Set(sessions.keys());
}

export interface VoiceSelectedContextAdmissionInput {
  conversationId: string;
  /** The credential the caller presented; must be the call's own. */
  realtimeSessionId: string;
  reference: SelectedContextRef | null;
  /** The utterance this publication speaks for, when the caller named one. */
  utterance?: VoiceUtteranceIdentity | null;
  now: number;
}

/**
 * Is this publication newer than the one standing?
 *
 * Preference order, and each step is used only when the one before it cannot
 * decide:
 *
 * 1. The utterance sequence, when both publications carry one. It is minted by
 *    the peer that saw the utterances happen, so it is the only ordering that
 *    describes the CALL rather than the network.
 * 2. The reference's own `revision`, monotonic within a view session — and a
 *    call is bound to exactly one view session, so within a call it is total.
 * 3. `capturedAt`, for a client that carries neither.
 *
 * Ties admit. A publication that cannot be shown to be older is treated as the
 * current one: refusing it would strand the call on a stale card whenever a
 * client stops carrying ordering evidence, which is the worse of the two.
 */
function supersedes(
  candidate: { reference: SelectedContextRef; utterance: VoiceUtteranceIdentity | null },
  standing: VoiceSelectedContextAdmission | null,
  standingUtteranceSequence: number | null,
): boolean {
  if (!standing) return true;
  if (candidate.utterance && standingUtteranceSequence !== null) {
    return candidate.utterance.sequence >= standingUtteranceSequence;
  }
  const candidateRevision = candidate.reference.revision;
  const standingRevision = standing.reference.revision;
  if (typeof candidateRevision === "number" && typeof standingRevision === "number") {
    return candidateRevision >= standingRevision;
  }
  return candidate.reference.capturedAt >= standing.reference.capturedAt;
}

export type VoiceSelectedContextAdmissionResult =
  | { ok: true; admission: VoiceSelectedContextAdmission }
  | { ok: false; failure: SelectedContextBindingFailure };

export function admitVoiceSelectedContext(input: VoiceSelectedContextAdmissionInput): VoiceSelectedContextAdmissionResult {
  const session = sessions.get(input.conversationId);
  /* An unknown conversation, a call that bound no window, and a caller
     presenting a different call's session id are one answer: this request has no
     established view to speak for. Distinguishing them in the error would tell
     an impostor which calls exist. */
  if (!session || !session.binding || session.realtimeSessionId !== input.realtimeSessionId) {
    return {
      ok: false,
      failure: {
        code: "unbound",
        message: "This voice session is not bound to a Viewer window, so it cannot resolve a selected card.",
      },
    };
  }
  const utterance = input.utterance ?? null;
  /* A REPLAY IS NOT A SECOND UTTERANCE. Publishing is fire-and-forget with a
     retry, so the same utterance can arrive twice; answering with the standing
     admission keeps the boundary counter equal to the number of spoken turns
     instead of the number of successful POSTs. */
  if (utterance && session.admission?.utteranceId === utterance.id) {
    return { ok: true, admission: session.admission };
  }
  const bound = bindSelectedContextToVoiceSession({
    binding: session.binding,
    reference: input.reference,
    now: input.now,
  });
  if (!bound.ok) return bound;
  if (!supersedes({ reference: bound.reference, utterance }, session.admission, session.utteranceSequence)) {
    return {
      ok: false,
      failure: {
        code: "superseded",
        message: "This voice session has already been told about a later utterance, so an earlier one cannot replace it.",
      },
    };
  }
  session.sequence += 1;
  if (utterance) session.utteranceSequence = utterance.sequence;
  session.admission = {
    conversationId: input.conversationId,
    realtimeSessionId: session.realtimeSessionId,
    binding: session.binding,
    reference: bound.reference,
    admittedAt: new Date(input.now).toISOString(),
    sequence: session.sequence,
    utteranceId: utterance?.id ?? null,
    handoff: null,
  };
  return { ok: true, admission: session.admission };
}

/**
 * Record which handoff an already-admitted utterance became.
 *
 * Deliberately not an admission: it mints no utterance, moves no counter and
 * replaces no reference. It only completes the record of one that already
 * exists, so a handoff reported for an utterance the ledger has moved past — a
 * late event, or one belonging to a superseded publication — is dropped rather
 * than allowed to reopen it.
 */
export function recordVoiceHandoff(input: {
  conversationId: string;
  realtimeSessionId: string;
  utteranceId: string;
  handoff: VoiceHandoffIdentity;
}): VoiceSelectedContextAdmissionResult {
  const session = sessions.get(input.conversationId);
  if (!session || !session.binding || session.realtimeSessionId !== input.realtimeSessionId) {
    return {
      ok: false,
      failure: {
        code: "unbound",
        message: "This voice session is not bound to a Viewer window, so it cannot resolve a selected card.",
      },
    };
  }
  const admission = session.admission;
  if (!admission || admission.utteranceId !== input.utteranceId) {
    return {
      ok: false,
      failure: {
        code: "superseded",
        message: "This voice session has already been told about a later utterance, so an earlier one cannot replace it.",
      },
    };
  }
  session.admission = { ...admission, handoff: input.handoff };
  return { ok: true, admission: session.admission };
}

/** What this conversation's live call currently points at. Read by realtime
    delegation and by tool routing; null when no call, no binding, or no
    utterance has been admitted yet. */
export function voiceSelectedContext(conversationId: string): VoiceSelectedContextAdmission | null {
  return sessions.get(conversationId)?.admission ?? null;
}

/**
 * What a tool call made from this conversation is entitled to read (#1629).
 *
 * This is the whole reader contract, and it is a state rather than a value on
 * purpose: the four ways there is no card each mean something different to the
 * agent holding the microphone, and collapsing them into `null` is how the agent
 * ends up guessing.
 *
 * THE CARD IS ONLY AVAILABLE WHILE IT DESCRIBES THE WORK IN HAND. A reference
 * becomes readable when its utterance has been handed off — that handoff is the
 * work this tool call belongs to — and stops being readable the moment the
 * operator speaks again, because a new utterance replaces the admission wholesale
 * and its own handoff has not landed yet. So a later turn that pointed at nothing
 * reads `awaiting-handoff` and refuses. It never reads the card from the turn
 * before, which is the failure this state machine exists to make impossible.
 */
export type VoiceUtteranceContext =
  | { state: "no-call" }
  | { state: "no-reference" }
  | { state: "awaiting-handoff" }
  | {
    state: "joined";
    reference: SelectedContextRef;
    handoff: VoiceHandoffIdentity;
    utteranceId: string | null;
    sequence: number;
  };

export function voiceUtteranceContext(conversationId: string): VoiceUtteranceContext {
  const session = sessions.get(conversationId);
  if (!session) return { state: "no-call" };
  const admission = session.admission;
  if (!admission) return { state: "no-reference" };
  if (!admission.handoff) return { state: "awaiting-handoff" };
  return {
    state: "joined",
    reference: admission.reference,
    handoff: admission.handoff,
    utteranceId: admission.utteranceId,
    sequence: admission.sequence,
  };
}

/** Test seam: the ledger is process-global, so a suite must be able to start
    from an empty one without reaching into module internals. */
export function resetVoiceViewBindings(): void {
  sessions.clear();
}
