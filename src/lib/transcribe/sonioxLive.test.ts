import { describe, expect, test } from "bun:test";

import {
  applySonioxFrame,
  sonioxLiveInitialState,
  sonioxStartRequest,
  SONIOX_LIVE_MODEL,
  SONIOX_LIVE_WS_URL,
} from "./sonioxLive";

/* Frames mirror the documented realtime schema
   (soniox.com/docs/stt/api-reference/websocket-api): a tokens array whose
   entries carry text/is_final, plus final_audio_proc_ms, total_audio_proc_ms,
   finished and a null error_code on every healthy frame. */
function frame(tokens: { text: string; is_final: boolean }[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    tokens,
    final_audio_proc_ms: 4800,
    total_audio_proc_ms: 5250,
    finished: false,
    error_code: null,
    ...extra,
  });
}

describe("Soniox realtime start request", () => {
  test("asks for raw PCM at the context's own rate, with endpoint detection", () => {
    expect(SONIOX_LIVE_WS_URL).toBe("wss://stt-rt.soniox.com/transcribe-websocket");
    expect(sonioxStartRequest({ token: "temp:ABC", sampleRate: 48_000 })).toEqual({
      api_key: "temp:ABC",
      model: SONIOX_LIVE_MODEL,
      audio_format: "pcm_s16le",
      sample_rate: 48_000,
      num_channels: 1,
      enable_endpoint_detection: true,
    });
  });

  test("passes language hints only when there are some, and rounds a fractional rate", () => {
    expect(sonioxStartRequest({ token: "t", sampleRate: 44_100.4, languageHints: ["en", "uk"] })).toMatchObject({
      sample_rate: 44_100,
      language_hints: ["en", "uk"],
    });
    expect(sonioxStartRequest({ token: "t", sampleRate: 16_000, languageHints: [] })).not.toHaveProperty("language_hints");
  });
});

describe("Soniox realtime frame folding", () => {
  test("non-final tokens render as the live tail without committing anything", () => {
    const update = applySonioxFrame(sonioxLiveInitialState(), frame([
      { text: "What's", is_final: false },
      { text: " the", is_final: false },
    ]));
    expect(update).not.toBeNull();
    expect(update!.liveText).toBe("What's the");
    expect(update!.commit).toBe("");
    expect(update!.state.finalText).toBe("");
  });

  test("sub-word final tokens join into one word instead of one commit each", () => {
    /* The reason a segment is only cut at the endpoint: committing per token
       would spell "Hel lo" into the draft. */
    let state = sonioxLiveInitialState();
    const first = applySonioxFrame(state, frame([{ text: "Hel", is_final: true }]))!;
    state = first.state;
    expect(first.commit).toBe("");
    expect(first.liveText).toBe("Hel");

    const second = applySonioxFrame(state, frame([
      { text: "lo", is_final: true },
      { text: " there", is_final: false },
    ]))!;
    expect(second.commit).toBe("");
    expect(second.liveText).toBe("Hello there");
    expect(second.state.finalText).toBe("Hello");
  });

  test("the endpoint token closes the segment and clears the carry", () => {
    let state = sonioxLiveInitialState();
    state = applySonioxFrame(state, frame([{ text: "Hello", is_final: true }]))!.state;
    const closed = applySonioxFrame(state, frame([
      { text: " there", is_final: true },
      { text: "<end>", is_final: true },
    ]))!;
    expect(closed.commit).toBe("Hello there");
    expect(closed.liveText).toBe("");
    expect(closed.state.finalText).toBe("");

    /* The next utterance starts clean — no leftovers from the committed one. */
    const next = applySonioxFrame(closed.state, frame([{ text: "Second", is_final: false }]))!;
    expect(next.commit).toBe("");
    expect(next.liveText).toBe("Second");
  });

  test("a frame that both closes a segment and starts the next keeps them apart", () => {
    const update = applySonioxFrame({ finalText: "Hello" }, frame([
      { text: "<end>", is_final: true },
      { text: "Next", is_final: false },
    ]))!;
    expect(update.commit).toBe("Hello");
    expect(update.liveText).toBe("Next");
  });

  test("two endpoints in one frame commit as separate segments", () => {
    const update = applySonioxFrame({ finalText: "One" }, frame([
      { text: "<end>", is_final: true },
      { text: "Two", is_final: true },
      { text: "<end>", is_final: true },
    ]))!;
    expect(update.commit).toBe("One Two");
    expect(update.state.finalText).toBe("");
  });

  test("a healthy frame's null error_code is not an error, and finished is reported", () => {
    const healthy = applySonioxFrame(sonioxLiveInitialState(), frame([{ text: "hi", is_final: false }]))!;
    expect(healthy.error).toBeNull();
    expect(healthy.finished).toBe(false);

    const done = applySonioxFrame({ finalText: "" }, frame([], { finished: true }))!;
    expect(done.finished).toBe(true);
    expect(done.error).toBeNull();
  });

  test("an error frame surfaces the server's message", () => {
    const update = applySonioxFrame(
      sonioxLiveInitialState(),
      JSON.stringify({
        error_code: 401,
        error_type: "unauthorized",
        error_message: "Invalid API key.",
        request_id: "req_1",
      }),
    )!;
    expect(update.error).toBe("Invalid API key.");
  });

  test("an error code without a message still reads as a failure", () => {
    expect(applySonioxFrame(sonioxLiveInitialState(), JSON.stringify({ error_code: 429 }))!.error).toContain("429");
  });

  test("frames that are not JSON objects are ignored", () => {
    const state = sonioxLiveInitialState();
    expect(applySonioxFrame(state, new ArrayBuffer(8))).toBeNull();
    expect(applySonioxFrame(state, "not json")).toBeNull();
    expect(applySonioxFrame(state, "[1,2,3]")).toBeNull();
    expect(applySonioxFrame(state, "null")).toBeNull();
  });

  test("malformed tokens are skipped rather than rendered", () => {
    const update = applySonioxFrame(sonioxLiveInitialState(), frame([]))!;
    expect(update.liveText).toBe("");
    const mixed = applySonioxFrame(
      sonioxLiveInitialState(),
      JSON.stringify({ tokens: [null, { is_final: true }, { text: 7 }, { text: "ok", is_final: false }] }),
    )!;
    expect(mixed.liveText).toBe("ok");
  });
});
