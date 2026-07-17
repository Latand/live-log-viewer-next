import path from "node:path";

import { fetchClaudeLimits } from "@/lib/limits";
import { LIMITS_RATE_LIMITED_REASON, LIMITS_REAUTH_REQUIRED_REASON } from "@/lib/types";

import type { ClaudeAccount } from "./claude";
import { claudeOauthMetadata, refreshClaudeOauth } from "./claudeOauth";

export type ClaudeValidityProbeResult = "valid" | "invalid" | "unknown";

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
    .catch(() => "unknown" as const)
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
  result: { source: string; reason: string | null },
): ClaudeValidityProbeResult {
  if (result.source === "live" || result.reason === LIMITS_RATE_LIMITED_REASON) return "valid";
  if (result.reason === LIMITS_REAUTH_REQUIRED_REASON
    || result.reason === "credentials missing access token"
    || result.reason?.startsWith("credentials unreadable:")) return "invalid";
  return "unknown";
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
  if (refreshed === "invalid") return "invalid";
  if (refreshed === "unknown") return "unknown";
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
 * validation outranks a transient probe failure; the requested/routed account
 * breaks ties inside the same health tier.
 */
export async function selectHealthyClaudeAccount(
  accounts: ClaudeAccount[],
  preferredId: string | null | undefined,
  dependencies: ClaudeSpawnHealthDependencies = productionDependencies,
): Promise<ClaudeAccount> {
  const now = dependencies.now();
  const classified = accounts.map((account) => {
    const oauth = claudeOauthMetadata(account);
    return { account, oauth };
  });
  const rank = (health: ClaudeValidityProbeResult) => health === "valid" ? 2 : health === "unknown" ? 1 : 0;
  const select = (candidates: Array<{ account: ClaudeAccount; health: ClaudeValidityProbeResult }>) => candidates
    .filter((candidate) => rank(candidate.health) > 0)
    .sort((left, right) => rank(right.health) - rank(left.health)
      || Number(right.account.id === preferredId) - Number(left.account.id === preferredId)
      || left.account.id.localeCompare(right.account.id))[0];

  const current = await Promise.all(classified
    .filter((candidate) => candidate.oauth && candidate.oauth.expiresAt > now)
    .map(async ({ account }) => ({ account, health: await dependencies.probe(account) })));
  const currentSelection = select(current);
  if (currentSelection) return currentSelection.account;

  const refreshed = await Promise.all(classified
    .filter((candidate) => candidate.oauth?.expiresAt && candidate.oauth.expiresAt <= now && candidate.oauth.refreshable)
    .map(async ({ account }) => ({ account, health: await refreshSingleFlight(account, dependencies.refresh) })));
  const refreshedSelection = select(refreshed);
  if (refreshedSelection) return refreshedSelection.account;
  throw new NoHealthyClaudeAccountError(accounts.map((candidate) => candidate.id));
}
