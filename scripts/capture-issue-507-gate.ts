/**
 * Pure, browser-free helpers for the #507 acceptance capture gate
 * (`capture-issue-507-editor.ts`). They live here so they can be unit-tested
 * without booting a server or a headless browser — the capture script wires the
 * Playwright page into these primitives.
 *
 * Two capture-gate repairs (#507 PR #512) live here:
 *   - the folded-pipeline NEGATIVE CONTROL, which must fire only on the exact
 *     fold sentinel and rethrow every unrelated failure, so a crashed page or a
 *     broken evaluate can never masquerade as "the gate tripped"; and
 *   - the mobile READINESS wait, which replaces a blind fixed delay with a
 *     deterministic "expected pipeline summary + settled layout" wait, so the
 *     390px shot can never capture loading/empty UI — even when the summary
 *     renders later than the old three-second delay.
 */

/** The single sentinel the F1 gate throws when an active pipeline is folded into
    a worker stack. The negative control matches this EXACTLY; anything else is an
    unrelated failure that must propagate. */
export const FOLDED_ACTIVE_PIPELINE_SENTINEL =
  "Finding 1 regression: the active pipeline's aged-idle stages folded into a worker stack (duplicate surface)";

/** Thrown when the deliberate fold does NOT trip the gate — proof the acceptance
    check is blind rather than merely satisfied. */
export const NEGATIVE_CONTROL_BLIND =
  "negative control failed: the gate did NOT detect a deliberately folded active pipeline — the acceptance check is blind";

/** True only for the exact fold sentinel. A near-miss message, a page crash, or a
    broken `evaluate` is deliberately NOT matched, so the negative control cannot
    swallow it. */
export function isFoldedActivePipelineError(error: unknown): error is Error {
  return error instanceof Error && error.message === FOLDED_ACTIVE_PIPELINE_SENTINEL;
}

/**
 * Run the folded-pipeline negative control. `check` is expected to throw the
 * fold sentinel (because the caller deliberately folded the active pipeline).
 *
 *   - it throws the exact sentinel  → the gate is live; resolve.
 *   - it throws anything else       → an unrelated failure (e.g. a destroyed
 *                                     execution context); RETHROW it untouched so
 *                                     a real break is never masked as a pass.
 *   - it does not throw at all      → the gate is blind; throw NEGATIVE_CONTROL_BLIND.
 */
export async function runFoldedNegativeControl(check: () => Promise<void>): Promise<void> {
  let fired = false;
  try {
    await check();
  } catch (error) {
    if (!isFoldedActivePipelineError(error)) throw error;
    fired = true;
  }
  if (!fired) throw new Error(NEGATIVE_CONTROL_BLIND);
}

/** The minimal, browser-agnostic surface the mobile readiness wait drives. The
    Playwright adapter in the capture script fulfils it against a real page; unit
    tests fulfil it with a virtual clock. */
export interface MobileReadinessDriver {
  /** The pipeline count the mobile summary currently reports, or `null` while the
      summary has not rendered yet (no pipelines have loaded). */
  summaryPipelineCount(): Promise<number | null>;
  /** Document layout metrics used to detect a settled frame. */
  layoutMetrics(): Promise<{ scrollWidth: number; scrollHeight: number }>;
  /** Monotonic clock in milliseconds. */
  now(): number;
  /** Resolve after roughly `ms` milliseconds (advancing `now`). */
  sleep(ms: number): Promise<void>;
}

export interface MobileReadinessOptions {
  /** The number of seeded pipelines the summary must report before we proceed. */
  expectedPipelines: number;
  /** Overall budget for both phases. */
  timeoutMs?: number;
  /** Poll cadence. */
  pollMs?: number;
  /** Consecutive equal layout samples that count as "settled". */
  stableSamples?: number;
}

export interface MobileReadinessResult {
  waitedMs: number;
  scrollWidth: number;
  scrollHeight: number;
}

export const MOBILE_READINESS_DEFAULTS = {
  timeoutMs: 60_000,
  pollMs: 150,
  stableSamples: 3,
} as const;

/**
 * Deterministically wait until the mobile shell is ready to photograph:
 *   1. the expected synthetic pipeline summary has rendered (count reaches the
 *      seeded total — never a blind delay that could fire before pipelines load),
 *      and
 *   2. the layout has settled (metrics unchanged across `stableSamples`
 *      consecutive polls), so the shot is not taken mid-reflow.
 *
 * Because both phases wait on OBSERVED state rather than a fixed delay, a summary
 * that only appears after several seconds is still awaited correctly — where a
 * fixed three-second delay would have captured empty UI.
 */
