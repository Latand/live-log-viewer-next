"use client";

import { charTimesFor, timeForChar, charForTime, type CharTimes, type ProviderAlignment } from "@/lib/ttsAlignment";
import type { SpeechChunk } from "@/lib/ttsChunks";

/** One synthesized chunk: an object URL, its size, and the provider alignment. */
export interface SynthesizedChunk {
  url: string;
  bytes: number;
  alignment: ProviderAlignment | null;
}

/** The provider identity a cached chunk belongs to — the active backend option. */
export interface VoiceKey {
  id: string;
  model: string;
  voice: string;
}

/* Per-CHUNK cache, so a replay of a long answer costs nothing and a repeated
   paragraph is reused across messages. Sized to hold a whole long message
   (~25 chunks at the 800-char ceiling) plus room for a second one, because a
   cache that evicted mid-message would make replay re-buy what it just paid
   for. */
const MAX_CACHE_ENTRIES = 64;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const chunkCache = new Map<string, SynthesizedChunk>();
let cachedBytes = 0;

/* The messages this page has voiced at least once. Replay is offered from this
   set rather than from the audio cache, so an evicted message still replays —
   it just re-synthesizes the chunks that are gone. */
const MAX_SPOKEN_KEYS = 200;
const spokenMessages = new Set<string>();

export function voiceKey(voice: VoiceKey, text: string): string {
  return `${voice.id}\0${voice.model}\0${voice.voice}\0${text}`;
}

export function cachedChunk(key: string): SynthesizedChunk | null {
  const entry = chunkCache.get(key);
  if (!entry) return null;
  /* Touch: Map iterates in insertion order, so re-inserting makes it newest. */
  chunkCache.delete(key);
  chunkCache.set(key, entry);
  return entry;
}

export function cacheChunk(key: string, blob: Blob, alignment: ProviderAlignment | null): SynthesizedChunk {
  const existing = chunkCache.get(key);
  if (existing) return existing;
  const entry: SynthesizedChunk = { url: URL.createObjectURL(blob), bytes: blob.size, alignment };
  chunkCache.set(key, entry);
  cachedBytes += entry.bytes;
  while (chunkCache.size > MAX_CACHE_ENTRIES || (cachedBytes > MAX_CACHE_BYTES && chunkCache.size > 1)) {
    const oldest = chunkCache.entries().next().value as [string, SynthesizedChunk] | undefined;
    if (!oldest) break;
    chunkCache.delete(oldest[0]);
    cachedBytes -= oldest[1].bytes;
    URL.revokeObjectURL(oldest[1].url);
  }
  return entry;
}

export function markSpoken(key: string): void {
  spokenMessages.delete(key);
  spokenMessages.add(key);
  while (spokenMessages.size > MAX_SPOKEN_KEYS) {
    const oldest = spokenMessages.values().next().value as string | undefined;
    if (oldest === undefined) break;
    spokenMessages.delete(oldest);
  }
}

export function hasBeenSpoken(key: string): boolean {
  return spokenMessages.has(key);
}

/** Drops the cached audio, keeping the record that a message was voiced —
    what the LRU does to an old message, on demand. */
export function evictTtsAudio(): void {
  for (const entry of chunkCache.values()) URL.revokeObjectURL(entry.url);
  chunkCache.clear();
  cachedBytes = 0;
}

/** Test seam: back to a page that has never spoken anything. */
export function clearTtsCache(): void {
  evictTtsAudio();
  spokenMessages.clear();
}

/** A synthesis that the provider (or the route) refused, carrying its own words. */
export class TtsRequestError extends Error {
  constructor(readonly status: number, readonly provider: string | null) {
    super(provider ?? `TTS request failed (${status})`);
    this.name = "TtsRequestError";
  }
}

/** Audio that arrived but would not play — a blocked autoplay, a dead source. */
export class TtsPlaybackError extends Error {
  constructor(cause?: unknown) {
    super("audio playback failed", { cause });
    this.name = "TtsPlaybackError";
  }
}

