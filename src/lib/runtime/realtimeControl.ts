import { parseSelectedContextRef } from "@/lib/selection/selectedContext";

import { redactCodexHostDiagnostic } from "./codexAppServerHost";
import { structuredDeliveryHostForConversation } from "./structuredDeliveryController";
import { permitRealtimeAction, type RealtimeCaller } from "./realtimeInjection";
import type { RuntimeVoiceDelivery } from "./voiceDelivery";
import type { VoicePersonaVariant } from "./voicePersona";
import {
  admitVoiceSelectedContext,
  bindVoiceSession,
  parseVoiceViewBinding,
  recordVoiceHandoff,
  releaseVoiceSession,
  voiceUtteranceContext,
  type VoiceHandoffIdentity,
  type VoiceUtteranceIdentity,
} from "./voiceViewBinding";
import { recordDirectOperatorWakatimeActivity } from "@/lib/wakatime/operatorActivity";

const MAX_SDP_BYTES = 512 * 1024;
const MAX_SPEECH_BYTES = 8 * 1024;

interface RealtimeHost {
  startRealtimeWebRtc(sdp: string, personaVariant?: VoicePersonaVariant): Promise<{
    sdp: string | null;
    realtimeSessionId: string | null;
    persona: { variant: VoicePersonaVariant; personaId: string };
  }>;
  appendRealtimeSpeech(text: string): Promise<void>;
  deliverRealtimeWorkerResponse?(delivery: RuntimeVoiceDelivery): Promise<{
    deliveryId: string;
    acknowledged: true;
  }>;
  stopRealtime(): Promise<void>;
  /** Optional so an older or stubbed host still satisfies the contract; the
      `status` action simply reports no failure when it is absent (#664). */
  lastRealtimeFailure?(): { message: string; at: string; realtimeSessionId: string | null } | null;
  /** #691 §6: the live session id injection is authorized against. Absent on a host
      that cannot report one, which denies session-based callers rather than
      admitting them. */
  currentRealtimeSessionId?(): string | null;
}

export type RealtimeControlResult = {
  status: number;
  body: Record<string, unknown>;
};

interface RealtimeControlDependencies {
  recordOperatorActivity: typeof recordDirectOperatorWakatimeActivity;
}

const REALTIME_CONTROL_DEPENDENCIES: RealtimeControlDependencies = {
  recordOperatorActivity: recordDirectOperatorWakatimeActivity,
};

function realtimeHost(value: unknown): RealtimeHost | null {
  if (!value || typeof value !== "object") return null;
  const host = value as Partial<RealtimeHost>;
  return typeof host.startRealtimeWebRtc === "function"
    && typeof host.appendRealtimeSpeech === "function"
    && typeof host.stopRealtime === "function"
    ? host as RealtimeHost
    : null;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** At least one canonical id, each bounded; a report naming nothing is refused. */
function voiceHandoffIdentity(value: unknown): VoiceHandoffIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const id = (key: string): string | null => {
    const raw = body[key];
    return typeof raw === "string" && raw.length > 0 && raw.length <= 200 ? raw : null;
  };
  const handoff = {
    handoffId: id("handoffId"),
    itemId: id("itemId"),
    userBidiTurnId: id("userBidiTurnId"),
  };
  return handoff.handoffId || handoff.itemId || handoff.userBidiTurnId ? handoff : null;
}

/**
 * The utterance a publication speaks for (#1629).
 *
 * Named by the browser, because the browser is the peer that sees the operator's
 * transcript go final — the operator's audio never passes through this server.
 * A malformed identity is dropped rather than refused where a reference is being
 * published: the reference is still the bound view's and still admissible, and
 * the ordering rules fall back to its own revision. A handoff report has nothing
 * left once it is dropped, so that path refuses instead.
 */
function voiceUtteranceIdentity(value: unknown): VoiceUtteranceIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const id = typeof body.id === "string" ? body.id : "";
  const sequence = body.sequence;
  if (!/^[a-f0-9]{32}$/.test(id)) return null;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) return null;
  return { id, sequence };
}

