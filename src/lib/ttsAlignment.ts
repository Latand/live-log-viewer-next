/**
 * Where the voice is, inside one chunk (issue #1022 addendum).
 *
 * Only ElevenLabs hands back an alignment: its `/with-timestamps` endpoint
 * returns a start and an end second for every character of the input, which
 * gives word-exact karaoke and exact seeking. OpenAI's speech endpoint returns
 * none, and Soniox's REST `/tts` returns raw audio bytes only (their character
 * timestamps are a WebSocket-stream feature), so both fall back to interpolating
 * the position proportionally inside the chunk. Chunk boundaries stay exact for
 * every provider, because the chunk itself is a known text range.
 */

/** The provider payload, as `/api/tts` passes it through. */
export interface ProviderAlignment {
  characters: string[];
  starts: number[];
  ends: number[];
}

/** Provider times re-indexed onto the chunk text's own character offsets. */
export interface CharTimes {
  starts: number[];
  ends: number[];
}

export interface ChunkTiming {
  /** Length of the chunk text, in characters. */
  length: number;
  /** Measured audio duration in seconds; 0 until the element reports it. */
  duration: number;
  /** Null for providers without alignment — the proportional fallback. */
  times: CharTimes | null;
}

/** How much of the text must line up before an alignment is trusted. */
const MIN_ALIGNED_RATIO = 0.5;
/** How far ahead a provider character may look for its place in the text. */
const RESYNC_WINDOW = 12;

function isProviderAlignment(value: unknown): value is ProviderAlignment {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ProviderAlignment>;
  return (
    Array.isArray(candidate.characters) &&
    Array.isArray(candidate.starts) &&
    Array.isArray(candidate.ends) &&
    candidate.characters.length === candidate.starts.length &&
    candidate.starts.length === candidate.ends.length &&
    candidate.characters.length > 0
  );
}

/**
 * Re-indexes provider character times onto the chunk text. Providers normalize
 * what they speak ("1" → "one", collapsed whitespace), so the two strings are
 * matched with a bounded resync rather than assumed identical; when too little
 * lines up the caller gets null and interpolates instead.
 */
export function charTimesFor(text: string, alignment: unknown): CharTimes | null {
  if (!isProviderAlignment(alignment)) return null;
  const starts = new Array<number>(text.length).fill(-1);
  const ends = new Array<number>(text.length).fill(-1);
  let cursor = 0;
  let aligned = 0;
  for (let index = 0; index < alignment.characters.length && cursor < text.length; index += 1) {
    const character = alignment.characters[index]!;
    let at = -1;
    for (let probe = cursor; probe < Math.min(text.length, cursor + RESYNC_WINDOW); probe += 1) {
      if (text[probe] === character) { at = probe; break; }
    }
    if (at < 0) continue;
    starts[at] = alignment.starts[index]!;
    ends[at] = alignment.ends[index]!;
    cursor = at + 1;
    aligned += 1;
  }
  if (aligned < text.length * MIN_ALIGNED_RATIO) return null;

  /* Characters the provider skipped (or spoke as something else) inherit the
     time of the last character that was placed, so the series stays monotonic
     and every index answers a question. */
  let last = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (starts[index]! < 0) starts[index] = last;
    else last = starts[index]!;
    if (ends[index]! < 0) ends[index] = last;
    else last = Math.max(last, ends[index]!);
  }
  return { starts, ends };
}

/** Seconds into the chunk audio at which the character at `index` is spoken. */
export function timeForChar(timing: ChunkTiming, index: number): number {
  if (timing.length <= 0) return 0;
  const clamped = Math.max(0, Math.min(index, timing.length - 1));
  if (timing.times) return timing.times.starts[clamped] ?? 0;
  return (clamped / timing.length) * timing.duration;
}

/** The character being spoken `time` seconds into the chunk audio. */
export function charForTime(timing: ChunkTiming, time: number): number {
  if (timing.length <= 0) return 0;
  if (!timing.times) {
    if (timing.duration <= 0) return 0;
    const ratio = Math.max(0, Math.min(time / timing.duration, 1));
    return Math.min(timing.length - 1, Math.floor(ratio * timing.length));
  }
  const { ends } = timing.times;
  let low = 0;
  let high = timing.length - 1;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((ends[middle] ?? 0) < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * The word around `index` — the karaoke unit for both providers. With
 * alignment it is the word the voice is on; interpolating, it is the tight
 * sliding window that snapping to word edges gives instead of a mid-word cut.
 */
export function wordSpanAt(text: string, index: number): { start: number; end: number } | null {
  if (!text) return null;
  const clamped = Math.max(0, Math.min(index, text.length - 1));
  const isWord = (at: number) => at >= 0 && at < text.length && !/\s/.test(text[at]!);
  let cursor = clamped;
  if (!isWord(cursor)) {
    /* Landed on whitespace: take the next word, or the previous one at the end. */
    let forward = cursor;
    while (forward < text.length && !isWord(forward)) forward += 1;
    if (forward < text.length) cursor = forward;
    else {
      let backward = cursor;
      while (backward >= 0 && !isWord(backward)) backward -= 1;
      if (backward < 0) return null;
      cursor = backward;
    }
  }
  let start = cursor;
  while (start > 0 && isWord(start - 1)) start -= 1;
  let end = cursor + 1;
  while (end < text.length && isWord(end)) end += 1;
  return { start, end };
}