/* The route caps concurrent syntheses at three and answers 429 above that. Two
   client slots leave one for another card, and a 429 is still possible when a
   second viewer tab is reading — so it waits and retries rather than failing a
   playback the operator already paid for. */
const RETRY_ON_BUSY = 3;
const BUSY_BACKOFF_MS = 400;

function base64ToBlob(base64: string, type: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type });
}

async function providerError(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" && body.error ? body.error : null;
  } catch {
    return null;
  }
}

/**
 * One chunk through `/api/tts`. Providers with character timestamps answer
 * with a JSON envelope (audio plus alignment); the rest stream audio bytes.
 */
export async function synthesizeChunk(
  text: string,
  signal: AbortSignal,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<{ blob: Blob; alignment: ProviderAlignment | null }> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch("/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal,
    });
    if (response.status === 429 && attempt < RETRY_ON_BUSY) {
      await response.body?.cancel();
      await sleep(BUSY_BACKOFF_MS * (attempt + 1));
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      continue;
    }
    if (!response.ok) throw new TtsRequestError(response.status, await providerError(response));
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const payload = (await response.json()) as { audio?: string; contentType?: string; alignment?: ProviderAlignment | null };
      if (!payload.audio) throw new TtsRequestError(response.status, null);
      return { blob: base64ToBlob(payload.audio, payload.contentType || "audio/mpeg"), alignment: payload.alignment ?? null };
    }
    return { blob: await response.blob(), alignment: null };
  }
}

export interface SessionPosition {
  chunkIndex: number;
  /** Character offset into the whole message text. */
  charIndex: number;
  /** Seconds played across the whole message, and its running estimate. */
  elapsed: number;
  total: number;
}

export interface TtsSessionOptions {
  chunks: SpeechChunk[];
  /** Cache key for a chunk's text under the active provider/model/voice. */
  key: (text: string) => string;
  synthesize: (text: string, signal: AbortSignal) => Promise<{ blob: Blob; alignment: ProviderAlignment | null }>;
  /** Pre-unlocked audio elements, alternated so a chunk hand-off has no gap. */
  elements: HTMLAudioElement[];
  concurrency?: number;
  onPosition: (position: SessionPosition) => void;
  onPhase: (phase: "loading" | "playing") => void;
  onError: (error: unknown) => void;
  onEnd: () => void;
}

/** Speech rate assumed for chunks whose audio has not been measured yet. */
const ASSUMED_CHARS_PER_SECOND = 15;

/**
 * Plays a chunked message: chunks are synthesized a couple at a time, ahead of
 * the voice, and played back in order on alternating audio elements. The whole
 * message is one text range, so a position in the audio is always a position in
 * the text — which is what karaoke highlighting and click-to-seek ride on.
 */
export class TtsSession {
  private readonly ready: (SynthesizedChunk | null)[];
  private readonly times: (CharTimes | null)[];
  private readonly durations: (number | null)[];
  private readonly pending = new Set<number>();
  private readonly controller = new AbortController();
  private readonly concurrency: number;
  private cursor = 0;
  private element = 0;
  /** Chunk currently wired to the active element, so replays of the same call don't restart it. */
  private wired: number | null = null;
  private seekChar: number | null = null;
  private stopped = false;

  constructor(private readonly options: TtsSessionOptions) {
    this.ready = options.chunks.map(() => null);
    this.times = options.chunks.map(() => null);
    this.durations = options.chunks.map(() => null);
    this.concurrency = Math.max(1, options.concurrency ?? 2);
  }

  /** Starts (or restarts) playback at the chunk holding `charIndex`. */
  start(charIndex = 0): void {
    if (this.stopped || !this.options.chunks.length) return;
    this.cursor = this.chunkIndexForChar(charIndex);
    this.seekChar = charIndex;
    this.options.onPhase("loading");
    this.pump();
    this.playCursor();
  }

