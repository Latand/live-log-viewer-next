import { afterEach, describe, expect, test } from "bun:test";

import type { LoopTransport, LoopVoiceHandle } from "./ambientLoop";

/**
 * The app-facing façade, on a device with no audio graph at all.
 *
 * This is the server render, a locked-down browser, and every moment before the
 * first user gesture. Product code calls `playCue` from poll handlers and effects
 * where an exception would take a pane down with it, so "never throws, never
 * wedges" is the property under test — not the sound.
 */

const {
  ambientLoop,
  ambientLoopAvailable,
  configureAmbientTransportForTests,
  ensureAmbientLoop,
  playCue,
  resetAppAudioForTests,
  setVoiceConnected,
} = await import("./app");
const { configureAudioPrefsStorage, setAudioPrefs } = await import("./prefs");
const { FADE_OUT_SECONDS } = await import("./ambientLoop");

afterEach(() => {
  resetAppAudioForTests();
  configureAudioPrefsStorage(undefined);
});

describe("no audio graph", () => {
  test("every cue is refused quietly, and the identity is still spent", () => {
    expect(playCue({ cue: "attention", eventId: "a1" })).toBe("blocked");
    expect(playCue({ cue: "attention", eventId: "a1" })).toBe("deduped");
    expect(playCue({ cue: "tool-tick", eventId: "t1" })).toBe("blocked");
  });

  test("a mute is honoured before anything else is attempted", () => {
    configureAudioPrefsStorage({ getItem: () => "off", setItem: () => undefined });
    resetAppAudioForTests();
    expect(playCue({ cue: "failure", eventId: "f1" })).toBe("disabled");
  });

  test("connecting and disconnecting a call is safe and leaves nothing playing", () => {
    expect(() => setVoiceConnected("call", true)).not.toThrow();
    expect(ambientLoop().state().playing).toBe(false);
    expect(() => setVoiceConnected("call", false)).not.toThrow();
    expect(ambientLoop().state().playing).toBe(false);
  });

  test("the bed is not even wanted while this device has not opted in", () => {
    configureAudioPrefsStorage({ getItem: () => null, setItem: () => undefined });
    resetAppAudioForTests();
    setVoiceConnected("call", true);
    /* Conservative first run: a connected call alone is not consent. */
    expect(ambientLoop().wanted()).toBe(false);
  });

  test("a wanted bed retries a bounded number of times and gives up", () => {
    const store = new Map<string, string>();
    configureAudioPrefsStorage({
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => void store.set(key, value),
    });
    resetAppAudioForTests();
    setAudioPrefs({ loopEnabled: true });
    setVoiceConnected("call", true);

    expect(ambientLoop().wanted()).toBe(true);
    /* Wanted, unplayable, and still not throwing or looping forever — the retry
       is what resumes it the moment the autoplay policy lifts. */
    expect(ambientLoop().state().playing).toBe(false);
    expect(() => ensureAmbientLoop()).not.toThrow();
  });

  test("one card cannot disconnect the ambient bed owned by another live call", () => {
    const store = new Map<string, string>();
    configureAudioPrefsStorage({
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => void store.set(key, value),
    });
    resetAppAudioForTests();
    setAudioPrefs({ loopEnabled: true });

    setVoiceConnected("live-call", true);
    setVoiceConnected("unrelated-card", false);

    expect(ambientLoop().wanted()).toBe(true);

    setVoiceConnected("live-call", false);
    expect(ambientLoop().wanted()).toBe(false);
  });
});

/**
 * Ambient ownership, on a device that CAN play audio.
 *
 * Several conversation cards mount composers in the same tab, and the operator
 * moves between them constantly. The lease model above is what keeps that from
 * being audible, and it is only observable through a transport.
 */
describe("ownership across conversation cards", () => {
  function fakeTransport() {
    const starts: { gain: number; offsetSeconds?: number }[] = [];
    const pauses: number[] = [];
    const stops: number[] = [];
    const transport: LoopTransport = {
      start(request) {
        starts.push({ gain: request.gain, offsetSeconds: request.offsetSeconds });
        const handle: LoopVoiceHandle = {
          rampTo: () => undefined,
          pause: (seconds) => {
            pauses.push(seconds);
            return 12;
          },
          stop: (seconds) => void stops.push(seconds),
        };
        return handle;
      },
    };
    return { transport, starts, pauses, stops };
  }

  function device(seed: Record<string, string> = {}) {
    const values = new Map(Object.entries(seed));
    configureAudioPrefsStorage({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value),
    });
    resetAppAudioForTests();
  }

  test("switching the selected card hands the lease over without touching the track", () => {
    device();
    const sink = fakeTransport();
    configureAmbientTransportForTests(sink.transport);
    setAudioPrefs({ loopEnabled: true });

    setVoiceConnected("card-a", true);
    expect(sink.starts).toHaveLength(1);

    /* The operator opens another card: its composer mounts and takes its own
       lease before the first one lets go, exactly as React orders the effects. */
    setVoiceConnected("card-b", true);
    setVoiceConnected("card-a", false);

    /* One track throughout — no restart, no duplicate, nothing dropped. */
    expect(sink.starts).toHaveLength(1);
    expect(sink.pauses).toEqual([]);
    expect(sink.stops).toEqual([]);
    expect(ambientLoop().state().playing).toBe(true);

    /* And the last card leaving is still what ends the call side of it. */
    setVoiceConnected("card-b", false);
    expect(sink.pauses).toEqual([FADE_OUT_SECONDS]);
  });

  test("with music in the Viewer on, a card switch is not even a boundary", () => {
    device();
    const sink = fakeTransport();
    configureAmbientTransportForTests(sink.transport);
    setAudioPrefs({ loopEnabled: true, viewerLoopEnabled: true });
    ensureAmbientLoop();

    expect(sink.starts).toHaveLength(1);
    setVoiceConnected("card-a", true);
    setVoiceConnected("card-b", true);
    setVoiceConnected("card-a", false);
    setVoiceConnected("card-b", false);

    /* The music started before the first call and is still the same track after
       the last one ended. */
    expect(sink.starts).toHaveLength(1);
    expect(sink.pauses).toEqual([]);
    expect(sink.stops).toEqual([]);
    expect(ambientLoop().state().playing).toBe(true);
    expect(ambientLoop().state().resumeAt).toBe(0);
  });
});

describe("asset availability", () => {
  test("this release ships a loop asset, so the controls are available", () => {
    expect(ambientLoopAvailable()).toBe(true);
  });
});
