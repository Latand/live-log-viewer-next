"use client";

import { isPriorityCue, type AudioCue } from "./cues";
import { ambientLoopConfigured } from "./loopAsset";
import type { AudioPrefs } from "./prefs";

/**
 * The ambient loop: background music in the Viewer, under a call, or both.
 *
 * Rules, in the order they bite:
 *
 * - the sound MASTER setting governs it, exactly as it governs the earcons. One
 *   switch turns product audio on or off; a bed that survived the mute would be
 *   the one sound the operator could not stop;
 * - on top of that master there are TWO opt-ins — music in the Viewer and music
 *   during a call — sharing ONE volume. Both are device-local and persisted, so
 *   first run is silent but a device that has said yes once never has to say it
 *   again;
 * - which switch applies is decided by where the operator is: in a call it is
 *   `loopEnabled`, outside one it is `viewerLoopEnabled`. With BOTH on the
 *   answer never changes at the call edge, so the same track simply keeps
 *   playing across it — no teardown, no re-init, no position reset;
 * - with only one of them on, the edge that silences the music PARKS it: the
 *   voice fades out and the position it reached is retained, so the edge that
 *   brings it back resumes from there rather than replaying the opening. Only a
 *   device that wants no music at all (master off, both switches off, no asset)
 *   tears the track down and forgets where it was;
 * - it fades. Becoming audible ramps up over {@link FADE_IN_SECONDS}; becoming
 *   silent ramps down over {@link FADE_OUT_SECONDS} and only then releases the
 *   voice. A hard cut on either edge reads as a fault;
 * - it ducks SMOOTHLY under EITHER participant speaking and under priority
 *   cues, and recovers smoothly — every level change here is a ramp, never a
 *   step, because a stepped duck is itself an event the ear reports;
 * - the earcons stay above it. {@link LOOP_GAIN_CEILING} caps what the loop can
 *   reach even at full slider, and the cue tier gains all sit above that.
 */

export const FADE_IN_SECONDS = 2.5;
export const FADE_OUT_SECONDS = 1.5;
/** Into a duck: fast enough to be out of the way before the second syllable. */
export const DUCK_ATTACK_SECONDS = 0.3;
/** Out of a duck: slow enough that the recovery is not itself an event. */
export const DUCK_RELEASE_SECONDS = 0.9;
/** Fraction of the loop volume left while somebody is speaking. */
export const SPEECH_DUCK = 0.25;
/** Fraction left while a priority cue sounds. */
export const CUE_DUCK = 0.4;
/** How long a priority cue holds its duck before the loop recovers. */
export const CUE_DUCK_HOLD_MS = 1_200;
/**
 * What a full ambient slider is actually worth.
 *
 * The bed master is authored far hotter than the earcons (its own level sits
 * ~5 dB above the loudest cue), so mapping the slider straight to gain would let
 * it climb over the very sounds it exists behind. The ceiling keeps the bed
 * under every cue tier at any setting, and makes the default a whisper.
 */
export const LOOP_GAIN_CEILING = 0.35;

/** Who is talking right now. `null` means nobody is. */
export type Speaker = "operator" | "agent";

export interface LoopVoiceHandle {
  /** Ramp the loop gain to `gain` over `seconds`. Always a ramp, never a set. */
  rampTo(gain: number, seconds: number): void;
  /**
   * Fade out over `seconds`, release the voice, and answer the position the
   * track had reached — what a later {@link LoopTransport.start} resumes from.
   */
  pause(seconds: number): number;
  /** Fade out over `seconds`, then stop. Never an abrupt cut. */
  stop(seconds: number): void;
}

export interface LoopStartRequest {
  src: string;
  gain: number;
  /** Where in the track to begin; omitted or `0` opens it from the top. */
  offsetSeconds?: number;
}

export interface LoopTransport {
  /**
   * Starts the gapless loop at `gain` (callers start it silent and ramp up), or
   * answers `null` when this device will not play audio right now — the autoplay
   * policy still holds, or the buffer has not decoded yet. Never throws.
   */
  start(request: LoopStartRequest): LoopVoiceHandle | null;
}

export interface AmbientLoopOptions {
  /** `null` is supported (no controls, no sound); this release ships an asset. */
  asset: string | null;
  transport: LoopTransport;
  /** Device-local settings, read at every decision. */
  prefs: () => AudioPrefs;
  /** Injectable timer for the priority-cue duck release. */
  schedule?: (run: () => void, ms: number) => number;
  cancel?: (handle: number) => void;
}

export interface AmbientLoopState {
  playing: boolean;
  /** The gain the loop is heading for, after the ceiling and any duck. */
  gain: number;
  ducked: boolean;
  /** Position a parked track will resume from; `0` means "open from the top". */
  resumeAt: number;
}

