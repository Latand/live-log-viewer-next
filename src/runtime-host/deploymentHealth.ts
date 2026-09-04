import type {
  ViewerHealthEvidence,
  ViewerHealthProbeObservation,
  ViewerHealthReadiness,
} from "@/lib/runtime/contracts";

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
    /* Every probe whose expectation is a 200 carries whatever credentials the
       candidate requires of it. Once a token is configured, every request
       authenticates, loopback included (#1496), so an unauthenticated success
       is no longer a property a correct Viewer has, and requiring one held a
       healthy candidate out of promotion (#1511). With no token there is
       nothing to carry, and a plain 200 remains the proof that the Viewer
       serves its own root. `unauthorized` below is the one probe left
       uncredentialed, because the refusal is what it asserts. */
    root: { url: `${endpoint}/`, headers: token ? { authorization: `Bearer ${token}` } : {} },
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

const BODY_EXCERPT_CHARS = 200;
const DETAIL_CHARS = 600;
const CANDIDATE_LOG_LINES = 20;
const CANDIDATE_LOG_CHARS = 200;

/** One printable line, bounded. Probe bodies and candidate output reach the
    durable deployment record and the operator's terminal, so neither a stack
    trace nor a megabyte of HTML may travel with them. */
export function probeExcerpt(text: string, limit = BODY_EXCERPT_CHARS): string {
  const collapsed = text.replace(/\p{C}/gu, " ").replace(/\s+/g, " ").trim();
  return collapsed.length > limit ? `${collapsed.slice(0, limit)}...` : collapsed;
}

/** The candidate is retired as soon as its health gate fails, taking its
    container logs with it, so the tail is read while it is still alive. */
export function candidateLogExcerpt(
  output: string,
  options: { maxLines?: number; maxChars?: number } = {},
): string[] {
  const maxLines = Math.min(Math.max(options.maxLines ?? CANDIDATE_LOG_LINES, 1), 200);
  const maxChars = Math.min(Math.max(options.maxChars ?? CANDIDATE_LOG_CHARS, 40), 1_000);
  return output
    .split("\n")
    .map((line) => probeExcerpt(line, maxChars))
    .filter((line) => line.length > 0)
    .slice(-maxLines);
}

export function describeProbeObservation(observation: ViewerHealthProbeObservation): string {
  const answered = observation.status === 0
    ? `no response (${observation.error ?? "transport failure"})`
    : `HTTP ${observation.status}`;
  return `${observation.name} GET ${observation.url} -> ${answered} in ${observation.elapsedMs} ms, expected ${observation.expected}`;
}

function withBody(sentence: string, observations: ViewerHealthProbeObservation[]): string {
  const body = observations.find((observation) => observation.body)?.body;
  return body ? `${sentence}; body: ${body}` : sentence;
}

export interface ViewerHealthGateOutcome {
  observations: ViewerHealthProbeObservation[];
  assets: Array<{ path: string; status: number }>;
  deploymentCapable: boolean;
  registryBackendMatches: boolean;
  expectedRegistryBackendMode: string;
  observedRegistryBackendMode: string | null;
  releaseReady: boolean;
  expectedAssetsMatch: boolean;
}

/** Names the gate that failed together with the request behind it. The order
    matters as much as the words: a candidate whose whole surface answers 500 is
    reported as that, not as the capability gate that happens to be checked
    first, which is how #790 spent a deploy cycle on a route that was never the
    problem. */
export function viewerHealthFailureDetail(outcome: ViewerHealthGateOutcome): string | null {
  const detail = failedGate(outcome);
  return detail === null ? null : probeExcerpt(detail, DETAIL_CHARS);
}

