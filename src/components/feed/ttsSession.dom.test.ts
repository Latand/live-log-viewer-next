import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { MAX_TTS_MESSAGE_LENGTH } from "@/lib/tts";
import { chunkSpeech, MIN_CHUNK_CHARS } from "@/lib/ttsChunks";

import {
  ASSUMED_CHARS_PER_SECOND,
  cacheChunk,
  cachedChunk,
  chunksCached,
  clearTtsCache,
  hasBeenSpoken,
  markSpoken,
  synthesizeChunk,
  TTS_AUDIO_BYTES_PER_SECOND,
  TtsRequestError,
  TtsSession,
  voiceKey,
} from "./ttsSession";

const originalFetch = globalThis.fetch;
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

/**
 * A stand-in for HTMLAudioElement: playback is driven by the test, not a clock.
 * Metadata arrives when a source is assigned, as it does in a browser — which
 * is why a chunk preloaded onto an unwired element reports its duration to
 * nobody, and why `play()` alone cannot stand in for that event.
 */
class FakeAudio {
  private source = "";
  currentTime = 0;
  duration = 4;
  muted = false;
  paused = true;
  plays = 0;
  loads = 0;
  onloadedmetadata: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  get src() { return this.source; }
  set src(value: string) {
    if (value === this.source) return;
    this.source = value;
    this.currentTime = 0;
    this.onloadedmetadata?.();
  }
  load() { this.loads += 1; }
  pause() { this.paused = true; }
  async play() {
    this.plays += 1;
    this.paused = false;
  }
  /** Runs this chunk to its end, the way the browser would. */
  finish() {
    this.currentTime = this.duration;
    this.paused = true;
    this.onended?.();
  }
  tick(time: number) {
    this.currentTime = time;
    this.ontimeupdate?.();
  }
}

function elements(): FakeAudio[] {
  return [new FakeAudio(), new FakeAudio()];
}

