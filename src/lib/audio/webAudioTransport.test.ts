import { describe, expect, test } from "bun:test";

import { createWebAudioTransports, type AudioContextLike } from "./webAudioTransport";

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

/** Decode is async; a start attempt kicks it and the next one succeeds. */
async function warmed(context: AudioContextLike, src: string) {
  const transports = createWebAudioTransports(() => context, okFetch());
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
  test("pausing fades out, releases the node, and answers where the track had got to", async () => {
    const context = fakeContext();
    const transports = await warmed(context, LOOP);
    const voice = transports.loop.start({ src: LOOP, gain: 0.12 })!;

    context.currentTime = 17;
    const at = voice.pause(1.5);

    /* Seven seconds of playback since the start, so seven seconds in. */
    expect(at).toBeCloseTo(7, 6);
    expect(context.gains[0].gain.ramps.at(-1)).toEqual({ value: 0, when: 18.5 });
    expect(context.sources[0].stopped[0]).toBeGreaterThan(18.5);
  });

  test("resuming starts the same buffer at the retained offset", async () => {
    const context = fakeContext();
    const transports = await warmed(context, LOOP);
    const first = transports.loop.start({ src: LOOP, gain: 0 })!;
    context.currentTime = 17;
    const at = first.pause(1.5);

    transports.loop.start({ src: LOOP, gain: 0, offsetSeconds: at });

    /* The resumed pass opens where the parked one stopped, not at the top. */
    expect(context.sources[1].offsets[0]).toBeCloseTo(7, 6);
    expect(context.sources[1].loop).toBe(true);
    expect(context.sources[1].buffer).toBe(context.sources[0].buffer);
  });

  test("a retained position past the end of the track wraps, it does not overrun", async () => {
    const context = fakeContext();
    const transports = await warmed(context, LOOP);
    const duration = 26.666;

    const voice = transports.loop.start({ src: LOOP, gain: 0, offsetSeconds: duration - 1 })!;
    context.currentTime = 15;

    /* Five seconds later the loop has wrapped: four seconds past the top. */
    expect(voice.pause(1.5)).toBeCloseTo(4, 3);
    expect(context.sources[0].offsets[0]).toBeCloseTo(duration - 1, 6);
  });

  test("a parked bed ignores later level changes, exactly as a stopped one does", async () => {
    const context = fakeContext();
    const transports = await warmed(context, LOOP);
    const voice = transports.loop.start({ src: LOOP, gain: 0.12 })!;

    voice.pause(1.5);
    const after = context.gains[0].gain.ramps.length;
    voice.rampTo(0.5, 1);

    expect(context.gains[0].gain.ramps).toHaveLength(after);
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
