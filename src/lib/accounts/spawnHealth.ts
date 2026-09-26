import path from "node:path";
import { accountsCollectionRevision } from "./accountsStore";

import { classifySpawnAccountAdmission, type SpawnAccountAdmission } from "@/lib/agent/accountLiveness";
import { gatingWindows } from "@/lib/accounts/migration/quotaPolicy";
import { fetchClaudeLimits } from "@/lib/limits";
import { LIMITS_REAUTH_REQUIRED_REASON, type EngineLimits } from "@/lib/types";

import { listClaudeAccounts, listClaudeProviderModels, readClaudeProviderToken, UnknownClaudeAccountError, type ClaudeAccount } from "./claude";
import { claudeOauthMetadata, refreshClaudeOauth } from "./claudeOauth";
import { accountProbeIdentity, accountProbeSnapshot, claudeProbeCredentialIdentity, AccountMutationBusyError, withAccountMutationLockAsync } from "./accountMutation";

export type ClaudeValidityProbeResult = SpawnAccountAdmission & {
  /** Shared provider read; each waiter applies its own model without another probe. */
  limitRead?: Parameters<typeof claudeValidityFromLimitRead>[0];
};

export class ClaudeCredentialUnavailableError extends Error {
  constructor() { super("Claude credential store is unavailable; retry when access is restored"); this.name = "ClaudeCredentialUnavailableError"; }
}

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
    .catch((error: unknown) => {
      if (error instanceof AccountMutationBusyError || error instanceof UnknownClaudeAccountError || error instanceof ClaudeCredentialUnavailableError) throw error;
      return classifySpawnAccountAdmission({
        enabled: true,
        authentication: "unknown",
        limits: "unknown",
        stale: true,
        retryAt: null,
      });
    })
    .finally(() => {
      if (inflight.get(key) === pending) inflight.delete(key);
    });
  inflight.set(key, pending);
  return pending;
}

export class NoHealthyClaudeAccountError extends Error {
  readonly accountIds: string[];

