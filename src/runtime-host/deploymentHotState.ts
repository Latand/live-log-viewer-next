import { HOT_STATE_BACKEND, type HotStateAuthority } from "@/lib/state/hotStateAuthority";

import type { ViewerCandidateContainerState } from "./deploymentHealth";

/* #1216 promote hand-over budgets.
 *
 * The activation signal a promote waits for is `hot-state-authority.json`
 * gaining `mode: "sqlite"`, the candidate's revision and `activationReadyAt`.
 * Only the promoted Viewer container writes it (markHotStateActivationReady),
 * and it does so several startup steps after the durable target flips, while
 * the incumbent is still running and still writing the same SQLite state.
 * Every one of those steps can block on a contended lock for up to 30s
 * (LOCK_ATTEMPTS * LOCK_WAIT_MS in sqliteStateStore.ts and fileTransaction.ts),
 * so the hand-over legitimately outlives a 30s promote.
 *
 * The host-side promote deadline must therefore stay strictly larger than the
 * adapter-side budgets it contains, or the host kills the adapter before the
 * adapter can report what it saw. Both sides read these constants so the two
 * budgets cannot drift back into a tie, and a configured budget is fitted to
 * the deadline it runs under (fitHandOverBudgets) rather than trusted. */
export const HOT_STATE_ACTIVATION_TIMEOUT_MS = 180_000;
export const HOT_STATE_ACTIVATION_POLL_MS = 250;
/** The demoted incumbent sees the flipped target on its own 250ms poll,
    checkpoints its rollback mirrors and exits, so a release that has not
    happened within this budget is not going to happen inside the promote — and
    does not have to, because the flip already fenced the incumbent out of
    SQLite writes. */
export const INCUMBENT_RELEASE_TIMEOUT_MS = 15_000;
export const INCUMBENT_RELEASE_POLL_MS = 5_000;
/** Every container inspection here is a diagnostic and dockerd can wedge, so
    each one is bounded: a wait keeps its own schedule instead of hanging on
    the daemon, and an inspection that does not settle reads as unobservable.
    Inside a wait this ceiling is further clamped to the wait's own remaining
    budget; only the one diagnostic inspection on the failure path, which runs
    after that budget is spent, costs the full ceiling. */
export const CONTAINER_INSPECTION_TIMEOUT_MS = 5_000;
/** Fencing, the switch intent, the authority publication and the durable
    target publication all run before the waits start, and every one of them
    fsyncs. */
export const PROMOTE_PUBLICATION_BUDGET_MS = 60_000;
export const HAND_OVER_BUDGET_MS = INCUMBENT_RELEASE_TIMEOUT_MS + HOT_STATE_ACTIVATION_TIMEOUT_MS;
/** Both waits, the publication that precedes them, and the one bounded
    inspection each wait can overshoot by. */
export const PROMOTE_ACTION_TIMEOUT_MS = HAND_OVER_BUDGET_MS
  + PROMOTE_PUBLICATION_BUDGET_MS
  + 2 * CONTAINER_INSPECTION_TIMEOUT_MS;

/** Adapter phases are validated against `/^[A-Za-z0-9 -]{1,160}$/` before the
    host will read them back, so every phase fragment stays in that alphabet. */
const PHASE_LIMIT = 160;

/** A phase costs two fsyncs on the same state directory the hand-over contends
    on, and its only consumer samples every few seconds, so elapsed time is
    reported in steps: the dedupe upstream then collapses a whole step into a
    single write instead of one per poll. */
const PHASE_ELAPSED_STEP_MS = 5_000;

export type IncumbentHotStateReleaseOutcome = "released" | "retained" | "unobservable" | "not required";

export interface IncumbentHotStateRelease {
  outcome: IncumbentHotStateReleaseOutcome;
  state: ViewerCandidateContainerState | "unknown";
  waitedMs: number;
}

export const INCUMBENT_RELEASE_NOT_REQUIRED: IncumbentHotStateRelease = {
  outcome: "not required",
  state: "unknown",
  waitedMs: 0,
};

function seconds(durationMs: number): number {
  return Math.max(0, Math.round(durationMs / 1_000));
}

function reportedSeconds(elapsedMs: number): number {
  return Math.max(0, Math.floor(elapsedMs / PHASE_ELAPSED_STEP_MS) * (PHASE_ELAPSED_STEP_MS / 1_000));
}

function clip(phase: string): string {
  return phase.length <= PHASE_LIMIT ? phase : phase.slice(0, PHASE_LIMIT).trimEnd();
}

/** The host kills the adapter's process group at its own action deadline, so
    the budgets the adapter waits on have to fit inside that deadline with the
    publication and inspection allowances still intact. Configured budgets are
    scaled down to fit rather than trusted: a budget that outruns the deadline
    silently restores the inversion #1216 was. */
