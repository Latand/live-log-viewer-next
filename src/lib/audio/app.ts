"use client";

import { primeAudio, sharedAudioContext } from "@/lib/chime";

import { createAmbientLoop, type AmbientLoop } from "./ambientLoop";
import { createCuePlayer, type CueOutcome, type CuePlayer } from "./cuePlayer";
import { cueAsset, CUES, type AudioCue, type CueRequest } from "./cues";
import { AMBIENT_LOOP_ASSET, ambientLoopConfigured } from "./loopAsset";
import { audioPrefs, subscribeAudioPrefs } from "./prefs";
import { createWebAudioTransports, type AudioContextLike } from "./webAudioTransport";

/**
 * The app's one cue player and one ambient loop.
 *
 * Module singletons on purpose, and for the same reason the pane registry in
 * `@/lib/chime` is one: de-duplication and the overlap cap are only meaningful
 * across the WHOLE tab. Two players would each dedupe correctly and still play
 * the same event twice — which is exactly the bug the identity keys exist to
 * prevent, reintroduced one layer up.
 */

/** Retry cadence while the bed is wanted but the graph is not ready yet — a
    locked context before the first gesture, or a buffer still decoding. */
const AMBIENT_RETRY_MS = 700;
/** Give up after this many retries (~21s): something is wrong with the asset,
    and a retry loop that never ends is worse than a silent bed. */
const AMBIENT_RETRY_LIMIT = 30;

/* The structural view in `webAudioTransport` is a subset of the real Web Audio
   surface, but `AudioBufferSourceNode.onended`'s event parameter makes the two
   only assignable through `unknown`. One cast, at this boundary, so the fake
   context in the tests stays a plain object. */
const transports = createWebAudioTransports(() => sharedAudioContext() as unknown as AudioContextLike | null);

let player: CuePlayer | null = null;
let loop: AmbientLoop | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retries = 0;
let prefsWatched = false;

function watchPrefs(): void {
  if (prefsWatched) return;
  prefsWatched = true;
  /* Turning the master (or the bed's own switch) off has to stop a sounding bed
     now, not at the next call. */
  subscribeAudioPrefs(() => ensureAmbientLoop());
}

export function ambientLoop(): AmbientLoop {
  loop ??= createAmbientLoop({
    asset: AMBIENT_LOOP_ASSET,
    transport: transports.loop,
    prefs: audioPrefs,
  });
  watchPrefs();
  return loop;
}

export function cuePlayer(): CuePlayer {
  player ??= createCuePlayer({
    transport: transports.cues,
    prefs: audioPrefs,
    /* Priority cues duck the bed rather than fighting it. */
    onPriorityCue: (cue) => ambientLoop().duckForCue(cue),
  });
  watchPrefs();
  return player;
}

/** Play one cue for one logical event. Safe to call from anywhere, any number
    of times: the identity decides whether anything sounds. */
export function playCue(request: CueRequest): CueOutcome {
  return cuePlayer().play(request);
}

/**
 * Bring the bed into line with the current settings, and keep trying while it is
 * wanted but the graph is not ready — a persisted "enabled" must resume by
 * itself on the next connected call, and the only thing allowed to delay that is
 * the autoplay policy.
 */
export function ensureAmbientLoop(): void {
  const bed = ambientLoop();
  bed.refresh();
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  if (!bed.wanted() || bed.state().playing) {
    retries = 0;
    return;
  }
  if (retries >= AMBIENT_RETRY_LIMIT) return;
  retries += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    ensureAmbientLoop();
  }, AMBIENT_RETRY_MS);
}

/** Realtime voice went live or ended. */
export function setVoiceConnected(connected: boolean): void {
  retries = 0;
  ambientLoop().setVoiceConnected(connected);
  ensureAmbientLoop();
}

/**
 * Unlock audio on the first real user gesture and warm the cue buffers.
 *
 * Nothing before that gesture may throw or complain: a browser refusing audio to
 * a page nobody has touched is normal, not an error. Returns the listener
 * cleanup, and also primes the shared synthesized chimes so one gesture unlocks
 * everything.
 */
export function unlockAudioOnGesture(): () => void {
  const stopPriming = primeAudio();
  if (typeof window === "undefined") return stopPriming;
  const unlock = () => {
    transports.warm(Object.keys(CUES).map((cue) => cueAsset(cue as AudioCue)));
    /* A device that has already opted in gets its bed the moment it is allowed
       one — the gesture is the last thing standing between the two. */
    ensureAmbientLoop();
  };
  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("keydown", unlock);
  return () => {
    stopPriming();
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
}

/** Whether the loop controls belong on screen at all. */
export function ambientLoopAvailable(): boolean {
  return ambientLoopConfigured();
}

/** Test/teardown seam. */
export function resetAppAudioForTests(): void {
  player?.reset();
  player = null;
  loop = null;
  prefsWatched = false;
  retries = 0;
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
  transports.reset();
}
