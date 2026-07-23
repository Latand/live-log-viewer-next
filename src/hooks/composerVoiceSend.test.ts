import { describe, expect, test } from "bun:test";

import { combineSpokenSubmission, performVoiceSend, type VoiceSendDeps } from "./composerVoiceSend";

/*
 * P1#1 (round-1 review), dictation arm — proven with a stable pure helper
 * instead of a process-global `useDictation` module mock. One-tap voice send
 * must combine the spoken transcript with the typed draft and hand off to the
 * SAME `submit` the Send button and Enter use (the queue-first path), so the
 * dictation optimistic bubble and composer clear come for free. A discard never
 * submits.
 */

describe("combineSpokenSubmission", () => {
  test("appends the spoken tail to the typed draft, space-joined", () => {
    expect(combineSpokenSubmission("half typed", "and the rest")).toBe("half typed and the rest");
  });
  test("uses the spoken text alone when the draft is empty", () => {
    expect(combineSpokenSubmission("", "spoken only")).toBe("spoken only");
  });
  test("keeps the typed draft when the realtime tail is empty (already committed live)", () => {
    expect(combineSpokenSubmission("already committed", "")).toBe("already committed");
  });
});

function deps(over: Partial<VoiceSendDeps> & Pick<VoiceSendDeps, "stop">): { deps: VoiceSendDeps; submitted: string[]; texts: string[]; voice: boolean[] } {
  const submitted: string[] = [];
  const texts: string[] = [];
  const voice: boolean[] = [];
  const base: VoiceSendDeps = {
    busy: false,
    voiceSending: false,
    setVoiceSending: (value) => voice.push(value),
    currentText: () => "typed so far",
    setText: (value) => texts.push(value),
    submit: (text) => { submitted.push(text ?? "<none>"); },
    ...over,
  };
  return { deps: base, submitted, texts, voice };
}

describe("performVoiceSend", () => {
  test("stop-and-send hands the combined text to the same submit as click/Enter", async () => {
    const { deps: d, submitted, texts, voice } = deps({ stop: async () => "spoken tail" });
    await performVoiceSend(d);
    // Combined draft placed in the field AND submitted through the shared path.
    expect(texts).toEqual(["typed so far spoken tail"]);
    expect(submitted).toEqual(["typed so far spoken tail"]);
    // The voice-sending flag is raised for the send and always lowered after.
    expect(voice).toEqual([true, false]);
  });

  test("a discarded recording (null) never submits", async () => {
    const { deps: d, submitted, texts } = deps({ stop: async () => null });
    await performVoiceSend(d);
    expect(submitted).toEqual([]);
    expect(texts).toEqual([]);
  });

  test("an already-in-flight send is not double-submitted", async () => {
    let stopped = false;
    const { deps: d, submitted } = deps({ busy: true, stop: async () => { stopped = true; return "x"; } });
    await performVoiceSend(d);
    expect(stopped).toBe(false);
    expect(submitted).toEqual([]);
  });

  test("the voice-sending flag is lowered even when the submit throws", async () => {
    const { deps: base, voice } = deps({ stop: async () => "spoken" });
    const d: VoiceSendDeps = { ...base, submit: () => { throw new Error("wire down"); } };
    await expect(performVoiceSend(d)).rejects.toThrow("wire down");
    expect(voice).toEqual([true, false]);
  });
});
