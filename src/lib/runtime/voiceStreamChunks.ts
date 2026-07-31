import { utf8ChunkAt } from "./voiceDelivery";

export const VOICE_STREAM_FLUSH_DELAY_MS = 1_100;
export const VOICE_STREAM_MIN_SENTENCE_CHARS = 180;
export const VOICE_STREAM_DEADLINE_MIN_CHARS = 140;
export const VOICE_STREAM_TARGET_CHARS = 560;
export const VOICE_STREAM_MAX_BYTES = 1_800;
export const VOICE_STREAM_MAX_PENDING = 6;
export const VOICE_STREAM_BUFFER_LIMIT_BYTES = 24 * 1024;

export type VoiceStreamFlushMode = "eager" | "deadline" | "final";

export interface VoiceStreamChunk {
  text: string;
  remainder: string;
}

const sentenceBoundary = /[.!?…](?:["')\]}»”’]+)?\s+/gu;

function lastBoundary(value: string, minimum: number): number {
  sentenceBoundary.lastIndex = 0;
  let boundary = -1;
  for (const match of value.matchAll(sentenceBoundary)) {
    const end = (match.index ?? 0) + match[0].length;
    if (end >= minimum) boundary = end;
  }
  return boundary;
}

function whitespaceBoundary(value: string, preferred: number, minimum: number): number {
  const before = value.slice(0, preferred + 1).search(/\s+\S*$/u);
  if (before >= minimum) return before + value.slice(before).match(/^\s+/u)![0].length;
  const after = value.slice(preferred).search(/\s/u);
  return after >= 0 ? preferred + after + 1 : value.length;
}

/**
 * Select one immutable, human-sized speech chunk from an accumulated assistant
 * draft. Callers keep the remainder and decide when to invoke the module again;
 * token cadence, timers, delivery acknowledgements, and interruption stay hidden
 * from this interface.
 */
export function takeVoiceStreamChunk(
  buffer: string,
  mode: VoiceStreamFlushMode,
): VoiceStreamChunk | null {
  if (!buffer) return null;
  const bounded = utf8ChunkAt(buffer, 0, VOICE_STREAM_MAX_BYTES)!;
  const window = bounded.text;
  const hardBounded = bounded.nextOffset < buffer.length;
  const sentence = lastBoundary(window, VOICE_STREAM_MIN_SENTENCE_CHARS);

  let cut = -1;
  if (sentence >= 0) cut = sentence;
  else if (mode === "final") cut = window.length;
  else if (hardBounded || buffer.length >= VOICE_STREAM_TARGET_CHARS) {
    cut = whitespaceBoundary(window, Math.min(VOICE_STREAM_TARGET_CHARS, window.length), VOICE_STREAM_MIN_SENTENCE_CHARS);
  } else if (mode === "deadline" && buffer.length >= VOICE_STREAM_DEADLINE_MIN_CHARS) {
    cut = whitespaceBoundary(window, window.length, VOICE_STREAM_DEADLINE_MIN_CHARS);
  }

  if (cut <= 0) return null;
  return { text: buffer.slice(0, cut), remainder: buffer.slice(cut) };
}
