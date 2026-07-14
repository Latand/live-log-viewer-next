import fs from "node:fs";
import path from "node:path";

import { fetchClaudeLimits } from "@/lib/limits";
import { LIMITS_RATE_LIMITED_REASON, LIMITS_REAUTH_REQUIRED_REASON } from "@/lib/types";

import type { ClaudeAccount } from "./claude";

export type ClaudeValidityProbeResult = "valid" | "invalid" | "unknown";

export interface ClaudeSpawnHealthDependencies {
  now(): number;
  probe(account: ClaudeAccount): Promise<ClaudeValidityProbeResult>;
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

function oauthExpiresAt(account: ClaudeAccount): number | null {
  if (!account.authPresent) return null;
  try {
    const credentials = JSON.parse(fs.readFileSync(path.join(account.home, ".credentials.json"), "utf8")) as {
      claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown };
    };
    const oauth = credentials.claudeAiOauth;
    return typeof oauth?.accessToken === "string" && oauth.accessToken.length > 0
      && typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt)
      ? oauth.expiresAt
      : null;
  } catch {
    return null;
  }
}

async function liveValidityProbe(account: ClaudeAccount): Promise<ClaudeValidityProbeResult> {
  const result = await fetchClaudeLimits(path.join(account.home, ".credentials.json"));
  if (result.source === "live" || result.reason === LIMITS_RATE_LIMITED_REASON) return "valid";
  if (result.reason === LIMITS_REAUTH_REQUIRED_REASON
    || result.reason === "credentials missing access token"
    || result.reason?.startsWith("credentials unreadable:")) return "invalid";
  return "unknown";
}

const productionDependencies: ClaudeSpawnHealthDependencies = {
  now: Date.now,
  probe: liveValidityProbe,
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
  const candidates = await Promise.all(accounts.map(async (account) => {
    const expiresAt = oauthExpiresAt(account);
    if (expiresAt === null || expiresAt <= now) return { account, health: "invalid" as const };
    return { account, health: await dependencies.probe(account) };
  }));
  const rank = (health: ClaudeValidityProbeResult) => health === "valid" ? 2 : health === "unknown" ? 1 : 0;
  const selected = candidates
    .filter((candidate) => rank(candidate.health) > 0)
    .sort((left, right) => rank(right.health) - rank(left.health)
      || Number(right.account.id === preferredId) - Number(left.account.id === preferredId)
      || left.account.id.localeCompare(right.account.id))[0];
  if (selected) return selected.account;
  throw new NoHealthyClaudeAccountError(candidates.map((candidate) => candidate.account.id));
}
