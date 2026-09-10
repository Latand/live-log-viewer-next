import {
  bindSelectedContextToVoiceSession,
  type SelectedContextBindingFailure,
  type VoiceViewBinding,
} from "@/lib/realtime/selectedContextBinding";
import { parseSelectedContextRef, type SelectedContextRef } from "@/lib/selection/selectedContext";

/**
 * Which Viewer window a live voice call belongs to, what it last pointed at,
 * and which backing work is entitled to read that (#844 §4, #1629).
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
 * - `voiceUtteranceContext` is what tool routing reads, and it answers ABOUT ONE
 *   PIECE OF BACKING WORK rather than about the conversation. See below.
 *
 * Process-scoped and deliberately not durable: it describes a live transport and
 * the work that transport started. A call does not survive the process, so
 * neither should its binding — and a binding that outlived its call would be
 * exactly the stale authority the typed refusals exist to prevent. The durable
 * record of what a TURN pointed at lives on the structured-user record instead.
 */

/**
 * The identity native Codex carries from backing work into an MCP tool call.
 *
 * Read off `params._meta` by the MCP transport and validated against the host
 * this Viewer actually runs — a model cannot assert it, because it never sees
 * these fields and its own arguments are carried in a different namespace
 * (`docs/design/native-voice-work-identity.md`). Every field is evidence about
 * the CALLER; none of it is permission, and the ledger uses it only to decide
 * WHICH of its own records this caller is allowed to read.
 */
export interface VoiceWorkIdentity {
  /** Native thread the call came from, cross-checked against the host's own. */
  threadId: string;
  /** `_meta["x-codex-turn-metadata"].turn_id`: the backing turn's identity. */
  turnId: string;
  /**
   * `turn_trigger`, when the metadata carried one. `"realtime"` on a turn native
   * started from the realtime leg, and absent on an ordinary text turn — which
   * is the only evidence there is that a turn belongs to the call at all.
   */
  turnTrigger: string | null;
  /** The tool-call occurrence within that turn. Evidence, never identity. */
  callId: string | null;
  /** The provider output item the call came from. Evidence, never identity. */
  itemId: string | null;
}

/** What the host says about a backing turn this ledger has a record for. */
export type VoiceWorkState = "active" | "completed" | "unknown";

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

/** An admission plus the ledger's own bookkeeping about it. */
interface AdmissionRecord {
  admission: VoiceSelectedContextAdmission;
  /** Unique within this process; what a work binding actually points at. */
  id: string;
  /**
   * Which call generation admitted it. A hangup or reconnect closes a
   * generation: its records stay readable through bindings already made, and
   * nothing new may bind to them.
   */
  generation: number;
  /** The backing turn that claimed it, once one did. Never reassigned. */
  boundTurnId: string | null;
  /**
   * The host's idle counter when this record's handoff was accepted, or null
   * while it has none.
   *
   * A handoff is routed into a backing turn by native's own start-or-steer, so
   * a turn is running at or immediately after the join. When the host is
   * afterwards observed going idle, that turn has ended — which is the only
   * authoritative way to retire a join no tool call ever claimed. Without it a
   * spoken turn the agent answered by voice alone would leave an unclaimable
   * candidate behind and make every later card ambiguous.
   */
  joinedAtIdleEpoch: number | null;
}

interface VoiceSessionState {
  realtimeSessionId: string;
  /** Incremented by every `bindVoiceSession`, including a reconnect. */
  generation: number;
  binding: VoiceViewBinding | null;
  /** The admission the NEXT handoff report may complete. */
  standing: AdmissionRecord | null;
  records: AdmissionRecord[];
  sequence: number;
  /** The utterance sequence the standing admission was published for. */
  utteranceSequence: number | null;
  /** Set when the call ended while records were still standing. */
  endedAt: number | null;
  /** Canonical handoff identities this generation has already consumed. */
  handoffKeys: Set<string>;
  /**
   * Set when a handoff arrived that this peer could not attribute, and never
   * cleared within its generation. See {@link recordVoiceHandoffAmbiguity}.
   */
  ambiguity: { generation: number; reason: string; at: string } | null;
  /**
   * True once an unresolved record had to be dropped for space. The ledger no
   * longer knows what it knew, which is not the same as knowing there was
   * nothing — so reads answer `unavailable` rather than `no-call`.
   */
  evidenceLost: boolean;
  /** Incremented every time the host is observed going from running to idle. */
  idleEpoch: number;
  /** The host's last reported active turn, for spotting that transition. */
  lastActiveTurnId: string | null;
}

