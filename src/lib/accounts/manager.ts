import { accountForSpawn, activeCodexAccountId, codexAccountsMutationLocked, codexHomeOwningSessionPath, CorruptCodexAccountsError, createManagedCodexAccount, listCodexAccounts, setActiveCodexAccount, UnknownAccountError, type CodexAccount } from "./codex";
import { activeClaudeAccountId, claudeAccountForSpawn, claudeAccountsMutationLocked, claudeHomeOwningTranscript, claudeManagedEnvironment, CorruptClaudeAccountsError, createManagedClaudeAccount, listClaudeAccounts, setActiveClaudeAccount, UnknownClaudeAccountError } from "./claude";
import { claudeLoginSupervisor, LIVE_CLAUDE_LOGIN_PHASES } from "./claudeLogin";
import { managedCodexRuntime } from "./codexRuntime";
import type { AccountContext, AccountManager, AccountSummary, ProjectSpawnResolution } from "./contracts";
import { unavailableLimits } from "./contracts";
import { withAccountMutationLockAsync } from "./accountMutation";
import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { accountProjectBindings, projectAccountRefusalDetail } from "./projectBindings";
import { selectProjectAccount } from "./projectSelection";
import { selectHealthyClaudeAccount } from "./spawnHealth";
import { withoutWakatimeCredential } from "@/lib/wakatime/credential";
import { classifySpawnAccountAdmission, type SpawnAccountAdmission } from "@/lib/agent/accountLiveness";

function contextForSpawn(engine: "claude" | "codex", requested?: string | null) {
  if (engine === "claude") { const item = claudeAccountForSpawn(requested); return { engine, accountId: item.id, kind: item.kind, home: item.home, transcriptRoot: item.projectsDir, env: item.kind === "managed" ? claudeManagedEnvironment(item.home) : withoutWakatimeCredential(process.env) }; }
  const item = accountForSpawn(requested); return { engine, accountId: item.id, kind: item.kind, home: item.home, transcriptRoot: item.sessionsDir, env: { ...withoutWakatimeCredential(process.env), CODEX_HOME: item.home } };
}

/** Viewer-visible spawn admission performs a fresh Claude OAuth health pass. */
export type HealthySpawnAccountResolution = AccountContext & {
  admission?: SpawnAccountAdmission;
  requestedAdmission?: SpawnAccountAdmission;
};

export async function resolveHealthySpawnAccount(
  engine: "claude" | "codex",
  requested?: string | null,
  /* #1279: the project's allowed set, or null for a project with no binding —
     which is every project until someone configures one, and takes the
     identical path this function always took. A bound project's health pass
     runs over its allowed accounts only, so the fallback a failing probe picks
     is drawn from the same set the pin would have been checked against. */
  allowedAccountIds: readonly string[] | null = null,
): Promise<HealthySpawnAccountResolution> {
  if (allowedAccountIds !== null && allowedAccountIds.length === 0) {
    throw new Error(`project allows no ${engine} account`);
  }
  const allowed = allowedAccountIds === null ? null : new Set(allowedAccountIds);
  const routing = agentRegistry().engineRouting(engine).activeAccountId ?? undefined;
  const active = allowed === null || (routing !== undefined && allowed.has(routing))
    ? routing
    : allowedAccountIds![0];
  const routed = requested ?? active;
  const missingRequested = classifySpawnAccountAdmission({
    enabled: false,
    authentication: "unknown",
    limits: "unknown",
    stale: false,
    retryAt: null,
  });
  if (engine === "codex") {
    try {
      return contextForSpawn(engine, routed);
    } catch (error) {
      if (requested === undefined || requested === null || !(error instanceof UnknownAccountError)) throw error;
      return { ...contextForSpawn(engine, active), requestedAdmission: missingRequested };
    }
  }
  const accounts = listClaudeAccounts().filter((account) => allowed === null || allowed.has(account.id));
  const requestedExists = requested === undefined
    || requested === null
    || accounts.some((account) => account.id === requested);
  const selected = await selectHealthyClaudeAccount(
    accounts,
    requestedExists ? routed : active,
    undefined,
    requested !== undefined && requested !== null && requestedExists,
    active,
  );
  return {
    ...contextForSpawn(engine, selected.account.id),
    admission: selected.admission,
    ...(requested !== undefined && requested !== null && !requestedExists
      ? { requestedAdmission: missingRequested }
      : selected.requestedAdmission ? { requestedAdmission: selected.requestedAdmission } : {}),
  };
}

/**
 * A launch the project's binding refused (#1279), carrying the resolution that
 * refused it so a caller can answer with the right status instead of reading a
 * message. Thrown only by {@link resolveProjectSpawnAccount}, which is the form
 * every launch path that names NO account of its own resolves through.
 */
export class ProjectAccountRefusedError extends Error {
  constructor(
    readonly resolution: Exclude<ProjectSpawnResolution, { kind: "available" }>,
    engine: "claude" | "codex",
    project: string | null,
  ) {
    super(projectAccountRefusalDetail(resolution, engine, project ?? ""));
    this.name = "ProjectAccountRefusedError";
  }
}

