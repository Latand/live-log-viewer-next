import { afterEach, describe, expect, test } from "bun:test";

import {
  audioPrefs,
  configureAudioPrefsStorage,
  CUES_ENABLED_KEY,
  DEFAULT_AUDIO_PREFS,
  LOOP_ENABLED_KEY,
  LOOP_VOLUME_KEY,
  readAudioPrefs,
  setAudioPrefs,
  subscribeAudioPrefs,
  type PrefStorage,
} from "./prefs";

/** One device's storage. Two of these are two devices, which is the whole point. */
function device(seed: Record<string, string> = {}): PrefStorage & { dump: () => Record<string, string> } {
  const values = new Map(Object.entries(seed));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    dump: () => Object.fromEntries(values),
  };
}

afterEach(() => configureAudioPrefsStorage(undefined));

describe("first run is conservative", () => {
  test("a device that has never chosen gets sound on, ambient off", () => {
    const fresh = readAudioPrefs(device());
    expect(fresh.cuesEnabled).toBe(true);
    /* Nothing starts playing a bed at somebody on first load. */
    expect(fresh.loopEnabled).toBe(false);
    expect(fresh).toEqual(DEFAULT_AUDIO_PREFS);
  });

  test("a device with no storage at all still answers with the defaults", () => {
    expect(readAudioPrefs(null)).toEqual(DEFAULT_AUDIO_PREFS);
  });

  test("storage that throws on write never breaks a setting change", () => {
    configureAudioPrefsStorage({
      getItem: () => null,
      setItem: () => { throw new Error("private mode"); },
    });
    expect(() => setAudioPrefs({ loopEnabled: true })).not.toThrow();
    /* The choice still applies for this session. */
    expect(audioPrefs().loopEnabled).toBe(true);
  });
});

describe("settings are device-local", () => {
  test("one device muting sound does not touch another device's settings", () => {
    const kitchen = device();
    const desk = device();

    configureAudioPrefsStorage(kitchen);
    setAudioPrefs({ cuesEnabled: false, loopEnabled: true, loopVolume: 0.8 });

    /* The other device reads its own storage and knows nothing about the first:
       no shared record exists for it to inherit. */
    expect(readAudioPrefs(desk)).toEqual(DEFAULT_AUDIO_PREFS);
    expect(readAudioPrefs(kitchen).cuesEnabled).toBe(false);
    expect(desk.dump()).toEqual({});
  });

  test("the ambient choice survives a reload and resumes on its own", () => {
    const persisted = device();
    configureAudioPrefsStorage(persisted);
    setAudioPrefs({ loopEnabled: true, loopVolume: 0.5 });

    /* A reload is a fresh read of the same device storage. */
    configureAudioPrefsStorage(undefined);
    const afterReload = readAudioPrefs(persisted);
    expect(afterReload.loopEnabled).toBe(true);
    expect(afterReload.loopVolume).toBe(0.5);
    expect(persisted.dump()[LOOP_ENABLED_KEY]).toBe("on");
    expect(persisted.dump()[LOOP_VOLUME_KEY]).toBe("0.5");
  });

  test("the master switch shares the key the header toggle already used", () => {
    const legacy = device({ [CUES_ENABLED_KEY]: "off" });
    /* An operator who muted sound before this change stays muted, cues included
       — one switch, not a second one they have to discover. */
    expect(readAudioPrefs(legacy).cuesEnabled).toBe(false);
  });
});

describe("volumes", () => {
  test("the two volumes are independent while the master governs both", () => {
    const store = device();
    configureAudioPrefsStorage(store);

    setAudioPrefs({ cueVolume: 0.9, loopVolume: 0.1 });
    expect(audioPrefs().cueVolume).toBe(0.9);
    expect(audioPrefs().loopVolume).toBe(0.1);

    setAudioPrefs({ cueVolume: 0.2 });
    /* Moving one slider leaves the other exactly where it was. */
    expect(audioPrefs().loopVolume).toBe(0.1);

    setAudioPrefs({ cuesEnabled: false });
    /* And the master does not erase either level — unmuting restores them. */
    expect(audioPrefs()).toMatchObject({ cuesEnabled: false, cueVolume: 0.2, loopVolume: 0.1 });
  });

  test("a corrupt or out-of-range stored level is clamped, never trusted", () => {
    expect(readAudioPrefs(device({ [LOOP_VOLUME_KEY]: "9" })).loopVolume).toBe(1);
    expect(readAudioPrefs(device({ [LOOP_VOLUME_KEY]: "-3" })).loopVolume).toBe(0);
    expect(readAudioPrefs(device({ [LOOP_VOLUME_KEY]: "banana" })).loopVolume).toBe(DEFAULT_AUDIO_PREFS.loopVolume);
  });

  test("subscribers hear about a change once, with the new value in place", () => {
    configureAudioPrefsStorage(device());
    const seen: number[] = [];
    const stop = subscribeAudioPrefs(() => seen.push(audioPrefs().cueVolume));

    setAudioPrefs({ cueVolume: 0.25 });
    stop();
    setAudioPrefs({ cueVolume: 0.75 });

    expect(seen).toEqual([0.25]);
  });
});