function failedGate(outcome: ViewerHealthGateOutcome): string | null {
  const failed = outcome.observations.filter((observation) => !observation.ok);
  const surface = failed.filter((observation) => observation.name !== "capability");
  if (failed.some((observation) => observation.status === 0)) {
    return `Viewer candidate did not answer: ${failed.map(describeProbeObservation).join("; ")}`;
  }
  if (surface.length > 0) {
    return withBody(`Viewer HTTP surface failed: ${failed.map(describeProbeObservation).join("; ")}`, failed);
  }
  if (!outcome.deploymentCapable) {
    const capability = outcome.observations.find((observation) => observation.name === "capability");
    return withBody(
      `Viewer deployment capability gate failed: ${capability
        ? describeProbeObservation(capability)
        : "no capability probe was recorded"}`,
      failed,
    );
  }
  if (!outcome.registryBackendMatches) {
    return `Viewer registry backend mode mismatch: expected ${outcome.expectedRegistryBackendMode}, observed ${outcome.observedRegistryBackendMode ?? "unavailable"}`;
  }
  if (!outcome.releaseReady) {
    return "Viewer release startup is incomplete: the capability route answered 200 with releaseReady false";
  }
  if (!outcome.expectedAssetsMatch) return "stable listener does not serve the candidate asset set";
  if (outcome.assets.length === 0) {
    return "Viewer asset gate failed: the served page referenced no build assets";
  }
  const broken = outcome.assets.filter((asset) => asset.status !== 200);
  if (broken.length > 0) {
    return `Viewer asset gate failed: ${broken.length} of ${outcome.assets.length} referenced assets did not answer 200 (${broken[0]?.path} -> ${broken[0]?.status})`;
  }
  return null;
}

/** A timeout that reports only the last symptom cannot be told apart from a
    budget that was too small, so the waiting itself is measured (#790). */
export function viewerReadinessTimeoutDetail(
  readiness: ViewerHealthReadiness,
  lastDetail: string | null,
): string {
  const elapsed = `${(readiness.elapsedMs / 1_000).toFixed(1)}s`;
  const budget = `budget ${readiness.maxAttempts} attempts ${readiness.delayMs} ms apart`;
  const first = readiness.firstDetail ? `; first attempt: ${readiness.firstDetail}` : "";
  return `candidate readiness timed out after ${readiness.attempts} attempts over ${elapsed} (${budget}): ${lastDetail ?? "no probe completed"}${first}`;
}

export interface ViewerReadinessProbe {
  endpoint: string;
  inspect(): Promise<ViewerCandidateContainerState>;
  probe(): Promise<ViewerHealthEvidence>;
  sleep?(delayMs: number): Promise<void>;
  maxAttempts?: number;
  delayMs?: number;
  now?(): number;
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
  const maxAttempts = Math.min(Math.max(options.maxAttempts ?? 30, 1), 120);
  const delayMs = Math.min(Math.max(options.delayMs ?? 1_000, 0), 10_000);
  const sleep = options.sleep ?? ((delay) => new Promise<void>((resolve) => setTimeout(resolve, delay)));
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  let last: ViewerHealthEvidence | null = null;
  let firstDetail: string | null = null;
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const state = await options.inspect();
    if (state !== "running") {
      return {
        ...unavailable(options.endpoint, state),
        readiness: readiness({ attempts, maxAttempts, delayMs, elapsedMs: now() - startedAt, firstDetail, lastDetail: last?.detail ?? null }),
      };
    }
    attempts = attempt;
    last = await options.probe();
    if (last.ok) return last;
    if (attempt === 1) firstDetail = last.detail ?? null;
    if (attempt < maxAttempts) await sleep(delayMs);
  }
  const record = readiness({
    attempts, maxAttempts, delayMs, elapsedMs: now() - startedAt, firstDetail, lastDetail: last?.detail ?? null,
  });
  return {
    ...(last ?? unavailable(options.endpoint, "missing")),
    ok: false,
    readiness: record,
    detail: viewerReadinessTimeoutDetail(record, last?.detail ?? null),
  };
}

function readiness(input: {
  attempts: number;
  maxAttempts: number;
  delayMs: number;
  elapsedMs: number;
  firstDetail: string | null;
  lastDetail: string | null;
}): ViewerHealthReadiness {
  return {
    attempts: input.attempts,
    maxAttempts: input.maxAttempts,
    delayMs: input.delayMs,
    elapsedMs: Math.max(0, Math.round(input.elapsedMs)),
    /* Only a symptom that changed while waiting carries information: repeating
       an identical detail twice says nothing about the budget. */
    ...(input.firstDetail && input.firstDetail !== input.lastDetail ? { firstDetail: input.firstDetail } : {}),
  };
}