/**
 * The account for a launch the SYSTEM is choosing — the caller passes the
 * project the work belongs to and, at most, the account an earlier attempt of
 * the same work already ran on.
 *
 * `resolveSpawn` answers with the engine's active account when nothing is
 * named, which is a choice made without consulting anything; this is the same
 * call with the project's pool in front of it. An unbound project keeps that
 * exact behaviour — `selectProjectAccount` answers with the preferred account
 * and `contextForSpawn` resolves it, byte for byte what the caller did before.
 * A bound project draws from its allowed set only, reports when every allowed
 * account is out of capacity, and refuses when the binding record cannot be
 * read (that read throws from here, and a caller that cannot see the boundary
 * does not get to decide there is none).
 *
 * `preferredAccountId` is a PREFERENCE and never a pin, because no caller of
 * this function names an account: it carries continuity ("this work already
 * ran on that account"), and continuity onto an account the project no longer
 * allows is a preference the pool overrides, not a launch to refuse. The pool
 * is still the fence — the pick simply comes from inside it.
 */
export function resolveProjectSpawnAccount(
  engine: "claude" | "codex",
  project: string | null,
  preferredAccountId?: string | null,
): AccountContext {
  const resolution = accountManager.resolveProjectSpawn(engine, { project, preferredId: preferredAccountId ?? null });
  if (resolution.kind !== "available") throw new ProjectAccountRefusedError(resolution, engine, project);
  return resolution.account;
}

function summary(engine: "claude" | "codex", id: string): AccountSummary {
  const account = (engine === "claude" ? listClaudeAccounts() : listCodexAccounts()).find((item) => item.id === id);
  if (!account) throw new Error(`unknown ${engine} account: ${id}`);
  return { id: account.id, label: account.label, kind: account.kind, active: (engine === "claude" ? activeClaudeAccountId() : activeCodexAccountId()) === id, auth: { state: account.authPresent ? "authenticated" : "signed_out", method: null, email: null, plan: null, checkedAt: null }, limits: unavailableLimits(), login: null };
}

export class AccountAuthenticationRequiredError extends Error {
  constructor(readonly engine: "claude" | "codex", readonly accountId: string) {
    super(`${engine} account requires authentication`);
    this.name = "AccountAuthenticationRequiredError";
  }
}

export class AccountLoginPendingError extends Error {
  constructor(readonly engine: "claude" | "codex", readonly accountId: string) {
    super(`${engine} account login is in progress`);
    this.name = "AccountLoginPendingError";
  }
}

type RoutingStore = Pick<AgentRegistry, "engineRouting" | "setEngineRouting">;

