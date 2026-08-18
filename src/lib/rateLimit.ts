import type { DurableQuotaObservation } from "@/lib/accounts/migration/contracts";
import { effectiveRemaining } from "@/lib/accounts/migration/quotaPolicy";
import type { Flow } from "@/lib/flows/types";
import { SESSION_WINDOW_MINUTES, WEEKLY_WINDOW_MINUTES } from "@/lib/limitWindows";
import type { Engine, EngineLimits, FileEntry, LimitsProvenance, LimitWindow, LimitWindowSource, RateLimitState } from "@/lib/types";

type HostedEngine = Extract<Engine, "claude" | "codex">;

export const LIMITS_FRESHNESS_S = 20 * 60;

export type QuotaReadingSource = LimitWindowSource;

export interface QuotaReading {
  limits: EngineLimits | null;
  observedAt: number | null;
  stale: boolean;
  source: QuotaReadingSource;
}

export interface ReconciledQuotaWindow {
  value: LimitWindow;
  observedAt: number | null;
  stale: boolean;
  source: QuotaReadingSource;
}

export interface ReconciledQuota {
  session: ReconciledQuotaWindow | null;
  weekly: ReconciledQuotaWindow | null;
  plan: string | null;
}

export interface AccountQuotaLimits {
  freshness: "fresh" | "stale";
  session: LimitWindow | null;
  weekly: LimitWindow | null;
  checkedAt?: string | null;
}

export function quotaReadingFromAccountLimits(limits: AccountQuotaLimits | null | undefined): QuotaReading | null {
  if (!limits) return null;
  const parsed = limits.checkedAt ? Date.parse(limits.checkedAt) / 1000 : NaN;
  const observedAt = Number.isFinite(parsed) ? parsed : null;
  return {
    limits: { session: limits.session, weekly: limits.weekly, plan: null, capturedAt: observedAt },
    observedAt,
    stale: limits.freshness === "stale",
    source: "account",
  };
}

export function quotaReadingFromEngineLimits(
  limits: EngineLimits | null | undefined,
  provenance: LimitsProvenance,
  receivedAt: number,
): QuotaReading | null {
  if (!limits) return null;
  const parsedStaleSince = provenance.staleSince ? Date.parse(provenance.staleSince) / 1000 : NaN;
  const staleSince = Number.isFinite(parsedStaleSince) ? parsedStaleSince : null;
  return {
    limits,
    observedAt: limits.capturedAt ?? staleSince ?? receivedAt,
    stale: provenance.source === "cache" || provenance.source === "unavailable",
    source: provenance.source,
  };
}

function reconciledWindow(reading: QuotaReading, key: "session" | "weekly", now: number): ReconciledQuotaWindow | null {
  const value = reading.limits?.[key];
  if (!value) return null;
  const observedAt = value.observedAt ?? reading.observedAt;
  const aged = observedAt !== null && now - observedAt > LIMITS_FRESHNESS_S;
  return { value, observedAt, stale: reading.stale || aged, source: value.source ?? reading.source };
}

/** A window that declares its own cycle start is direct evidence about which
    cycle is open: one that opened after an observation belongs to a later cycle
    than that observation does. */
function cycleOpenedAfter(window: ReconciledQuotaWindow | null, observedAt: number): boolean {
  const value = window?.value;
  if (!value || value.resetsAt === null || typeof value.windowMinutes !== "number") return false;
  return value.resetsAt - value.windowMinutes * 60 > observedAt;
}

/** An exhaustion with a known reset governs until it. One whose reset the
    provider never named can only speak for the cycle it was observed in, so it
    expires a window length after that observation — the horizon of the key it
    is filed under when the window declares no length of its own — and loses
    sooner to a rival whose own cycle opened after it, which is proof that cycle
    has rolled. */
function activeExhaustion(window: ReconciledQuotaWindow, rival: ReconciledQuotaWindow | null, key: "session" | "weekly", now: number): boolean {
  if (window.value.usedPercent < 100) return false;
  if (window.value.resetsAt !== null) return window.value.resetsAt > now;
  if (window.observedAt === null) return true;
  const windowMinutes = typeof window.value.windowMinutes === "number"
    ? window.value.windowMinutes
    : key === "weekly" ? WEEKLY_WINDOW_MINUTES : SESSION_WINDOW_MINUTES;
  if (now - window.observedAt >= windowMinutes * 60) return false;
  return !cycleOpenedAfter(rival, window.observedAt);
}

function newerWindow(left: ReconciledQuotaWindow | null, right: ReconciledQuotaWindow | null, key: "session" | "weekly", now: number): ReconciledQuotaWindow | null {
  if (!left) return right;
  if (!right) return left;
  const leftExhausted = activeExhaustion(left, right, key, now);
  const rightExhausted = activeExhaustion(right, left, key, now);
  if (leftExhausted !== rightExhausted) return leftExhausted ? left : right;
  if (left.observedAt === null) return right.observedAt === null ? left : right;
  if (right.observedAt === null) return left;
  return right.observedAt > left.observedAt ? right : left;
}

/** Reconciles two observations of one account. Each quota window selects its
    own newest observation so a caller cannot combine a chip from one snapshot
    with rows from another. */
export function reconcileQuotaReadings(left: QuotaReading | null, right: QuotaReading | null, now: number): ReconciledQuota {
  const session = newerWindow(left ? reconciledWindow(left, "session", now) : null, right ? reconciledWindow(right, "session", now) : null, "session", now);
  const weekly = newerWindow(left ? reconciledWindow(left, "weekly", now) : null, right ? reconciledWindow(right, "weekly", now) : null, "weekly", now);
  const readings = [left, right]
    .filter((reading): reading is QuotaReading => Boolean(reading?.limits?.plan))
    .sort((a, b) => (b.observedAt ?? Number.NEGATIVE_INFINITY) - (a.observedAt ?? Number.NEGATIVE_INFINITY));
  return { session, weekly, plan: readings[0]?.limits?.plan ?? null };
}

