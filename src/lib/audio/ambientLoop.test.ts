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

type Ramp = { gain: number; seconds: number; voice: number };

/**
 * Records every level change the bed asks for, so a test can tell a ramp from
 * a step and a fade from a cut.
 *
 * Each voice carries the ordinal of the `start` that created it. That ordinal is
 * what makes a RESTART visible: a bed that crossed an edge on the same track
 * only ever ramps voice 1, and one that was torn down and re-created ramps
 * voice 2 — indistinguishable by level alone.
 */
function recorder(options: { refuse?: boolean; position?: () => number; revive?: boolean } = {}) {
  const starts: { src: string; gain: number; offsetSeconds?: number }[] = [];
  const ramps: Ramp[] = [];
  const pauses: number[] = [];
  const resumes: number[] = [];
  const stops: number[] = [];
  const transport: LoopTransport = {
    start(request) {
      if (options.refuse) return null;
      starts.push(request);
      const voice = starts.length;
      const handle: LoopVoiceHandle = {
        rampTo: (gain, seconds) => void ramps.push({ gain, seconds, voice }),
        pause: (seconds) => {
          pauses.push(seconds);
          return options.position?.() ?? 0;
        },
        /* Whether the parked voice is still alive. `false` is the ordinary
           case — the fade finished long ago; `true` models a call that ended
           inside it. */
        resume: () => {
          resumes.push(voice);
          return options.revive === true;
        },
        stop: (seconds) => void stops.push(seconds),
      };
      return handle;
    },
  };
  return { transport, starts, ramps, pauses, resumes, stops, last: () => ramps.at(-1) };
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

/** One row of the toggle matrix, at full slider so levels are legible. */
const music = (viewer: boolean, call: boolean): AudioPrefs => ({
  ...DEFAULT_AUDIO_PREFS,
  loopVolume: 1,
  viewerLoopEnabled: viewer,
  loopEnabled: call,
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
    expect(sink.ramps[0]).toEqual({ gain: loopGain(1), seconds: FADE_IN_SECONDS, voice: 1 });
  });

  test("disconnecting fades out over time, never a hard stop", () => {
    const sink = recorder();
    const { bed } = loop(enabled(), sink);

    bed.setVoiceConnected(true);
    bed.setVoiceConnected(false);

    /* Music the device still wants for its calls is PARKED, not destroyed: the
       fade is the same length, and the position outlives it. */
    expect(sink.pauses).toEqual([FADE_OUT_SECONDS]);
    expect(sink.stops).toEqual([]);
    expect(FADE_OUT_SECONDS).toBeGreaterThan(0);
    expect(bed.state().playing).toBe(false);
  });

  test("a second call fades back in rather than cutting in", () => {
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

/**
 * Two independent switches — music in the Viewer, music during a call — and the
 * four ways they can be set. One shared level governs all four.
 */
describe("the toggle matrix", () => {
  test("on/on — one continuous track crosses the call boundary in both directions", () => {
    /* The position source would answer a resume offset if anything ever asked
       for one. Nothing on this row does, which is the assertion. */
    const sink = recorder({ position: () => 12 });
    const { bed } = loop(music(true, true), sink);

    bed.refresh();
    expect(sink.starts).toHaveLength(1);
    expect(sink.starts[0].offsetSeconds ?? 0).toBe(0);

    bed.setVoiceConnected(true);
    /* Ducking still applies while the call is live and the music is audible. */
    bed.setSpeaking("agent");
    expect(sink.last()!.gain).toBeCloseTo(loopGain(1) * SPEECH_DUCK, 6);
    bed.setSpeaking(null);
    bed.setVoiceConnected(false);

    /* One voice, from before the call to after it. A re-created track would show
       up as a second start and as ramps against voice 2 — this passes only while
       nothing was torn down at either edge. */
    expect(sink.starts).toHaveLength(1);
    expect(sink.pauses).toEqual([]);
    expect(sink.stops).toEqual([]);
    expect([...new Set(sink.ramps.map((ramp) => ramp.voice))]).toEqual([1]);
    /* And no position was ever retained, because nothing ever stopped. */
    expect(bed.state().resumeAt).toBe(0);
    expect(bed.state().playing).toBe(true);
    expect(sink.last()!.gain).toBeCloseTo(loopGain(1), 6);
  });

  test("on/off — the call parks the music at its position, and hangup resumes it there", () => {
    const sink = recorder({ position: () => 12 });
    const { bed } = loop(music(true, false), sink);

    bed.refresh();
    expect(bed.state().playing).toBe(true);

    bed.setVoiceConnected(true);
    expect(sink.pauses).toEqual([FADE_OUT_SECONDS]);
    expect(sink.stops).toEqual([]);
    expect(bed.state().playing).toBe(false);
    expect(bed.state().resumeAt).toBe(12);

    bed.setVoiceConnected(false);
    expect(sink.starts).toHaveLength(2);
    expect(sink.starts[1]).toEqual({ src: AMBIENT_LOOP_ASSET as string, gain: 0, offsetSeconds: 12 });
    expect(sink.last()).toEqual({ gain: loopGain(1), seconds: FADE_IN_SECONDS, voice: 2 });
  });

  test("off/on — silent in the Viewer, and a repeat call does not replay the same opening", () => {
    let position = 9;
    const sink = recorder({ position: () => position });
    const { bed } = loop(music(false, true), sink);

    bed.refresh();
    expect(sink.starts).toEqual([]);
    expect(bed.state().playing).toBe(false);

    bed.setVoiceConnected(true);
    expect(sink.starts).toHaveLength(1);
    expect(sink.starts[0].offsetSeconds ?? 0).toBe(0);
    expect(sink.last()).toEqual({ gain: loopGain(1), seconds: FADE_IN_SECONDS, voice: 1 });

    bed.setVoiceConnected(false);
    expect(sink.pauses).toEqual([FADE_OUT_SECONDS]);
    expect(bed.state().playing).toBe(false);

    position = 40;
    bed.setVoiceConnected(true);
    /* The second call picks the track up where the first one left it. */
    expect(sink.starts[1].offsetSeconds).toBe(9);
    expect(sink.starts[1].gain).toBe(0);
  });

  test("a boundary reversed inside the fade returns to the parked voice, not a second one", () => {
    /* The operator hangs up a second after answering. The parked voice is still
       fading and still audible, so starting another would double the music. */
    const sink = recorder({ position: () => 12, revive: true });
    const { bed } = loop(music(true, false), sink);

    bed.refresh();
    bed.setVoiceConnected(true);
    expect(sink.pauses).toEqual([FADE_OUT_SECONDS]);

    bed.setVoiceConnected(false);

    expect(sink.resumes).toEqual([1]);
    expect(sink.starts).toHaveLength(1);
    expect(bed.state().playing).toBe(true);
    /* Back up to full on the same voice, no reopening at the retained offset. */
    expect(sink.last()).toEqual({ gain: loopGain(1), seconds: FADE_IN_SECONDS, voice: 1 });
  });

  test("a parked voice that has already died is replaced, not revived", () => {
    const sink = recorder({ position: () => 12, revive: false });
    const { bed } = loop(music(true, false), sink);

    bed.refresh();
    bed.setVoiceConnected(true);
    bed.setVoiceConnected(false);

    /* Asked first, and only then replaced at the position it left. */
    expect(sink.resumes).toEqual([1]);
    expect(sink.starts).toHaveLength(2);
    expect(sink.starts[1].offsetSeconds).toBe(12);
  });

  test("off/off — silent everywhere, in a call and out of one", () => {
    const sink = recorder({ position: () => 5 });
    const harness = loop(music(false, false), sink);

    harness.bed.refresh();
    harness.bed.setVoiceConnected(true);
    harness.bed.duckForCue("attention");
    harness.bed.setVoiceConnected(false);

    expect(harness.bed.wanted()).toBe(false);
    expect(sink.starts).toEqual([]);
    expect(sink.ramps).toEqual([]);
    expect(sink.pauses).toEqual([]);
  });

  test("enabling music in the Viewer starts it without waiting for a call", () => {
    const prefs = music(false, false);
    const sink = recorder();
    const { bed } = loop(prefs, sink);

    bed.refresh();
    expect(sink.starts).toEqual([]);

    prefs.viewerLoopEnabled = true;
    bed.refresh();

    expect(sink.starts).toHaveLength(1);
    expect(bed.state().playing).toBe(true);
  });

  test("the master mute tears the music down rather than parking it", () => {
    const prefs = music(true, true);
    const sink = recorder({ position: () => 12 });
    const { bed } = loop(prefs, sink);
    bed.refresh();

    prefs.cuesEnabled = false;
    bed.refresh();

    /* A mute is not an intermission: nothing is held for later, so the next
       unmute opens the track rather than resuming a position nobody chose. */
    expect(sink.stops).toEqual([FADE_OUT_SECONDS]);
    expect(sink.pauses).toEqual([]);
    expect(bed.state().resumeAt).toBe(0);

    prefs.cuesEnabled = true;
    bed.refresh();
    expect(sink.starts[1].offsetSeconds ?? 0).toBe(0);
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
    expect(sink.last()).toEqual({ gain: loopGain(1), seconds: FADE_IN_SECONDS, voice: 2 });
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
