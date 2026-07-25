"use client";

import { useSyncExternalStore } from "react";

/** Default cadence: a chip state whose threshold is minutes settles well
    inside one tick, and every subscriber shares the one timer below. */
const DEFAULT_TICK_MS = 15_000;

interface Clock {
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  /* Stable per cadence: `useSyncExternalStore` resubscribes whenever these
     change identity, and a fresh subscription each render would restart the
     timer forever. */
  subscribe: (listener: () => void) => () => void;
  read: () => number;
}

/* One clock per cadence, shared by every subscriber: a board carries a chip
   surface per card, and each owning its own timer would tick them apart from
   each other for no gain. */
const clocks = new Map<number, Clock>();

function clockFor(tickMs: number): Clock {
  const existing = clocks.get(tickMs);
  if (existing) return existing;
  const clock = { now: 0, listeners: new Set<() => void>(), timer: null } as Clock;
  clock.subscribe = (listener) => {
    clock.listeners.add(listener);
    if (clock.timer === null) {
      clock.now = Date.now() / 1000;
      clock.timer = setInterval(() => {
        clock.now = Date.now() / 1000;
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

const serverSnapshot = () => 0;

/**
 * A ticking wall clock in epoch SECONDS for age-derived UI (issue #669: chip
 * activity follows transcript freshness, so it must advance between scans).
 *
 * Reads `0` on the server render and through hydration, so their markup
 * agrees; the subscription then lands the real time. Age consumers read `0` as
 * "no clock yet" and leave their state undemoted for that frame rather than
 * inventing an age.
 */
export function useNowSeconds(tickMs: number = DEFAULT_TICK_MS): number {
  const clock = clockFor(tickMs);
  return useSyncExternalStore(clock.subscribe, clock.read, serverSnapshot);
}
