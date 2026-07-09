import { describe, expect, test } from "bun:test";

import { TUNES } from "./chime";

describe("dictation cap chimes are distinct and correctly shaped", () => {
  test("the near-cap warning is a single ping", () => {
    expect(TUNES.dictWarn).toHaveLength(1);
  });

  test("the cap stop is an unmistakably descending two-note", () => {
    const stop = TUNES.dictStop;
    expect(stop).toHaveLength(2);
    expect(stop[1].freq).toBeLessThan(stop[0].freq);
    expect(stop[1].at).toBeGreaterThan(stop[0].at);
  });

  test("the stop tune sits below the warning ping so the ear reads 'ended'", () => {
    const stopLow = Math.min(...TUNES.dictStop.map((note) => note.freq));
    const warnFreq = TUNES.dictWarn[0].freq;
    expect(stopLow).toBeLessThan(warnFreq);
  });

  test("the two new cues are distinct from every lifecycle tune", () => {
    const signature = (kind: keyof typeof TUNES) => TUNES[kind].map((n) => `${n.freq}@${n.at}`).join(",");
    const lifecycle = (["waiting", "returned", "stalled", "question", "spawned"] as const).map(signature);
    expect(lifecycle).not.toContain(signature("dictWarn"));
    expect(lifecycle).not.toContain(signature("dictStop"));
    expect(signature("dictWarn")).not.toBe(signature("dictStop"));
  });
});