export function fitHandOverBudgets(
  requested: { releaseMs: number; activationMs: number },
  hostDeadlineMs: number = PROMOTE_ACTION_TIMEOUT_MS,
): { releaseMs: number; activationMs: number } {
  const releaseMs = Math.max(0, Math.floor(requested.releaseMs));
  const activationMs = Math.max(0, Math.floor(requested.activationMs));
  const available = Math.max(
    0,
    Math.floor(Math.max(0, hostDeadlineMs) * HAND_OVER_BUDGET_MS / PROMOTE_ACTION_TIMEOUT_MS),
  );
  const requestedTotal = releaseMs + activationMs;
  if (requestedTotal <= available || requestedTotal === 0) return { releaseMs, activationMs };
  const fittedRelease = Math.floor(available * releaseMs / requestedTotal);
  return { releaseMs: fittedRelease, activationMs: available - fittedRelease };
}

export function hotStateActivationSatisfied(
  authority: HotStateAuthority | null,
  revision: string,
): boolean {
  return authority?.mode === "sqlite"
    && authority.releaseRevision === revision
    && typeof authority.activationReadyAt === "string";
}

/** What the promote can actually see about the signal it is waiting for. */
export function hotStateActivationObservation(
  authority: HotStateAuthority | null,
  revision: string,
): string {
  if (!authority) return "no hot-state authority is published";
  const match = authority.releaseRevision === null
    ? "revision unset"
    : authority.releaseRevision === revision ? "revision matches" : "revision differs";
  const activation = typeof authority.activationReadyAt === "string" ? "activation ready" : "activation pending";
  return `authority mode ${authority.mode} ${match} epoch ${authority.epoch} ${activation}`;
}

export function incumbentHotStateReleaseSummary(release: IncumbentHotStateRelease): string {
  if (release.outcome === "not required") return "incumbent release not required";
  if (release.outcome === "released") return `incumbent released hot state after ${seconds(release.waitedMs)}s`;
  if (release.outcome === "unobservable") return `incumbent state unobservable after ${seconds(release.waitedMs)}s`;
  return `incumbent still ${release.state} after ${seconds(release.waitedMs)}s`;
}

/** The hand-over as the deployment journal keeps it, so a promote that
    succeeded inside one log sampling window still records what each ordered
    step did. */
export function hotStateHandOverSummary(
  release: IncumbentHotStateRelease,
  activationWaitedMs: number,
): string {
  return `${incumbentHotStateReleaseSummary(release)}; activation published after ${seconds(activationWaitedMs)}s`;
}

export function incumbentHotStateReleasePhase(
  state: ViewerCandidateContainerState | "unknown",
  elapsedMs: number,
  budgetMs: number,
): string {
  return clip(`releasing incumbent hot state - ${reportedSeconds(elapsedMs)}s of ${seconds(budgetMs)}s - incumbent ${state}`);
}

export function hotStateActivationPhase(
  observation: string,
  elapsedMs: number,
  budgetMs: number,
): string {
  return clip(`waiting for hot-state activation - ${reportedSeconds(elapsedMs)}s of ${seconds(budgetMs)}s - ${observation}`);
}

export const CANDIDATE_STATE_UNOBSERVABLE = "candidate container state is unobservable";

export function candidateContainerSummary(state: ViewerCandidateContainerState): string {
  return `candidate container is ${state}`;
}

/** The named reason the operator reads when the signal never arrives. */
export function hotStateActivationTimeoutMessage(input: {
  revision: string;
  waitedMs: number;
  budgetMs: number;
  observation: string;
  release: IncumbentHotStateRelease;
  candidate: string;
}): string {
  return [
    `promoted Viewer never published hot-state activation for revision ${input.revision}`,
    `waited ${seconds(input.waitedMs)}s of ${seconds(input.budgetMs)}s`,
    `last observed ${input.observation}`,
    input.candidate,
    incumbentHotStateReleaseSummary(input.release),
  ].join("; ");
}

export interface AbandonableTimer {
  expired: Promise<void>;
  cancel(): void;
}

interface WaitClock {
  sleep(delayMs: number): Promise<void>;
  now?(): number;
  reportPhase?(phase: string): void;
  /** Bounds work that may never finish. Abandoned as soon as that work does,
      so bounding a fast inspection costs nothing. */
  timer?(delayMs: number): AbandonableTimer;
}

function wallClockTimer(delayMs: number): AbandonableTimer {
  let handle: ReturnType<typeof setTimeout> | null = null;
  const expired = new Promise<void>((resolve) => { handle = setTimeout(resolve, delayMs); });
  return { expired, cancel: () => { if (handle !== null) clearTimeout(handle); } };
}

const INSPECTION_EXPIRED: unique symbol = Symbol("container inspection expired");

/** A container inspection that outlives its bound reads as unobservable
    instead of holding the caller: a wedged dockerd froze the whole release
    loop, which then never re-read the activation signal and never expired. */
async function inspectWithin(
  inspect: () => Promise<ViewerCandidateContainerState>,
  timeoutMs: number,
  timer: (delayMs: number) => AbandonableTimer,
): Promise<ViewerCandidateContainerState | null> {
  const attempt = (async () => {
    try { return await inspect(); }
    catch { return null; }
  })();
  const bound = timer(Math.max(1, timeoutMs));
  try {
    const observed = await Promise.race([
      attempt,
      bound.expired.then((): typeof INSPECTION_EXPIRED => INSPECTION_EXPIRED),
    ]);
    return observed === INSPECTION_EXPIRED ? null : observed;
  } finally {
    bound.cancel();
  }
}

