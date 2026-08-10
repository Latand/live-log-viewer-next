import type { ViewerHealthEvidence } from "@/lib/runtime/contracts";

export type ViewerCandidateContainerState = "running" | "exited" | "missing";

export interface ViewerHealthRequest {
  url: string;
  headers: Record<string, string>;
}

export interface ViewerHealthRequestPlan {
  root: ViewerHealthRequest;
  authenticated: ViewerHealthRequest | null;
  unauthorized: ViewerHealthRequest | null;
  capability: ViewerHealthRequest;
}

export function viewerHealthRequestPlan(endpoint: string, token: string | null): ViewerHealthRequestPlan {
  const remoteHeaders = { "x-forwarded-for": "203.0.113.10" };
  const authenticatedHeaders = token ? { ...remoteHeaders, authorization: `Bearer ${token}` } : {};
  return {
    root: { url: `${endpoint}/`, headers: {} },
    authenticated: token
      ? { url: `${endpoint}/`, headers: authenticatedHeaders }
      : null,
    unauthorized: token ? { url: `${endpoint}/`, headers: remoteHeaders } : null,
    capability: {
      url: `${endpoint}/api/runtime/deployments/capabilities/v1`,
      headers: authenticatedHeaders,
    },
  };
}

export function hasViewerDeploymentCapability(status: number, body: string): boolean {
  if (status !== 200) return false;
  try {
    const response = JSON.parse(body) as { capability?: unknown; version?: unknown };
    return response?.capability === "viewer-deployments" && response.version === 1;
  } catch {
    return false;
  }
}

export function viewerDeploymentRegistryBackendMode(
  status: number,
  body: string,
): "off" | "dual-write" | "read" | "sqlite" | null {
  if (!hasViewerDeploymentCapability(status, body)) return null;
  try {
    const mode = (JSON.parse(body) as { registryBackendMode?: unknown }).registryBackendMode;
    return mode === "off" || mode === "dual-write" || mode === "read" || mode === "sqlite" ? mode : null;
  } catch {
    return null;
  }
}

/** Older release capabilities omit this field and already represent complete
 * startup. SQLite-wave releases expose an explicit false value until their
 * post-activation serving controllers have started. */
export function viewerDeploymentReleaseReady(status: number, body: string): boolean {
  if (!hasViewerDeploymentCapability(status, body)) return false;
  try {
    return (JSON.parse(body) as { releaseReady?: unknown }).releaseReady !== false;
  } catch {
    return false;
  }
}

export interface ViewerStructuredHostStartupProgress {
  state: "pending" | "failed" | "ready";
  phase: string;
  completedHosts: number;
  totalHosts: number | null;
}

export function viewerDeploymentStructuredHostStartup(
  status: number,
  body: string,
): ViewerStructuredHostStartupProgress | null {
  if (!hasViewerDeploymentCapability(status, body)) return null;
  try {
    const progress = (JSON.parse(body) as { structuredHostStartup?: unknown }).structuredHostStartup;
    if (!progress || typeof progress !== "object" || Array.isArray(progress)) return null;
    const candidate = progress as Record<string, unknown>;
    const state = candidate.state;
    const phase = candidate.phase;
    const completedHosts = candidate.completedHosts;
    const totalHosts = candidate.totalHosts;
    if ((state !== "pending" && state !== "failed" && state !== "ready")
      || typeof phase !== "string"
      || !/^[A-Za-z0-9 -]{1,80}$/.test(phase)
      || !Number.isSafeInteger(completedHosts)
      || (completedHosts as number) < 0
      || (totalHosts !== null
        && (!Number.isSafeInteger(totalHosts)
          || (totalHosts as number) < (completedHosts as number)))) return null;
    return {
      state,
      phase,
      completedHosts: completedHosts as number,
      totalHosts: totalHosts as number | null,
    };
  } catch {
    return null;
  }
}

export function promotedViewerReadinessPhase(
  progress: ViewerStructuredHostStartupProgress | null,
): string {
  if (!progress) {
    return "waiting for promoted Viewer serving readiness - adoption progress unavailable";
  }
  const total = progress.totalHosts === null ? "unknown" : String(progress.totalHosts);
  const prefix = `waiting for promoted Viewer serving readiness - adoption ${progress.completedHosts} of ${total} - `;
  return `${prefix}${progress.phase.slice(0, Math.max(0, 160 - prefix.length)).trimEnd()}`;
}

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
    unauthorizedStatus: null,
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
