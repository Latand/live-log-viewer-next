"use client";

import { primeAudio, sharedAudioContext } from "@/lib/chime";

import { createAmbientLoop, type AmbientLoop, type LoopTransport, type Speaker } from "./ambientLoop";
import { createCuePlayer, type CueOutcome, type CuePlayer } from "./cuePlayer";
import { cueAssetAll, CUES, type AudioCue, type CueRequest } from "./cues";
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
let loopTransport: LoopTransport | null = null;
let voiceSettlePending = false;
const voiceOwners = new Set<unknown>();
/** Who each mounted surface last reported talking, in the order they took the
    floor. A `Map` because the duck belongs to whoever is speaking NOW, and one
    card falling silent must not speak for another. */
const speakingOwners = new Map<unknown, Speaker>();

/**
 * Run `settle` once the current commit is finished.
 *
 * A microtask, not a timer: React destroys and creates effects for one commit in
 * a single synchronous pass, so this is the first moment at which the lease set
 * is known to be complete — and it is still the same tick, so a call that really
 * ended fades out with no perceptible delay.
 */
function defer(settle: () => void): void {
  if (typeof queueMicrotask === "function") queueMicrotask(settle);
  else setTimeout(settle, 0);
}

function watchPrefs(): void {
  if (prefsWatched) return;
  prefsWatched = true;
  /* Turning the master (or either music switch) off has to stop a sounding bed
     now, not at the next call — and turning one on is a fresh intent, so it gets
     a fresh retry budget rather than the remains of an earlier one. */
  subscribeAudioPrefs(() => {
    retries = 0;
    ensureAmbientLoop();
  });
}

export function ambientLoop(): AmbientLoop {
  loop ??= createAmbientLoop({
    asset: AMBIENT_LOOP_ASSET,
    transport: loopTransport ?? transports.loop,
    prefs: audioPrefs,
  });
  watchPrefs();
  return loop;
}

/**
 * Test seam: run the bed on a fake transport.
 *
 * The ownership rules that decide when the bed starts and stops live HERE, above
 * the loop controller, so a test that only drives `createAmbientLoop` cannot see
 * them. `null` restores the real Web Audio backend.
 */
export function configureAmbientTransportForTests(transport: LoopTransport | null): void {
  loopTransport = transport;
  loop = null;
}

export function cuePlayer(): CuePlayer {
  player ??= createCuePlayer({
    transport: transports.cues,
    prefs: audioPrefs,
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

/**
 * One mounted realtime surface went live or ended.
 *
 * Ownership matters because several conversation cards can mount composers in
 * the same tab. A card may release only its own lease; the ambient bed remains
 * connected while any other live call still owns one.
 *
 * The LAST lease going away is settled at the end of the tick rather than on the
 * spot, because a card switch is not one event but two. The focused card is a
 * keyed element, and React replaces a keyed subtree by destroying the old
 * effects and only then creating the new ones — so between the two the count is
 * legitimately zero, in the same commit, with the operator still in the same
 * call. Acting on that instant is what makes the music fade out and restart
 * under a swipe. A call that has genuinely ended stays ended: nothing takes the
 * lease over, and the settle lands a microtask later.
 */
export function setVoiceConnected(owner: unknown, connected: boolean): void {
  if (connected) voiceOwners.add(owner);
  else {
    voiceOwners.delete(owner);
    /* A card that stopped talking (or unmounted) is not talking, whatever it
       said last: leaving its duck behind would hold the music down for the card
       that took over. */
    speakingOwners.delete(owner);
  }
  retries = 0;
  if (voiceOwners.size > 0) {
    settleVoiceConnection();
    return;
  }
  if (voiceSettlePending) return;
  voiceSettlePending = true;
  defer(() => {
    voiceSettlePending = false;
    settleVoiceConnection();
  });
}

/** Whoever is talking anywhere, most recent first. */
function currentSpeaker(): Speaker | null {
  let latest: Speaker | null = null;
  for (const speaker of speakingOwners.values()) latest = speaker;
  return latest;
}

function settleVoiceConnection(): void {
  const bed = ambientLoop();
  bed.setVoiceConnected(voiceOwners.size > 0);
  bed.setSpeaking(voiceOwners.size > 0 ? currentSpeaker() : null);
  ensureAmbientLoop();
}

/**
 * One mounted realtime surface's participant started or stopped talking.
 *
 * Owner-scoped for the same reason the connection is: with two composers
 * mounted, the silent one must not release the duck the talking one is holding.
 * The most recent speaker wins, so a barge-in ducks under whoever took the floor
 * rather than under whichever card re-rendered last.
 */
export function setVoiceSpeaking(owner: unknown, speaker: Speaker | null): void {
  speakingOwners.delete(owner);
  if (speaker) speakingOwners.set(owner, speaker);
  ambientLoop().setSpeaking(voiceOwners.size > 0 ? currentSpeaker() : null);
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
    transports.warm(Object.keys(CUES).flatMap((cue) => cueAssetAll(cue as AudioCue)));
    /* A device that has already opted in gets its bed the moment it is allowed
       one — the gesture is the last thing standing between the two. Music in the
       Viewer is wanted from the first paint, so the retry budget may well have
       burned out waiting for exactly this gesture: the attempt that follows it
       is a fresh one, not the tail of an exhausted run. */
    retries = 0;
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
  loopTransport = null;
  prefsWatched = false;
  voiceSettlePending = false;
  voiceOwners.clear();
  speakingOwners.clear();
  retries = 0;
  if (retryTimer !== null) clearTimeout(retryTimer);
  retryTimer = null;
  transports.reset();
}