/** Ordered step one of an SQLite promote: the incumbent hands its hot state
    back. It is bounded and non-fatal — the durable target flip already fences
    the incumbent out of SQLite writes (hotStateSqliteWriterReady), so a
    lingering incumbent cannot block activation. Its outcome is reported and
    carried into the activation diagnosis instead of being raced silently. */
export async function awaitIncumbentHotStateRelease(options: WaitClock & {
  inspect(): Promise<ViewerCandidateContainerState>;
  activated(): boolean;
  timeoutMs?: number;
  pollMs?: number;
  inspectionTimeoutMs?: number;
}): Promise<IncumbentHotStateRelease> {
  const now = options.now ?? Date.now;
  const timeoutMs = Math.max(0, options.timeoutMs ?? INCUMBENT_RELEASE_TIMEOUT_MS);
  const pollMs = Math.max(5, options.pollMs ?? INCUMBENT_RELEASE_POLL_MS);
  const inspectionMs = Math.max(1, options.inspectionTimeoutMs ?? CONTAINER_INSPECTION_TIMEOUT_MS);
  const timer = options.timer ?? wallClockTimer;
  const started = now();
  /* What the step actually managed to see. The last inspection before the
     deadline is the one most likely to be cut short by the clamp below, so the
     outcome is decided by every observation the step made, not by that one. */
  let seen: ViewerCandidateContainerState | null = null;
  for (;;) {
    /* Activation already landing means the incumbent is out of the way as far
       as the promote is concerned; a real release returns from the branch
       below instead. */
    if (options.activated()) return { outcome: "not required", state: "unknown", waitedMs: now() - started };
    /* The inspection is bounded by whatever is left of the step's own budget as
       well as by its own ceiling, so a wedged daemon cannot make a bounded step
       overrun the deadline that contains it. */
    const observed = await inspectWithin(
      options.inspect,
      Math.min(inspectionMs, Math.max(1, timeoutMs - (now() - started))),
      timer,
    );
    if (observed !== null) seen = observed;
    options.reportPhase?.(incumbentHotStateReleasePhase(observed ?? "unknown", now() - started, timeoutMs));
    if (observed !== null && observed !== "running") {
      return { outcome: "released", state: observed, waitedMs: now() - started };
    }
    if (now() - started >= timeoutMs) {
      return seen === null
        ? { outcome: "unobservable", state: "unknown", waitedMs: now() - started }
        : { outcome: "retained", state: seen, waitedMs: now() - started };
    }
    await options.sleep(pollMs);
  }
}

/** Ordered step two: the promoted Viewer publishes hot-state activation.
    Resolves with how long the signal took, which is the step's own visible
    outcome on the success path. */
export async function awaitHotStateActivation(options: WaitClock & {
  revision: string;
  readAuthority(): HotStateAuthority | null;
  release?: IncumbentHotStateRelease;
  /** Inspected once, on the failure path: a candidate that died during its own
      activation and one that is up but never published look identical in the
      authority file, and they are different bugs. Bounded like every other
      inspection, so a wedged daemon cannot swallow the named error. */
  inspectCandidate?(): Promise<ViewerCandidateContainerState>;
  timeoutMs?: number;
  pollMs?: number;
  inspectionTimeoutMs?: number;
}): Promise<{ waitedMs: number }> {
  const now = options.now ?? Date.now;
  const timeoutMs = Math.max(100, options.timeoutMs ?? HOT_STATE_ACTIVATION_TIMEOUT_MS);
  const pollMs = Math.max(5, options.pollMs ?? HOT_STATE_ACTIVATION_POLL_MS);
  const inspectionMs = Math.max(1, options.inspectionTimeoutMs ?? CONTAINER_INSPECTION_TIMEOUT_MS);
  const release = options.release ?? INCUMBENT_RELEASE_NOT_REQUIRED;
  const timer = options.timer ?? wallClockTimer;
  const started = now();
  let observation = hotStateActivationObservation(null, options.revision);
  for (;;) {
    const authority = options.readAuthority();
    observation = hotStateActivationObservation(authority, options.revision);
    if (hotStateActivationSatisfied(authority, options.revision)) return { waitedMs: now() - started };
    const elapsedMs = now() - started;
    options.reportPhase?.(hotStateActivationPhase(observation, elapsedMs, timeoutMs));
    if (elapsedMs >= timeoutMs) {
      const inspected = options.inspectCandidate
        ? await inspectWithin(options.inspectCandidate, inspectionMs, timer)
        : null;
      throw new Error(hotStateActivationTimeoutMessage({
        revision: options.revision,
        waitedMs: elapsedMs,
        budgetMs: timeoutMs,
        observation,
        release,
        candidate: inspected === null ? CANDIDATE_STATE_UNOBSERVABLE : candidateContainerSummary(inspected),
      }));
    }
    await options.sleep(pollMs);
  }
}

export function hotStateActivationApplies(hotStateBackend: string | undefined): boolean {
  return hotStateBackend === HOT_STATE_BACKEND;
}
