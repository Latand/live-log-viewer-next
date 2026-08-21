import { structuredHostsEnabled } from "./flags";

const startupStore = process as typeof process & {
  __llvStructuredHostStartupFailed?: boolean;
  __llvStructuredHostStartupProgress?: StructuredHostStartupStatus;
};

export type StructuredHostStartupPhase =
  | "waiting for structured startup"
  | "refreshing transcripts"
  | "adopting Codex hosts"
  | "adopting Claude hosts"
  | "reconciling structured hosts"
  | "finalizing structured delivery"
  | "ready";

export interface StructuredHostStartupProgress {
  phase: StructuredHostStartupPhase;
  completedHosts: number;
  totalHosts: number | null;
}

export interface StructuredHostStartupStatus extends StructuredHostStartupProgress {
  state: "pending" | "failed" | "ready";
  updatedAt: string;
}

function pendingStatus(): StructuredHostStartupStatus {
  return {
    state: "pending",
    phase: "waiting for structured startup",
    completedHosts: 0,
    totalHosts: null,
    updatedAt: new Date().toISOString(),
  };
}

function setStatus(
  state: StructuredHostStartupStatus["state"],
  progress: StructuredHostStartupProgress,
): void {
  if (!Number.isSafeInteger(progress.completedHosts) || progress.completedHosts < 0) {
    throw new Error("structured host startup completed count is invalid");
  }
  if (progress.totalHosts !== null
    && (!Number.isSafeInteger(progress.totalHosts)
      || progress.totalHosts < progress.completedHosts)) {
    throw new Error("structured host startup total count is invalid");
  }
  startupStore.__llvStructuredHostStartupProgress = {
    ...progress,
    state,
    updatedAt: new Date().toISOString(),
  };
}

export function markStructuredHostStartupProgress(progress: StructuredHostStartupProgress): void {
  setStatus(startupStore.__llvStructuredHostStartupFailed === true ? "failed" : "pending", progress);
}

export function markStructuredHostStartupFailed(): void {
  startupStore.__llvStructuredHostStartupFailed = true;
  const current = startupStore.__llvStructuredHostStartupProgress ?? pendingStatus();
  setStatus("failed", current);
}

export function markStructuredHostStartupReady(): void {
  startupStore.__llvStructuredHostStartupFailed = false;
  const current = startupStore.__llvStructuredHostStartupProgress ?? pendingStatus();
  setStatus("ready", { ...current, phase: "ready" });
}

export function didStructuredHostStartupFail(): boolean {
  return startupStore.__llvStructuredHostStartupFailed === true;
}

/** Truthful readiness axis for operator surfaces: "ready" only after startup
    adoption succeeded, "failed" after it failed, "pending" before either, and
    null when structured hosting is disabled. Production #367 reported ready
    health while structured spawn admission was failing end to end. */
export function structuredStartupAxis(
  env: Readonly<Record<string, string | undefined>> = process.env,
): "ready" | "failed" | "pending" | null {
  if (!structuredHostsEnabled(env)) return null;
  const failed = startupStore.__llvStructuredHostStartupFailed;
  if (failed === undefined) return "pending";
  return failed ? "failed" : "ready";
}

export function structuredStartupStatus(
  env: Readonly<Record<string, string | undefined>> = process.env,
): StructuredHostStartupStatus | null {
  if (!structuredHostsEnabled(env)) return null;
  return { ...(startupStore.__llvStructuredHostStartupProgress ?? pendingStatus()) };
}
