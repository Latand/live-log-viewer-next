import { describe, expect, test } from "bun:test";

import {
  createAmbientLoop,
  CUE_DUCK,
  CUE_DUCK_HOLD_MS,
  FADE_IN_SECONDS,
  FADE_OUT_SECONDS,
  loopGain,
  SPEECH_DUCK,
  type LoopTransport,
  type LoopVoiceHandle,
} from "./ambientLoop";
import { cueGain } from "./cues";
import { AMBIENT_LOOP_ASSET } from "./loopAsset";
import { DEFAULT_AUDIO_PREFS, type AudioPrefs } from "./prefs";
import { speakingFromLines } from "./speech";

type Ramp = { gain: number; seconds: number };

/** Records every level change the bed asks for, so a test can tell a ramp from
    a step and a fade from a cut. */
function recorder(options: { refuse?: boolean } = {}) {
  const starts: { src: string; gain: number }[] = [];
  const ramps: Ramp[] = [];
  const stops: number[] = [];
  const transport: LoopTransport = {
    start(request) {
      if (options.refuse) return null;
      starts.push(request);
      const handle: LoopVoiceHandle = {
        rampTo: (gain, seconds) => void ramps.push({ gain, seconds }),
        stop: (seconds) => void stops.push(seconds),
      };
      return handle;
    },
  };
  return { transport, starts, ramps, stops, last: () => ramps.at(-1) };
}

function loop(
  prefs: AudioPrefs,
  sink: ReturnType<typeof recorder>,
  extras: { asset?: string | null } = {},
) {
  const timers = new Map<number, () => void>();
  let sequence = 0;
  const bed = createAmbientLoop({
    asset: extras.asset === undefined ? AMBIENT_LOOP_ASSET : extras.asset,
    transport: sink.transport,
    prefs: () => prefs,
    schedule: (run) => {
      timers.set(++sequence, run);
      return sequence;
    },
    cancel: (handle) => void timers.delete(handle),
  });
  return {
    bed,
    /** Fire every pending scheduled release, as the clock would. */
    runTimers() {
      for (const [handle, run] of [...timers]) {
        timers.delete(handle);
        run();
      }
    },
    pendingTimers: () => timers.size,
  };
}

const enabled = (over: Partial<AudioPrefs> = {}): AudioPrefs => ({
  ...DEFAULT_AUDIO_PREFS,
  loopEnabled: true,
  ...over,
});

describe("eligibility", () => {
  test("the shipped release has an asset, so the bed is available", () => {
    const sink = recorder();
    expect(loop(enabled(), sink).bed.configured()).toBe(true);
  });

  test("nothing plays before a call connects", () => {
    const sink = recorder();
    const { bed } = loop(enabled(), sink);
    bed.refresh();
    expect(sink.starts).toEqual([]);
    expect(bed.state().playing).toBe(false);
  });

  test("a persisted opt-in starts the bed by itself on the next connection", () => {
    const sink = recorder();
    /* No UI interaction in this test: the device said yes on some earlier day
       and the setting is all that is left of that. */
    const { bed } = loop(enabled(), sink);

    bed.setVoiceConnected(true);

    expect(sink.starts).toHaveLength(1);
    expect(sink.starts[0].src).toBe(AMBIENT_LOOP_ASSET as string);
    expect(bed.state().playing).toBe(true);
  });

  test("first run — the bed stays silent until the device opts in", () => {
    const sink = recorder();
    const prefs = { ...DEFAULT_AUDIO_PREFS };
    const { bed } = loop(prefs, sink);

    bed.setVoiceConnected(true);
    expect(sink.starts).toEqual([]);

    /* The operator enables it mid-call: it comes up without reconnecting. */
    prefs.loopEnabled = true;
    bed.refresh();
    expect(sink.starts).toHaveLength(1);
  });

  test("the master switch governs the bed as well as the cues", () => {
    const prefs = enabled({ cuesEnabled: false });
    const sink = recorder();
    const { bed } = loop(prefs, sink);

    bed.setVoiceConnected(true);
    expect(sink.starts).toEqual([]);

    /* Unmuting the master brings it up; muting again fades it out. */
    prefs.cuesEnabled = true;
    bed.refresh();
    expect(sink.starts).toHaveLength(1);
    prefs.cuesEnabled = false;
    bed.refresh();
    expect(sink.stops).toEqual([FADE_OUT_SECONDS]);
    expect(bed.state().playing).toBe(false);
  });

  test("with no asset configured nothing is started and nothing is claimed", () => {
    const sink = recorder();
    const { bed } = loop(enabled(), sink, { asset: null });

    bed.setVoiceConnected(true);
    bed.setSpeaking("agent");
    bed.duckForCue("attention");
    bed.refresh();

    expect(bed.configured()).toBe(false);
    expect(bed.wanted()).toBe(false);
    expect(sink.starts).toEqual([]);
    expect(sink.ramps).toEqual([]);
  });

  test("an autoplay-locked device wants the bed and keeps wanting it", () => {
    const locked = recorder({ refuse: true });
    const { bed } = loop(enabled(), locked);

    bed.setVoiceConnected(true);

    /* Nothing threw, nothing is playing, and the caller can see it should retry
       once the gesture lands. */
    expect(bed.state().playing).toBe(false);
    expect(bed.wanted()).toBe(true);
  });
});

