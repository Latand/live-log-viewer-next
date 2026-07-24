import { redactCodexHostDiagnostic } from "./codexAppServerHost";
import { structuredDeliveryHostForConversation } from "./structuredDeliveryController";

const MAX_SDP_BYTES = 512 * 1024;
const MAX_SPEECH_BYTES = 8 * 1024;

interface RealtimeHost {
  startRealtimeWebRtc(sdp: string): Promise<{ sdp: string; realtimeSessionId: string | null }>;
  appendRealtimeSpeech(text: string): Promise<void>;
  stopRealtime(): Promise<void>;
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
    if (request.action === "stop") {
      await host.stopRealtime();
      return { status: 200, body: { ok: true } };
    }
    return { status: 400, body: { error: "action must be start, appendSpeech, or stop" } };
  } catch (error) {
    return { status: 409, body: { error: redactCodexHostDiagnostic(error) } };
  }
}
