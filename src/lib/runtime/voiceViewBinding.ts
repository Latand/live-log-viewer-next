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
 *   validates the reference against the binding and, only then, replaces what
 *   the call points at. A refusal changes NOTHING: the previously admitted
 *   reference stands, so a phone's stray publish cannot blank the desk's.
 * - `voiceSelectedContext` is what realtime delegation and tool routing read.
 *
 * Process-scoped and deliberately not durable: it describes a live transport. A
 * call does not survive the process, so neither should its binding — and a
 * binding that outlived its call would be exactly the stale authority the typed
 * refusals exist to prevent. The durable record of what a TURN pointed at lives
 * on the structured-user record instead.
 */

export interface VoiceSelectedContextAdmission {
  conversationId: string;
  realtimeSessionId: string;
  binding: VoiceViewBinding;
  reference: SelectedContextRef;
  admittedAt: string;
  /** Utterance boundary counter for this call: 1 for the first admission. */
  sequence: number;
}

interface VoiceSessionState {
  realtimeSessionId: string;
  binding: VoiceViewBinding | null;
  admission: VoiceSelectedContextAdmission | null;
  sequence: number;
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
  sessions.set(conversationId, { realtimeSessionId, binding, admission: null, sequence: 0 });
}

export function releaseVoiceSession(conversationId: string): void {
  sessions.delete(conversationId);
}

export interface VoiceSelectedContextAdmissionInput {
  conversationId: string;
  /** The credential the caller presented; must be the call's own. */
  realtimeSessionId: string;
  reference: SelectedContextRef | null;
  now: number;
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
  const bound = bindSelectedContextToVoiceSession({
    binding: session.binding,
    reference: input.reference,
    now: input.now,
  });
  if (!bound.ok) return bound;
  session.sequence += 1;
  session.admission = {
    conversationId: input.conversationId,
    realtimeSessionId: session.realtimeSessionId,
    binding: session.binding,
    reference: bound.reference,
    admittedAt: new Date(input.now).toISOString(),
    sequence: session.sequence,
  };
  return { ok: true, admission: session.admission };
}

/** What this conversation's live call currently points at. Read by realtime
    delegation and by tool routing; null when no call, no binding, or no
    utterance has been admitted yet. */
export function voiceSelectedContext(conversationId: string): VoiceSelectedContextAdmission | null {
  return sessions.get(conversationId)?.admission ?? null;
}

/** Test seam: the ledger is process-global, so a suite must be able to start
    from an empty one without reaching into module internals. */
export function resetVoiceViewBindings(): void {
  sessions.clear();
}