/**
 * How many admissions one conversation retains.
 *
 * Bounded because the ledger outlives a call now: work started by an utterance
 * keeps its record until the host says that work finished, and a host that never
 * answers would otherwise grow this without limit. Resolved records are dropped
 * first; dropping an unresolved one sets `evidenceLost`, so the bound costs
 * certainty rather than silently inventing it.
 */
const MAX_RETAINED_ADMISSIONS = 64;

const store = globalThis as typeof globalThis & {
  __llvVoiceViewBindings?: Map<string, VoiceSessionState>;
};
const sessions = store.__llvVoiceViewBindings ??= new Map<string, VoiceSessionState>();

let admissionCounter = 0;

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

/**
 * Bind a call to the window that opened it.
 *
 * A reconnect is a NEW GENERATION, not a fresh ledger. What the previous
 * generation left behind is kept exactly as far as the work it started may still
 * be running:
 *
 * - A record a backing turn already claimed is always carried. That turn is an
 *   accepted operation and it keeps its card through anything.
 * - A record whose utterance became a handoff but which no turn has claimed yet
 *   is carried only when the host says a turn is running. That is the reconnect
 *   the operator actually hits — hang up, come back, and the agent is still
 *   working on what they last said — and without the host's evidence there is
 *   nothing to distinguish it from a call that finished with nothing pending.
 * - Everything else is dropped: an utterance that never became work has no work
 *   to be entitled to it.
 *
 * The previous generation's ambiguity is retained, because it describes handoff
 * reports that may still arrive.
 */
export function bindVoiceSession(
  conversationId: string,
  realtimeSessionId: string,
  binding: VoiceViewBinding | null,
  evidence: { activeWork?: boolean } = {},
): void {
  const previous = sessions.get(conversationId);
  const carried = previous
    ? previous.records.filter((record) =>
      record.boundTurnId !== null
      || (evidence.activeWork === true && record.admission.handoff !== null))
    : [];
  sessions.set(conversationId, {
    realtimeSessionId,
    generation: (previous?.generation ?? 0) + 1,
    binding,
    standing: null,
    records: carried,
    sequence: 0,
    utteranceSequence: null,
    endedAt: null,
    handoffKeys: new Set(),
    ambiguity: previous?.ambiguity ?? null,
    evidenceLost: previous?.evidenceLost ?? false,
    idleEpoch: previous?.idleEpoch ?? 0,
    lastActiveTurnId: previous?.lastActiveTurnId ?? null,
  });
}

/**
 * Hang up, and keep exactly what the work still running may legitimately need.
 *
 * A turn started by the last thing the operator said outlives the transport that
 * carried it: they ask for something, hang up, and the agent is still working
 * when it reaches for the card they were pointing at. Dropping the whole ledger
 * at `stop` threw that away, so the tool answered "you have no call" to work the
 * call itself started.
 *
 * What is kept is bounded by WORK, never by a clock. A record whose utterance
 * never became a handoff describes something that never became work, so nothing
 * is running that could need it. Everything else is retired by
 * {@link voiceUtteranceContext} when the host says its turn finished — see
 * {@link VoiceWorkState}. Elapsed time proves nothing about whether an agent is
 * still working, and the earlier ten-minute window both discarded live work and
 * left a finished call's card available to unrelated turns.
 */
export function releaseVoiceSession(conversationId: string, now = Date.now()): void {
  const session = sessions.get(conversationId);
  if (!session) return;
  session.records = session.records.filter((record) => record.admission.handoff !== null);
  if (session.records.length === 0) {
    sessions.delete(conversationId);
    return;
  }
  session.binding = null;
  session.standing = null;
  session.endedAt = now;
}

/**
 * Conversations holding a LIVE voice call right now.
 *
 * Automatic host retirement (#747) reads this: a call in progress holds a
 * transport that no transcript can restore, so it is never a retirement
 * candidate. What a finished call left behind is deliberately NOT reported here
 * — that is a record about work, and the work's own liveness is what decides
 * whether its host may retire. Reporting it would make one hangup pin a host for
 * as long as the ledger kept anything at all.
 */
