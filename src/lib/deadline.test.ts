import { expect, test } from "bun:test";

import {
  backoffDelayMs,
  deadlineSignal,
  DeadlineExceededError,
  isAbortError,
  type DeadlineScheduler,
} from "./deadline";

/** A scheduler whose clock only moves when the test says so. */
function virtualScheduler(): DeadlineScheduler & { advance(ms: number): void; pending(): number } {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; handler: () => void }>();
  return {
    setTimeout(handler, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, handler });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers].sort((left, right) => left[1].at - right[1].at)) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.handler();
      }
    },
    pending: () => timers.size,
  };
}

test("the signal aborts when the deadline elapses", () => {
  const scheduler = virtualScheduler();
  const deadline = deadlineSignal(5_000, { scheduler });
  expect(deadline.signal.aborted).toBe(false);
  scheduler.advance(4_999);
  expect(deadline.signal.aborted).toBe(false);
  scheduler.advance(1);
  expect(deadline.signal.aborted).toBe(true);
  expect(deadline.signal.reason).toBeInstanceOf(DeadlineExceededError);
  expect(isAbortError(deadline.signal.reason)).toBe(true);
  deadline.release();
});

test("an upstream abort propagates, and releasing drops both the timer and the listener", () => {
  const scheduler = virtualScheduler();
  const upstream = new AbortController();
  const deadline = deadlineSignal(5_000, { scheduler, signal: upstream.signal });
  expect(scheduler.pending()).toBe(1);
  upstream.abort(new Error("caller went away"));
  expect(deadline.signal.aborted).toBe(true);

  deadline.release();
  expect(scheduler.pending()).toBe(0);
});

test("releasing many deadlines leaves no listener growth on a long-lived upstream signal", () => {
  const scheduler = virtualScheduler();
  const upstream = new AbortController();
  let listeners = 0;
  const target = upstream.signal as AbortSignal & {
    addEventListener: AbortSignal["addEventListener"];
    removeEventListener: AbortSignal["removeEventListener"];
  };
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  target.addEventListener = ((...args: Parameters<AbortSignal["addEventListener"]>) => {
    listeners += 1;
    return add(...args);
  }) as AbortSignal["addEventListener"];
  target.removeEventListener = ((...args: Parameters<AbortSignal["removeEventListener"]>) => {
    listeners -= 1;
    return remove(...args);
  }) as AbortSignal["removeEventListener"];

  for (let index = 0; index < 200; index += 1) deadlineSignal(1_000, { scheduler, signal: upstream.signal }).release();
  expect(listeners).toBe(0);
  expect(scheduler.pending()).toBe(0);
});

test("an already-aborted upstream signal produces an aborted deadline with no timer at all", () => {
  const scheduler = virtualScheduler();
  const upstream = AbortSignal.abort(new Error("gone"));
  const deadline = deadlineSignal(5_000, { scheduler, signal: upstream });
  expect(deadline.signal.aborted).toBe(true);
  expect(scheduler.pending()).toBe(0);
  deadline.release();
});

test("backoff grows exponentially, honours its ceiling, and never exceeds it under jitter", () => {
  const policy = { baseMs: 1_000, maxMs: 60_000, jitter: 0 };
  expect(backoffDelayMs(1, policy)).toBe(1_000);
  expect(backoffDelayMs(2, policy)).toBe(2_000);
  expect(backoffDelayMs(3, policy)).toBe(4_000);
  expect(backoffDelayMs(7, policy)).toBe(60_000);
  /* The exponent is capped before it is applied: a very long outage must not
     overflow the shift on its way to being clamped. */
  expect(backoffDelayMs(4_000, policy)).toBe(60_000);
});

test("jitter only ever subtracts, so the ceiling is a real ceiling", () => {
  const policy = { baseMs: 1_000, maxMs: 30_000, jitter: 0.5, random: () => 1 };
  expect(backoffDelayMs(1, policy)).toBe(500);
  expect(backoffDelayMs(50, policy)).toBe(15_000);
  const spread = new Set<number>();
  let sequence = 0;
  const varied = { ...policy, random: () => ((sequence++ * 37) % 100) / 100 };
  for (let index = 0; index < 20; index += 1) spread.add(backoffDelayMs(5, varied));
  expect(spread.size).toBeGreaterThan(1);
  for (const delay of spread) expect(delay).toBeLessThanOrEqual(30_000);
});
