import { parseSelectedContextRef } from "@/lib/selection/selectedContext";

import { redactCodexHostDiagnostic } from "./codexAppServerHost";
import { structuredDeliveryHostForConversation } from "./structuredDeliveryController";
import { permitRealtimeAction, type RealtimeCaller } from "./realtimeInjection";
import type { RuntimeVoiceDelivery } from "./voiceDelivery";
import type { VoicePersonaBootstrapReceipt } from "./voicePersona";
import {
  admitVoiceSelectedContext,
  bindVoiceSession,
  parseVoiceViewBinding,
  releaseVoiceSession,
} from "./voiceViewBinding";

const MAX_SDP_BYTES = 512 * 1024;
const MAX_SPEECH_BYTES = 8 * 1024;

interface RealtimeHost {
  startRealtimeWebRtc(sdp: string): Promise<{
    sdp: string | null;
    realtimeSessionId: string | null;
    personaBootstrap: VoicePersonaBootstrapReceipt;
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

function voicePersonaBootstrapReceipt(value: unknown): VoicePersonaBootstrapReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  const receiptId = typeof receipt.receiptId === "string" ? receipt.receiptId : "";
  const itemId = typeof receipt.itemId === "string" ? receipt.itemId : "";
  if (!/^voice_persona_[a-f0-9]{46}$/.test(receiptId) || itemId !== `msg_${receiptId}`) return null;
  if (receipt.insertion !== "accepted" && receipt.insertion !== "rejected") return null;
  if (receipt.diagnostic !== undefined
    && (typeof receipt.diagnostic !== "string" || receipt.diagnostic.length > 500)) return null;
  return receipt as VoicePersonaBootstrapReceipt;
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
  authority: { caller?: RealtimeCaller; managerConversationId?: string | null; operator: boolean },
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
      const answer = await host.startRealtimeWebRtc(sdp);
      if (!answer.personaBootstrap) {
        return rejectStartedRealtimeContract(host, { error: "Codex returned no voice persona bootstrap receipt" });
      }
      const personaBootstrap = voicePersonaBootstrapReceipt(answer.personaBootstrap);
      if (!personaBootstrap) {
        return rejectStartedRealtimeContract(host, { error: "Codex returned an invalid voice persona bootstrap receipt" });
      }
      if (personaBootstrap.insertion === "rejected") {
        const diagnostic = redactCodexHostDiagnostic(personaBootstrap.diagnostic ?? "Voice persona insertion was rejected");
        const error = redactCodexHostDiagnostic(`Voice persona could not be recorded: ${diagnostic}`);
        return rejectStartedRealtimeContract(host, {
          error,
          personaBootstrap: { ...personaBootstrap, diagnostic },
        });
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
      return { status: 200, body: { ok: true, ...answer, personaBootstrap } };
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
    return { status: 400, body: { error: "action must be start, selectedContext, appendSpeech, deliverWorkerResponse, stop, or status" } };
  } catch (error) {
    return { status: 409, body: { error: redactCodexHostDiagnostic(error) } };
  }
}
