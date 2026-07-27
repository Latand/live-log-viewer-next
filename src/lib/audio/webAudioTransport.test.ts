import { describe, expect, test } from "bun:test";

import { createWebAudioTransports, type AudioContextLike, type AudioParamLike } from "./webAudioTransport";

/**
 * A fake Web Audio graph that records the wiring.
 *
 * The point of these tests is the SHAPE of the graph: a bed that loops inside
 * the audio thread has no seam, and one that is re-triggered from JavaScript
 * always does. That is observable here and nowhere else.
 */
function fakeContext(state = "running", scheduledSetterUpdatesValue = true) {
  const sources: FakeSource[] = [];
  const gains: FakeGain[] = [];
  let resumed = 0;

  interface FakeSource {
    buffer: { duration: number } | null;
    loop: boolean;
    loopStart: number;
    loopEnd: number;
    onended?: unknown;
    started: number[];
    offsets: number[];
    stopped: number[];
    connect(destination: never): unknown;
    start(when?: number, offset?: number): void;
    stop(when?: number): void;
  }
  interface FakeGain {
    gain: {
      value: number;
      calls: string[];
      ramps: { value: number; when: number }[];
      cancelScheduledValues(when: number): void;
      setValueAtTime(value: number, when: number): void;
      linearRampToValueAtTime(value: number, when: number): void;
    };
    connect(destination: never): unknown;
  }

  const context: AudioContextLike & { sources: FakeSource[]; gains: FakeGain[]; resumed: () => number } = {
    state,
    currentTime: 10,
    destination: { id: "out" },
    resume: async () => void (resumed += 1),
    createBufferSource() {
      const source: FakeSource = {
        buffer: null,
        loop: false,
        loopStart: -1,
        loopEnd: -1,
        started: [],
        offsets: [],
        stopped: [],
        connect: () => undefined,
        start(when, offset) { source.started.push(when ?? 0); source.offsets.push(offset ?? 0); },
        stop(when) { source.stopped.push(when ?? 0); },
      };
      sources.push(source);
      return source;
    },
    createGain() {
      let currentValue = 1;
      const gain: FakeGain = {
        gain: {
          get value() { return currentValue; },
          set value(value) { currentValue = value; },
          calls: [],
          ramps: [],
          cancelScheduledValues(when) { gain.gain.calls.push(`cancel@${when}`); },
          setValueAtTime(value, when) {
            gain.gain.calls.push(`set:${value}@${when}`);
            if (scheduledSetterUpdatesValue) currentValue = value;
          },
          linearRampToValueAtTime(value, when) {
            gain.gain.calls.push(`ramp:${value}@${when}`);
            gain.gain.ramps.push({ value, when });
          },
        },
        connect: () => undefined,
      };
      gains.push(gain);
      return gain;
    },
    createStereoPanner() {
      return {
        pan: {
          value: 0,
          cancelScheduledValues: () => undefined,
          setValueAtTime: () => undefined,
          linearRampToValueAtTime: () => undefined,
        },
        connect: () => undefined,
      };
    },
    decodeAudioData: async () => ({ duration: 26.666 }),
    sources,
    gains,
    resumed: () => resumed,
  };
  return context;
}

function okFetch(): typeof fetch {
  return (async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })) as unknown as typeof fetch;
}

/**
 * A clock the test advances by hand.
 *
 * The park is the one thing here that spans real time — the node has to stay
 * alive and audible for the whole fade — so the test drives it rather than
 * waiting for it.
 */
function fakeClock() {
  const pending = new Map<number, { run: () => void; ms: number }>();
  let sequence = 0;
  return {
    timers: {
      schedule(run: () => void, ms: number) {
        pending.set(++sequence, { run, ms });
        return sequence;
      },
      cancel(handle: number) {
        pending.delete(handle);
      },
    },
    pending: () => pending.size,
    delays: () => [...pending.values()].map((timer) => timer.ms),
    /** Fire everything due, as the clock would. */
    run() {
      for (const [handle, timer] of [...pending]) {
        pending.delete(handle);
        timer.run();
      }
    },
  };
}

