import type { ViewerHealthEvidence } from "@/lib/runtime/contracts";

export type ViewerCandidateContainerState = "running" | "exited" | "missing";

export interface ViewerReadinessProbe {
  endpoint: string;
  inspect(): Promise<ViewerCandidateContainerState>;
  probe(): Promise<ViewerHealthEvidence>;
  sleep?(delayMs: number): Promise<void>;
  maxAttempts?: number;
  delayMs?: number;
}

function unavailable(endpoint: string, state: Exclude<ViewerCandidateContainerState, "running">): ViewerHealthEvidence {
  return {
    checkedAt: new Date().toISOString(),
    endpoint,
    processReady: false,
    rootStatus: 0,
    authenticatedStatus: null,
    assets: [],
    ok: false,
    detail: state === "exited" ? "candidate container exited before readiness" : "candidate container disappeared before readiness",
  };
}

export async function waitForViewerReadiness(options: ViewerReadinessProbe): Promise<ViewerHealthEvidence> {
  const attempts = Math.min(Math.max(options.maxAttempts ?? 30, 1), 120);
  const delayMs = Math.min(Math.max(options.delayMs ?? 1_000, 0), 10_000);
  const sleep = options.sleep ?? ((delay) => new Promise<void>((resolve) => setTimeout(resolve, delay)));
  let last: ViewerHealthEvidence | null = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const state = await options.inspect();
    if (state !== "running") return unavailable(options.endpoint, state);
    last = await options.probe();
    if (last.ok) return last;
    if (attempt < attempts) await sleep(delayMs);
  }
  return {
    ...(last ?? unavailable(options.endpoint, "missing")),
    ok: false,
    detail: last?.detail ? `candidate readiness timed out: ${last.detail}` : "candidate readiness timed out",
  };
}
