import { describe, expect, test } from "bun:test";

import { charForTime, charTimesFor, timeForChar, wordSpanAt, type ChunkTiming } from "./ttsAlignment";

/** An ElevenLabs-shaped alignment: one entry per character, 0.1s apiece. */
function evenAlignment(text: string, step = 0.1) {
  return {
    characters: [...text],
    starts: [...text].map((_, index) => index * step),
    ends: [...text].map((_, index) => (index + 1) * step),
  };
}

describe("charTimesFor (#1022)", () => {
  test("maps a character-per-character provider alignment straight onto the text", () => {
    const text = "Hello there";
    const times = charTimesFor(text, evenAlignment(text))!;
    expect(times.starts).toHaveLength(text.length);
    expect(times.starts[0]).toBeCloseTo(0);
    expect(times.starts[6]).toBeCloseTo(0.6);
    expect(times.ends.at(-1)).toBeCloseTo(1.1);
  });

  test("resyncs across characters the provider spoke differently", () => {
    const text = "Read 42 lines";
    const spoken = "Read forty two lines";
    const alignment = evenAlignment(spoken);
    const times = charTimesFor(text, alignment)!;
    /* "Read " lines up exactly; the tail resyncs on "lines". */
    expect(times.starts[0]).toBeCloseTo(0);
    expect(times.starts[text.indexOf("lines")]).toBeGreaterThan(times.starts[0]!);
    for (let index = 1; index < times.starts.length; index += 1) {
      expect(times.starts[index]!).toBeGreaterThanOrEqual(times.starts[index - 1]!);
    }
  });

  test("rejects an alignment that does not describe this text", () => {
    expect(charTimesFor("Completely different words here", evenAlignment("zzzz qqqq xxxx"))).toBeNull();
    expect(charTimesFor("text", null)).toBeNull();
    expect(charTimesFor("text", { characters: ["a"], starts: [0], ends: [] })).toBeNull();
    expect(charTimesFor("text", { characters: [], starts: [], ends: [] })).toBeNull();
  });
});

describe("timeForChar / charForTime (#1022)", () => {
  const text = "abcdefghij";

  test("with alignment the lookup is exact in both directions", () => {
    const timing: ChunkTiming = { length: text.length, duration: 1, times: charTimesFor(text, evenAlignment(text)) };
    expect(timing.times).not.toBeNull();
    expect(timeForChar(timing, 3)).toBeCloseTo(0.3);
    expect(charForTime(timing, 0.35)).toBe(3);
    expect(charForTime(timing, 0)).toBe(0);
    expect(charForTime(timing, 99)).toBe(text.length - 1);
  });

  test("without alignment the position is interpolated across the chunk duration", () => {
    const timing: ChunkTiming = { length: text.length, duration: 5, times: null };
    expect(timeForChar(timing, 0)).toBe(0);
    expect(timeForChar(timing, 5)).toBeCloseTo(2.5);
    expect(charForTime(timing, 2.5)).toBe(5);
    expect(charForTime(timing, 5)).toBe(text.length - 1);
    /* Before the element reports a duration nothing can be known but the start. */
    expect(charForTime({ length: text.length, duration: 0, times: null }, 3)).toBe(0);
  });

  test("indexes outside the chunk clamp instead of returning NaN", () => {
    const timing: ChunkTiming = { length: text.length, duration: 5, times: null };
    expect(timeForChar(timing, -4)).toBe(0);
    expect(timeForChar(timing, 999)).toBeCloseTo(4.5);
    expect(timeForChar({ length: 0, duration: 5, times: null }, 2)).toBe(0);
  });
});

describe("wordSpanAt (#1022)", () => {
  const text = "the quick brown fox";

  test("snaps to the word under the index", () => {
    expect(wordSpanAt(text, 0)).toEqual({ start: 0, end: 3 });
    expect(wordSpanAt(text, 5)).toEqual({ start: 4, end: 9 });
    expect(wordSpanAt(text, 18)).toEqual({ start: 16, end: 19 });
  });

  test("whitespace takes the next word, and the tail keeps the last one", () => {
    expect(wordSpanAt(text, 3)).toEqual({ start: 4, end: 9 });
    expect(wordSpanAt("hi   ", 4)).toEqual({ start: 0, end: 2 });
    expect(wordSpanAt("   ", 1)).toBeNull();
    expect(wordSpanAt("", 0)).toBeNull();
  });
});
