import { describe, expect, test } from "bun:test";

import {
  CAP_SECONDS,
  dictationCues,
  isWarning,
  micVisual,
  pingLead,
  remaining,
  warnLead,
} from "./dictationTimer";

describe("dictation cap constants and derived values", () => {
  test("the cap is ten minutes", () => {
    expect(CAP_SECONDS).toBe(600);
  });

  test("remaining counts down and never goes negative", () => {
    expect(remaining(0, 600)).toBe(600);
    expect(remaining(540, 600)).toBe(60);
    expect(remaining(600, 600)).toBe(0);
    expect(remaining(650, 600)).toBe(0);
  });

  test("leads clamp to the full minute/half-minute at the real cap", () => {
    expect(warnLead(600)).toBe(60);
    expect(pingLead(600)).toBe(30);
  });

  test("leads shrink for a short dev cap so every cue still fires", () => {
    expect(warnLead(8)).toBe(4);
    expect(pingLead(8)).toBe(2);
  });
});

describe("isWarning marks the final-stretch window", () => {
  test("off before the window, on inside it, off once capped", () => {
    expect(isWarning(539, 600)).toBe(false);
    expect(isWarning(540, 600)).toBe(true);
    expect(isWarning(599, 600)).toBe(true);
    expect(isWarning(600, 600)).toBe(false);
  });
});

describe("dictationCues fire once at their threshold crossing", () => {
  test("warn fires only on the 540→541 style crossing", () => {
    expect(dictationCues(539, 540, 600).warn).toBe(true);
    expect(dictationCues(540, 541, 600).warn).toBe(false);
    expect(dictationCues(538, 539, 600).warn).toBe(false);
  });

  test("ping fires only crossing 30s-to-go", () => {
    expect(dictationCues(569, 570, 600).ping).toBe(true);
    expect(dictationCues(570, 571, 600).ping).toBe(false);
  });

  test("capped fires only on the tick that reaches the cap", () => {
    expect(dictationCues(598, 599, 600).capped).toBe(false);
    expect(dictationCues(599, 600, 600).capped).toBe(true);
    expect(dictationCues(600, 601, 600).capped).toBe(false);
  });

  /* A full per-second replay must produce exactly one of each cue — the
     single-fire guarantee the near-cap ping and auto-stop depend on. */
  function tally(maxSeconds: number) {
    let warn = 0;
    let ping = 0;
    let capped = 0;
    for (let s = 0; s < maxSeconds + 5; s += 1) {
      const cues = dictationCues(s, s + 1, maxSeconds);
      if (cues.warn) warn += 1;
      if (cues.ping) ping += 1;
      if (cues.capped) capped += 1;
    }
    return { warn, ping, capped };
  }

  test("each cue fires exactly once across a 600s recording", () => {
    expect(tally(600)).toEqual({ warn: 1, ping: 1, capped: 1 });
  });

  test("each cue fires exactly once across a short dev cap too", () => {
    expect(tally(8)).toEqual({ warn: 1, ping: 1, capped: 1 });
  });

  test("warn precedes ping precedes cap in ordering", () => {
    const warnAt = 600 - warnLead(600);
    const pingAt = 600 - pingLead(600);
    expect(warnAt).toBeLessThan(pingAt);
    expect(pingAt).toBeLessThan(600);
  });
});

describe("micVisual — the single visual-state source", () => {
  const max = 600;
  test("idle / starting / busy pass through when nothing capped or recording", () => {
    expect(micVisual({ phase: "idle", elapsed: 0, maxSeconds: max, capStopped: false })).toBe("idle");
    expect(micVisual({ phase: "starting", elapsed: 0, maxSeconds: max, capStopped: false })).toBe("starting");
    expect(micVisual({ phase: "busy", elapsed: 0, maxSeconds: max, capStopped: false })).toBe("busy");
  });

  test("recording shows the normal chip, then the warn chip in the final stretch", () => {
    expect(micVisual({ phase: "rec", elapsed: 100, maxSeconds: max, capStopped: false })).toBe("recNormal");
    expect(micVisual({ phase: "rec", elapsed: 550, maxSeconds: max, capStopped: false })).toBe("recWarn");
  });

  test("the held cap-stopped chip covers the post-stop idle and transcription", () => {
    expect(micVisual({ phase: "idle", elapsed: 600, maxSeconds: max, capStopped: true })).toBe("capStopped");
    expect(micVisual({ phase: "busy", elapsed: 600, maxSeconds: max, capStopped: true })).toBe("capStopped");
  });

  /* Cap vs manual stop: a manual stop leaves capStopped false, and even a
     stale cap flag must never override a fresh recording — so a new start
     right after a cap shows the live meter, not the stopped chip. */
  test("a fresh recording always wins over a lingering cap flag", () => {
    expect(micVisual({ phase: "rec", elapsed: 3, maxSeconds: max, capStopped: true })).toBe("recNormal");
  });

  test("a manual stop (capStopped false) shows busy/idle, never the capped chip", () => {
    expect(micVisual({ phase: "busy", elapsed: 200, maxSeconds: max, capStopped: false })).toBe("busy");
    expect(micVisual({ phase: "idle", elapsed: 200, maxSeconds: max, capStopped: false })).toBe("idle");
  });
});
