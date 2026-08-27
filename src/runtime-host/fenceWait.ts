/* How a runtime-host generation waits for the singleton fence at boot.
 *
 * #518 gave a staged successor a bounded wait: it boots while the predecessor
 * still holds the fence, waits for that predecessor's graceful exit, and fails
 * its container if the exit never comes. The bound is the detector — a
 * hand-over is in flight, and one that wedges has to become visible.
 *
 * #1216 added a second way a successor comes to exist: `--stage` from
 * `scripts/bootstrap-runtime-host.ts`, where the predecessor has NOT been
 * asked to exit and will not be until the operator runs the hand-over. There
 * is no hand-over in flight for a deadline to detect, so a bounded wait there
 * detects nothing and instead exits the container at the bound, which dockerd
 * restart-loops on that period. A successor advertised as "staged and idle"
 * was crash-looping. Such a generation is *parked* instead: no deadline, and
 * the wait says so on a fixed cadence so `docker logs` shows a container that
 * is deliberately waiting rather than one that is wedged.
 */

/** #518: the bounded successor wait, in milliseconds. */
export const RUNTIME_HOST_FENCE_WAIT_ENV = "LLV_RUNTIME_HOST_FENCE_WAIT_MS";

/** #1216: this generation was parked by an operator bootstrap. It outranks the
    bounded wait, because a parked successor's predecessor is still serving on
    purpose. */
export const RUNTIME_HOST_FENCE_PARK_ENV = "LLV_RUNTIME_HOST_FENCE_PARK";

/* Internal defaults. `hostBootstrap.ts` owns a separate, unrelated poll: this
   one is how often a booting container retries the fence, that one is how
   often the operator's hand-over run checks whether it took. */
const FENCE_ACQUIRE_POLL_MS = 500;
const FENCE_REPORT_EVERY_MS = 60_000;

export interface RuntimeHostFenceWaitPlan {
  /** No deadline: the predecessor has not been asked to exit. */
  parked: boolean;
  /** The bounded wait, or `0` for an ordinary boot that must fail immediately
      when another generation already owns the fence. */
  budgetMs: number;
}

export function runtimeHostFenceWaitPlan(
  environment: Record<string, string | undefined>,
): RuntimeHostFenceWaitPlan {
  if (environment[RUNTIME_HOST_FENCE_PARK_ENV] === "1") return { parked: true, budgetMs: 0 };
  const budgetMs = Number(environment[RUNTIME_HOST_FENCE_WAIT_ENV] || 0);
  return { parked: false, budgetMs: Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : 0 };
}

function seconds(milliseconds: number): number {
  return Math.max(0, Math.round(milliseconds / 1_000));
}

function generation(container: string | undefined): string {
  return container ? `runtime-host successor ${container}` : "this runtime-host generation";
}

/** What the wait is waiting for and how long it has waited — the same
    discipline the promote's hot-state waits carry (#1216). */
export function runtimeHostFenceWaitLine(
  plan: RuntimeHostFenceWaitPlan,
  container: string | undefined,
  elapsedMs: number,
): string {
  if (plan.parked) {
    return `[runtime host] ${generation(container)} is parked on the singleton fence with no deadline`
      + `; waited ${seconds(elapsedMs)}s`
      + "; the predecessor still serves and has not been asked to exit"
      + "; run scripts/bootstrap-runtime-host.ts --hand-over to release it";
  }
  return `[runtime host] ${generation(container)} is waiting for the singleton fence`
    + `; waited ${seconds(elapsedMs)}s of ${seconds(plan.budgetMs)}s`
    + "; the predecessor has not released it yet";
}

/** What it saw at give-up. A bounded wait that expires used to surface the
    fence's own "singleton fence is held", which named neither the generation
    nor the budget it had just spent (#1216). An ordinary boot carries no
    budget, has nothing to report about waiting, and keeps that error verbatim. */
export function runtimeHostFenceTimeoutLine(
  plan: RuntimeHostFenceWaitPlan,
  container: string | undefined,
  elapsedMs: number,
): string {
  return `${generation(container)} never acquired the singleton fence`
    + `; waited ${seconds(elapsedMs)}s of ${seconds(plan.budgetMs)}s`
    + "; the predecessor generation still holds it";
}

/** Acquire the singleton fence the way this generation was staged to wait for
    it. A parked wait never gives up; a bounded wait gives up at its budget
    with a named message that keeps the fence's own error as its cause. */
export async function acquireRuntimeHostFence(options: {
  acquire(): void;
  plan: RuntimeHostFenceWaitPlan;
  container?: string;
  now?(): number;
  sleep?(milliseconds: number): Promise<void>;
  report?(line: string): void;
  pollMs?: number;
  reportEveryMs?: number;
}): Promise<{ waitedMs: number }> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep
    ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const pollMs = Math.max(1, options.pollMs ?? FENCE_ACQUIRE_POLL_MS);
  const reportEveryMs = Math.max(1, options.reportEveryMs ?? FENCE_REPORT_EVERY_MS);
  const started = now();
  const deadline = started + options.plan.budgetMs;
  let reportedAt: number | null = null;
  for (;;) {
    try {
      options.acquire();
      return { waitedMs: now() - started };
    } catch (error) {
      const elapsedMs = now() - started;
      if (!options.plan.parked && now() >= deadline) {
        if (options.plan.budgetMs <= 0) throw error;
        throw new Error(runtimeHostFenceTimeoutLine(options.plan, options.container, elapsedMs), { cause: error });
      }
      if (reportedAt === null || elapsedMs - reportedAt >= reportEveryMs) {
        reportedAt = elapsedMs;
        options.report?.(runtimeHostFenceWaitLine(options.plan, options.container, elapsedMs));
      }
      await sleep(pollMs);
    }
  }
}