/** Decode is async; a start attempt kicks it and the next one succeeds. */
async function warmed(context: AudioContextLike, src: string, clock = fakeClock()) {
  const transports = createWebAudioTransports(() => context, okFetch(), clock.timers);
  transports.warm([src]);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  return transports;
}

const LOOP = "/audio/ambient/voice-call-loop.wav";
const CUE = "/audio/cues/attention.mp3";

describe("the ambient bed loops without a seam", () => {
  test("the decoded buffer loops on the audio clock, end to end", async () => {
    const context = fakeContext();
    const transports = await warmed(context, LOOP);

    const voice = transports.loop.start({ src: LOOP, gain: 0 });

    expect(voice).not.toBeNull();
    const source = context.sources[0];
    /* Gapless by construction: the wrap is a property of the source node. */
    expect(source.loop).toBe(true);
    expect(source.loopStart).toBe(0);
    expect(source.loopEnd).toBe(source.buffer!.duration);
    expect(source.started).toHaveLength(1);
  });

  test("nothing re-triggers the bed: no ended handler, no scheduled restart", async () => {
    const context = fakeContext();
    const transports = await warmed(context, LOOP);

    transports.loop.start({ src: LOOP, gain: 0.1 });

    /* An `onended` restart or a timer-scheduled next pass are the two ways to
       reintroduce the click this asset was authored to avoid. */
    expect(context.sources[0].onended).toBeUndefined();
    expect(context.sources[0].stopped).toEqual([]);
  });

  test("one decode serves every pass and every later call", async () => {
    const context = fakeContext();
    const transports = await warmed(context, LOOP);

    transports.loop.start({ src: LOOP, gain: 0 })?.stop(1);
    transports.loop.start({ src: LOOP, gain: 0 });

    /* Two voices, one buffer: nothing re-fetches or re-decodes mid-call. */
    expect(context.sources).toHaveLength(2);
    expect(context.sources[0].buffer).toBe(context.sources[1].buffer);
  });
});

