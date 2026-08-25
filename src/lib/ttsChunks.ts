import { MAX_TTS_TEXT_LENGTH } from "@/lib/tts";

/**
 * One synthesis unit of a spoken message (issue #1022). A chunk is an exact
 * substring of the source — `source.slice(start, end) === text` — so the
 * playback queue can map an audio position back onto the message text for
 * karaoke highlighting and click-to-seek.
 *
 * The input is always `spokenAnswerText` output, which has already dropped
 * fenced and indented code, inline code, tables and every `http(s)://…` run, so
 * this splits prose and nothing else.
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
   `v1.2.3` and every dotted host in one piece — a host name never contains a
   space, so it can never straddle this boundary. */
const SENTENCE_END = /[.!?…]["'”’)\]]*(?=\s)/g;

interface Unit {
  start: number;
  end: number;
  /** Preceded by a blank line — the split point a chunk prefers. */
  paragraph: boolean;
}

function trimmedRange(source: string, start: number, end: number): { start: number; end: number } | null {
  let from = start;
  let to = end;
  while (from < to && /\s/.test(source[from]!)) from += 1;
  while (to > from && /\s/.test(source[to - 1]!)) to -= 1;
  return to > from ? { start: from, end: to } : null;
}

/** Sentence-sized units, each carrying whether a blank line opened it. */
function sentenceUnits(source: string): Unit[] {
  const units: Unit[] = [];
  const bounds: number[] = [];
  SENTENCE_END.lastIndex = 0;
  for (let match = SENTENCE_END.exec(source); match; match = SENTENCE_END.exec(source)) {
    bounds.push(match.index + match[0].length);
  }
  /* A blank line ends a unit too: list items and headings carry no full stop. */
  for (const match of source.matchAll(/\n[ \t]*\n/g)) bounds.push(match.index + match[0].length);
  bounds.sort((a, b) => a - b);

  let cursor = 0;
  for (const bound of [...bounds, source.length]) {
    if (bound <= cursor) continue;
    const range = trimmedRange(source, cursor, bound);
    if (range) {
      units.push({ ...range, paragraph: units.length > 0 && /\n[ \t]*\n\s*$/.test(source.slice(0, range.start)) });
    }
    cursor = bound;
  }
  return units;
}

/**
 * Splits a unit longer than `limit` on whitespace, never inside a word. A
 * single unbreakable token stays whole even when it overshoots — cutting a word
 * would make the synthesizer read nonsense.
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
         space so the word survives intact. */
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
export function chunkSpeech(source: string): SpeechChunk[] {
  const whole = trimmedRange(source, 0, source.length);
  if (!whole) return [];
  if (whole.end - whole.start <= MAX_CHUNK_CHARS) {
    return [{ index: 0, text: source.slice(whole.start, whole.end), start: whole.start, end: whole.end }];
  }

  /* Oversized units are cut down first, so packing never has to break one. */
  const sized: Unit[] = [];
  for (const unit of sentenceUnits(source)) {
    if (unit.end - unit.start <= MAX_CHUNK_CHARS) { sized.push(unit); continue; }
    for (const [index, piece] of splitOnWhitespace(source, unit.start, unit.end, MAX_CHUNK_CHARS).entries()) {
      const paragraph = unit.paragraph && index === 0;
      if (piece.end - piece.start <= MAX_TTS_TEXT_LENGTH) {
        sized.push({ ...piece, paragraph });
        continue;
      }
      /* An unbroken run longer than a whole request. A bare token — a hash, a
         base64 blob, a URL written without a scheme — survives
         `spokenAnswerText`, and there is no word inside it to keep whole; the
         alternative is a request the route is bound to refuse with a 413. */
      for (let at = piece.start; at < piece.end; at += MAX_TTS_TEXT_LENGTH) {
        sized.push({ start: at, end: Math.min(at + MAX_TTS_TEXT_LENGTH, piece.end), paragraph: paragraph && at === piece.start });
      }
    }
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
    if (open && (unit.end - open.start > MAX_CHUNK_CHARS || (unit.paragraph && open.end - open.start >= MIN_CHUNK_CHARS))) flush();
    open = open ? { start: open.start, end: unit.end } : { start: unit.start, end: unit.end };
    if (length >= MAX_CHUNK_CHARS) flush();
  }
  flush();
  return chunks;
}
