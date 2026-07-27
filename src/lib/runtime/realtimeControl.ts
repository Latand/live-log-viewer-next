import { redactCodexHostDiagnostic } from "./codexAppServerHost";
import { structuredDeliveryHostForConversation } from "./structuredDeliveryController";
import { permitRealtimeAction, type RealtimeCaller } from "./realtimeInjection";
import type { RuntimeVoiceDelivery } from "./voiceDelivery";

const MAX_SDP_BYTES = 512 * 1024;
const MAX_SPEECH_BYTES = 8 * 1024;

interface RealtimeHost {
  startRealtimeWebRtc(sdp: string): Promise<{ sdp: string; realtimeSessionId: string | null }>;
  appendRealtimeSpeech(text: string): Promise<void>;
  deliverRealtimeWorkerResponse?(delivery: RuntimeVoiceDelivery): Promise<{
    deliveryId: string;
    acknowledged: true;
  }>;
  stopRealtime(): Promise<void>;
  /** Optional so an older or stubbed host still satisfies the contract; the
      `status` action simply reports no failure when it is absent (#664). */
  lastRealtimeFailure?(): { message: string; at: string; realtimeSessionId: string | null } | null;
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

export async function executeRealtimeControl(
  body: unknown,
  resolveHost: (conversationId: string) => unknown = structuredDeliveryHostForConversation,
  /* #691 §6: who is calling, and which conversation the designation record names as
     the manager. Defaulted to the operator so every existing caller of this function
     (the browser's own control path, and its tests) keeps its behaviour; the route
     resolves the real caller from the capability header. */
  authority: { caller?: RealtimeCaller; managerConversationId?: string | null } = {},
): Promise<RealtimeControlResult> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { status: 400, body: { error: "body must be an object" } };
  }
  const request = body as Record<string, unknown>;

  /* Checked before the conversation is resolved and before any host is touched: an
     agent that may not speak must not be able to probe which conversations are
     hosted by watching the error it gets back. */
  const permitted = permitRealtimeAction(
    request.action,
    authority.caller ?? { kind: "operator" },
    authority.managerConversationId ?? null,
  );
  if (!permitted.allowed) {
    return { status: permitted.status, body: { error: permitted.error } };
  }

  const conversationId = typeof request.conversationId === "string" ? request.conversationId.trim() : "";
  if (!conversationId.startsWith("conversation_")) {
    return { status: 400, body: { error: "a canonical conversationId is required" } };
  }
  const host = realtimeHost(resolveHost(conversationId));
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
      return { status: 200, body: { ok: true, ...answer } };
    }
    if (request.action === "appendSpeech") {
      const text = typeof request.text === "string" ? request.text.trim() : "";
      if (!text || byteLength(text) > MAX_SPEECH_BYTES) {
        return { status: 400, body: { error: "speech text is empty or too large" } };
      }
      await host.appendRealtimeSpeech(text);
      return { status: 200, body: { ok: true } };
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
    return { status: 400, body: { error: "action must be start, appendSpeech, deliverWorkerResponse, stop, or status" } };
  } catch (error) {
    return { status: 409, body: { error: redactCodexHostDiagnostic(error) } };
  }
}