describe("parking the bed keeps its place in the track", () => {
  test("the retained position is where the fade ENDS, because the bed plays through it", async () => {
    const context = fakeContext();
    const clock = fakeClock();
    const transports = await warmed(context, LOOP, clock);
    const voice = transports.loop.start({ src: LOOP, gain: 0.12 })!;

    context.currentTime = 17;
    const at = voice.pause(1.5);

    /* Seven seconds played before the park was asked for, and the bed is
       audible for the whole 1.5s fade — so it reaches 8.5s, not 7s. Retaining
       the position the fade STARTED at would replay that second and a half. */
    expect(at).toBeCloseTo(8.5, 6);
    expect(context.gains[0].gain.ramps.at(-1)).toEqual({ value: 0, when: 18.5 });
  });

  test("the node is released when the fade finishes, never during it", async () => {
    const context = fakeContext();
    const clock = fakeClock();
    const transports = await warmed(context, LOOP, clock);
    const voice = transports.loop.start({ src: LOOP, gain: 0.12 })!;

    context.currentTime = 17;
    voice.pause(1.5);

    /* Mid-fade: still playing, still audible, nothing cut. */
    expect(context.sources[0].stopped).toEqual([]);
    expect(clock.delays()).toEqual([1500]);

    context.currentTime = 18.5;
    clock.run();
    expect(context.sources[0].stopped).toHaveLength(1);
  });

  test("resuming after the park starts the same buffer exactly where the fade left off", async () => {
    const context = fakeContext();
    const clock = fakeClock();
    const transports = await warmed(context, LOOP, clock);
    const first = transports.loop.start({ src: LOOP, gain: 0 })!;
    context.currentTime = 17;
    const at = first.pause(1.5);
    context.currentTime = 18.5;
    clock.run();

    transports.loop.start({ src: LOOP, gain: 0, offsetSeconds: at });

    /* The resumed pass opens on the sample after the last audible one. */
    expect(context.sources[1].offsets[0]).toBeCloseTo(8.5, 6);
    expect(context.sources[1].loop).toBe(true);
    expect(context.sources[1].buffer).toBe(context.sources[0].buffer);
  });

  test("a retained position past the end of the track wraps, it does not overrun", async () => {
    const context = fakeContext();
    const clock = fakeClock();
    const transports = await warmed(context, LOOP, clock);
    const duration = 26.666;

    const voice = transports.loop.start({ src: LOOP, gain: 0, offsetSeconds: duration - 1 })!;
    context.currentTime = 15;

    /* Five seconds of playback plus a 1.5s fade from one second before the end:
       5.5s past the top, wrapped. */
    expect(voice.pause(1.5)).toBeCloseTo(5.5, 3);
    expect(context.sources[0].offsets[0]).toBeCloseTo(duration - 1, 6);
  });

  test("a call that ends inside the fade returns to the SAME voice, never a second one", async () => {
    const context = fakeContext();
    const clock = fakeClock();
    const transports = await warmed(context, LOOP, clock);
    const voice = transports.loop.start({ src: LOOP, gain: 0.12 })!;

    context.currentTime = 17;
    voice.pause(1.5);
    /* The operator hangs up 200ms into the fade. The parked node is still
       audible; starting another one here would double the music and flam. */
    context.currentTime = 17.2;
    expect(voice.resume()).toBe(true);
    voice.rampTo(0.12, 2.5);

    expect(context.sources).toHaveLength(1);
    expect(context.sources[0].stopped).toEqual([]);
    /* The park was called off, so nothing is left to kill the revived voice. */
    expect(clock.pending()).toBe(0);
    expect(context.gains[0].gain.ramps.at(-1)).toEqual({ value: 0.12, when: 19.7 });
  });

  test("a park the AUDIO clock already finished cannot be revived by a late timer", async () => {
    const context = fakeContext();
    const clock = fakeClock();
    const transports = await warmed(context, LOOP, clock);
    const voice = transports.loop.start({ src: LOOP, gain: 0.12 })!;

    context.currentTime = 17;
    const retained = voice.pause(1.5);

    /* A backgrounded tab throttles timers; the audio clock does not throttle.
       Here the fade ended at 18.5 and the release timer still has not run. */
    context.currentTime = 19;
    expect(clock.pending()).toBe(1);

    /* The park is over on the clock that decides — the bed is silent and the
       node has run a further half second past the position anyone retained.
       Reviving it would resume the track half a second adrift of `retained`. */
    expect(voice.resume()).toBe(false);
    expect(retained).toBeCloseTo(8.5, 6);
    expect(context.sources[0].stopped).toHaveLength(1);
    expect(clock.pending()).toBe(0);

    const after = context.gains[0].gain.ramps.length;
    voice.rampTo(0.5, 1);
    expect(context.gains[0].gain.ramps).toHaveLength(after);
  });

  test("the instant the fade ends counts as finished, not as still parking", async () => {
    const context = fakeContext();
    const clock = fakeClock();
    const transports = await warmed(context, LOOP, clock);
    const voice = transports.loop.start({ src: LOOP, gain: 0.12 })!;

    context.currentTime = 17;
    voice.pause(1.5);
    context.currentTime = 18.5;

    expect(voice.resume()).toBe(false);
  });

  test("once the park has completed the voice is gone, and says so", async () => {
    const context = fakeContext();
    const clock = fakeClock();
    const transports = await warmed(context, LOOP, clock);
    const voice = transports.loop.start({ src: LOOP, gain: 0.12 })!;

    context.currentTime = 17;
    voice.pause(1.5);
    context.currentTime = 18.5;
    clock.run();

    /* The caller must start a fresh voice at the retained offset instead. */
    expect(voice.resume()).toBe(false);
    const after = context.gains[0].gain.ramps.length;
    voice.rampTo(0.5, 1);
    expect(context.gains[0].gain.ramps).toHaveLength(after);
  });

  test("tearing down during a park kills the node instead of leaving it running", async () => {
    const context = fakeContext();
    const clock = fakeClock();
    const transports = await warmed(context, LOOP, clock);
    const voice = transports.loop.start({ src: LOOP, gain: 0.12 })!;

    context.currentTime = 17;
    voice.pause(1.5);
    voice.stop(1.5);

    expect(context.sources[0].stopped).toHaveLength(1);
    /* And the park timer is not left behind to fire at a dead node. */
    expect(clock.pending()).toBe(0);
    expect(voice.resume()).toBe(false);
  });
});