export interface AmbientLoop {
  /** False when no loop asset is configured: the UI shows no loop controls. */
  configured(): boolean;
  /** Realtime voice went live, or ended. */
  setVoiceConnected(connected: boolean): void;
  /** Either participant started or stopped speaking. */
  setSpeaking(speaker: Speaker | null): void;
  /** A cue started. Only priority cues duck the bed. */
  duckForCue(cue: AudioCue): void;
  /**
   * The device's settings changed, or the autoplay policy just lifted. Starts
   * the bed if it is now eligible and stops it if it no longer is — this is what
   * makes a persisted "enabled" resume without another gesture.
   */
  refresh(): void;
  /** Whether the bed SHOULD be sounding right here: asset, master and the switch
      that governs the current side of the call boundary all say yes. True while
      a start attempt is still being refused by the autoplay policy, which is
      what lets the caller retry. */
  wanted(): boolean;
  state(): AmbientLoopState;
}

/** Loop gain for a device volume setting, under the ceiling. */
export function loopGain(volume: number): number {
  return LOOP_GAIN_CEILING * Math.max(0, Math.min(1, volume));
}

export function createAmbientLoop(options: AmbientLoopOptions): AmbientLoop {
  const schedule = options.schedule ?? ((run, ms) => setTimeout(run, ms) as unknown as number);
  const cancel = options.cancel ?? ((handle: number) => clearTimeout(handle));

  let voice: LoopVoiceHandle | null = null;
  /** Where a parked track resumes: the position it had when it was paused. */
  let resumeAt = 0;
  let connected = false;
  let speaking: Speaker | null = null;
  let cueDuck = false;
  let cueDuckTimer: number | null = null;

  const targetGain = (): number => {
    const base = loopGain(options.prefs().loopVolume);
    if (speaking) return base * SPEECH_DUCK;
    if (cueDuck) return base * CUE_DUCK;
    return base;
  };

  /* The master governs the bed and the cues alike; the two music switches are
     the bed's own opt-ins on top of it, one per side of the call boundary. */
  const audible = (): boolean => {
    const { cuesEnabled, loopEnabled, viewerLoopEnabled } = options.prefs();
    if (!ambientLoopConfigured(options.asset) || !cuesEnabled) return false;
    return connected ? loopEnabled : viewerLoopEnabled;
  };

  /** Whether this device wants music at all — the difference between parking a
      track for the other side of the boundary and tearing it down for good. */
  const armed = (): boolean => {
    const { cuesEnabled, loopEnabled, viewerLoopEnabled } = options.prefs();
    return ambientLoopConfigured(options.asset) && cuesEnabled && (loopEnabled || viewerLoopEnabled);
  };

  /** Bring the voice into line with the current inputs. */
  const apply = (rampSeconds: number): void => {
    if (!audible()) {
      if (voice) {
        /* Parked, not destroyed, while the other switch still wants this track:
           the position is what makes the return leg a continuation. */
        if (armed()) resumeAt = voice.pause(FADE_OUT_SECONDS);
        else {
          voice.stop(FADE_OUT_SECONDS);
          resumeAt = 0;
        }
        voice = null;
      } else if (!armed()) {
        /* Nothing wants music any more, so there is nothing to come back to. */
        resumeAt = 0;
      }
      return;
    }
    if (!voice) {
      /* Starts silent: the fade-in is the whole point of the first ramp. A
         `null` here is the autoplay policy still holding — nothing throws, and
         the next `refresh()` after the unlocking gesture starts the bed. */
      voice = options.transport.start({ src: options.asset as string, gain: 0, offsetSeconds: resumeAt });
      voice?.rampTo(targetGain(), FADE_IN_SECONDS);
      return;
    }
    voice.rampTo(targetGain(), rampSeconds);
  };

  const clearCueDuck = (): void => {
    cueDuck = false;
    if (cueDuckTimer !== null) {
      cancel(cueDuckTimer);
      cueDuckTimer = null;
    }
  };

  return {
    configured: () => ambientLoopConfigured(options.asset),

    setVoiceConnected(next: boolean): void {
      if (next === connected) return;
      connected = next;
      /* Leaving a call also clears who was talking: the next call starts from
         silence, not from whatever the last one was mid-sentence. */
      if (!connected) {
        speaking = null;
        clearCueDuck();
      }
      apply(FADE_IN_SECONDS);
    },

    setSpeaking(next: Speaker | null): void {
      if (next === speaking) return;
      speaking = next;
      apply(next ? DUCK_ATTACK_SECONDS : DUCK_RELEASE_SECONDS);
    },

    duckForCue(cue: AudioCue): void {
      if (!isPriorityCue(cue)) return;
      cueDuck = true;
      if (cueDuckTimer !== null) cancel(cueDuckTimer);
      cueDuckTimer = schedule(() => {
        cueDuckTimer = null;
        cueDuck = false;
        apply(DUCK_RELEASE_SECONDS);
      }, CUE_DUCK_HOLD_MS);
      apply(DUCK_ATTACK_SECONDS);
    },

    refresh(): void {
      apply(DUCK_RELEASE_SECONDS);
    },

    wanted: audible,

    state(): AmbientLoopState {
      return {
        playing: voice !== null,
        gain: voice ? targetGain() : 0,
        ducked: Boolean(speaking) || cueDuck,
        resumeAt,
      };
    },
  };
}