  /** Accounts are named by the label the Accounts panel shows ("Main"), never
      by their internal id ("default"): the message tells the operator which
      row to sign back in on (#2170). A bare id is its own label. */
  constructor(accounts: ReadonlyArray<string | (Pick<ClaudeAccount, "id" | "label"> & Partial<Pick<ClaudeAccount, "provider">>)>) {
    const byId = new Map<string, string>();
    for (const account of accounts) {
      const id = typeof account === "string" ? account : account.id;
      const label = typeof account === "string" ? account : account.label.trim() || account.id;
      if (!byId.has(id)) byId.set(id, label);
    }
    const ids = [...byId.keys()].sort();
    const labels = ids.map((id) => byId.get(id)!);
    const target = labels.length === 1 ? labels[0] : labels.length > 1 ? `${labels.slice(0, -1).join(", ")} or ${labels.at(-1)}` : "a Claude account";
    super(accounts.length > 0 && accounts.every((account) => typeof account !== "string" && account.provider)
      ? `No healthy Claude provider account is available. Check the provider token for ${target} in Accounts and retry.`
      : `No healthy Claude account is available. Re-login ${target} in Accounts and retry.`);
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
  /** The model the launch names, when the caller knows it. */
  model?: string | null,
): ClaudeValidityProbeResult {
  if (result.reason === "credential store unavailable" || result.reason?.startsWith("credentials unreadable:")) {
    throw new ClaudeCredentialUnavailableError();
  }
  const authentication = result.reason === LIMITS_REAUTH_REQUIRED_REASON
    || result.reason === "credentials missing access token"
    || result.reason === "credentials absent"
    ? "failed" as const
    : result.source === "live"
      ? "authenticated" as const
      : "unknown" as const;
  /* The windows that gate THIS spawn (issues #1796, #1431): the session and
     general week, plus the requested model's own tier weekly when the provider
     reports one. Another tier's exhaustion is not this launch's refusal. */
  const windows = gatingWindows("claude", result.data, model)
    .map((entry) => entry.value)
    .filter((window) => window !== null && window !== undefined);
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
  return { ...claudeValidityFromLimitRead(result), limitRead: result };
}

function currentClaudeAccount(account: ClaudeAccount): ClaudeAccount {
  const current = listClaudeAccounts().find((candidate) => candidate.id === account.id);
  if (!current || current.kind !== account.kind || path.resolve(current.home) !== path.resolve(account.home)) {
    throw new UnknownClaudeAccountError(account.id);
  }
  return current;
}

async function fencedLiveValidityProbe(account: ClaudeAccount): Promise<ClaudeValidityProbeResult> {
  const snapshot = await accountProbeSnapshot(() => currentClaudeAccount(account), { holder: "Claude validity snapshot", caller: "spawn health" });
  const credentialIdentity = claudeProbeCredentialIdentity(snapshot.account.home);
  const result = await liveValidityProbe(snapshot.account);
  if (credentialIdentity === null || credentialIdentity !== claudeProbeCredentialIdentity(snapshot.account.home)) throw new ClaudeCredentialUnavailableError();
  await withAccountMutationLockAsync(() => {
    if (snapshot.revision !== accountsCollectionRevision() || accountProbeIdentity(snapshot.account) !== snapshot.identity) throw new ClaudeCredentialUnavailableError();
  }, { holder: "Claude validity recheck" });
  return result;
}

async function refreshValidityProbe(account: ClaudeAccount): Promise<ClaudeValidityProbeResult> {
  const { account: current } = await accountProbeSnapshot(() => currentClaudeAccount(account), { holder: "Claude refresh admission", caller: "spawn health" });
  // The existing OAuth refresh fence compares the credential read before its
  // network request with the current credential at replacement time.
  const refreshed = await refreshClaudeOauth(current);
  if (refreshed === "invalid") {
    return classifySpawnAccountAdmission({ enabled: true, authentication: "failed", limits: "unknown", stale: false, retryAt: null });
  }
  if (refreshed === "unknown") throw new ClaudeCredentialUnavailableError();
  return await fencedLiveValidityProbe(current);
}

const productionDependencies: ClaudeSpawnHealthDependencies = {
  now: Date.now,
  probe: fencedLiveValidityProbe,
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
  model?: string | null,
): Promise<ClaudeSpawnAccountSelection> {
  const now = dependencies.now();
  const forModel = (result: ClaudeValidityProbeResult): SpawnAccountAdmission => result.limitRead
    ? claudeValidityFromLimitRead(result.limitRead, now, model)
    : result;
  const classified = accounts.map((account) => {
    if (account.provider) return { account, oauth: null, unknown: false, provider: true };
    const metadata = claudeOauthMetadata(account);
    const unknown = metadata === "unknown";
    if (unknown && pinPreferred && account.id === preferredId) throw new ClaudeCredentialUnavailableError();
    return { account, oauth: unknown ? null : metadata, unknown, provider: false };
  });
  type Evaluated = { account: ClaudeAccount; admission: SpawnAccountAdmission };
  const unknownAccounts = new Set(classified.filter((candidate) => candidate.unknown).map((candidate) => candidate.account.id));
  const evaluate = async (
    account: ClaudeAccount,
    probe: ClaudeSpawnHealthDependencies["probe"],
  ): Promise<Evaluated | null> => {
    try {
      return { account, admission: forModel(await probe(account)) };
    } catch (error) {
      // Credential uncertainty excludes only this candidate. An explicit pin
      // must still refuse substitution; identity and other errors retain their fences.
      if (!(error instanceof ClaudeCredentialUnavailableError)
        || (pinPreferred && account.id === preferredId)) throw error;
      unknownAccounts.add(account.id);
      return null;
    }
  };
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

  const providers = classified.filter((candidate) => candidate.provider);
  const providerCurrent: Evaluated[] = providers.length ? await Promise.all(providers.map(async ({ account }) => {
    const token = readClaudeProviderToken(account.home);
    let authentication: "authenticated" | "failed" = token ? "authenticated" : "failed";
    if (token && account.provider) {
      try { await listClaudeProviderModels(account.provider, token); }
      catch (error) { if (error instanceof Error && error.message === "Provider authentication failed") authentication = "failed"; }
    }
    return { account, admission: classifySpawnAccountAdmission({ enabled: true, authentication, limits: "unknown", stale: false, retryAt: null }, now) };
  })) : [];
  const current = [...providerCurrent, ...(await Promise.all(classified
    .filter((candidate) => candidate.oauth && candidate.oauth.expiresAt > now)
    .map(({ account }) => evaluate(account, dependencies.probe))))
    .filter((candidate) => candidate !== null)];
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
      admission: forModel(await refreshSingleFlight(preferredExpired.account, dependencies.refresh)),
    };
    if (requested.admission.kind === "admissible") return result(requested, requested);
  }

  const currentSelection = select(current);
  if (currentSelection) return result(currentSelection, requested);

  const refreshed = (await Promise.all(classified
    .filter((candidate) => candidate.oauth?.expiresAt && candidate.oauth.expiresAt <= now && candidate.oauth.refreshable)
    .filter((candidate) => candidate.account.id !== preferredExpired?.account.id)
    .map(({ account }) => evaluate(account, (candidate) => refreshSingleFlight(candidate, dependencies.refresh)))))
    .filter((candidate) => candidate !== null);
  const all = [...current, ...(requested ? [requested] : []), ...refreshed];
  const refreshedSelection = select(all);
  if (refreshedSelection) return result(refreshedSelection, requested);
  if (unknownAccounts.size > 0) throw new ClaudeCredentialUnavailableError();
  throw new NoHealthyClaudeAccountError(accounts);
}
