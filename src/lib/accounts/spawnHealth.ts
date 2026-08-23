import path from "node:path";

import { classifySpawnAccountAdmission, type SpawnAccountAdmission } from "@/lib/agent/accountLiveness";
import { fetchClaudeLimits } from "@/lib/limits";
import { LIMITS_REAUTH_REQUIRED_REASON, type EngineLimits } from "@/lib/types";

import type { ClaudeAccount } from "./claude";
import { claudeOauthMetadata, refreshClaudeOauth } from "./claudeOauth";

export type ClaudeValidityProbeResult = SpawnAccountAdmission;

export interface ClaudeSpawnAccountSelection {
  account: ClaudeAccount;
  admission: SpawnAccountAdmission;
  /** Classification of the explicitly requested account when one was given. */
  requestedAdmission?: SpawnAccountAdmission;
}

const CLAUDE_SPAWN_HEALTH_TIMEOUT_MS = 600;

export interface ClaudeSpawnHealthDependencies {
  now(): number;
  probe(account: ClaudeAccount): Promise<ClaudeValidityProbeResult>;
  refresh(account: ClaudeAccount): Promise<ClaudeValidityProbeResult>;
}

const globalStore = globalThis as typeof globalThis & {
  __llvClaudeRefreshInflight?: Map<string, Promise<ClaudeValidityProbeResult>>;
};

function refreshSingleFlight(
  account: ClaudeAccount,
  refresh: ClaudeSpawnHealthDependencies["refresh"],
): Promise<ClaudeValidityProbeResult> {
  const inflight = globalStore.__llvClaudeRefreshInflight ??= new Map();
  const key = `${account.id}\0${path.resolve(account.home)}`;
  const existing = inflight.get(key);
  if (existing) return existing;
  const pending = Promise.resolve()
    .then(() => refresh(account))
    .catch(() => classifySpawnAccountAdmission({
      enabled: true,
      authentication: "unknown",
      limits: "unknown",
      stale: true,
      retryAt: null,
    }))
    .finally(() => {
      if (inflight.get(key) === pending) inflight.delete(key);
    });
  inflight.set(key, pending);
  return pending;
}

export class NoHealthyClaudeAccountError extends Error {
  readonly accountIds: string[];

  constructor(accountIds: string[]) {
    const ids = [...new Set(accountIds)].sort();
    const target = ids.length === 1 ? `account ${ids[0]}` : ids.length > 1 ? `accounts ${ids.join(", ")}` : "a Claude account";
    super(`No healthy Claude account is available. Re-login ${target} in Accounts and retry.`);
    this.name = "NoHealthyClaudeAccountError";
    this.accountIds = ids;
  }
}

export function claudeValidityFromLimitRead(
  result: {
    source: string;
    reason: string | null;
    data: EngineLimits | null;
    retryAt?: number | string | null;
  },
  now = Date.now(),
): ClaudeValidityProbeResult {
  const authentication = result.reason === LIMITS_REAUTH_REQUIRED_REASON
    || result.reason === "credentials missing access token"
    || result.reason?.startsWith("credentials unreadable:")
    ? "failed" as const
    : result.source === "live"
      ? "authenticated" as const
      : "unknown" as const;
  const windows = result.data
    ? [result.data.session, result.data.weekly].filter((window) => window !== null)
    : [];
  const exhausted = windows.filter((window) => Number.isFinite(window.usedPercent) && window.usedPercent >= 100);
  const limits = exhausted.length > 0
    ? "exhausted" as const
    : windows.length > 0
      ? "available" as const
      : "unknown" as const;
  let retryAt: string | null = null;
  if (exhausted.length > 0 && exhausted.every((window) =>
    Number.isSafeInteger(window.resetsAt)
      && window.resetsAt! * 1_000 > now)) {
    retryAt = new Date(Math.max(...exhausted.map((window) => window.resetsAt!)) * 1_000).toISOString();
  } else if (typeof result.retryAt === "number" && Number.isFinite(result.retryAt)) {
    retryAt = new Date(result.retryAt).toISOString();
  } else if (typeof result.retryAt === "string") {
    retryAt = result.retryAt;
  }
  return classifySpawnAccountAdmission({
    enabled: true,
    authentication,
    limits,
    stale: result.source !== "live",
    retryAt,
  }, now);
}