describe("levels move as ramps on the audio clock", () => {
  test("a fade-in anchors at the requested initial gain in a spec-accurate AudioParam", async () => {
    const context = fakeContext("running", false);
    const transports = await warmed(context, LOOP);
    const voice = transports.loop.start({ src: LOOP, gain: 0 })!;

    voice.rampTo(0.12, 2.5);

    expect(context.gains[0].gain.calls).toContain("set:0@10");
    expect(context.gains[0].gain.ramps).toEqual([{ value: 0.12, when: 12.5 }]);
  });

  test("a fade anchors at the current value and ramps to the target", async () => {
    const context = fakeContext();
    const transports = await warmed(context, LOOP);
    const voice = transports.loop.start({ src: LOOP, gain: 0 })!;

    voice.rampTo(0.12, 2.5);

    const gain = context.gains[0].gain;
    expect(gain.calls).toContain("cancel@10");
    expect(gain.ramps).toEqual([{ value: 0.12, when: 12.5 }]);
  });

  test("stopping fades to zero first and only then stops the source", async () => {
    const context = fakeContext();
    const transports = await warmed(context, LOOP);
    const voice = transports.loop.start({ src: LOOP, gain: 0.12 })!;

    voice.stop(1.5);

    const gain = context.gains[0].gain;
    expect(gain.ramps.at(-1)).toEqual({ value: 0, when: 11.5 });
    /* The node dies after the fade has run, never during it. */
    expect(context.sources[0].stopped[0]).toBeGreaterThan(11.5);
  });

  test("a stopped bed ignores later level changes", async () => {
    const context = fakeContext();
    const transports = await warmed(context, LOOP);
    const voice = transports.loop.start({ src: LOOP, gain: 0.12 })!;

    voice.stop(1.5);
    const after = context.gains[0].gain.ramps.length;
    voice.rampTo(0.5, 1);

    expect(context.gains[0].gain.ramps).toHaveLength(after);
  });
});

describe("cues", () => {
  test("a cue plays its own gain and pan, once, and reports its end", async () => {
    const context = fakeContext();
    const transports = await warmed(context, CUE);
    let ended = 0;

    const voice = transports.cues.start({
      cue: "attention", src: CUE, gain: 0.7, pan: -0.5, delaySeconds: 0, onEnded: () => { ended += 1; },
    });

    expect(voice).not.toBeNull();
    expect(context.gains[0].gain.value).toBe(0.7);
    expect(context.sources[0].loop).toBe(false);
    (context.sources[0].onended as () => void)();
    expect(ended).toBe(1);
  });

  test("a staggered cue is scheduled ahead on the audio clock, not with a timer", async () => {
    const context = fakeContext();
    const transports = await warmed(context, CUE);

    transports.cues.start({ cue: "success", src: CUE, gain: 0.5, pan: 0, delaySeconds: 0.22, onEnded: () => undefined });

    expect(context.sources[0].started).toEqual([10.22]);
  });
});

/**
 * A context whose gain params are AUTOMATION TIMELINES, not numbers.
 *
 * Every other fake here records what was asked for. This one answers what would
 * be HEARD, which is the only way to see the defect in #728: the bed opened at
 * full volume and slid down to its level, and every individual call the code made
 * looked right. The two rules that produce it are both the real ones:
 *
 * - `cancelScheduledValues(t)` drops every event at or after `t` — including one
 *   scheduled at exactly `t`, so an initialization and a ramp in the same tick
 *   collide and the initialization is the one that loses;
 * - reading `value` back answers from the timeline, so once the cancel above has
 *   emptied it the answer is the param's own 1.0 default — a full-scale gain
 *   nobody asked for, taken as the level to fade from.
 */
