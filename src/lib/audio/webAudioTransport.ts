"use client";

import type { LoopTransport, LoopVoiceHandle } from "./ambientLoop";
import type { CueTransport, CueVoiceHandle } from "./cuePlayer";

/**
 * The one real audio backend: decoded buffers on the Web Audio clock.
 *
 * Why buffers and not `<audio>` elements:
 *
 * - the ambient bed must loop with NO seam. An `AudioBufferSourceNode` with
 *   `loop` + `loopStart`/`loopEnd` wraps inside the audio thread on the sample
 *   clock. Re-triggering on `ended`, or scheduling the next pass from a timer,
 *   both put a main-thread hop between the last sample and the first — that hop
 *   is the click. Neither appears here, and `onended` is deliberately left unset
 *   on the loop voice;
 * - fades and ducks have to be ramps on the same clock. `AudioParam`
 *   `linearRampToValueAtTime` is sample-accurate; stepping `.volume` from a
 *   `setInterval` is not, and the steps are audible;
 * - cues need stereo placement, which the pane geometry already computes.
 *
 * Everything degrades to `null` — never an exception, never a log line. A locked
 * context (autoplay policy) and an undecoded buffer are the same answer to the
 * caller: not now.
 */

/** Minimal structural view of the Web Audio surface actually used here. */
export interface AudioBufferLike {
  duration: number;
}

export interface AudioParamLike {
  value: number;
  cancelScheduledValues(when: number): void;
  setValueAtTime(value: number, when: number): void;
  linearRampToValueAtTime(value: number, when: number): void;
}

export interface AudioNodeLike {
  connect(destination: never): unknown;
}

export interface GainNodeLike {
  gain: AudioParamLike;
  connect(destination: never): unknown;
}

export interface PannerNodeLike {
  pan: AudioParamLike;
  connect(destination: never): unknown;
}

export interface BufferSourceLike {
  buffer: AudioBufferLike | null;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  connect(destination: never): unknown;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface AudioContextLike {
  state: string;
  currentTime: number;
  destination: unknown;
  resume(): Promise<void>;
  createBufferSource(): BufferSourceLike;
  createGain(): GainNodeLike;
  createStereoPanner?(): PannerNodeLike;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>;
}

export interface WebAudioTransports {
  cues: CueTransport;
  loop: LoopTransport;
  /** Decode assets ahead of the first event, so the first cue is not the one
      that pays for the fetch. Safe to call repeatedly. */
  warm(sources: readonly string[]): void;
  /** Test/teardown seam: forget every decoded buffer. */
  reset(): void;
}

/** The shortest ramp worth scheduling; below this the ear hears a step. */
const MIN_RAMP_SECONDS = 0.01;

export function createWebAudioTransports(
  getContext: () => AudioContextLike | null,
  fetchFn: typeof fetch | null = typeof fetch === "function" ? fetch : null,
): WebAudioTransports {
  const buffers = new Map<string, AudioBufferLike>();
  /** A source that failed to fetch or decode is never retried: a 404 asset
      would otherwise re-request on every single event. */
  const failed = new Set<string>();
  const loading = new Set<string>();

  const ensureBuffer = (context: AudioContextLike, src: string): AudioBufferLike | null => {
    const ready = buffers.get(src);
    if (ready) return ready;
    if (failed.has(src) || loading.has(src) || !fetchFn) return null;
    loading.add(src);
    void (async () => {
      try {
        const response = await fetchFn(src);
        if (!response.ok) throw new Error(`asset ${response.status}`);
        buffers.set(src, await context.decodeAudioData(await response.arrayBuffer()));
      } catch {
        failed.add(src);
      } finally {
        loading.delete(src);
      }
    })();
    return null;
  };

  /** The context, if it will play right now. Kicks a resume and a decode
      otherwise, so the NEXT event lands. */
  const playable = (src: string): { context: AudioContextLike; buffer: AudioBufferLike } | null => {
    const context = getContext();
    if (!context) return null;
    if (context.state !== "running") {
      void context.resume().catch(() => undefined);
      ensureBuffer(context, src);
      return null;
    }
    const buffer = ensureBuffer(context, src);
    return buffer ? { context, buffer } : null;
  };

  const ramp = (context: AudioContextLike, param: AudioParamLike, target: number, seconds: number): void => {
    const now = context.currentTime;
    param.cancelScheduledValues(now);
    /* Anchor at the CURRENT value: without this the ramp starts from whatever
       was last scheduled and a duck that interrupts a fade-in jumps. */
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(target, now + Math.max(MIN_RAMP_SECONDS, seconds));
  };

  return {
    cues: {
      start(request): CueVoiceHandle | null {
        const ready = playable(request.src);
        if (!ready) return null;
        try {
          const { context, buffer } = ready;
          const source = context.createBufferSource();
          source.buffer = buffer;
          const gain = context.createGain();
          gain.gain.value = request.gain;
          const panner = context.createStereoPanner?.();
          if (panner) {
            panner.pan.value = request.pan;
            gain.connect(panner as never);
            panner.connect(context.destination as never);
          } else {
            gain.connect(context.destination as never);
          }
          source.connect(gain as never);
          /* A cue is one-shot: `onended` is how the player learns a voice freed
             up. (The LOOP voice never sets this — see the file header.) */
          (source as { onended?: unknown }).onended = () => request.onEnded();
          source.start(context.currentTime + Math.max(0, request.delaySeconds));
          return {
            stop() {
              try {
                source.stop();
              } catch {
                /* already finished */
              }
            },
          };
        } catch {
          return null;
        }
      },
    },

    loop: {
      start(request): LoopVoiceHandle | null {
        const ready = playable(request.src);
        if (!ready) return null;
        try {
          const { context, buffer } = ready;
          const source = context.createBufferSource();
          source.buffer = buffer;
          /* Gapless by construction: the wrap happens on the audio thread at
             `loopEnd`, with no main-thread hop between passes. */
          source.loop = true;
          source.loopStart = 0;
          source.loopEnd = buffer.duration;
          const gain = context.createGain();
          gain.gain.value = request.gain;
          source.connect(gain as never);
          gain.connect(context.destination as never);
          source.start();
          let stopped = false;
          return {
            rampTo(target, seconds) {
              if (stopped) return;
              ramp(context, gain.gain, Math.max(0, target), seconds);
            },
            stop(seconds) {
              if (stopped) return;
              stopped = true;
              const fade = Math.max(MIN_RAMP_SECONDS, seconds);
              ramp(context, gain.gain, 0, fade);
              try {
                /* Stop only AFTER the fade has run to zero. */
                source.stop(context.currentTime + fade + 0.05);
              } catch {
                /* already stopped */
              }
            },
          };
        } catch {
          return null;
        }
      },
    },

    warm(sources): void {
      const context = getContext();
      if (!context) return;
      for (const src of sources) ensureBuffer(context, src);
    },

    reset(): void {
      buffers.clear();
      failed.clear();
      loading.clear();
    },
  };
}