export function realtimeBoundConversationIds(): ReadonlySet<string> {
  return new Set(
    [...sessions.entries()]
      .filter(([, session]) => session.endedAt === null)
      .map(([conversationId]) => conversationId),
  );
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

/**
 * Keep the retained set inside its bound.
 *
 * Resolved records go first, oldest to newest: a record whose turn is bound and
 * whose generation is closed has already answered every question it can. Only
 * when nothing resolved is left does an unresolved record go, and then the
 * session says so — the alternative is a ledger that quietly forgets an
 * unanswered question and then answers "there was none".
 */
function enforceRetentionBound(session: VoiceSessionState): void {
  while (session.records.length > MAX_RETAINED_ADMISSIONS) {
    const resolvedIndex = session.records.findIndex((record) =>
      record.boundTurnId !== null && record.generation !== session.generation);
    if (resolvedIndex >= 0) {
      session.records.splice(resolvedIndex, 1);
      continue;
    }
    const dropped = session.records.shift();
    if (dropped && dropped.admission.handoff) session.evidenceLost = true;
  }
}

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
  if (utterance && session.standing?.admission.utteranceId === utterance.id) {
    return { ok: true, admission: session.standing.admission };
  }
  const bound = bindSelectedContextToVoiceSession({
    binding: session.binding,
    reference: input.reference,
    now: input.now,
  });
  if (!bound.ok) return bound;
  if (!supersedes({ reference: bound.reference, utterance }, session.standing?.admission ?? null, session.utteranceSequence)) {
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
  admissionCounter += 1;
  const record: AdmissionRecord = {
    id: `admission-${admissionCounter}`,
    generation: session.generation,
    boundTurnId: null,
    joinedAtIdleEpoch: null,
    admission: {
      conversationId: input.conversationId,
      realtimeSessionId: session.realtimeSessionId,
      binding: session.binding,
      reference: bound.reference,
      admittedAt: new Date(input.now).toISOString(),
      sequence: session.sequence,
      utteranceId: utterance?.id ?? null,
      handoff: null,
    },
  };
  /* An utterance that was replaced before it ever became work describes nothing
     that is running, and keeping it would leave a second unclaimed candidate for
     the next backing turn to be ambiguous about. */
  if (session.standing && session.standing.admission.handoff === null) {
    session.records = session.records.filter((candidate) => candidate !== session.standing);
  }
  session.records.push(record);
  session.standing = record;
  enforceRetentionBound(session);
  return { ok: true, admission: record.admission };
}

/** The canonical name of one handoff, for a generation's dedup set. */
function handoffKey(generation: number, handoff: VoiceHandoffIdentity): string {
  return [generation, handoff.handoffId ?? "", handoff.itemId ?? "", handoff.userBidiTurnId ?? ""].join(" ");
}

/**
 * Record which handoff an already-admitted utterance became.
 *
 * It mints no utterance, moves no counter and replaces no reference: it only
 * completes the record of one that already exists, so a handoff reported for an
 * utterance the ledger has moved past — a late event, or one belonging to a
 * superseded publication — is dropped rather than allowed to reopen it.
 *
 * AND THE SAME HANDOFF IS ONLY EVER ONE HANDOFF. Canonical identities are
 * deduplicated per generation, so a report that arrives twice completes the
 * record it already completed and claims nothing new. Without that, repeating a
 * handoff after the operator spoke again attached the earlier work's identities
 * to the later utterance's card — one of the two ways a question about card A
 * used to be answered about card B.
 *
 * WHAT IT CANNOT CHECK is whether the caller labelled a FIRST report correctly.
 * The peer that hears the operator is the only one that sees both the transcript
 * boundary and the handoff, so it is the only one that can tell whether the
 * association is a fact; this end refuses everything that contradicts its own
 * record and trusts the rest. That is why the client reports ambiguity instead
 * of a join when more than one utterance is outstanding.
 */
export function recordVoiceHandoff(input: {
  conversationId: string;
  realtimeSessionId: string;
  utterance: VoiceUtteranceIdentity;
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
  const key = handoffKey(session.generation, input.handoff);
  if (session.handoffKeys.has(key)) {
    const already = session.records.find((record) =>
      record.generation === session.generation
      && record.admission.handoff !== null
      && handoffKey(record.generation, record.admission.handoff) === key);
    /* Idempotent for the report it already accepted; refused for anything else,
       because a canonical identity that has been used cannot be spent again. */
    if (already && already.admission.utteranceId === input.utterance.id) {
      return { ok: true, admission: already.admission };
    }
    return {
      ok: false,
      failure: {
        code: "superseded",
        message: "This handoff has already been recorded for this call, so it cannot be joined to another utterance.",
      },
    };
  }
  const standing = session.standing;
  /* BOTH halves of the identity, because they answer different questions. The id
     says which publication this report belongs to; the sequence says where that
     publication sits in the call. A report whose halves disagree describes a
     boundary this ledger never saw, and completing the standing admission from
     it would attach one turn's work to another turn's card. */
  if (!standing
    || standing.admission.utteranceId !== input.utterance.id
    || session.utteranceSequence !== input.utterance.sequence) {
    return {
      ok: false,
      failure: {
        code: "superseded",
        message: "This voice session has already been told about a later utterance, so an earlier one cannot replace it.",
      },
    };
  }
  session.handoffKeys.add(key);
  standing.admission = { ...standing.admission, handoff: input.handoff };
  standing.joinedAtIdleEpoch = session.idleEpoch;
  return { ok: true, admission: standing.admission };
}

/**
 * The call could not say which utterance a handoff belongs to (#1629).
 *
 * Reported by the browser, which is the only peer that can see the arrangement:
 * a handoff arriving while two utterances are outstanding could belong to
 * either, and native emits no acceptance receipt naming which
 * (`docs/design/native-voice-work-identity.md`). The earlier client dropped its
 * queue and carried on, which meant the NEXT handoff — belonging to one of the
 * abandoned utterances — was attributed to whatever had been said since.
 *
 * So uncertainty is recorded rather than discarded, and it stands for the rest
 * of its generation: every unattributed utterance may still produce a handoff at
 * any time, so no later arrival can be shown to be anyone's. Implicit selection
 * stays unavailable until a new call, and explicit targeting is unaffected.
 */
export function recordVoiceHandoffAmbiguity(input: {
  conversationId: string;
  realtimeSessionId: string;
  reason: string;
  now?: number;
}): { ok: true } | { ok: false; failure: SelectedContextBindingFailure } {
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
  session.ambiguity ??= {
    generation: session.generation,
    reason: input.reason,
    at: new Date(input.now ?? Date.now()).toISOString(),
  };
  return { ok: true };
}

/**
 * What the host is doing right now, as its own state projection reports it.
 *
 * Called from the Viewer's structured-host state listener — the same process
 * this ledger lives in — so a turn ending is observed rather than inferred. The
 * running-to-idle transition is the retirement evidence for a join no tool call
 * ever claimed: native routes a handoff into a running turn or starts one, so
 * once the thread is idle again that work is over.
 *
 * Idempotent and cheap: a conversation with no call ignores it entirely.
 */
export function noteVoiceWorkBoundary(conversationId: string, activeTurnId: string | null): void {
  const session = sessions.get(conversationId);
  if (!session) return;
  if (session.lastActiveTurnId !== null && activeTurnId === null) session.idleEpoch += 1;
  session.lastActiveTurnId = activeTurnId;
}

/** What this conversation's live call currently points at. Null when no call, no
    binding, or no utterance has been admitted yet. Evidence for the panel and
    the control endpoint; tool routing reads {@link voiceUtteranceContext}. */
export function voiceSelectedContext(conversationId: string): VoiceSelectedContextAdmission | null {
  return sessions.get(conversationId)?.standing?.admission ?? null;
}

/**
 * What a tool call made from this conversation is entitled to read (#1629).
 *
 * This is the whole reader contract, and it is a state rather than a value on
 * purpose: every way there is no card means something different to the agent
 * holding the microphone, and collapsing them into `null` is how the agent ends
 * up guessing.
 *
 * THE QUESTION IS ABOUT WORK, NOT ABOUT THE CONVERSATION. A conversation-level
 * answer cannot be right: while A's work is still running the operator may have
 * spoken about B, and "what does this conversation point at" then hands A's tool
 * call B's card. So the caller must present the native work identity its request
 * actually carried, and the answer is about THAT turn:
 *
 * - A turn that has already claimed a record keeps it, unchanged, forever. An
 *   accepted operation is frozen: later utterances, later calls and a hangup all
 *   leave it exactly where it was.
 * - A turn that has claimed nothing may claim one only when exactly one
 *   unclaimed join exists in the CURRENT generation and nothing about the call
 *   is ambiguous. Two candidates is the same problem native has: multiple
 *   handoffs can share one backing turn, so there is no discriminator and the
 *   answer is a refusal.
 * - A turn native did not start from the realtime leg never claims anything.
 *   That is the unrelated later text turn, and inheriting the call's card there
 *   is precisely the leak this state machine exists to close.
 *
 * A hangup does not end any of it. The work the last utterance started outlives
 * the transport, and it is retired here when the host says that turn finished —
 * never on a clock.
 */
export type VoiceUtteranceContext =
  | { state: "no-call" }
  | { state: "no-reference" }
  | { state: "awaiting-handoff" }
  /** The caller could not prove which backing work it is. */
  | { state: "unidentified-work"; reason: string }
  /** The caller's work exists, but nothing about the call belongs to it. */
  | { state: "unrelated-work" }
  /** Evidence exists but cannot pick one card, and saying so is the answer. */
  | { state: "ambiguous"; reason: string }
  /** The ledger knew something and no longer does. */
  | { state: "unavailable"; reason: string }
  | {
    state: "joined";
    reference: SelectedContextRef;
    handoff: VoiceHandoffIdentity;
    utteranceId: string | null;
    sequence: number;
    /** True when the call has ended and this is what it left for the work it
        started. The card is still the one that work was asked about. */
    callEnded: boolean;
  };

export interface VoiceUtteranceContextOptions {
  /** The native work identity the caller's own request carried, if any. */
  work?: VoiceWorkIdentity | null;
  /** The host's verdict on a backing turn. Absent means every turn is unknown,
      which retires nothing — uncertainty is preserved rather than resolved. */
  workState?(turnId: string): VoiceWorkState;
}

function joined(record: AdmissionRecord, session: VoiceSessionState): VoiceUtteranceContext {
  return {
    state: "joined",
    reference: record.admission.reference,
    handoff: record.admission.handoff!,
    utteranceId: record.admission.utteranceId,
    sequence: record.admission.sequence,
    /* Evidence, so a reader can tell live context from what a finished call
       left behind for the work it started. */
    callEnded: session.endedAt !== null,
  };
}

/**
 * Retire what the host says is finished, and only that.
 *
 * A bound record whose turn the host reports `completed` has answered its last
 * question: that turn makes no further tool calls. A turn the host cannot speak
 * for is `unknown` and is KEPT — a host that died or was replaced is missing
 * evidence, and treating missing evidence as completion is the same mistake the
 * ten-minute window made.
 */
function retireCompletedWork(session: VoiceSessionState, options: VoiceUtteranceContextOptions): void {
  session.records = session.records.filter((record) => {
    if (record.boundTurnId !== null) {
      return !options.workState || options.workState(record.boundTurnId) !== "completed";
    }
    /* Never claimed by a tool call. It is retired only once the host has been
       seen going idle SINCE the join — the turn that handoff was routed into has
       then ended, and nothing is left that could be entitled to the card. */
    return record.joinedAtIdleEpoch === null || record.joinedAtIdleEpoch >= session.idleEpoch;
  });
}

export function voiceUtteranceContext(
  conversationId: string,
  options: VoiceUtteranceContextOptions = {},
): VoiceUtteranceContext {
  const session = sessions.get(conversationId);
  if (!session) return { state: "no-call" };
  retireCompletedWork(session, options);
  /* A finished call whose work is all finished too has nothing left to say, and
     leaving the row behind would keep answering about a call nobody is on. */
  if (session.endedAt !== null && session.records.length === 0 && !session.evidenceLost) {
    sessions.delete(conversationId);
    return { state: "no-call" };
  }
  const work = options.work ?? null;
  if (!work) {
    return {
      state: "unidentified-work",
      reason: "this request carries no backing-turn identity, so which work it belongs to cannot be established",
    };
  }
  const bound = session.records.find((record) => record.boundTurnId === work.turnId);
  if (bound) return joined(bound, session);
  if (session.ambiguity) return { state: "ambiguous", reason: session.ambiguity.reason };
  if (session.evidenceLost) {
    return {
      state: "unavailable",
      reason: "this call's earlier utterance records were dropped for space, so an unclaimed join cannot be ruled out",
    };
  }
  /* Only a turn native started FROM the call may claim what the call admitted.
     `turn_trigger` is the one piece of evidence that says so, and an ordinary
     text turn carries none. */
  if (work.turnTrigger !== "realtime") return { state: "unrelated-work" };
  /* A SPOKEN TURN WITH NO HANDOFF YET BLOCKS EVERY NEW CLAIM. The operator has
     said something whose work has not been reported, so an unclaimed join from
     before it cannot be shown to be this caller's rather than that one's — the
     handoff report is asynchronous and the backing turn may already be running.
     Refusing here is the conservative half of the same rule that freezes an
     accepted binding: work that already claimed a card keeps it (checked
     above), and nothing new is guessed at. */
  if (session.standing && session.standing.admission.handoff === null) return { state: "awaiting-handoff" };
  const candidates = session.records.filter((record) =>
    record.boundTurnId === null && record.admission.handoff !== null);
  if (candidates.length > 1) {
    return {
      state: "ambiguous",
      reason: "more than one spoken turn is waiting to be claimed, and native gives no way to tell which of them this work is",
    };
  }
  if (candidates.length === 0) return { state: "no-reference" };
  const claimed = candidates[0]!;
  claimed.boundTurnId = work.turnId;
  return joined(claimed, session);
}

/** Test seam: the ledger is process-global, so a suite must be able to start
    from an empty one without reaching into module internals. */
export function resetVoiceViewBindings(): void {
  sessions.clear();
}