describe("fades", () => {
  test("connecting fades in from silence rather than cutting in", () => {
    const sink = recorder();
    const { bed } = loop(enabled({ loopVolume: 1 }), sink);

    bed.setVoiceConnected(true);

    expect(sink.starts[0].gain).toBe(0);
    expect(sink.ramps[0]).toEqual({ gain: loopGain(1), seconds: FADE_IN_SECONDS });
  });

  test("disconnecting fades out over time, never a hard stop", () => {
    const sink = recorder();
    const { bed } = loop(enabled(), sink);

    bed.setVoiceConnected(true);
    bed.setVoiceConnected(false);

    expect(sink.stops).toEqual([FADE_OUT_SECONDS]);
    expect(FADE_OUT_SECONDS).toBeGreaterThan(0);
    expect(bed.state().playing).toBe(false);
  });

  test("a second call starts a fresh fade-in", () => {
    const sink = recorder();
    const { bed } = loop(enabled(), sink);

    bed.setVoiceConnected(true);
    bed.setVoiceConnected(false);
    bed.setVoiceConnected(true);

    expect(sink.starts).toHaveLength(2);
    expect(sink.starts[1].gain).toBe(0);
    expect(sink.ramps.at(-1)?.seconds).toBe(FADE_IN_SECONDS);
  });
});

describe("ducking", () => {
  test("either participant speaking ducks the bed smoothly, and it recovers", () => {
    const prefs = enabled({ loopVolume: 1 });
    const sink = recorder();
    const { bed } = loop(prefs, sink);
    bed.setVoiceConnected(true);
    const full = loopGain(1);

    for (const speaker of ["operator", "agent"] as const) {
      bed.setSpeaking(speaker);
      const down = sink.last()!;
      expect(down.gain).toBeCloseTo(full * SPEECH_DUCK, 6);
      /* A ramp, not a step: a stepped duck is itself an event the ear reports. */
      expect(down.seconds).toBeGreaterThan(0);
      expect(bed.state().ducked).toBe(true);

      bed.setSpeaking(null);
      const up = sink.last()!;
      expect(up.gain).toBeCloseTo(full, 6);
      expect(up.seconds).toBeGreaterThan(0);
      expect(bed.state().ducked).toBe(false);
    }
  });

  test("attention and failure duck the bed, then release it", () => {
    const prefs = enabled({ loopVolume: 1 });
    const sink = recorder();
    const harness = loop(prefs, sink);
    harness.bed.setVoiceConnected(true);
    const full = loopGain(1);

    for (const cue of ["attention", "failure"] as const) {
      harness.bed.duckForCue(cue);
      expect(sink.last()!.gain).toBeCloseTo(full * CUE_DUCK, 6);
      expect(sink.last()!.seconds).toBeGreaterThan(0);

      harness.runTimers();
      expect(sink.last()!.gain).toBeCloseTo(full, 6);
      expect(harness.bed.state().ducked).toBe(false);
    }
    expect(CUE_DUCK_HOLD_MS).toBeGreaterThan(0);
  });

  test("routine cues leave the bed where it is", () => {
    const sink = recorder();
    const harness = loop(enabled({ loopVolume: 1 }), sink);
    harness.bed.setVoiceConnected(true);
    const before = sink.ramps.length;

    harness.bed.duckForCue("tool-tick");
    harness.bed.duckForCue("viewer-mcp");
    harness.bed.duckForCue("success");

    expect(sink.ramps).toHaveLength(before);
    expect(harness.bed.state().ducked).toBe(false);
    expect(harness.pendingTimers()).toBe(0);
  });

  test("speech outranks a cue duck: the recovery does not talk over the speaker", () => {
    const prefs = enabled({ loopVolume: 1 });
    const sink = recorder();
    const harness = loop(prefs, sink);
    harness.bed.setVoiceConnected(true);

    harness.bed.duckForCue("attention");
    harness.bed.setSpeaking("agent");
    harness.runTimers();

    /* The cue's release fired while the agent is still talking: the bed stays at
       the speech duck, not back up at full. */
    expect(sink.last()!.gain).toBeCloseTo(loopGain(1) * SPEECH_DUCK, 6);
  });

  test("leaving a call forgets who was talking", () => {
    const sink = recorder();
    const harness = loop(enabled({ loopVolume: 1 }), sink);

    harness.bed.setVoiceConnected(true);
    harness.bed.setSpeaking("operator");
    harness.bed.duckForCue("failure");
    harness.bed.setVoiceConnected(false);
    harness.bed.setVoiceConnected(true);

    /* The new call opens at full bed level, not mid-duck from the last one. */
    expect(sink.last()).toEqual({ gain: loopGain(1), seconds: FADE_IN_SECONDS });
    expect(harness.bed.state().ducked).toBe(false);
    expect(harness.pendingTimers()).toBe(0);
  });
});