/** Keeps the compatibility catalog and launch-routing registry aligned. */
function selectAccountLocked(engine: "claude" | "codex", id: string, routing: RoutingStore): AccountSummary {
  if (engine === "claude" ? claudeAccountsMutationLocked() : codexAccountsMutationLocked()) {
    if (engine === "claude") throw new CorruptClaudeAccountsError();
    throw new CorruptCodexAccountsError();
  }
  const accounts = engine === "claude" ? listClaudeAccounts() : listCodexAccounts();
  const account = accounts.find((candidate) => candidate.id === id);
  if (!account) {
    if (engine === "claude") throw new UnknownClaudeAccountError(id);
    throw new UnknownAccountError(id);
  }
  const loginPending = engine === "claude"
    ? (() => {
        const login = claudeLoginSupervisor.forAccount(id);
        return login !== null && LIVE_CLAUDE_LOGIN_PHASES.has(login.phase);
      })()
    : (() => {
        const codexAccount = account as CodexAccount;
        return codexAccount.loginPane !== null || managedCodexRuntime().peekLogin(codexAccount).attemptState === "pending";
      })();
  if (loginPending) throw new AccountLoginPendingError(engine, id);
  if (!account.authPresent) throw new AccountAuthenticationRequiredError(engine, id);

  const previousCatalogId = engine === "claude" ? activeClaudeAccountId() : activeCodexAccountId();
  const previousRoutingId = routing.engineRouting(engine).activeAccountId;
  if (engine === "claude") setActiveClaudeAccount(id); else setActiveCodexAccount(id);
  try {
    routing.setEngineRouting(engine, id);
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    try {
      const currentRoutingId = routing.engineRouting(engine).activeAccountId;
      if (currentRoutingId !== previousRoutingId) routing.setEngineRouting(engine, previousRoutingId ?? previousCatalogId);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    try {
      if (engine === "claude") setActiveClaudeAccount(previousCatalogId); else setActiveCodexAccount(previousCatalogId);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length > 0) throw new AggregateError([error, ...rollbackErrors], "account selection rollback failed");
    throw error;
  }
  return summary(engine, id);
}

export async function selectAccount(engine: "claude" | "codex", id: string, routing: RoutingStore = agentRegistry()): Promise<AccountSummary> {
  return await withAccountMutationLockAsync(async () => selectAccountLocked(engine, id, routing));
}

/** Narrow boundary used by all launch paths. Filesystem account details remain behind it. */
export const accountManager: AccountManager = {
  async list() { return { claude: { active: activeClaudeAccountId(), accounts: listClaudeAccounts().map((item) => summary("claude", item.id)) }, codex: { active: activeCodexAccountId(), accounts: listCodexAccounts().map((item) => summary("codex", item.id)) } }; },
  async add(engine, label) {
    return await withAccountMutationLockAsync(async () => {
      const item = engine === "claude" ? createManagedClaudeAccount(label) : createManagedCodexAccount(label);
      return summary(engine, item.id);
    });
  },
  async select(engine, id) { return selectAccount(engine, id); },
  async status(engine, id) { return summary(engine, id); },
  async submitLoginInput() { throw new Error("login input is Claude-operation specific"); },
  async cancelLogin() { throw new Error("login cancellation is Claude-operation specific"); },
  resolveSpawn(engine, requested) { return contextForSpawn(engine, requested ?? agentRegistry().engineRouting(engine).activeAccountId ?? undefined); },
  resolveHeadlessSpawn(engine, requested, excludedIds, project) {
    const selected = selectProjectAccount({
      project,
      engine,
      accounts: engine === "claude" ? listClaudeAccounts() : listCodexAccounts(),
      observations: agentRegistry().quotaObservations(engine),
      bindings: accountProjectBindings(),
      /* Headless selection has no pin: `requested` has always been a
         preference here, and it stays one — the fence is the candidate set. */
      preferredId: requested ?? agentRegistry().engineRouting(engine).activeAccountId,
      excludedIds,
      /* This path has always been the rate-limit-aware one, bound project or
         not, and stays so — the binding only narrows what it may pick from. */
      unbound: "capacity",
    });
    if (selected.kind === "available") {
      return { kind: "available", account: contextForSpawn(engine, selected.accountId ?? undefined) };
    }
    return selected.kind === "exhausted"
      ? { kind: "exhausted", resetsAt: selected.resetsAt }
      : { kind: "unavailable" };
  },
  /* #1279: one seam for every project-owned launch. An unbound project takes
     the branch that has always existed — the active account, resolved and
     used, with no capacity arithmetic anywhere near it. A bound project is the
     only case that changes: its candidates are the allowed set and nothing
     else, and when all of them are out of capacity that is reported, never
     resolved by widening the set. */
  resolveProjectSpawn(engine, request) {
    const selected = selectProjectAccount({
      project: request.project,
      engine,
      accounts: engine === "claude" ? listClaudeAccounts() : listCodexAccounts(),
      observations: agentRegistry().quotaObservations(engine),
      bindings: accountProjectBindings(),
      requestedId: request.requestedId,
      /* The caller's continuity hint outranks the engine's routing as an
         ORDERING, and neither one widens the candidate set. */
      preferredId: request.preferredId ?? agentRegistry().engineRouting(engine).activeAccountId,
      excludedIds: request.excludedIds ?? [],
    });
    if (selected.kind !== "available") return selected;
    return { kind: "available", account: contextForSpawn(engine, selected.accountId ?? undefined) };
  },
  resolveTranscriptOwner(engine, transcript) {
    /* Registry first (issue #891, phase 0): the durable generation record
       names the owning account directly. Path-layout derivation below stays
       as recovery for artifacts the registry never saw — it collapses once
       transcript roots stop being account-scoped. */
    const recorded = agentRegistry().transcriptAccountId(engine, transcript);
    if (recorded) {
      if (engine === "claude") {
        const item = listClaudeAccounts().find((candidate) => candidate.id === recorded);
        if (item) return { engine, accountId: item.id, kind: item.kind, home: item.home, transcriptRoot: item.projectsDir, env: item.kind === "managed" ? claudeManagedEnvironment(item.home) : withoutWakatimeCredential(process.env) };
      } else {
        const item = listCodexAccounts().find((candidate) => candidate.id === recorded);
        if (item) return { engine, accountId: item.id, kind: item.kind, home: item.home, transcriptRoot: item.sessionsDir, env: { ...withoutWakatimeCredential(process.env), CODEX_HOME: item.home } };
      }
    }
    if (engine === "claude") { const home = claudeHomeOwningTranscript(transcript); if (!home) return null; const item = listClaudeAccounts().find((candidate) => candidate.home === home); return item ? { engine, accountId: item.id, kind: item.kind, home, transcriptRoot: item.projectsDir, env: item.kind === "managed" ? claudeManagedEnvironment(home) : withoutWakatimeCredential(process.env) } : null; }
    const home = codexHomeOwningSessionPath(transcript); if (!home) return null; const item = listCodexAccounts().find((candidate) => candidate.home === home); return item ? { engine, accountId: item.id, kind: item.kind, home, transcriptRoot: item.sessionsDir, env: { ...withoutWakatimeCredential(process.env), CODEX_HOME: home } } : null;
  },
};