async function liveValidityProbe(account: ClaudeAccount): Promise<ClaudeValidityProbeResult> {
  const result = await fetchClaudeLimits(
    path.join(account.home, ".credentials.json"),
    Date.now,
    CLAUDE_SPAWN_HEALTH_TIMEOUT_MS,
  );
  return claudeValidityFromLimitRead(result);
}

async function refreshValidityProbe(account: ClaudeAccount): Promise<ClaudeValidityProbeResult> {
  const refreshed = await refreshClaudeOauth(account);
  if (refreshed === "invalid") {
    return classifySpawnAccountAdmission({
      enabled: true,
      authentication: "failed",
      limits: "unknown",
      stale: false,
      retryAt: null,
    });
  }
  if (refreshed === "unknown") {
    return classifySpawnAccountAdmission({
      enabled: true,
      authentication: "unknown",
      limits: "unknown",
      stale: true,
      retryAt: null,
    });
  }
  return await liveValidityProbe(account);
}

const productionDependencies: ClaudeSpawnHealthDependencies = {
  now: Date.now,
  probe: liveValidityProbe,
  refresh: refreshValidityProbe,
};

/**
 * Chooses one launchable Claude account from a single preflight health pass.
 * A current OAuth expiry is required before the live usage probe runs. Live
 * validation outranks a transient probe failure for ordinary routing. An
 * explicit admissible pin keeps its account; the active account breaks ties
 * inside the same health tier when the caller left the account unpinned.
 */
export async function selectHealthyClaudeAccount(
  accounts: ClaudeAccount[],
  preferredId: string | null | undefined,
  dependencies: ClaudeSpawnHealthDependencies = productionDependencies,
  pinPreferred = true,
  fallbackPreferredId: string | null | undefined = preferredId,
): Promise<ClaudeSpawnAccountSelection> {
  const now = dependencies.now();
  const classified = accounts.map((account) => {
    const oauth = claudeOauthMetadata(account);
    return { account, oauth };
  });
  type Evaluated = { account: ClaudeAccount; admission: SpawnAccountAdmission };
  const rank = (admission: SpawnAccountAdmission) => admission.kind === "admissible"
    ? admission.basis === "current" ? 2 : 1
    : 0;
  const select = (candidates: Evaluated[]) => candidates
    .filter((candidate) => rank(candidate.admission) > 0)
    .sort((left, right) => rank(right.admission) - rank(left.admission)
      || Number(right.account.id === fallbackPreferredId) - Number(left.account.id === fallbackPreferredId)
      || left.account.id.localeCompare(right.account.id))[0];
  const result = (selected: Evaluated, requested?: Evaluated | null): ClaudeSpawnAccountSelection => ({
    account: selected.account,
    admission: selected.admission,
    ...(pinPreferred && preferredId && requested ? { requestedAdmission: requested.admission } : {}),
  });

  const current = await Promise.all(classified
    .filter((candidate) => candidate.oauth && candidate.oauth.expiresAt > now)
    .map(async ({ account }) => ({ account, admission: await dependencies.probe(account) })));
  let requested = preferredId ? current.find((candidate) => candidate.account.id === preferredId) ?? null : null;
  if (pinPreferred && requested?.admission.kind === "admissible") return result(requested, requested);

  const preferredExpired = pinPreferred && preferredId
    ? classified.find((candidate) => candidate.account.id === preferredId
      && candidate.oauth?.expiresAt
      && candidate.oauth.expiresAt <= now
      && candidate.oauth.refreshable)
    : null;
  if (preferredExpired) {
    requested = {
      account: preferredExpired.account,
      admission: await refreshSingleFlight(preferredExpired.account, dependencies.refresh),
    };
    if (requested.admission.kind === "admissible") return result(requested, requested);
  }

  const currentSelection = select(current);
  if (currentSelection) return result(currentSelection, requested);

  const refreshed = await Promise.all(classified
    .filter((candidate) => candidate.oauth?.expiresAt && candidate.oauth.expiresAt <= now && candidate.oauth.refreshable)
    .filter((candidate) => candidate.account.id !== preferredExpired?.account.id)
    .map(async ({ account }) => ({ account, admission: await refreshSingleFlight(account, dependencies.refresh) })));
  const all = [...current, ...(requested ? [requested] : []), ...refreshed];
  const refreshedSelection = select(all);
  if (refreshedSelection) return result(refreshedSelection, requested);
  throw new NoHealthyClaudeAccountError(accounts.map((candidate) => candidate.id));
}
