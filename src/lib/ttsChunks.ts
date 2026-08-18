import { MAX_TTS_TEXT_LENGTH } from "@/lib/tts";

/**
 * One synthesis unit of a spoken message (issue #1022). A chunk is an exact
 * substring of the source — `source.slice(start, end) === text` — so the
 * playback queue can map an audio position back onto the message text for
 * karaoke highlighting and click-to-seek.
 */
export interface SpeechChunk {
  index: number;
  text: string;
  start: number;
  end: number;
}

/** Below this a chunk is only flushed at a paragraph break or at the end. */
export const MIN_CHUNK_CHARS = 400;
/** Target ceiling: small enough to synthesize fast, long enough to keep prosody. */
export const MAX_CHUNK_CHARS = 800;

/* A sentence ends at .!?… (plus any closing quote/bracket) FOLLOWED BY
   whitespace. The trailing-whitespace requirement is what keeps `example.com`,
   `v1.2.3` and every dotted URL path in one piece — a URL never contains a
   space, so it can never straddle this boundary. */
const SENTENCE_END = /[.!?…]["'”’)\]]*(?=\s)/g;
const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

interface Unit {
  start: number;
  end: number;
  /** A fenced code block: kept whole, never split on a sentence boundary. */
  atomic: boolean;
  /** Preceded by a blank line — the split point a chunk prefers. */
  paragraph: boolean;
}

/** Source ranges for the fenced code blocks, which survive chunking whole. */
function fencedRanges(source: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let offset = 0;
  let open: { start: number; char: string; length: number } | null = null;
  for (const line of source.split("\n")) {
    const next = offset + line.length + 1;
    if (open) {
      const closer = line.match(FENCE_CLOSE)?.[1];
      if (closer?.[0] === open.char && closer.length >= open.length) {
        ranges.push({ start: open.start, end: Math.min(next, source.length) });
        open = null;
      }
    } else {
      const opener = line.match(FENCE_OPEN)?.[1];
      if (opener) open = { start: offset, char: opener[0]!, length: opener.length };
    }
    offset = next;
  }
  /* An unterminated fence runs to the end of the message. */
  if (open) ranges.push({ start: open.start, end: source.length });
  return ranges;
}

function trimmedRange(source: string, start: number, end: number): { start: number; end: number } | null {
  let from = start;
  let to = end;
  while (from < to && /\s/.test(source[from]!)) from += 1;
  while (to > from && /\s/.test(source[to - 1]!)) to -= 1;
  return to > from ? { start: from, end: to } : null;
}

/** Sentence-sized units of a prose run, each carrying whether a blank line opened it. */
function proseUnits(source: string, start: number, end: number): Unit[] {
  const units: Unit[] = [];
  const text = source.slice(start, end);
  const bounds: number[] = [];
  SENTENCE_END.lastIndex = 0;
  for (let match = SENTENCE_END.exec(text); match; match = SENTENCE_END.exec(text)) {
    bounds.push(match.index + match[0].length);
  }
  /* A blank line ends a unit too: list items and headings carry no full stop. */
  for (const match of text.matchAll(/\n[ \t]*\n/g)) bounds.push(match.index + match[0].length);
  bounds.sort((a, b) => a - b);

  let cursor = 0;
  for (const bound of [...bounds, text.length]) {
    if (bound <= cursor) continue;
    const range = trimmedRange(source, start + cursor, start + bound);
    if (range) {
      const before = source.slice(0, range.start);
      units.push({ ...range, atomic: false, paragraph: units.length > 0 && /\n[ \t]*\n\s*$/.test(before) });
    }
    cursor = bound;
  }
  return units;
}

/**
 * Splits a unit that is longer than `limit` on whitespace, never inside a word.
 * A single unbreakable token (a long URL, a base64 blob) stays whole even when
 * it overshoots — cutting it would make the synthesizer read nonsense.
 */
function splitOnWhitespace(source: string, start: number, end: number, limit: number): { start: number; end: number }[] {
  const pieces: { start: number; end: number }[] = [];
  let from = start;
  while (end - from > limit) {
    let cut = -1;
    for (let index = from + limit; index > from; index -= 1) {
      if (/\s/.test(source[index]!)) { cut = index; break; }
    }
    if (cut < 0) {
      /* No whitespace inside the window: take the whole token up to the next
         space so the word (or URL) survives intact. */
      const next = source.slice(from).search(/\s/);
      cut = next < 0 ? end : from + next;
    }
    const piece = trimmedRange(source, from, cut);
    if (piece) pieces.push(piece);
    from = cut;
    if (cut >= end) break;
  }
  const tail = trimmedRange(source, from, end);
  if (tail) pieces.push(tail);
  return pieces;
}

/**
 * Splits a message into synthesis chunks on paragraph and sentence boundaries.
 * A message that already fits in one chunk comes back as exactly one chunk, so
 * short answers keep the single-request behaviour they have always had.
 */
export function chunkSpeech(
  source: string,
  options: { min?: number; max?: number; hardMax?: number } = {},
): SpeechChunk[] {
  const min = options.min ?? MIN_CHUNK_CHARS;
  const max = options.max ?? MAX_CHUNK_CHARS;
  const hardMax = options.hardMax ?? MAX_TTS_TEXT_LENGTH;
  const whole = trimmedRange(source, 0, source.length);
  if (!whole) return [];
  if (whole.end - whole.start <= max) {
    return [{ index: 0, text: source.slice(whole.start, whole.end), start: whole.start, end: whole.end }];
  }

  const units: Unit[] = [];
  let cursor = 0;
  for (const fence of fencedRanges(source)) {
    if (fence.start > cursor) units.push(...proseUnits(source, cursor, fence.start));
    const range = trimmedRange(source, fence.start, fence.end);
    if (range) units.push({ ...range, atomic: true, paragraph: true });
    cursor = fence.end;
  }
  if (cursor < source.length) units.push(...proseUnits(source, cursor, source.length));

  /* Oversized units are cut down first, so packing never has to break one. A
     code block is only cut when it alone would blow the per-request limit. */
  const sized: Unit[] = [];
  for (const unit of units) {
    const limit = unit.atomic ? hardMax : max;
    if (unit.end - unit.start <= limit) { sized.push(unit); continue; }
    const pieces = splitOnWhitespace(source, unit.start, unit.end, limit);
    pieces.forEach((piece, index) => {
      const paragraph = unit.paragraph && index === 0;
      if (piece.end - piece.start <= hardMax) {
        sized.push({ ...piece, atomic: unit.atomic, paragraph });
        return;
      }
      /* An unbroken run longer than a whole request — a hash, a base64 blob.
         There is no word here to keep whole, and the alternative is a request
         the route is bound to refuse. */
      for (let at = piece.start; at < piece.end; at += hardMax) {
        sized.push({ start: at, end: Math.min(at + hardMax, piece.end), atomic: unit.atomic, paragraph: paragraph && at === piece.start });
      }
    });
  }

  const chunks: SpeechChunk[] = [];
  let open: { start: number; end: number } | null = null;
  const flush = () => {
    if (!open) return;
    chunks.push({ index: chunks.length, text: source.slice(open.start, open.end), start: open.start, end: open.end });
    open = null;
  };
  for (const unit of sized) {
    const length = unit.end - unit.start;
    if (open) {
      const packed = unit.end - open.start;
      const openLength = open.end - open.start;
      /* A code block never shares a chunk: its own boundaries are the split.
         An atomic unit always flushes right after it is added, so the open
         chunk here only ever holds prose. */
      if (packed > max || unit.atomic || (unit.paragraph && openLength >= min)) flush();
    }
    if (open) open = { start: open.start, end: unit.end };
    else open = { start: unit.start, end: unit.end };
    if (unit.atomic || length >= max) flush();
  }
  flush();
  return chunks;
}