  /** Jumps to a character of the message, synthesizing its chunk if needed. */
  seekToChar(charIndex: number): void {
    if (this.stopped || !this.options.chunks.length) return;
    const index = this.chunkIndexForChar(charIndex);
    this.seekChar = charIndex;
    if (index === this.cursor) {
      this.applySeek();
      this.emit();
      return;
    }
    this.current().pause();
    this.cursor = index;
    this.pump();
    this.playCursor();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.controller.abort();
    for (const element of this.options.elements) {
      this.unwire(element);
      element.pause();
    }
  }

  private current(): HTMLAudioElement {
    return this.options.elements[this.element % this.options.elements.length]!;
  }

  private chunkIndexForChar(charIndex: number): number {
    const chunks = this.options.chunks;
    for (let index = 0; index < chunks.length; index += 1) {
      if (charIndex < chunks[index]!.end) return index;
    }
    return chunks.length - 1;
  }

  /** Keeps `concurrency` syntheses in flight, always from the cursor forward. */
  private pump(): void {
    if (this.stopped) return;
    const chunks = this.options.chunks;
    /* The chunk under the play head is never queued behind chunks the operator
       has just seeked past: it is loaded even when that is one request over the
       client's own concurrency, which still fits the route's budget of three. */
    if (!this.ready[this.cursor] && !this.pending.has(this.cursor)) this.load(this.cursor);
    for (let index = this.cursor + 1; index < chunks.length; index += 1) {
      if (this.pending.size >= this.concurrency) return;
      if (this.ready[index] || this.pending.has(index)) continue;
      this.load(index);
    }
  }

  private load(index: number): void {
    const chunk = this.options.chunks[index]!;
    const key = this.options.key(chunk.text);
    const hit = cachedChunk(key);
    if (hit) {
      this.accept(index, hit);
      return;
    }
    this.pending.add(index);
    this.options
      .synthesize(chunk.text, this.controller.signal)
      .then(({ blob, alignment }) => {
        this.pending.delete(index);
        if (this.stopped) return;
        this.accept(index, cacheChunk(key, blob, alignment));
        this.pump();
      })
      .catch((error: unknown) => {
        this.pending.delete(index);
        if (this.stopped || this.controller.signal.aborted) return;
        this.options.onError(error);
        this.stop();
      });
  }

  private accept(index: number, entry: SynthesizedChunk): void {
    this.ready[index] = entry;
    this.times[index] = charTimesFor(this.options.chunks[index]!.text, entry.alignment);
    /* Keyed on what is wired up, not on `paused`: the element may still be
       running the silent clip that unlocked autoplay when the first chunk
       lands, and that must not read as "already playing". */
    if (index === this.cursor && this.wired !== this.cursor) this.playCursor();
    else if (index === this.cursor + 1) this.preloadNext();
  }

  /** Loads the following chunk on the idle element, so the hand-off is silent. */
  private preloadNext(): void {
    const next = this.ready[this.cursor + 1];
    if (!next || this.options.elements.length < 2) return;
    const idle = this.options.elements[(this.element + 1) % this.options.elements.length]!;
    if (idle.src === next.url) return;
    /* The idle element still carries the handlers from the chunk it played;
       loading a new source there would otherwise report that source's metadata
       (and any failure) as the chunk currently being spoken. */
    this.unwire(idle);
    idle.src = next.url;
    idle.load?.();
  }

  private unwire(element: HTMLAudioElement): void {
    element.onended = null;
    element.ontimeupdate = null;
    element.onerror = null;
    element.onloadedmetadata = null;
  }

