import { accountForSpawn, activeCodexAccountId, codexAccountsMutationLocked, codexHomeOwningSessionPath, CorruptCodexAccountsError, createManagedCodexAccount, listCodexAccounts, setActiveCodexAccount, UnknownAccountError, type CodexAccount } from "./codex";
import { activeClaudeAccountId, claudeAccountForSpawn, claudeAccountsMutationLocked, claudeHomeOwningTranscript, claudeManagedEnvironment, CorruptClaudeAccountsError, createManagedClaudeAccount, listClaudeAccounts, setActiveClaudeAccount, UnknownClaudeAccountError } from "./claude";
import { claudeLoginSupervisor, LIVE_CLAUDE_LOGIN_PHASES } from "./claudeLogin";
import { managedCodexRuntime } from "./codexRuntime";
import type { AccountContext, AccountManager, AccountSummary, ProjectSpawnResolution } from "./contracts";
import { unavailableLimits } from "./contracts";
import { withAccountMutationLockAsync } from "./accountMutation";
import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { accountProjectBindings, allowedAccountIdsForProject, projectAccountRefusalDetail } from "./projectBindings";
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

/**
 * The direct-launch seam: `/api/spawn` and everything that reaches it — the
 * board's spawn button, the orchestrator seat, the scheduled report launcher.
 *
 * It used to hold its own copy of the rule: the caller read the project's pool,
 * handed it here as a list, and the account this function picked when nobody
 * named one was the engine's routing account, or `allowedAccountIds[0]` when
 * routing sat outside the pool. That first id was chosen for being FIRST — the
 * pool was consulted and quota never was, so a launch could land on an allowed
 * account with a fresh, confirmed, zero-capacity sample while an allowed
 * account with room stood next to it in the same list.
 *
 * So the automatic pick is now the one every other automatic launch makes, from
 * `selectProjectAccount`, which answers both halves of the question at once —
 * the project's pool AND capacity — and the engine health probing stays here,
 * behind it, narrowing what the shared rule already allowed. The caller passes
 * the PROJECT and nothing else: the pool is read once, in one place, and a
 * damaged record throws from that read rather than being re-derived by whoever
 * called in.
 *
 * An account the caller NAMES is still checked against the pool alone and never
 * against capacity — nobody may quietly substitute an account somebody asked
 * for, and a pin is a decision, not a guess to improve on.
 */