/**
 * Which persona the started call is running on (#1629).
 *
 * The persona now rides on `thread/realtime/start` itself, so a started call has
 * one by construction and there is no insertion to accept or reject. This
 * validates the shape only, so a host that answers something else is caught
 * rather than reported to the browser as a live persona.
 */
function voiceSessionPersonaReceipt(value: unknown): { variant: VoicePersonaVariant; personaId: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  const personaId = typeof receipt.personaId === "string" ? receipt.personaId : "";
  if (!/^voice_persona_[a-f0-9]{46}$/.test(personaId)) return null;
  if (receipt.variant !== "coordinator" && receipt.variant !== "modality") return null;
  return { variant: receipt.variant, personaId };
}

async function rejectStartedRealtimeContract(
  host: RealtimeHost,
  body: Record<string, unknown>,
): Promise<RealtimeControlResult> {
  try {
    await host.stopRealtime();
    return { status: 409, body };
  } catch (error) {
    return {
      status: 409,
      body: {
        ...body,
        error: redactCodexHostDiagnostic(`${String(body.error)}; realtime cleanup failed: ${redactCodexHostDiagnostic(error)}`),
      },
    };
  }
}

export async function executeRealtimeControl(
  body: unknown,
  resolveHost: (conversationId: string) => unknown = structuredDeliveryHostForConversation,
  /* #691 §6: who is calling, which conversation the designation record names as the
     manager, and whether this request carries the operator's own authority.
     `operator` is REQUIRED and never defaulted: it is the answer to a question only
     the caller's transport can ask (`voiceTransportOperator` reads the request's
     headers), so a call site that omits it has not asked — and an unasked authority
     question must resolve to "no", not to "yes". */
  authority: {
    caller?: RealtimeCaller;
    managerConversationId?: string | null;
    operator: boolean;
    /** Which persona a `start` bootstraps (#1615). Omitted is `modality`. */
    personaVariant?: VoicePersonaVariant;
  },
  dependencies: RealtimeControlDependencies = REALTIME_CONTROL_DEPENDENCIES,
): Promise<RealtimeControlResult> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, body: { error: "body must be an object" } };
  }
  const request = body as Record<string, unknown>;


  const conversationId = typeof request.conversationId === "string" ? request.conversationId.trim() : "";
  if (!conversationId.startsWith("conversation_")) {
    return { status: 400, body: { error: "a canonical conversationId is required" } };
  }
  const host = realtimeHost(resolveHost(conversationId));

  /* Authorized before anything is DONE, but after the host is looked up, because the
     live session id is the credential a browser presents and only the host holds it.
     The refusal is identical whether or not a host exists, so an agent that may not
     speak cannot probe which conversations are hosted by reading the error. */
  const caller: RealtimeCaller = authority.caller ?? { kind: "anonymous" };
  const permitted = permitRealtimeAction(
    request.action,
    caller,
    authority.managerConversationId ?? null,
    host?.currentRealtimeSessionId?.() ?? null,
    /* Passed straight through, with no default on either side of it. A default of
       `true` is an open door for any future call site that forgets the question;
       a default of `false` silently refuses the browser's own one-click start.
       Requiring it makes both mistakes a type error instead. */
    authority.operator,
  );
  if (!permitted.allowed) {
    return { status: permitted.status, body: { error: permitted.error } };
  }

  /**
   * The reader (#1629), answered before the host requirement because it reads a
   * process-local ledger and needs no thread.
   *
   * The agent running the backing turn asks what the operator was looking at
   * when they spoke. It is entitled to that about ITS OWN call and nothing else,
   * which the capability the registry mapped is what establishes — an agent
   * cannot ask about another conversation's call, and a caller presenting
   * nothing cannot ask at all.
   *
   * Every answer is 200 with a state, including the ones that say no. The four
   * ways there is no card mean different things to the agent holding the
   * microphone, and an error would flatten them into "something went wrong".
   */
  if (request.action === "utteranceContext") {
    const own = caller.kind === "conversation" && caller.conversationId === conversationId;
    if (!own && !authority.operator) {
      return {
        status: 403,
        body: {
          error: "utteranceContext reads what the operator's own voice call points at. "
            + "Only that call's conversation may read it.",
        },
      };
    }
    return { status: 200, body: { ok: true, utterance: voiceUtteranceContext(conversationId) } };
  }

  if (!host) {
    return { status: 409, body: { error: "the active conversation has no hosted Codex realtime thread" } };
  }

  try {
    if (request.action === "start") {
      /* Never trim the SDP: its grammar requires a terminal CRLF, and OpenAI's
         parser rejects an offer whose last line is unterminated ("unmarshal
         SDP: EOF"). Validate on a trimmed view only. */
      const sdp = typeof request.sdp === "string" ? request.sdp : "";
      if (!sdp.trimStart().startsWith("v=0") || byteLength(sdp) > MAX_SDP_BYTES) {
        return { status: 400, body: { error: "a valid WebRTC SDP offer is required" } };
      }
      /* #1615: voice is a modality, so the persona a call bootstraps is decided
         from WHAT THIS CONVERSATION ALREADY IS, resolved per start rather than
         cached — a seat rotation between two calls must be seen by the second.
         Absent, it is `modality`: the variant that assigns no role, because a
         call site that did not ask has not established that this thread is the
         voice front. */
      const answer = await host.startRealtimeWebRtc(sdp, authority.personaVariant ?? "modality");
      const persona = voiceSessionPersonaReceipt(answer.persona);
      if (!persona) {
        return rejectStartedRealtimeContract(host, { error: "Codex returned no voice session persona" });
      }
      if (!answer.sdp) {
        return rejectStartedRealtimeContract(host, { error: "Codex returned no WebRTC answer" });
      }
      /* #844 §4: the call belongs to the window that opened it, from here on.
         A browser that presents no usable view/device binds to nothing, which
         refuses every later selected-card reference rather than accepting the
         first one offered — the same fail-closed rule injection follows. */
      if (answer.realtimeSessionId) {
        bindVoiceSession(conversationId, answer.realtimeSessionId, parseVoiceViewBinding(request.view));
      }
      return { status: 200, body: { ok: true, ...answer, persona } };
    }
    /**
     * The browser's utterance boundary (#844 §2).
     *
     * The operator's speech never passes through this server — it rides the
     * WebRTC leg straight to the model — so the only place a spoken turn can be
     * paired with a selected card is the moment the browser sees its own
     * transcript go final. That is what this action reports, and it writes no
     * words: it records what the NEXT delegated turn points at.
     *
     * Not listed in `REALTIME_INJECTION_ACTIONS`, and deliberately so. The
     * authority check is not a separate allowlist but the ledger itself: the
     * admission matches the presented session id against the one this call was
     * bound to, so a caller presenting nothing (or another call's id) is
     * refused `unbound` without a second rule to keep in sync.
     */
    if (request.action === "selectedContext") {
      const admission = admitVoiceSelectedContext({
        conversationId,
        realtimeSessionId: caller.kind === "session" ? caller.realtimeSessionId : "",
        reference: parseSelectedContextRef(request.selectedContext),
        utterance: voiceUtteranceIdentity(request.utterance),
        now: Date.now(),
      });
      if (!admission.ok) {
        return { status: 409, body: { error: admission.failure.message, code: admission.failure.code } };
      }
      return {
        status: 200,
        body: { ok: true, selectedContext: admission.admission.reference, sequence: admission.admission.sequence },
      };
    }
    /**
     * Which handoff the last published utterance became (#1629).
     *
     * Authorized the same way `selectedContext` is — by the ledger, against the
     * session id the call was bound to — because it completes that ledger's own
     * record and nothing else. It writes no words, mints no utterance and moves
     * no counter.
     */
    if (request.action === "handoff") {
      const utterance = voiceUtteranceIdentity(request.utterance);
      const handoff = voiceHandoffIdentity(request.handoff);
      if (!utterance || !handoff) {
        return { status: 400, body: { error: "a handoff report needs an utterance identity and at least one handoff id" } };
      }
      const recorded = recordVoiceHandoff({
        conversationId,
        realtimeSessionId: caller.kind === "session" ? caller.realtimeSessionId : "",
        utteranceId: utterance.id,
        handoff,
      });
      if (!recorded.ok) {
        return { status: 409, body: { error: recorded.failure.message, code: recorded.failure.code } };
      }
      return { status: 200, body: { ok: true, handoff: recorded.admission.handoff } };
    }
    if (request.action === "operatorActivity") {
      const operatorEventId = typeof request.operatorEventId === "string" ? request.operatorEventId.trim() : "";
      if (!/^[a-f0-9]{64}$/.test(operatorEventId)) {
        return { status: 400, body: { error: "operatorEventId must be a 64-character lowercase hexadecimal identity" } };
      }
      if (caller.kind !== "session" || caller.realtimeSessionId !== host.currentRealtimeSessionId?.()) {
        return { status: 403, body: { error: "operator activity requires the live realtime peer" } };
      }
      try {
        dependencies.recordOperatorActivity({
          conversationId,
          idempotencyKey: `realtime:${operatorEventId}`,
        });
      } catch {
        return { status: 503, body: { error: "direct operator activity could not be recorded" } };
      }
      return { status: 200, body: { ok: true, operatorEventId } };
    }
    if (request.action === "appendSpeech") {
      const text = typeof request.text === "string" ? request.text.trim() : "";
      if (!text || byteLength(text) > MAX_SPEECH_BYTES) {
        return { status: 400, body: { error: "speech text is empty or too large" } };
      }
      /* ATOMIC WITH THE UTTERANCE. The reference is admitted BEFORE the speech
         is written, and a refusal writes nothing: an utterance that says "look
         at that one" must not reach the agent with its "that one" dropped, and
         the operator gets a typed reason instead of a confidently wrong answer.
         An utterance carrying no reference at all is ordinary voice and passes
         straight through — this feature adds a capability, it does not make
         speaking conditional on having selected something. */
      let admitted: Record<string, unknown> = {};
      if (request.selectedContext !== undefined) {
        const reference = parseSelectedContextRef(request.selectedContext);
        const admission = admitVoiceSelectedContext({
          conversationId,
          realtimeSessionId: caller.kind === "session" ? caller.realtimeSessionId : "",
          reference,
          utterance: voiceUtteranceIdentity(request.utterance),
          now: Date.now(),
        });
        if (!admission.ok) {
          return { status: 409, body: { error: admission.failure.message, code: admission.failure.code } };
        }
        admitted = { selectedContext: admission.admission.reference };
      }
      await host.appendRealtimeSpeech(text);
      return { status: 200, body: { ok: true, ...admitted } };
    }
    if (request.action === "deliverWorkerResponse") {
      if (typeof host.deliverRealtimeWorkerResponse !== "function") {
        return { status: 409, body: { error: "the hosted realtime receiver does not support durable worker delivery" } };
      }
      const result = await host.deliverRealtimeWorkerResponse(request.delivery as RuntimeVoiceDelivery);
      return { status: 200, body: { ok: true, ...result } };
    }
    if (request.action === "stop") {
      await host.stopRealtime();
      /* The binding describes a live transport, so it dies with it. A binding
         that outlived its call would be exactly the stale authority the typed
         refusals exist to prevent. */
      releaseVoiceSession(conversationId);
      return { status: 200, body: { ok: true } };
    }
    /* Why the browser asks (#664): it owns the WebRTC leg and sees only that
       the transport died. The reason arrived on the app-server's sideband
       channel, so the operator gets the backend's own words instead of a
       generic interruption notice. */
    if (request.action === "status") {
      const failure = host.lastRealtimeFailure?.() ?? null;
      return {
        status: 200,
        body: {
          ok: true,
          failure: failure
            ? { ...failure, message: redactCodexHostDiagnostic(new Error(failure.message)) }
            : null,
        },
      };
    }
    return { status: 400, body: { error: "action must be start, operatorActivity, selectedContext, handoff, utteranceContext, appendSpeech, deliverWorkerResponse, stop, or status" } };
  } catch (error) {
    return { status: 409, body: { error: redactCodexHostDiagnostic(error) } };
  }
}