export async function waitForMobilePipelineReady(
  driver: MobileReadinessDriver,
  options: MobileReadinessOptions,
): Promise<MobileReadinessResult> {
  const timeoutMs = options.timeoutMs ?? MOBILE_READINESS_DEFAULTS.timeoutMs;
  const pollMs = options.pollMs ?? MOBILE_READINESS_DEFAULTS.pollMs;
  const stableSamples = options.stableSamples ?? MOBILE_READINESS_DEFAULTS.stableSamples;
  const start = driver.now();
  const deadline = start + timeoutMs;

  /* Phase 1 — the expected pipeline summary is present and reports the seeded
     total. `null` means the summary has not rendered (no pipelines yet). */
  for (;;) {
    const count = await driver.summaryPipelineCount();
    if (count !== null && count >= options.expectedPipelines) break;
    if (driver.now() >= deadline) {
      throw new Error(
        `mobile pipeline summary never reported ${options.expectedPipelines} seeded pipelines ` +
          `(last: ${count ?? "absent"}) within ${timeoutMs}ms`,
      );
    }
    await driver.sleep(pollMs);
  }

  /* Phase 2 — layout settled across consecutive polls. */
  let last: { scrollWidth: number; scrollHeight: number } | null = null;
  let stable = 0;
  for (;;) {
    const metrics = await driver.layoutMetrics();
    if (last && metrics.scrollWidth === last.scrollWidth && metrics.scrollHeight === last.scrollHeight) {
      stable += 1;
      if (stable >= stableSamples) {
        return { waitedMs: driver.now() - start, scrollWidth: metrics.scrollWidth, scrollHeight: metrics.scrollHeight };
      }
    } else {
      stable = 0;
    }
    last = metrics;
    if (driver.now() >= deadline) {
      throw new Error(`mobile layout never settled (scrollWidth/scrollHeight kept changing) within ${timeoutMs}ms`);
    }
    await driver.sleep(pollMs);
  }
}

/**
 * A materialized real stage node the pipelines API reports: an attempt that has
 * bound a REAL transcript — both a live conversation id AND its on-disk agent
 * path. A placeholder stage (queued, nothing launched) has no launched attempt
 * and so contributes no such node, which is exactly why a board carrying only
 * placeholders can never satisfy the verify-stage gate below.
 */
export interface MaterializedStageNode {
  pipelineId: string;
  stageId: string;
  conversationId: string;
  agentPath: string;
}

/** The minimal, browser-free surface the scan-readiness gate drives: the backend
    file scan's discovered paths and the pipelines API's materialized stage nodes,
    plus a virtual clock. The capture script fulfils it against the live demo
    server; unit tests fulfil it with scripted observations on a virtual clock. */
export interface ScanReadinessDriver {
  /** The file paths the backend file scan currently reports (from /api/files). */
  discoveredPaths(): Promise<string[]>;
  /** Every materialized real stage node the pipelines API currently reports. */
  materializedStageNodes(): Promise<MaterializedStageNode[]>;
  /** Monotonic clock in milliseconds. */
  now(): number;
  /** Resolve after roughly `ms` milliseconds (advancing `now`). */
  sleep(ms: number): Promise<void>;
}

export interface VerifyStageReadinessOptions {
  /** The materialized transcript path the verify stage must own on disk. */
  verifyPath: string;
  /** The active pipeline whose verify stage must be materialized. */
  pipelineId: string;
  /** The stage id that must own the materialized transcript (the running stage). */
  stageId: string;
  /** Overall budget before failing closed. */
  timeoutMs?: number;
  /** Poll cadence. */
  pollMs?: number;
}

export interface VerifyStageReadinessResult {
  waitedMs: number;
  conversationId: string;
}

export const SCAN_READINESS_DEFAULTS = {
  timeoutMs: 30_000,
  pollMs: 500,
} as const;

/**
 * Fail-closed scan-readiness gate for the #507 capture. Before any screenshot is
 * taken, TWO things must be observably true at the same poll:
 *   1. the backend file scan has DISCOVERED the verify transcript on disk
 *      (`verifyPath` appears in the scan), and
 *   2. the pipelines API reports that the active pipeline's verify stage OWNS a
 *      materialized real stage node bound to exactly that transcript — a live
 *      conversation id AND the same agent path — never a placeholder.
 *
 * If either condition is still unmet when the deadline passes this THROWS (fail
 * closed): the prior loop merely broke after a fixed number of polls and captured
 * anyway, so an undiscovered transcript or a placeholder-only board could pass off
 * as real evidence. Because both conditions poll OBSERVED state rather than a
 * fixed delay, a transcript that surfaces late is still awaited correctly.
 */
export async function waitForMaterializedVerifyStage(
  driver: ScanReadinessDriver,
  options: VerifyStageReadinessOptions,
): Promise<VerifyStageReadinessResult> {
  const timeoutMs = options.timeoutMs ?? SCAN_READINESS_DEFAULTS.timeoutMs;
  const pollMs = options.pollMs ?? SCAN_READINESS_DEFAULTS.pollMs;
  const start = driver.now();
  const deadline = start + timeoutMs;

  for (;;) {
    const discovered = (await driver.discoveredPaths()).includes(options.verifyPath);
    const owner = (await driver.materializedStageNodes()).find(
      (node) =>
        node.pipelineId === options.pipelineId &&
        node.stageId === options.stageId &&
        node.agentPath === options.verifyPath &&
        node.conversationId.length > 0,
    );
    if (discovered && owner) {
      return { waitedMs: driver.now() - start, conversationId: owner.conversationId };
    }
    if (driver.now() >= deadline) {
      const reason = !discovered
        ? `the verify transcript was never discovered by the file scan`
        : `the file scan discovered the verify transcript but pipeline "${options.pipelineId}" stage "${options.stageId}" ` +
          `never materialized a real node owning it (placeholder-only evidence)`;
      throw new Error(`#507 scan-readiness gate failed closed: ${reason} within ${timeoutMs}ms`);
    }
    await driver.sleep(pollMs);
  }
}
