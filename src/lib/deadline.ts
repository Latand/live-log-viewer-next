/**
 * Deadlines, cancellation, and bounded retry spacing (#845).
 *
 * Every one of the three defects behind the 403 retry storm was a missing bound
 * of this shape: a fetch with no deadline, a retry with no ceiling, and work that
 * kept running after the only caller that wanted it had gone. They are the same
 * two primitives, so they live in one place rather than being re-derived — badly
 * — at each call site.
 *
 * The timer and randomness seams are injectable because the acceptance tests
 * simulate thirty minutes in a few milliseconds. A virtual scheduler cannot be a
 * real `setTimeout`, so the handle type stays opaque and nothing here assumes a
 * Node `Timeout`.
 */

export interface DeadlineScheduler {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemScheduler: DeadlineScheduler = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

export interface DeadlineHandle {
  signal: AbortSignal;
  /**
   * Drop the timer AND the upstream listener.
   *
   * The listener half is the one that bites: an `AbortSignal` handed in by a
   * caller outlives the request it bounded, so a subscription left behind on it
   * accumulates one entry per request forever. Every deadline is released in a
   * `finally`.
   */
  release(): void;
}

/**
 * A signal that aborts when `timeoutMs` elapses, when `signal` aborts, or when
 * the caller says so.
 *
 * Deliberately not `AbortSignal.timeout` + `AbortSignal.any`: those allocate a
 * real timer this process cannot advance under a virtual clock, and `any` gives
 * no way to unsubscribe, which is exactly the leak this exists to prevent.
 */
export function deadlineSignal(
  timeoutMs: number,
  options: { signal?: AbortSignal | null; scheduler?: DeadlineScheduler; reason?: string } = {},
): DeadlineHandle {
  const scheduler = options.scheduler ?? systemScheduler;
  const controller = new AbortController();
  const upstream = options.signal ?? null;
  let handle: unknown;
  let listening = false;

  /* Idempotent, and reached from every exit — the caller's `release`, the upstream
     abort, and the deadline firing. An aborted request has nothing left to time out,
     so leaving its timer armed until the socket unwinds would show up as timer growth
     for exactly as long as the timeout it no longer needs. */
  const disarm = () => {
    if (handle !== undefined) {
      scheduler.clearTimeout(handle);
      handle = undefined;
    }
    if (listening) {
      upstream?.removeEventListener("abort", onUpstreamAbort);
      listening = false;
    }
  };

  function onUpstreamAbort(): void {
    disarm();
    if (!controller.signal.aborted) controller.abort(upstream?.reason);
  }

  if (upstream?.aborted) {
    controller.abort(upstream.reason);
  } else {
    if (upstream) {
      upstream.addEventListener("abort", onUpstreamAbort, { once: true });
      listening = true;
    }
    if (Number.isFinite(timeoutMs) && timeoutMs >= 0) {
      handle = scheduler.setTimeout(() => {
        handle = undefined;
        disarm();
        if (!controller.signal.aborted) {
          controller.abort(new DeadlineExceededError(options.reason ?? "deadline exceeded", timeoutMs));
        }
      }, timeoutMs);
    }
  }

  return { signal: controller.signal, release: disarm };
}

export class DeadlineExceededError extends Error {
  readonly timeoutMs: number;
  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = "DeadlineExceededError";
    this.timeoutMs = timeoutMs;
  }
}

export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
  /** Fraction of the computed delay that is randomised away, 0…1. */
  jitter?: number;
  random?: () => number;
}

/**
 * Exponential spacing with a ceiling and jitter, for attempt 1, 2, 3, …
 *
 * Jitter subtracts rather than adds, so the ceiling is a real ceiling: a caller
 * reading `maxMs` as "never slower than this" is right, and many clients that
 * failed together do not come back together.
 */
export function backoffDelayMs(attempt: number, policy: BackoffPolicy): number {
  const ordinal = Math.max(1, Math.floor(attempt));
  const jitter = Math.min(Math.max(policy.jitter ?? 0, 0), 1);
  const random = policy.random ?? Math.random;
  /* Capped before the exponent is applied, so a long-lived failure cannot
     overflow the shift into Infinity on its way to being clamped. */
  const exponential = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.min(ordinal - 1, 30));
  return Math.max(0, Math.round(exponential * (1 - jitter * random())));
}

/** Whether a rejection is this request being cancelled rather than failing. */
export function isAbortError(error: unknown): boolean {
  if (error instanceof DeadlineExceededError) return true;
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}