function timelineContext(state = "running") {
  interface Event { type: "set" | "ramp"; value: number; when: number }
  const gains: TimelineGain[] = [];
  const sources: { started: number[] }[] = [];

  interface TimelineGain {
    gain: AudioParamLike;
    /** What this node is sounding at `time`. */
    heardAt(time: number): number;
    connect(destination: never): unknown;
  }

  const context = {
    state,
    currentTime: 10,
    destination: { id: "out" },
    resume: async () => undefined,
    createBufferSource() {
      const source = {
        buffer: null as { duration: number } | null,
        loop: false,
        loopStart: -1,
        loopEnd: -1,
        started: [] as number[],
        connect: () => undefined,
        start(when?: number) { source.started.push(when ?? context.currentTime); },
        stop: () => undefined,
      };
      sources.push(source);
      return source;
    },
    createGain() {
      const events: Event[] = [];
      /** The gain param's default. A bed that reaches this is a burst. */
      const heardAt = (time: number): number => {
        let previous = { value: 1, when: 0 };
        for (const event of [...events].sort((a, b) => a.when - b.when)) {
          if (event.when > time) {
            if (event.type !== "ramp") return previous.value;
            const span = event.when - previous.when;
            const progress = span > 0 ? (time - previous.when) / span : 1;
            return previous.value + (event.value - previous.value) * progress;
          }
          previous = { value: event.value, when: event.when };
        }
        return previous.value;
      };
      const gain: TimelineGain = {
        gain: {
          /* Both directions go through the timeline, exactly as the browser's
             do: setting `value` is `setValueAtTime(value, currentTime)`, and
             getting it reads back whatever the timeline currently says. */
          get value() { return heardAt(context.currentTime); },
          set value(value: number) { events.push({ type: "set", value, when: context.currentTime }); },
          cancelScheduledValues(when: number) {
            for (let index = events.length - 1; index >= 0; index -= 1) {
              if (events[index].when >= when) events.splice(index, 1);
            }
          },
          setValueAtTime(value: number, when: number) { events.push({ type: "set", value, when }); },
          linearRampToValueAtTime(value: number, when: number) { events.push({ type: "ramp", value, when }); },
        },
        heardAt,
        connect: () => undefined,
      };
      gains.push(gain);
      return gain;
    },
    decodeAudioData: async () => ({ duration: 26.666 }),
    gains,
    sources,
  };
  return context as unknown as AudioContextLike & { gains: TimelineGain[]; sources: { started: number[] }[]; currentTime: number };
}

