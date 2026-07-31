import { describe, expect, test } from "bun:test";

import {
  VOICE_STREAM_DEADLINE_MIN_CHARS,
  VOICE_STREAM_MAX_BYTES,
  VOICE_STREAM_MIN_SENTENCE_CHARS,
  takeVoiceStreamChunk,
} from "./voiceStreamChunks";

describe("semantic realtime voice chunks", () => {
  test("holds token-sized fragments until a complete substantial sentence exists", () => {
    const short = "Small token fragment. ".repeat(4);
    expect(short.length).toBeLessThan(VOICE_STREAM_MIN_SENTENCE_CHARS);
    expect(takeVoiceStreamChunk(short, "eager")).toBeNull();

    const first = `${"One related idea stays in this batch long enough to sound natural, clear, and complete. ".repeat(3)}`;
    const second = "The next sentence remains buffered.";
    const chunk = takeVoiceStreamChunk(first + second, "eager");
    expect(chunk).toEqual({ text: first, remainder: second });
  });

  test("flushes a meaningful partial phrase after the deadline", () => {
    const text = "a useful phrase with related context ".repeat(5);
    expect(text.length).toBeGreaterThanOrEqual(VOICE_STREAM_DEADLINE_MIN_CHARS);
    expect(takeVoiceStreamChunk(text, "deadline")).toEqual({ text, remainder: "" });
  });

  test("preserves exact Unicode content while respecting the byte ceiling", () => {
    const text = `🙂界${"context ".repeat(400)}`;
    const chunk = takeVoiceStreamChunk(text, "eager")!;
    expect(chunk.text + chunk.remainder).toBe(text);
    expect(Buffer.byteLength(chunk.text, "utf8")).toBeLessThanOrEqual(VOICE_STREAM_MAX_BYTES);
    expect(chunk.text).not.toContain("\ufffd");
  });

  test("flushes the final residual exactly once", () => {
    expect(takeVoiceStreamChunk("short final answer", "final")).toEqual({
      text: "short final answer",
      remainder: "",
    });
  });
});
