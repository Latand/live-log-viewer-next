"use client";

import { useSyncExternalStore } from "react";

import { epochSeconds, epochSecondsFromMs, type EpochSeconds } from "@/lib/types";

/** Default cadence: a chip state whose threshold is minutes settles well
    inside one tick, and every subscriber shares the one timer below. */
const DEFAULT_TICK_MS = 15_000;

interface Clock {
  now: EpochSeconds;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  /* Stable per cadence: `useSyncExternalStore` resubscribes whenever these
     change identity, and a fresh subscription each render would restart the
     timer forever. */
  subscribe: (listener: () => void) => () => void;
  read: () => EpochSeconds;
}

/* One clock per cadence, shared by every subscriber: a board carries a chip
   surface per card, and each owning its own timer would tick them apart from
   each other for no gain. */
const clocks = new Map<number, Clock>();

function clockFor(tickMs: number): Clock {
  const existing = clocks.get(tickMs);
  /* While nothing is subscribed the timer is off, so a clock re-read after a
     gap would hand out its last value. Re-seed it there — never per read,
     which must stay cached (React re-renders forever on a moving snapshot). */
  if (existing) {
    if (existing.timer === null && Date.now() / 1000 - existing.now >= tickMs / 1000) {
      existing.now = epochSecondsFromMs(Date.now());
    }
    return existing;
  }
  /* Seeded at creation, so the FIRST client frame already carries the real
     time: a board that painted `0` would paint every chip undemoted — a rail
     of pulsing green — and correct itself a frame later, which is the exact
     lie issue #669 exists to remove. */
  const clock = { now: epochSecondsFromMs(Date.now()), listeners: new Set<() => void>(), timer: null } as Clock;
  clock.subscribe = (listener) => {
    clock.listeners.add(listener);
    if (clock.timer === null) {
      clock.now = epochSecondsFromMs(Date.now());
      clock.timer = setInterval(() => {
        clock.now = epochSecondsFromMs(Date.now());
        for (const notify of [...clock.listeners]) notify();
      }, tickMs);
    }
    return () => {
      clock.listeners.delete(listener);
      if (clock.listeners.size === 0 && clock.timer !== null) {
        clearInterval(clock.timer);
        clock.timer = null;
      }
    };
  };
  clock.read = () => clock.now;
  clocks.set(tickMs, clock);
  return clock;
}

/** Hydration renders against the server's value, so both sides paint `0` and
    their markup agrees; consumers read `0` as "no clock yet" and leave an
    age-derived state undemoted rather than inventing an age. */
const serverSnapshot = () => epochSeconds(0);

/**
 * A ticking wall clock in epoch seconds for age-derived UI (issue #669: chip
 * activity follows transcript freshness, so it must advance between scans).
 * Client renders read the real time from the first frame; only the server
 * render and the hydration pass read `0`.
 */
export function useNowSeconds(tickMs: number = DEFAULT_TICK_MS): EpochSeconds {
  const clock = clockFor(tickMs);
  return useSyncExternalStore(clock.subscribe, clock.read, serverSnapshot);
}
