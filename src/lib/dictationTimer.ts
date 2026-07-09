/**
 * Pure timing rules for the dictation cap. Kept side-effect-free and away from
 * the hook so the near-cap warning, the auto-stop, and the mic's visual state
 * can be unit-tested without a recorder, a timer, or a DOM.
 *
 * The recording is capped so a forgotten-open mic can't run forever. The last
 * stretch is announced: the timer flips to an amber countdown, a soft ping
 * sounds shortly before the cap, and at the cap the recorder stops with a
 * distinct chime and a held "stopped" chip.
 */

/** Hard recording limit, in seconds (10 minutes). */
export const CAP_SECONDS = 600;
/** How long before the cap the amber countdown appears and the SR warning fires. */
export const WARN_LEAD_SECONDS = 60;
/** How long before the cap the single soft ping sounds. */
export const PING_LEAD_SECONDS = 30;

/* The leads shrink for very short caps so a lowered dev cap still demonstrates
   every cue (warn → ping → stop) instead of skipping straight to the stop. At
   the real 600s cap these clamp to the full 60s / 30s. */
export function warnLead(maxSeconds: number): number {
  return Math.min(WARN_LEAD_SECONDS, Math.floor(maxSeconds / 2));
}
export function pingLead(maxSeconds: number): number {
  return Math.min(PING_LEAD_SECONDS, Math.floor(maxSeconds / 4));
}

/** Seconds left before the auto-stop; never negative. */
export function remaining(elapsed: number, maxSeconds: number): number {
  return Math.max(0, maxSeconds - elapsed);
}

/** True inside the final-stretch window: the timer shows the amber countdown. */
export function isWarning(elapsed: number, maxSeconds: number): boolean {
  return elapsed >= maxSeconds - warnLead(maxSeconds) && elapsed < maxSeconds;
}

/** One-shot cues, fired the tick their threshold is crossed (prev < t ≤ next). */
export interface DictationCues {
  /** Show the amber countdown and announce that under a minute remains. */
  warn: boolean;
  /** Play the single soft near-cap ping. */
  ping: boolean;
  /** The cap is reached — stop the recorder, play the stop chime, hold the chip. */
  capped: boolean;
}

/**
 * Which cues fire on the tick from `prev` to `next` elapsed seconds. Crossing
 * detection (`prev < threshold && next >= threshold`) makes each cue fire
 * exactly once across a recording, so the ping never repeats and the stop
 * fires on a single tick.
 */
export function dictationCues(prev: number, next: number, maxSeconds: number): DictationCues {
  const warnAt = maxSeconds - warnLead(maxSeconds);
  const pingAt = maxSeconds - pingLead(maxSeconds);
  return {
    warn: prev < warnAt && next >= warnAt,
    ping: prev < pingAt && next >= pingAt,
    capped: prev < maxSeconds && next >= maxSeconds,
  };
}

/** The mic control's visual state — the single source both the view and the
    tests read, so "what the button shows" is verifiable without rendering. */
export type MicVisual = "idle" | "starting" | "recNormal" | "recWarn" | "capStopped" | "busy";

export interface MicVisualInput {
  phase: "idle" | "starting" | "rec" | "busy";
  elapsed: number;
  maxSeconds: number;
  /** Set by the hook when the cap fired the stop; self-clears after a hold. */
  capStopped: boolean;
}

export function micVisual({ phase, elapsed, maxSeconds, capStopped }: MicVisualInput): MicVisual {
  /* The held cap-stopped chip wins over idle/busy (it covers the post-stop
     transcription too) but never overrides a fresh recording — a manual stop
     then a new start must show the live meter, not a stale stopped chip. */
  if (capStopped && phase !== "rec") return "capStopped";
  if (phase === "rec") return isWarning(elapsed, maxSeconds) ? "recWarn" : "recNormal";
  if (phase === "busy") return "busy";
  if (phase === "starting") return "starting";
  return "idle";
}
