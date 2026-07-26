/**
 * The six approved earcons, and the ONE table that binds them.
 *
 * Every cue name below is a semantic event class, never a sound description:
 * the mapping from a product event to a cue lives in {@link CUE_OF_LIFECYCLE}
 * and in the wiring hooks, and the mapping from a cue to a file lives here.
 * Nothing else in the app may name an audio file.
 *
 * LOUDNESS — read before touching a number.
 *
 * The bundled masters ALREADY encode the approved hierarchy: measured mean
 * levels run attention (loudest) → failure → success → launch → viewer-mcp →
 * tool-tick (quietest). They are shipped byte-for-byte; nothing re-normalizes,
 * re-encodes or per-cue gain-adjusts them. {@link TIER_GAIN} is one playback
 * tier table layered on top, and it preserves the same ordering — a priority
 * cue is never played quieter than a routine one.
 */

export type AudioCue =
  /** The agent needs the operator: a question, a waiting turn, a focus request. */
  | "attention"
  /** Something terminal went wrong: a launch failed, a run stalled. */
  | "failure"
  /** A new agent exists: an accepted spawn, a subagent joining the tree. */
  | "launch"
  /** A run reached a good terminal state and came home. */
  | "success"
  /** The agent reached back into this viewer through the Viewer MCP server. */
  | "viewer-mcp"
  /** Ordinary per-tool activity. The quietest thing here, by design. */
  | "tool-tick";

/**
 * Playback tiers.
 *
 * `priority` — interrupts on purpose; ducks the ambient loop.
 * `salient` — worth a glance, not an interruption.
 * `routine` — texture. Coalesced, capped, and the first thing dropped.
 */
export type CueTier = "priority" | "salient" | "routine";

export const CUE_ASSET_DIR = "/audio/cues";

/** cue → bundled asset + playback tier. The one table. */
export const CUES: Record<AudioCue, { file: string; tier: CueTier }> = {
  attention: { file: "attention.mp3", tier: "priority" },
  failure: { file: "failure.mp3", tier: "priority" },
  launch: { file: "launch.mp3", tier: "salient" },
  success: { file: "success.mp3", tier: "salient" },
  "viewer-mcp": { file: "viewer-mcp.mp3", tier: "routine" },
  "tool-tick": { file: "tool-tick.mp3", tier: "routine" },
};

/** The documented tier table, layered on top of the masters' own levels. */
export const TIER_GAIN: Record<CueTier, number> = {
  priority: 1,
  salient: 0.75,
  routine: 0.5,
};

/** Higher wins when the overlap cap has to choose what to drop. */
export const TIER_RANK: Record<CueTier, number> = {
  priority: 3,
  salient: 2,
  routine: 1,
};

export function cueTier(cue: AudioCue): CueTier {
  return CUES[cue].tier;
}

export function cueAsset(cue: AudioCue): string {
  return `${CUE_ASSET_DIR}/${CUES[cue].file}`;
}

/** A priority cue is the only thing allowed to duck the ambient loop. */
export function isPriorityCue(cue: AudioCue): boolean {
  return cueTier(cue) === "priority";
}

/**
 * Playback gain for one cue at the device's cue volume. The tier factor and the
 * operator's volume multiply; the master file's own level is untouched.
 */
export function cueGain(cue: AudioCue, volume: number): number {
  const clamped = Math.max(0, Math.min(1, volume));
  return TIER_GAIN[cueTier(cue)] * clamped;
}

/**
 * The lifecycle transitions {@link import("@/hooks/useAgentChimes")} already
 * detects, mapped onto cues. `waiting`/`question` are the same fact from the
 * operator's side — the agent stopped and wants them — so both ring `attention`.
 */
export const CUE_OF_LIFECYCLE = {
  waiting: "attention",
  question: "attention",
  returned: "success",
  stalled: "failure",
  spawned: "launch",
} as const satisfies Record<string, AudioCue>;

export type LifecycleCueKind = keyof typeof CUE_OF_LIFECYCLE;

/** One cue request: the cue, plus the stable identity it de-duplicates on. */
export interface CueRequest {
  cue: AudioCue;
  /**
   * Stable identity of the LOGICAL event — a tool call id, a launch id, an
   * attention request id, a conversation identity plus its transcript mtime.
   * Never a timestamp taken at call time: the same event observed again after a
   * refetch, a re-render or a reconnect replay must produce the same string.
   */
  eventId: string;
  /** Stereo position, -1 hard left … 1 hard right. */
  pan?: number;
  /**
   * Scheduling offset, so several cues from one poll read as a cascade instead
   * of a chord. Scheduled on the audio clock, NOT with a timer: the identity is
   * spent and the voice is counted against the overlap cap the moment the cue is
   * requested, so a delay can never let a burst slip past the cap.
   */
  delayMs?: number;
}
