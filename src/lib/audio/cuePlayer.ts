"use client";

import {
  cueAsset,
  cueGain,
  cueTier,
  isPriorityCue,
  TIER_RANK,
  type AudioCue,
  type CueRequest,
} from "./cues";

/**
 * The cue player: one logical event in, at most one sound out.
 *
 * Four properties, all of them learned the hard way from the poll-driven
 * chimes this sits beside:
 *
 * - **de-duplication** on the caller's stable event identity, not on a time
 *   window. Every source here is observed repeatedly by construction — a 4s
 *   attention poll, a re-parsed transcript, a remounted pane, a reconnect that
 *   replays its tail — so "same identity, already considered" is the only rule
 *   that holds. An identity is spent the moment it is considered, whatever the
 *   outcome: nothing accumulates a backlog to flush later;
 * - **a bounded overlap cap** instead of a queue. Twenty tool ticks in one
 *   burst are twenty logical events and one sound, because late audio is worse
 *   than missing audio — a cue that arrives after the thing it describes has
 *   scrolled away is noise;
 * - **silent degradation** while the autoplay policy holds the graph shut. The
 *   transport answers `null`, the cue is dropped, and nothing throws or logs;
 * - **device-local enablement**, read at play time so a mute takes effect on the
 *   next event rather than the next reload.
 */

/** One playing voice, as the transport hands it back. */
export interface CueVoiceHandle {
  stop(): void;
}

export interface CueStartRequest {
  cue: AudioCue;
  /** Bundled asset path. */
  src: string;
  /** Final playback gain: tier factor × device volume. */
  gain: number;
  /** Stereo position, -1…1. */
  pan: number;
  /** Audio-clock offset before the first sample, in seconds. */
  delaySeconds: number;
  /** The transport calls this when the sound finishes on its own. */
  onEnded: () => void;
}

export interface CueTransport {
  /**
   * Starts one voice, or answers `null` when this device will not play audio
   * right now — the autoplay policy still holds, there is no audio graph, or the
   * asset has not decoded yet. Never throws.
   */
  start(request: CueStartRequest): CueVoiceHandle | null;
}

export type CueOutcome =
  /** A voice started. */
  | "played"
  /** This exact logical event was already considered. */
  | "deduped"
  /** The overlap cap or routine coalescing refused it. */
  | "dropped"
  /** Cues are off on this device. */
  | "disabled"
  /** The device would not play audio (autoplay policy, no audio graph). */
  | "blocked";

/** Simultaneous voices. Three is the point where a burst still reads as a
    burst rather than a chord. */
export const MAX_CONCURRENT_VOICES = 3;

/** Identities remembered for de-duplication. Bounded so a tab left open for a
    week cannot grow this without limit; eviction is oldest-first, and an
    identity old enough to be evicted belongs to an event nothing will report
    again. */
export const DEDUPE_CAPACITY = 2048;

export interface CuePlayerOptions {
  transport: CueTransport;
  /** Device-local settings, read per event. */
  prefs: () => { cuesEnabled: boolean; cueVolume: number };
  /** Called after a priority cue actually starts — the ambient loop ducks. */
  onPriorityCue?: (cue: AudioCue) => void;
  maxConcurrent?: number;
  dedupeCapacity?: number;
}

export interface CuePlayer {
  play(request: CueRequest): CueOutcome;
  /** Voices currently sounding. */
  activeVoices(): readonly AudioCue[];
  /** Drops every remembered identity and stops every voice (page teardown). */
  reset(): void;
}

export function createCuePlayer(options: CuePlayerOptions): CuePlayer {
  const maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_VOICES;
  const dedupeCapacity = options.dedupeCapacity ?? DEDUPE_CAPACITY;
  /** Insertion-ordered, so eviction walks the oldest identity first. */
  const considered = new Set<string>();
  const active = new Map<number, { cue: AudioCue; handle: CueVoiceHandle }>();
  let voiceSequence = 0;

  const remember = (eventId: string): void => {
    considered.add(eventId);
    if (considered.size <= dedupeCapacity) return;
    for (const id of considered) {
      if (considered.size <= dedupeCapacity) break;
      considered.delete(id);
    }
  };

  /** The weakest voice currently sounding, or null when nothing is. */
  const weakest = (): { key: number; cue: AudioCue; handle: CueVoiceHandle } | null => {
    let found: { key: number; cue: AudioCue; handle: CueVoiceHandle } | null = null;
    for (const [key, voice] of active) {
      if (!found || TIER_RANK[cueTier(voice.cue)] < TIER_RANK[cueTier(found.cue)]) {
        found = { key, cue: voice.cue, handle: voice.handle };
      }
    }
    return found;
  };

  return {
    play({ cue, eventId, pan = 0, delayMs = 0 }: CueRequest): CueOutcome {
      if (considered.has(eventId)) return "deduped";
      remember(eventId);

      const { cuesEnabled, cueVolume } = options.prefs();
      if (!cuesEnabled) return "disabled";

      if (active.size >= maxConcurrent) {
        const victim = weakest();
        if (!victim || TIER_RANK[cueTier(cue)] <= TIER_RANK[cueTier(victim.cue)]) return "dropped";
        /* Louder news displaces quieter news rather than waiting behind it. */
        victim.handle.stop();
        active.delete(victim.key);
      }

      const key = ++voiceSequence;
      const handle = options.transport.start({
        cue,
        src: cueAsset(cue),
        gain: cueGain(cue, cueVolume),
        pan: Math.max(-1, Math.min(1, pan)),
        delaySeconds: Math.max(0, delayMs) / 1000,
        onEnded: () => { active.delete(key); },
      });
      if (!handle) return "blocked";
      active.set(key, { cue, handle });
      if (isPriorityCue(cue)) options.onPriorityCue?.(cue);
      return "played";
    },

    activeVoices(): readonly AudioCue[] {
      return [...active.values()].map((voice) => voice.cue);
    },

    reset(): void {
      for (const voice of active.values()) voice.handle.stop();
      active.clear();
      considered.clear();
    },
  };
}
