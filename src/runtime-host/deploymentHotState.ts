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
 * budgets cannot drift back into a tie. */
export const HOT_STATE_ACTIVATION_TIMEOUT_MS = 180_000;
export const HOT_STATE_ACTIVATION_POLL_MS = 250;
export const INCUMBENT_RELEASE_TIMEOUT_MS = 60_000;
export const INCUMBENT_RELEASE_POLL_MS = 1_000;
/** Fencing, the switch intent, the authority publication and the durable
    target publication all run before the waits start, and every one of them
    fsyncs. */
export const PROMOTE_PUBLICATION_BUDGET_MS = 60_000;
export const PROMOTE_ACTION_TIMEOUT_MS =
  HOT_STATE_ACTIVATION_TIMEOUT_MS + INCUMBENT_RELEASE_TIMEOUT_MS + PROMOTE_PUBLICATION_BUDGET_MS;

/** Adapter phases are validated against `/^[A-Za-z0-9 -]{1,160}$/` before the
    host will read them back, so every phase fragment stays in that alphabet. */
const PHASE_LIMIT = 160;

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

function clip(phase: string): string {
  return phase.length <= PHASE_LIMIT ? phase : phase.slice(0, PHASE_LIMIT).trimEnd();
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

export function incumbentHotStateReleasePhase(
  state: ViewerCandidateContainerState | "unknown",
  elapsedMs: number,
  budgetMs: number,
): string {
  return clip(`releasing incumbent hot state - ${seconds(elapsedMs)}s of ${seconds(budgetMs)}s - incumbent ${state}`);
}

export function hotStateActivationPhase(
  observation: string,
  elapsedMs: number,
  budgetMs: number,
): string {
  return clip(`waiting for hot-state activation - ${seconds(elapsedMs)}s of ${seconds(budgetMs)}s - ${observation}`);
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

interface WaitClock {
  sleep(delayMs: number): Promise<void>;
  now?(): number;
  reportPhase?(phase: string): void;
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
}): Promise<IncumbentHotStateRelease> {
  const now = options.now ?? Date.now;
  const timeoutMs = Math.max(0, options.timeoutMs ?? INCUMBENT_RELEASE_TIMEOUT_MS);
  const pollMs = Math.max(5, options.pollMs ?? INCUMBENT_RELEASE_POLL_MS);
  const started = now();
  for (;;) {
    /* Activation already landing means the incumbent is out of the way as far
       as the promote is concerned; a real release returns from the branch
       below instead. */
    if (options.activated()) return { outcome: "not required", state: "unknown", waitedMs: now() - started };
    let observed: ViewerCandidateContainerState | null = null;
    try { observed = await options.inspect(); }
    catch { observed = null; }
    const state = observed ?? "unknown";
    options.reportPhase?.(incumbentHotStateReleasePhase(state, now() - started, timeoutMs));
    if (observed !== null && observed !== "running") {
      return { outcome: "released", state: observed, waitedMs: now() - started };
    }
    if (now() - started >= timeoutMs) {
      return {
        outcome: observed === null ? "unobservable" : "retained",
        state,
        waitedMs: now() - started,
      };
    }
    await options.sleep(pollMs);
  }
}

/** Ordered step two: the promoted Viewer publishes hot-state activation. */
export async function awaitHotStateActivation(options: WaitClock & {
  revision: string;
  readAuthority(): HotStateAuthority | null;
  release?: IncumbentHotStateRelease;
  /** Inspected once, on the failure path: a candidate that died during its own
      activation and one that is up but never published look identical in the
      authority file, and they are different bugs. */
  inspectCandidate?(): Promise<ViewerCandidateContainerState>;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<void> {
  const now = options.now ?? Date.now;
  const timeoutMs = Math.max(100, options.timeoutMs ?? HOT_STATE_ACTIVATION_TIMEOUT_MS);
  const pollMs = Math.max(5, options.pollMs ?? HOT_STATE_ACTIVATION_POLL_MS);
  const release = options.release ?? INCUMBENT_RELEASE_NOT_REQUIRED;
  const started = now();
  let observation = hotStateActivationObservation(null, options.revision);
  for (;;) {
    const authority = options.readAuthority();
    observation = hotStateActivationObservation(authority, options.revision);
    if (hotStateActivationSatisfied(authority, options.revision)) return;
    const elapsedMs = now() - started;
    options.reportPhase?.(hotStateActivationPhase(observation, elapsedMs, timeoutMs));
    if (elapsedMs >= timeoutMs) {
      let candidate = CANDIDATE_STATE_UNOBSERVABLE;
      if (options.inspectCandidate) {
        try { candidate = candidateContainerSummary(await options.inspectCandidate()); }
        catch { /* the failure message keeps the unobservable default */ }
      }
      throw new Error(hotStateActivationTimeoutMessage({
        revision: options.revision,
        waitedMs: elapsedMs,
        budgetMs: timeoutMs,
        observation,
        release,
        candidate,
      }));
    }
    await options.sleep(pollMs);
  }
}

export function hotStateActivationApplies(hotStateBackend: string | undefined): boolean {
  return hotStateBackend === HOT_STATE_BACKEND;
}