export async function resolveHealthySpawnAccount(
  engine: "claude" | "codex",
  requested?: string | null,
  /* The project the work belongs to; `null` is a project a caller genuinely
     cannot name, and resolves exactly as an unbound one always did. */
  project: string | null = null,
): Promise<HealthySpawnAccountResolution> {
  const bindings = accountProjectBindings();
  const allowedAccountIds = allowedAccountIdsForProject(project, engine, bindings);
  const allowed = allowedAccountIds === null ? null : new Set(allowedAccountIds);
  const registry = agentRegistry();
  const routing = registry.engineRouting(engine).activeAccountId ?? undefined;
  const named = requested === undefined || requested === null ? null : requested;
  const selectionInput = {
    project,
    engine,
    accounts: engine === "claude" ? listClaudeAccounts() : listCodexAccounts(),
    observations: registry.quotaObservations(engine),
    bindings,
    preferredId: routing ?? null,
    /* An unbound project keeps the engine's active account with no capacity
       arithmetic in front of it, which is what this seam has always done. */
    unbound: "engine-default" as const,
  };
  /* The pick nobody named: the pool, then capacity, in that order. Computed
     even when an account IS named, because it is also the fallback the branches
     below reach for, and a fallback that skipped the rule would be the same
     defect one level down. */
  const automatic = selectProjectAccount(selectionInput);
  if (named === null && automatic.kind !== "available") {
    throw new ProjectAccountRefusedError(automatic, engine, project);
  }
  if (named !== null) {
    const pinned = selectProjectAccount({ ...selectionInput, requestedId: named });
    if (pinned.kind !== "available") throw new ProjectAccountRefusedError(pinned, engine, project);
  }
  const active = automatic.kind === "available" ? automatic.accountId ?? undefined : undefined;
  const routed = named ?? active;
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
      if (named === null || !(error instanceof UnknownAccountError)) throw error;
      /* The named account does not exist, and the automatic rule produced no
         account to fall back to either — so there is nothing left to launch on
         that this project's binding permits, and the original failure stands
         rather than being answered with an account outside the pool. */
      if (automatic.kind !== "available") throw error;
      return { ...contextForSpawn(engine, active), requestedAdmission: missingRequested };
    }
  }
  const accounts = listClaudeAccounts().filter((account) => allowed === null || allowed.has(account.id));
  const requestedExists = named === null || accounts.some((account) => account.id === named);
  try {
    const selected = await selectHealthyClaudeAccount(
      accounts,
      requestedExists ? routed : active,
      undefined,
      named !== null && requestedExists,
      active,
    );
    return {
      ...contextForSpawn(engine, selected.account.id),
      admission: selected.admission,
      ...(named !== null && !requestedExists
        ? { requestedAdmission: missingRequested }
        : selected.requestedAdmission ? { requestedAdmission: selected.requestedAdmission } : {}),
    };
  } catch (error) {
    /* A bound project whose pool produced no launchable account. Nothing was
       named, so there is no pin to degrade and nothing outside the pool to
       reach for — what is left is to REPORT, in the one wording every other
       seam uses, with the health pass's own reason after it so the operator
       learns which account to repair. An UNBOUND project keeps the failure it
       always had: nobody drew a boundary, so the failure is about the machine's
       accounts and is answered as such. */
    if (named !== null || allowedAccountIds === null) throw error;
    throw new ProjectAccountRefusedError(
      { kind: "unavailable", allowedAccountIds },
      engine,
      project,
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * A launch the project's binding refused (#1279), carrying the resolution that
 * refused it so a caller can answer with the right status instead of reading a
 * message. Thrown by the two forms a launch resolves an account through —
 * {@link resolveProjectSpawnAccount} for a project-owned launch and
 * {@link resolveHealthySpawnAccount} for a direct one — so both answer a
 * boundary with the same type and the same wording.
 */
export class ProjectAccountRefusedError extends Error {
  constructor(
    readonly resolution: Exclude<ProjectSpawnResolution, { kind: "available" }>,
    engine: "claude" | "codex",
    project: string | null,
    /** What the seam behind the rule said, when the rule reported a pool the
        selection survived and something further in refused it anyway. Kept in
        the message so the operator learns which account to repair. */
    detail?: string,
  ) {
    const refusal = projectAccountRefusalDetail(resolution, engine, project ?? "");
    super(detail ? `${refusal}: ${detail}` : refusal);
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

/**
 * The account a RESUME of existing work runs on — the last seam where an
 * account could still be chosen without anybody being asked (#1279).
 *
 * The two halves are deliberately not the same question:
 *
 * - **The work records an account.** That is CONTINUITY, not a selection.
 *   The session already lives in that account's home, so resuming anywhere
 *   else resumes nothing; the pool does not get to re-seat it and capacity
 *   does not get to veto it. Byte for byte `resolveSpawn` with an id.
 * - **The work records none.** Nobody named an account, so this call is
 *   picking one — and `resolveSpawn(engine, null)` picked the engine's
 *   routing account, reading neither the project's pool nor any quota. That
 *   is the automatic rule's own case, so it goes where every other automatic
 *   pick goes: the pool first, capacity second, an exhausted pool reported
 *   and an unreadable record refused before anything is started. An UNBOUND
 *   project resolves to the engine's active account exactly as it always did.
 */
export function resolveContinuityAccount(
  engine: "claude" | "codex",
  accountId: string | null,
  /* Required, with no default: a caller that cannot name the project does not
     get to decide there is no pool. `null` is the project a caller genuinely
     has none of, and resolves exactly as an unbound one always did. */
  project: string | null,
): AccountContext {
  if (accountId !== null) return accountManager.resolveSpawn(engine, accountId);
  return resolveProjectSpawnAccount(engine, project);
}

/**
 * The same question one layer lower, for the resume-spec builder (#1279).
 *
 * `resumeSpecFor` needs an account ID rather than a resolved context, and the
 * id it is handed is PROVENANCE — the registry's record of where this
 * transcript ran — which can be absent (an adopted conversation the Viewer
 * never launched) or name an account that has since been deleted. Neither case
 * was a refusal: `claudeTranscriptOwnership` answered them from the SHARED
 * transcript store, where every cut-over home resolves to one root and the
 * path names no owner (#935), by falling back to the engine's ACTIVE account.
 * That fallback is a pick — it decides which credentials the resumed turn runs
 * under and whose quota it spends — and it read neither the project's pool nor
 * any quota to make it.
 *
 * So the two cases are separated here, exactly as in
 * {@link resolveContinuityAccount}:
 *
 * - **Provenance names an account the machine still has.** Continuity. The
 *   session lives in that home; the pool does not re-seat it and capacity does
 *   not veto it.
 * - **It names none, or names one that is gone.** Nobody chose, so this is the
 *   automatic rule's own case and it goes through the shared decision: the
 *   project's pool first, capacity second, an exhausted pool reported and an
 *   unreadable record refused before any spec is built.
 *
 * An UNBOUND project answers `null` — no preference is offered and the spec
 * builder's own fallback stands, byte for byte what it always did.
 */
export function resolveResumeAccountId(
  engine: "claude" | "codex",
  recordedAccountId: string | null | undefined,
  project: string | null,
): string | null {
  const accounts = engine === "claude" ? listClaudeAccounts() : listCodexAccounts();
  const recorded = recordedAccountId?.trim() || null;
  if (recorded !== null && accounts.some((account) => account.id === recorded)) return recorded;
  const bindings = accountProjectBindings();
  const allowed = allowedAccountIdsForProject(project, engine, bindings);
  const registry = agentRegistry();
  const selection = selectProjectAccount({
    project,
    engine,
    accounts,
    observations: registry.quotaObservations(engine),
    bindings,
    /* Offered only where it can order a candidate set. An unbound project has
       none, and handing its routing account back here would replace the spec
       builder's fallback with a different one on projects that opted into
       nothing. */
    preferredId: allowed === null ? null : registry.engineRouting(engine).activeAccountId,
    unbound: "engine-default",
  });
  if (selection.kind !== "available") throw new ProjectAccountRefusedError(selection, engine, project);
  return selection.accountId;
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
      unavailableIds: request.unavailableIds ?? [],
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
