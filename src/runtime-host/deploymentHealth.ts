import type { ViewerHealthEvidence } from "@/lib/runtime/contracts";

export type ViewerCandidateContainerState = "running" | "exited" | "missing";

export interface ViewerHealthRequest {
  url: string;
  headers: Record<string, string>;
  method?: "GET" | "POST";
  body?: string;
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
      url: `${endpoint}/api/runtime/deployments`,
      headers: { ...authenticatedHeaders, "content-type": "application/json" },
      method: "POST",
      body: "{}",
    },
  };
}

export function hasViewerDeploymentCapability(status: number, body: string): boolean {
  if (status !== 400) return false;
  try {
    const response = JSON.parse(body) as { error?: unknown };
    return response?.error === "idempotencyKey is required";
  } catch {
    return false;
  }
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
