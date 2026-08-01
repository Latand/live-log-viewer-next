import type { SelectedContextRef } from "@/lib/selection/selectedContext";

/**
 * Binding a spoken turn's selected-card reference to the view that produced it
 * (#844 §4).
 *
 * A typed composer send needs no binding check: the reference travels inside the
 * same request as the text, from the same document, so the document IS the
 * proof. A voice session does not work that way. The call is one long-lived leg
 * whose utterances arrive without a page context, the operator may have the
 * Viewer open on a desk machine AND a phone, and reloading a tab mints a new
 * view session on the same device. "Whatever selection was published last" would
 * therefore let the phone's selection steer the desk's call — and the operator
 * would never see it happen.
 *
 * So the session is BOUND at `start` to one `viewSessionId` + `deviceId`, and
 * every utterance's reference must match that binding. What does not match is
 * refused with a code that says which failure it is, because the three are
 * different problems for the operator:
 *
 * - `ambiguous` — another DEVICE. Two devices are two operators' worth of
 *   attention; picking one is a guess with real consequences, so nothing is
 *   picked.
 * - `stale` — the same device, a different view session (a reload), or a
 *   reference older than the window. The operator's screen has moved on.
 * - `missing` — no reference, or one with no view/device evidence at all. It
 *   cannot prove it came from anywhere, which is not the same as an empty
 *   selection: an explicit `none` from the bound view resolves normally.
 * - `unbound` — the session never recorded a view. A bug or an old client, and
 *   it fails closed rather than accepting the first reference offered.
 */

/**
 * How long a captured reference may steer a spoken turn.
 *
 * Ten minutes: long enough that "select this, then talk for a while" works
 * across a real conversation, short enough that a reference captured before a
 * coffee break cannot silently direct a later utterance. Presence republishes
 * every 10 s, so a still-open view refreshes its capture far inside this.
 */
export const SELECTED_CONTEXT_MAX_AGE_MS = 10 * 60_000;

/** The view/device a voice session was opened from. */
export interface VoiceViewBinding {
  viewSessionId: string;
  deviceId: string;
}

export type SelectedContextBindingFailureCode = "unbound" | "missing" | "stale" | "ambiguous";

export interface SelectedContextBindingFailure {
  code: SelectedContextBindingFailureCode;
  message: string;
}

export type SelectedContextBindingResult =
  | { ok: true; reference: SelectedContextRef }
  | { ok: false; failure: SelectedContextBindingFailure };

export interface SelectedContextBindingInput {
  /** The binding recorded when this call started; null when none was. */
  binding: VoiceViewBinding | null;
  /** The reference the utterance carried. */
  reference: SelectedContextRef | null;
  now: number;
  maxAgeMs?: number;
}

function refuse(code: SelectedContextBindingFailureCode, message: string): SelectedContextBindingResult {
  return { ok: false, failure: { code, message } };
}

export function bindSelectedContextToVoiceSession(input: SelectedContextBindingInput): SelectedContextBindingResult {
  const { binding, reference } = input;
  if (!binding) {
    return refuse("unbound", "This voice session is not bound to a Viewer window, so it cannot resolve a selected card.");
  }
  if (!reference) {
    return refuse("missing", "The utterance carried no selected-card reference.");
  }
  if (!reference.viewSessionId || !reference.deviceId) {
    return refuse("missing", "The selected-card reference names no view session or device, so it cannot be attributed to this call.");
  }
  /* Device first: a mismatch there is the two-screens case, and calling it
     "stale" would invite a retry that can never succeed. */
  if (reference.deviceId !== binding.deviceId) {
    return refuse("ambiguous", "The selected-card reference came from a different device than this voice session. Select the card on the device holding the call.");
  }
  if (reference.viewSessionId !== binding.viewSessionId) {
    return refuse("stale", "The selected-card reference came from an earlier Viewer window on this device. Re-select the card in the window holding the call.");
  }
  const capturedAt = Date.parse(reference.capturedAt);
  const maxAgeMs = input.maxAgeMs ?? SELECTED_CONTEXT_MAX_AGE_MS;
  if (!Number.isFinite(capturedAt) || input.now - capturedAt > maxAgeMs) {
    return refuse("stale", "The selected-card reference is older than this voice session accepts. Re-select the card.");
  }
  return { ok: true, reference };
}