  private playCursor(): void {
    if (this.stopped) return;
    const entry = this.ready[this.cursor];
    if (!entry) {
      this.options.onPhase("loading");
      return;
    }
    const element = this.current();
    if (this.wired === this.cursor && !element.paused) {
      this.applySeek();
      return;
    }
    const index = this.cursor;
    this.wired = index;
    /* Every handler is scoped to the chunk it was wired for: an event from a
       source this element has since moved on from changes nothing. */
    element.onloadedmetadata = () => {
      if (this.cursor !== index) return;
      this.durations[index] = Number.isFinite(element.duration) ? element.duration : null;
      /* A proportional seek needs the duration, which only arrives here. */
      if (this.seekChar !== null) this.applySeek();
      this.emit();
    };
    element.ontimeupdate = () => {
      if (this.cursor !== index) return;
      if (Number.isFinite(element.duration) && element.duration > 0) this.durations[index] = element.duration;
      this.emit();
    };
    element.onended = () => {
      if (this.cursor === index) this.advance();
    };
    element.onerror = () => {
      if (this.stopped || this.cursor !== index) return;
      this.options.onError(new TtsPlaybackError());
      this.stop();
    };
    if (element.src !== entry.url) element.src = entry.url;
    /* Always from the top: the same element can be handed the same chunk again
       (a repeated paragraph), and a stale currentTime would end it instantly. */
    element.currentTime = 0;
    element.muted = false;
    this.applySeek();
    this.options.onPhase("playing");
    void Promise.resolve(element.play()).catch((error: unknown) => {
      if (this.stopped) return;
      this.options.onError(new TtsPlaybackError(error));
      this.stop();
    });
    this.preloadNext();
    this.emit();
  }

  /** Places the play head at the requested character, when that is knowable. */
  private applySeek(): void {
    if (this.seekChar === null) return;
    const chunk = this.options.chunks[this.cursor]!;
    const offset = Math.max(0, Math.min(this.seekChar - chunk.start, chunk.text.length - 1));
    const element = this.current();
    if (offset === 0) {
      /* The head of a chunk needs no timing at all. */
      element.currentTime = 0;
      this.seekChar = null;
      return;
    }
    const times = this.times[this.cursor];
    const duration = this.durations[this.cursor] ?? 0;
    if (!times && duration <= 0) return;
    element.currentTime = timeForChar({ length: chunk.text.length, duration, times }, offset);
    this.seekChar = null;
  }

  private advance(): void {
    if (this.stopped) return;
    const element = this.current();
    if (Number.isFinite(element.duration) && element.duration > 0) this.durations[this.cursor] = element.duration;
    if (this.cursor + 1 >= this.options.chunks.length) {
      this.emit(true);
      this.stop();
      this.options.onEnd();
      return;
    }
    this.cursor += 1;
    this.element += 1;
    this.playCursor();
    this.pump();
  }

  /** Seconds already spoken, and the best estimate of the whole message. */
  private clock(finished: boolean): { elapsed: number; total: number } {
    let measured = 0;
    let measuredChars = 0;
    let unmeasuredChars = 0;
    this.options.chunks.forEach((chunk, index) => {
      const duration = this.durations[index];
      if (duration && duration > 0) {
        measured += duration;
        measuredChars += chunk.text.length;
      } else {
        unmeasuredChars += chunk.text.length;
      }
    });
    const rate = measuredChars > 0 && measured > 0 ? measuredChars / measured : ASSUMED_CHARS_PER_SECOND;
    const total = measured + unmeasuredChars / rate;
    let elapsed = 0;
    for (let index = 0; index < this.cursor; index += 1) {
      elapsed += this.durations[index] ?? this.options.chunks[index]!.text.length / rate;
    }
    elapsed += finished ? (this.durations[this.cursor] ?? 0) : this.current().currentTime;
    return { elapsed: Math.min(elapsed, total), total };
  }

  private emit(finished = false): void {
    const chunk = this.options.chunks[this.cursor];
    if (!chunk) return;
    const element = this.current();
    const timing = {
      length: chunk.text.length,
      duration: this.durations[this.cursor] ?? 0,
      times: this.times[this.cursor],
    };
    const offset = finished ? chunk.text.length - 1 : charForTime(timing, element.currentTime);
    const { elapsed, total } = this.clock(finished);
    this.options.onPosition({ chunkIndex: this.cursor, charIndex: chunk.start + offset, elapsed, total });
  }
}
