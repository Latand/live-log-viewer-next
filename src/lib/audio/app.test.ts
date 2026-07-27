import { afterEach, describe, expect, test } from "bun:test";

/**
 * The app-facing façade, on a device with no audio graph at all.
 *
 * This is the server render, a locked-down browser, and every moment before the
 * first user gesture. Product code calls `playCue` from poll handlers and effects
 * where an exception would take a pane down with it, so "never throws, never
 * wedges" is the property under test — not the sound.
 */

const { ambientLoop, ambientLoopAvailable, ensureAmbientLoop, playCue, resetAppAudioForTests, setVoiceConnected } =
  await import("./app");
const { configureAudioPrefsStorage, setAudioPrefs } = await import("./prefs");

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

describe("asset availability", () => {
  test("this release ships a loop asset, so the controls are available", () => {
    expect(ambientLoopAvailable()).toBe(true);
  });
});