function urlOf(text: string): string {
  return `blob:${text.slice(0, 12)}`;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

const LONG = Array.from({ length: 60 }, (_, index) => `This is spoken sentence number ${index} of the answer.`).join(" ");
/* The most chunks a message can have: every chunk but the last is at least
   MIN_CHUNK_CHARS, so the longest message the control reads splits into this
   many at worst. */
const LONGEST_MESSAGE_CHUNKS = Math.ceil(MAX_TTS_MESSAGE_LENGTH / MIN_CHUNK_CHARS);

beforeEach(() => {
  clearTtsCache();
  URL.createObjectURL = mock((blob: Blob) => urlOf(String((blob as Blob & { text?: string }).text ?? Math.random())));
  URL.revokeObjectURL = mock(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

/** Session wiring whose synthesis is resolved by hand, one chunk at a time. */
function harness(source = LONG, options: { concurrency?: number } = {}) {
  const chunks = chunkSpeech(source);
  const audio = elements();
  const requested: string[] = [];
  const resolvers = new Map<string, (value: { blob: Blob; alignment: null }) => void>();
  const rejecters = new Map<string, (error: unknown) => void>();
  const positions: { chunkIndex: number; charIndex: number; elapsed: number; total: number }[] = [];
  const phases: string[] = [];
  const errors: unknown[] = [];
  let ended = 0;

  const session = new TtsSession({
    chunks,
    key: (text) => voiceKey({ id: "openai", model: "m", voice: "v" }, text),
    synthesize: (text) => {
      requested.push(text);
      return new Promise((resolve, reject) => {
        resolvers.set(text, resolve);
        rejecters.set(text, reject);
      });
    },
    elements: audio as unknown as HTMLAudioElement[],
    concurrency: options.concurrency ?? 2,
    onPosition: (position) => positions.push(position),
    onPhase: (phase) => phases.push(phase),
    onError: (error) => errors.push(error),
    onEnd: () => { ended += 1; },
  });

  const deliver = async (index: number) => {
    const text = chunks[index]!.text;
    const blob = new Blob([text]);
    Object.assign(blob, { text });
    resolvers.get(text)!({ blob, alignment: null });
    await settle();
  };
  const reject = async (index: number, error: unknown) => {
    rejecters.get(chunks[index]!.text)!(error);
    await settle();
  };

  return { chunks, audio, requested, session, positions, phases, errors, deliver, reject, ended: () => ended };
}

describe("TtsSession (#1022)", () => {
  test("synthesizes ahead in parallel and plays the chunks in order", async () => {
    const view = harness();
    expect(view.chunks.length).toBeGreaterThan(3);
    view.session.start();
    await settle();

    /* Two requests are in flight before a single byte has played. */
    expect(view.requested).toEqual([view.chunks[0]!.text, view.chunks[1]!.text]);
    expect(view.audio[0]!.plays).toBe(0);

    await view.deliver(0);
    expect(view.audio[0]!.src).toBe(urlOf(view.chunks[0]!.text));
    expect(view.audio[0]!.plays).toBe(1);
    /* Playing chunk 0 frees a slot, so chunk 2 is already being fetched. */
    expect(view.requested).toContain(view.chunks[2]!.text);

    await view.deliver(1);
    /* The next chunk is preloaded on the second element, not on the playing one. */
    expect(view.audio[1]!.src).toBe(urlOf(view.chunks[1]!.text));
    expect(view.audio[1]!.plays).toBe(0);

    view.audio[0]!.finish();
    await settle();
    expect(view.audio[1]!.plays).toBe(1);
    expect(view.audio[0]!.paused).toBe(true);
    view.session.stop();
  });

  test("a chunk starts from the top on an element that carried another one", async () => {
    const view = harness();
    view.session.start();
    await settle();
    await view.deliver(0);
    /* The idle element is preloading chunk 1 and keeps no handlers of its own,
       so its metadata and failures cannot be read as the chunk being spoken. */
    await view.deliver(1);
    expect(view.audio[1]!.onloadedmetadata).toBeNull();
    expect(view.audio[1]!.onended).toBeNull();

    view.audio[1]!.currentTime = 3.5;
    view.audio[0]!.finish();
    await settle();
    expect(view.audio[1]!.currentTime).toBe(0);
    view.session.stop();
  });

  test("waits for a chunk that is not ready yet and resumes when it lands", async () => {
    const view = harness();
    view.session.start();
    await settle();
    await view.deliver(0);
    view.audio[0]!.finish();
    await settle();

    /* Chunk 1 has not arrived: the session reports loading and plays nothing. */
    expect(view.phases.at(-1)).toBe("loading");
    expect(view.audio[1]!.plays).toBe(0);

    await view.deliver(1);
    expect(view.audio[1]!.plays).toBe(1);
    expect(view.phases.at(-1)).toBe("playing");
    view.session.stop();
  });

  test("reports the spoken character position as the audio advances", async () => {
    const view = harness();
    view.session.start();
    await settle();
    await view.deliver(0);
    const chunk = view.chunks[0]!;
    view.audio[0]!.tick(2);
    const position = view.positions.at(-1)!;
    /* Half the chunk's four seconds is about half its characters. */
    expect(position.chunkIndex).toBe(0);
    expect(position.charIndex).toBeGreaterThan(chunk.start + chunk.text.length * 0.3);
    expect(position.charIndex).toBeLessThan(chunk.start + chunk.text.length * 0.7);
    expect(position.total).toBeGreaterThan(position.elapsed);
    view.session.stop();
  });

  test("ends after the last chunk and reports the end once", async () => {
    const view = harness("First short sentence here.");
    expect(view.chunks).toHaveLength(1);
    view.session.start();
    await settle();
    await view.deliver(0);
    view.audio[0]!.finish();
    await settle();
    expect(view.ended()).toBe(1);
    expect(view.errors).toEqual([]);
  });

  test("a failure mid-sequence stops the session with the provider's own words", async () => {
    const view = harness();
    view.session.start();
    await settle();
    await view.deliver(0);
    expect(view.audio[0]!.plays).toBe(1);

    await view.reject(1, new TtsRequestError(502, "elevenlabs TTS failed (HTTP 401)"));

    expect(view.errors).toHaveLength(1);
    expect((view.errors[0] as TtsRequestError).provider).toBe("elevenlabs TTS failed (HTTP 401)");
    expect(view.audio[0]!.paused).toBe(true);
    expect(view.audio[1]!.plays).toBe(0);
    /* Stopped means stopped: the finished element cannot advance the sequence. */
    view.audio[0]!.finish();
    await settle();
    expect(view.ended()).toBe(0);
  });

  test("replay costs nothing while the chunks are cached, and re-synthesizes only what was evicted", async () => {
    const first = harness();
    first.session.start();
    await settle();
    await first.deliver(0);
    await first.deliver(1);
    first.session.stop();

    const replay = harness();
    replay.session.start();
    await settle();
    /* Both chunks came from the cache, so the replay asked for neither. */
    expect(replay.requested).not.toContain(replay.chunks[0]!.text);
    expect(replay.requested).not.toContain(replay.chunks[1]!.text);
    expect(replay.audio[0]!.plays).toBe(1);
    replay.session.stop();

    clearTtsCache();
    const evicted = harness();
    evicted.session.start();
    await settle();
    expect(evicted.requested).toContain(evicted.chunks[0]!.text);
    await evicted.deliver(0);
    expect(evicted.audio[0]!.plays).toBe(1);
    evicted.session.stop();
  });

  test("a seek in the first moments of a preloaded chunk still moves the play head", async () => {
    const view = harness();
    view.session.start();
    await settle();
    await view.deliver(0);
    /* Chunk 1 is preloaded on the idle element, which is unwired: it reports
       its metadata to nobody, and after the hand-off no event will repeat it. */
    await view.deliver(1);
    view.audio[0]!.finish();
    await settle();
    const element = view.audio[1]!;
    expect(element.paused).toBe(false);
    expect(element.currentTime).toBe(0);

    /* A click before the first timeupdate of the new chunk. */
    const chunk = view.chunks[1]!;
    view.session.seekToChar(chunk.start + Math.floor(chunk.text.length / 2));

    expect(element.currentTime).toBeGreaterThan(1.5);
    expect(element.currentTime).toBeLessThan(2.5);
    view.session.stop();
  });

  test("seeking inside a synthesized chunk moves the play head proportionally", async () => {
    const view = harness();
    view.session.start();
    await settle();
    await view.deliver(0);
    const chunk = view.chunks[0]!;

    view.session.seekToChar(chunk.start + Math.floor(chunk.text.length / 2));

    /* Four seconds of audio, half the text: about two seconds in. */
    expect(view.audio[0]!.currentTime).toBeGreaterThan(1.5);
    expect(view.audio[0]!.currentTime).toBeLessThan(2.5);
    expect(view.audio[0]!.plays).toBe(1);
    view.session.stop();
  });

  test("seeking into a chunk that is not synthesized yet queues it and starts there", async () => {
    const view = harness();
    view.session.start();
    await settle();
    await view.deliver(0);
    const target = view.chunks[3]!;

    view.session.seekToChar(target.start + 10);
    await settle();

    expect(view.audio[0]!.paused).toBe(true);
    expect(view.phases.at(-1)).toBe("loading");
    expect(view.requested).toContain(target.text);

    await view.deliver(3);
    const playing = view.audio.find((element) => !element.paused)!;
    expect(playing.src).toBe(urlOf(target.text));
    expect(playing.currentTime).toBeGreaterThan(0);
    expect(view.positions.at(-1)!.chunkIndex).toBe(3);
    view.session.stop();
  });

  test("seeking with a character alignment lands on the aligned second", async () => {
    const chunks = chunkSpeech("Alpha beta gamma delta.");
    const text = chunks[0]!.text;
    const audio = elements();
    const session = new TtsSession({
      chunks,
      key: (value) => voiceKey({ id: "elevenlabs", model: "m", voice: "v" }, value),
      synthesize: async () => ({
        blob: Object.assign(new Blob([text]), { text }),
        alignment: {
          characters: [...text],
          /* One second per character: the aligned time is the index itself. */
          starts: [...text].map((_, index) => index),
          ends: [...text].map((_, index) => index + 1),
        },
      }),
      elements: audio as unknown as HTMLAudioElement[],
      onPosition: () => {},
      onPhase: () => {},
      onError: () => {},
      onEnd: () => {},
    });
    session.start();
    await settle();

    session.seekToChar(text.indexOf("gamma"));

    expect(audio[0]!.currentTime).toBe(text.indexOf("gamma"));
    session.stop();
  });

  test("stop halts playback and ignores syntheses still in flight", async () => {
    const view = harness();
    view.session.start();
    await settle();
    await view.deliver(0);
    view.session.stop();

    expect(view.audio[0]!.paused).toBe(true);
    const before = view.audio.map((element) => element.plays);
    await view.deliver(1);
    expect(view.audio.map((element) => element.plays)).toEqual(before);
  });
});

describe("chunk cache and replay markers (#1022)", () => {
  test("the cache keys on provider, model, voice and chunk text", () => {
    const key = voiceKey({ id: "openai", model: "gpt-4o-mini-tts", voice: "alloy" }, "Hello");
    expect(cachedChunk(key)).toBeNull();
    cacheChunk(key, new Blob(["audio"]), null);
    expect(cachedChunk(key)).not.toBeNull();
    expect(cachedChunk(voiceKey({ id: "openai", model: "gpt-4o-mini-tts", voice: "nova" }, "Hello"))).toBeNull();
    expect(cachedChunk(voiceKey({ id: "elevenlabs", model: "gpt-4o-mini-tts", voice: "alloy" }, "Hello"))).toBeNull();
  });

  test("a spoken message stays replayable after its audio is evicted", () => {
    const key = voiceKey({ id: "openai", model: "m", voice: "v" }, "message text");
    expect(hasBeenSpoken(key)).toBe(false);
    markSpoken(key);
    cacheChunk(key, new Blob(["audio"]), null);
    expect(hasBeenSpoken(key)).toBe(true);
  });

  test("eviction revokes the object URL it drops", () => {
    const revoke = mock(() => {});
    URL.revokeObjectURL = revoke;
    const over = LONGEST_MESSAGE_CHUNKS * 2;
    for (let index = 0; index < over; index += 1) {
      cacheChunk(voiceKey({ id: "openai", model: "m", voice: "v" }, `chunk ${index}`), new Blob([`audio ${index}`]), null);
    }
    expect(revoke.mock.calls.length).toBeGreaterThan(0);
    expect(cachedChunk(voiceKey({ id: "openai", model: "m", voice: "v" }, "chunk 0"))).toBeNull();
    expect(cachedChunk(voiceKey({ id: "openai", model: "m", voice: "v" }, `chunk ${over - 1}`))).not.toBeNull();
  });

  /* The cache exists so a replay is free. That only holds if a whole message at
     the ceiling fits it — at the fattest audio the route accepts, which is the
     bitrate the byte cap is derived from. */
  test("a message at the length ceiling fits whole: its head is still cached when its tail lands", () => {
    const bytesPerChunk = Math.ceil((MIN_CHUNK_CHARS / ASSUMED_CHARS_PER_SECOND) * TTS_AUDIO_BYTES_PER_SECOND);
    const key = (index: number) => voiceKey({ id: "elevenlabs", model: "m", voice: "v" }, `chunk ${index}`);
    for (let index = 0; index < LONGEST_MESSAGE_CHUNKS; index += 1) {
      cacheChunk(key(index), new Blob([new Uint8Array(bytesPerChunk)]), null);
    }

    expect(cachedChunk(key(0))).not.toBeNull();
    expect(cachedChunk(key(LONGEST_MESSAGE_CHUNKS - 1))).not.toBeNull();
    expect(chunksCached(Array.from({ length: LONGEST_MESSAGE_CHUNKS }, (_, index) => key(index)))).toBe(true);
  });
});

describe("synthesizeChunk (#1022)", () => {
  test("decodes a timestamped JSON envelope into audio plus alignment", async () => {
    globalThis.fetch = mock(async () => Response.json({
      audio: "QUJD",
      contentType: "audio/mpeg",
      alignment: { characters: ["H", "i"], starts: [0, 0.1], ends: [0.1, 0.2] },
    })) as unknown as typeof fetch;

    const result = await synthesizeChunk("Hi", new AbortController().signal);

    expect(await result.blob.text()).toBe("ABC");
    expect(result.blob.type).toBe("audio/mpeg");
    expect(result.alignment).toEqual({ characters: ["H", "i"], starts: [0, 0.1], ends: [0.1, 0.2] });
  });

  test("takes an audio response as-is, with no alignment", async () => {
    globalThis.fetch = mock(async () => new Response(new Blob(["mp3"]), { headers: { "content-type": "audio/mpeg" } })) as unknown as typeof fetch;
    const result = await synthesizeChunk("Hi", new AbortController().signal);
    expect(await result.blob.text()).toBe("mp3");
    expect(result.alignment).toBeNull();
  });

  test("waits out the route's busy answer, then surfaces a real failure verbatim", async () => {
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      return calls === 1
        ? Response.json({ error: "another read-aloud is in progress" }, { status: 429 })
        : Response.json({ error: "openai TTS failed (HTTP 401)" }, { status: 502 });
    }) as unknown as typeof fetch;

    const failure = await synthesizeChunk("Hi", new AbortController().signal, async () => {}).catch((error: unknown) => error);

    expect(calls).toBe(2);
    expect(failure).toBeInstanceOf(TtsRequestError);
    expect((failure as TtsRequestError).provider).toBe("openai TTS failed (HTTP 401)");
  });
});