export function effectiveQuota(quota: ReconciledQuota): (ReconciledQuotaWindow & { window: "session" | "weekly"; percent: number }) | null {
  const windows = (["session", "weekly"] as const).flatMap((window) => {
    const value = quota[window];
    return value ? [{ ...value, window, percent: Math.max(0, Math.min(100, 100 - value.value.usedPercent)) }] : [];
  });
  return windows.sort((a, b) => a.percent - b.percent || a.window.localeCompare(b.window))[0] ?? null;
}

export function quotaAsEngineLimits(quota: ReconciledQuota): EngineLimits | null {
  if (!quota.session && !quota.weekly) return null;
  const observed = [quota.session?.observedAt, quota.weekly?.observedAt]
    .filter((value): value is number => value !== null && value !== undefined);
  return {
    session: quota.session ? { ...quota.session.value, observedAt: quota.session.observedAt, source: quota.session.source } : null,
    weekly: quota.weekly ? { ...quota.weekly.value, observedAt: quota.weekly.observedAt, source: quota.weekly.source } : null,
    plan: quota.plan,
    capturedAt: observed.length ? Math.min(...observed) : null,
  };
}

export function quotaUsesSource(quota: ReconciledQuota, source: QuotaReadingSource): boolean {
  return quota.session?.source === source || quota.weekly?.source === source;
}

export interface RateLimitProjectionSnapshot {
  conversations: Record<string, {
    id: string;
    engine: HostedEngine;
    generations: Array<{ path: string; accountId: string | null }>;
  }>;
  quotaObservations: Record<HostedEngine, Record<string, DurableQuotaObservation>>;
}

export function rateLimitFromQuotaObservation(
  observation: DurableQuotaObservation | undefined,
  now = Date.now(),
): RateLimitState | null {
  if (!observation) return null;
  const observedAt = Date.parse(observation.observedAt);
  const authCheckedAt = Date.parse(observation.authCheckedAt);
  const remaining = effectiveRemaining({
    engine: observation.engine,
    accountId: observation.accountId,
    authenticated: observation.authenticated,
    limits: observation.limits,
    provenance: observation.provenance,
    observedAt,
    authCheckedAt,
  }, now);
  if (remaining?.percent !== 0 || !observation.limits) return null;

  const exhausted = (["session", "weekly"] as const).flatMap((window) => {
    const value = observation.limits?.[window];
    return value && value.usedPercent >= 100 ? [{ window, resetAt: value.resetsAt }] : [];
  });
  if (!exhausted.length) return null;
  const activeExhausted = exhausted.filter((item) => item.resetAt === null || item.resetAt * 1000 > now);
  if (!activeExhausted.length) return null;
  const governing = activeExhausted.find((item) => item.resetAt === null)
    ?? activeExhausted.sort((left, right) => right.resetAt! - left.resetAt!)[0]!;
  return {
    source: "account",
    accountId: observation.accountId,
    window: governing.window,
    resetAt: governing.resetAt !== null && governing.resetAt * 1000 > now ? governing.resetAt : null,
  };
}

function mergeRateLimits(
  pane: RateLimitState | null | undefined,
  structured: RateLimitState | null,
  accountId: string | null,
): RateLimitState | null {
  if (!pane) return structured;
  return {
    source: "pane",
    accountId: accountId ?? pane.accountId,
    window: structured?.window ?? pane.window,
    resetAt: structured?.resetAt ?? pane.resetAt,
  };
}

/** Pure projection over the scanner and registry snapshots. The returned
    flow block carries the stable conversation seam for successor reseating. */
export function projectRateLimitReadModel(
  files: FileEntry[],
  flows: Flow[],
  snapshot: RateLimitProjectionSnapshot,
  now = Date.now(),
): { files: FileEntry[]; flows: Flow[] } {
  const hosts = new Map<string, { conversationId: string; engine: HostedEngine; accountId: string | null }>();
  for (const conversation of Object.values(snapshot.conversations)) {
    for (const generation of conversation.generations) {
      hosts.set(generation.path, {
        conversationId: conversation.id,
        engine: conversation.engine,
        accountId: generation.accountId,
      });
    }
  }

  const projectedFiles = files.map((file) => {
    const host = hosts.get(file.path);
    const observation = host?.accountId
      ? snapshot.quotaObservations[host.engine][host.accountId]
      : undefined;
    const structured = file.proc === "running"
      ? rateLimitFromQuotaObservation(observation, now)
      : null;
    const rateLimit = mergeRateLimits(file.rateLimit, structured, host?.accountId ?? null);
    return {
      ...file,
      conversationId: file.conversationId ?? host?.conversationId,
      rateLimit,
    };
  });
  const filesByPath = new Map(projectedFiles.map((file) => [file.path, file]));
  const implementerStates = new Set<Flow["state"]>(["waiting_ready", "relaying", "fixing"]);
  const projectedFlows = flows.map((flow) => {
    const implementer = filesByPath.get(flow.implementerPath);
    const rateLimit = implementer?.rateLimit;
    if (!rateLimit || !implementerStates.has(flow.state)) {
      return flow.block ? { ...flow, block: null } : flow;
    }
    return {
      ...flow,
      block: {
        reason: "rate_limited" as const,
        conversationId: implementer.conversationId ?? flow.implementerConversationId ?? null,
        accountId: rateLimit.accountId,
        resetAt: rateLimit.resetAt,
      },
    };
  });
  return { files: projectedFiles, flows: projectedFlows };
}
