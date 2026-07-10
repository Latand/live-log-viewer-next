import type { DurableQuotaObservation } from "@/lib/accounts/migration/contracts";
import { effectiveRemaining } from "@/lib/accounts/migration/quotaPolicy";
import type { Flow } from "@/lib/flows/types";
import type { Engine, FileEntry, RateLimitState } from "@/lib/types";

type HostedEngine = Extract<Engine, "claude" | "codex">;

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
