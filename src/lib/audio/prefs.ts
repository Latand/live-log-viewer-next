"use client";

import { useSyncExternalStore } from "react";

/**
 * Audio preferences, and they are DEVICE-LOCAL by construction.
 *
 * Everything here lives in this browser profile's `localStorage` and nowhere
 * else: no route, no viewer state file, no account record. Muting cues on the
 * phone in the kitchen must not mute the desk, and a shared setting would make
 * exactly that mistake — which is why there is no server read or write on this
 * path at all.
 *
 * `cuesEnabled` deliberately reuses the legacy `llvSound` key so the header
 * switch the operator already knows keeps governing sound, cues included,
 * instead of the app growing a second mute nobody can find.
 */

export const CUES_ENABLED_KEY = "llvSound";
export const CUE_VOLUME_KEY = "llvAudioCueVolume";
export const LOOP_ENABLED_KEY = "llvAudioLoopEnabled";
export const LOOP_VOLUME_KEY = "llvAudioLoopVolume";

export interface AudioPrefs {
  cuesEnabled: boolean;
  /** 0…1, multiplied into the cue tier gain. */
  cueVolume: number;
  /** The ambient loop is opt-in, always. */
  loopEnabled: boolean;
  /** 0…1, independent of {@link AudioPrefs.cueVolume}. */
  loopVolume: number;
}

export const DEFAULT_AUDIO_PREFS: AudioPrefs = {
  cuesEnabled: true,
  cueVolume: 0.7,
  loopEnabled: false,
  loopVolume: 0.35,
};

/** The slice of `Storage` this module needs, so tests can hand over a fake. */
export interface PrefStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

let injected: PrefStorage | null | undefined;
let cached: AudioPrefs | null = null;
const listeners = new Set<() => void>();

/** Test seam: pin the storage (or `null` for a device with none). */
export function configureAudioPrefsStorage(storage: PrefStorage | null | undefined): void {
  injected = storage;
  cached = null;
  notify();
}

function activeStorage(): PrefStorage | null {
  if (injected !== undefined) return injected;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    /* private mode with storage disabled: settings stay session-only. */
    return null;
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

function readString(storage: PrefStorage | null, key: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function readSwitch(storage: PrefStorage | null, key: string, fallback: boolean): boolean {
  const raw = readString(storage, key);
  if (raw === "on") return true;
  if (raw === "off") return false;
  return fallback;
}

function readVolume(storage: PrefStorage | null, key: string, fallback: number): number {
  const parsed = Number.parseFloat(readString(storage, key) ?? "");
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

/** One read straight from the given (or active) device storage. */
export function readAudioPrefs(storage: PrefStorage | null = activeStorage()): AudioPrefs {
  return {
    cuesEnabled: readSwitch(storage, CUES_ENABLED_KEY, DEFAULT_AUDIO_PREFS.cuesEnabled),
    cueVolume: readVolume(storage, CUE_VOLUME_KEY, DEFAULT_AUDIO_PREFS.cueVolume),
    loopEnabled: readSwitch(storage, LOOP_ENABLED_KEY, DEFAULT_AUDIO_PREFS.loopEnabled),
    loopVolume: readVolume(storage, LOOP_VOLUME_KEY, DEFAULT_AUDIO_PREFS.loopVolume),
  };
}

/** The current settings of THIS device, memoized between writes. */
export function audioPrefs(): AudioPrefs {
  cached ??= readAudioPrefs();
  return cached;
}

export function setAudioPrefs(patch: Partial<AudioPrefs>): AudioPrefs {
  const next = { ...audioPrefs(), ...patch };
  const storage = activeStorage();
  if (storage) {
    try {
      if (patch.cuesEnabled !== undefined) storage.setItem(CUES_ENABLED_KEY, next.cuesEnabled ? "on" : "off");
      if (patch.cueVolume !== undefined) storage.setItem(CUE_VOLUME_KEY, String(next.cueVolume));
      if (patch.loopEnabled !== undefined) storage.setItem(LOOP_ENABLED_KEY, next.loopEnabled ? "on" : "off");
      if (patch.loopVolume !== undefined) storage.setItem(LOOP_VOLUME_KEY, String(next.loopVolume));
    } catch {
      /* storage refused the write: the choice still applies for this session. */
    }
  }
  cached = {
    ...next,
    cueVolume: Math.max(0, Math.min(1, next.cueVolume)),
    loopVolume: Math.max(0, Math.min(1, next.loopVolume)),
  };
  notify();
  return cached;
}

export function subscribeAudioPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Another tab on the SAME device changed a setting — adopt it, don't fight it. */
export function watchAudioPrefsStorage(target: Pick<Window, "addEventListener" | "removeEventListener">): () => void {
  const onStorage = () => {
    cached = null;
    notify();
  };
  target.addEventListener("storage", onStorage);
  return () => target.removeEventListener("storage", onStorage);
}

export function useAudioPrefs(): AudioPrefs {
  return useSyncExternalStore(subscribeAudioPrefs, audioPrefs, () => DEFAULT_AUDIO_PREFS);
}