describe("levels", () => {
  test("the bed stays under every cue tier, even at full slider", () => {
    const quietest = cueGain("tool-tick", 1);
    expect(loopGain(1)).toBeLessThan(quietest);
    /* And the shipped default is a whisper by comparison. */
    expect(loopGain(DEFAULT_AUDIO_PREFS.loopVolume)).toBeLessThan(loopGain(1));
    expect(loopGain(DEFAULT_AUDIO_PREFS.loopVolume)).toBeLessThan(quietest / 2);
  });

  test("the ambient level is its own: moving it never moves a cue", () => {
    const prefs = enabled({ loopVolume: 0.2, cueVolume: 0.9 });
    const sink = recorder();
    const { bed } = loop(prefs, sink);
    bed.setVoiceConnected(true);

    prefs.loopVolume = 1;
    bed.refresh();

    expect(sink.last()!.gain).toBeCloseTo(loopGain(1), 6);
    /* The cue side read the same prefs object and did not budge. */
    expect(cueGain("attention", prefs.cueVolume)).toBeCloseTo(0.9, 6);
  });

  test("a muted ambient slider keeps the voice running at zero, not stopped", () => {
    const prefs = enabled({ loopVolume: 0 });
    const sink = recorder();
    const { bed } = loop(prefs, sink);

    bed.setVoiceConnected(true);
    expect(bed.state().playing).toBe(true);
    expect(sink.last()!.gain).toBe(0);
    expect(sink.stops).toEqual([]);
  });
});

describe("who is speaking, read from the call's own transcript", () => {
  const line = (role: "user" | "assistant" | "progress", final: boolean, id: string = role) => ({ id, role, text: "…", final });

  test("a partial line means that participant is talking", () => {
    expect(speakingFromLines([line("user", false)])).toBe("operator");
    expect(speakingFromLines([line("assistant", false)])).toBe("agent");
  });

  test("a finished line means nobody is", () => {
    expect(speakingFromLines([line("assistant", true)])).toBe(null);
    expect(speakingFromLines([])).toBe(null);
  });

  test("the newest participant line wins", () => {
    expect(speakingFromLines([line("user", false, "a"), line("assistant", false, "b")])).toBe("agent");
    expect(speakingFromLines([line("assistant", false, "a"), line("user", true, "b")])).toBe(null);
  });

  test("relayed worker progress is text, not a voice", () => {
    /* A delegated worker's commentary streams as `progress`; ducking under it
       would duck the bed under nobody speaking. */
    expect(speakingFromLines([line("assistant", true, "a"), line("progress", false, "b")])).toBe(null);
    expect(speakingFromLines([line("user", false, "a"), line("progress", false, "b")])).toBe("operator");
  });
});