describe("the bed opens in silence and only ever comes UP (#728)", () => {
  /** What a 5% ambient slider is worth once the loop ceiling is applied. */
  const TARGET = 0.35 * 0.05;
  const FADE_IN = 2.5;

  /** Highest level heard between the node starting and the fade finishing. */
  function loudest(gain: { heardAt(time: number): number }, from: number, to: number): number {
    let peak = 0;
    for (let time = from; time <= to + 1e-9; time += 0.05) peak = Math.max(peak, gain.heardAt(time));
    return peak;
  }

  test("a call opens below the bed's target, not above it", async () => {
    const context = timelineContext();
    const transports = await warmed(context, LOOP);

    /* Exactly what `createAmbientLoop` does at the start of a call: open the
       voice silent, then fade it up. */
    const voice = transports.loop.start({ src: LOOP, gain: 0, offsetSeconds: 0 })!;
    voice.rampTo(TARGET, FADE_IN);

    const bed = context.gains[0];
    /* The first sample the operator can hear is the one the node starts on. */
    expect(bed.heardAt(10)).toBeCloseTo(0, 6);
    /* And nothing between there and the end of the fade is above the level the
       bed was asked for — a burst is exactly a sample that is. */
    expect(loudest(bed, 10, 10 + FADE_IN)).toBeLessThanOrEqual(TARGET + 1e-9);
    /* Which is a fade IN: the level rises to its target rather than falling to it. */
    expect(bed.heardAt(12.5)).toBeCloseTo(TARGET, 6);
    expect(bed.heardAt(11.25)).toBeGreaterThan(0);
    expect(bed.heardAt(11.25)).toBeLessThan(TARGET);
  });

  test("a bed resumed at a retained position opens silent too", async () => {
    const context = timelineContext();
    const transports = await warmed(context, LOOP);

    /* The park/resume leg: a fresh voice for the same track, part way in. It is
       still a fade-in, so it still may not be heard above the target. */
    const voice = transports.loop.start({ src: LOOP, gain: 0, offsetSeconds: 8.5 })!;
    voice.rampTo(TARGET, FADE_IN);

    expect(context.gains[0].heardAt(10)).toBeCloseTo(0, 6);
    expect(loudest(context.gains[0], 10, 10 + FADE_IN)).toBeLessThanOrEqual(TARGET + 1e-9);
  });

  test("a duck that interrupts the fade-in continues from the level being heard", async () => {
    const context = timelineContext();
    const transports = await warmed(context, LOOP);
    const voice = transports.loop.start({ src: LOOP, gain: 0 })!;
    voice.rampTo(TARGET, FADE_IN);

    /* Somebody speaks half a second in, while the bed is still coming up. */
    context.currentTime = 10.5;
    const heardWhenDucked = context.gains[0].heardAt(10.5);
    voice.rampTo(TARGET * 0.25, 0.3);

    /* The duck starts from that same level — no step, in either direction — and
       nothing after it climbs over the target either. */
    expect(context.gains[0].heardAt(10.5)).toBeCloseTo(heardWhenDucked, 6);
    expect(loudest(context.gains[0], 10.5, 13)).toBeLessThanOrEqual(TARGET + 1e-9);
  });
});

describe("degradation", () => {
  test("a locked context plays nothing, throws nothing, and asks for a resume", async () => {
    const context = fakeContext("suspended");
    const transports = createWebAudioTransports(() => context, okFetch());

    expect(transports.cues.start({ cue: "attention", src: CUE, gain: 1, pan: 0, delaySeconds: 0, onEnded: () => undefined })).toBeNull();
    expect(transports.loop.start({ src: LOOP, gain: 0 })).toBeNull();
    expect(context.resumed()).toBeGreaterThan(0);
    expect(context.sources).toEqual([]);
  });

  test("no audio graph at all is simply silence", () => {
    const transports = createWebAudioTransports(() => null, okFetch());
    expect(transports.cues.start({ cue: "failure", src: CUE, gain: 1, pan: 0, delaySeconds: 0, onEnded: () => undefined })).toBeNull();
    expect(transports.loop.start({ src: LOOP, gain: 0 })).toBeNull();
    expect(() => transports.warm([CUE])).not.toThrow();
  });

  test("the first cue before the buffer exists is dropped, and it kicks the decode", async () => {
    const context = fakeContext();
    const transports = createWebAudioTransports(() => context, okFetch());

    expect(transports.cues.start({ cue: "launch", src: CUE, gain: 1, pan: 0, delaySeconds: 0, onEnded: () => undefined })).toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    /* The next event lands, because the miss started the decode. */
    expect(transports.cues.start({ cue: "launch", src: CUE, gain: 1, pan: 0, delaySeconds: 0, onEnded: () => undefined })).not.toBeNull();
  });

  test("a missing asset fails once and is never re-requested", async () => {
    const context = fakeContext();
    let requests = 0;
    const transports = createWebAudioTransports(() => context, (async () => {
      requests += 1;
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    }) as unknown as typeof fetch);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(transports.cues.start({ cue: "tool-tick", src: CUE, gain: 1, pan: 0, delaySeconds: 0, onEnded: () => undefined })).toBeNull();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }

    expect(requests).toBe(1);
  });
});
