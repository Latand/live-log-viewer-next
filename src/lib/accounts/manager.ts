import path from "node:path";

import { grokAuthStatus, grokHome } from "./grok";
import { accountForSpawn, activeCodexAccountId, codexAccountsMutationLocked, codexHomeOwningSessionPath, CorruptCodexAccountsError, createManagedCodexAccount, listCodexAccounts, setActiveCodexAccount, UnknownAccountError, type CodexAccount } from "./codex";
import { activeClaudeAccountId, claudeAccountForSpawn, claudeAccountsMutationLocked, claudeHomeOwningTranscript, claudeManagedEnvironment, CorruptClaudeAccountsError, createManagedClaudeAccount, listClaudeAccounts, setActiveClaudeAccount, UnknownClaudeAccountError } from "./claude";
import { claudeLoginSupervisor, LIVE_CLAUDE_LOGIN_PHASES } from "./claudeLogin";
import { managedCodexRuntime } from "./codexRuntime";
import type { AccountContext, AccountManager, AccountSummary } from "./contracts";
import { unavailableLimits } from "./contracts";
import { withAccountMutationLockAsync } from "./accountMutation";
import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { selectHeadlessAccount } from "./headlessSelection";
import { selectHealthyClaudeAccount } from "./spawnHealth";
import { withoutWakatimeCredential } from "@/lib/wakatime/credential";
import { classifySpawnAccountAdmission, type SpawnAccountAdmission } from "@/lib/agent/accountLiveness";

function grokSpawnContext(): AccountContext {
  const home = grokHome();
  return {
    engine: "grok",
    accountId: "grok",
    kind: "legacy",
    home,
    transcriptRoot: path.join(home, "sessions"),
    env: withoutWakatimeCredential(process.env),
  };
}

function contextForSpawn(engine: "claude" | "codex" | "grok", requested?: string | null) {
  if (engine === "grok") return grokSpawnContext();
  if (engine === "claude") { const item = claudeAccountForSpawn(requested); return { engine, accountId: item.id, kind: item.kind, home: item.home, transcriptRoot: item.projectsDir, env: item.kind === "managed" ? claudeManagedEnvironment(item.home) : withoutWakatimeCredential(process.env) }; }
  const item = accountForSpawn(requested); return { engine, accountId: item.id, kind: item.kind, home: item.home, transcriptRoot: item.sessionsDir, env: { ...withoutWakatimeCredential(process.env), CODEX_HOME: item.home } };
}

/** Viewer-visible spawn admission performs a fresh Claude OAuth health pass. */
export type HealthySpawnAccountResolution = AccountContext & {
  admission?: SpawnAccountAdmission;
  requestedAdmission?: SpawnAccountAdmission;
};

export async function resolveHealthySpawnAccount(
  engine: "claude" | "codex" | "grok",
  requested?: string | null,
): Promise<HealthySpawnAccountResolution> {
  if (engine === "grok") {
    if (!grokAuthStatus().signedIn) throw new AccountAuthenticationRequiredError("grok", "grok");
    return grokSpawnContext();
  }
  const active = agentRegistry().engineRouting(engine).activeAccountId ?? undefined;
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
  const accounts = listClaudeAccounts();
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

function summary(engine: "claude" | "codex", id: string): AccountSummary {
  const account = (engine === "claude" ? listClaudeAccounts() : listCodexAccounts()).find((item) => item.id === id);
  if (!account) throw new Error(`unknown ${engine} account: ${id}`);
  return { id: account.id, label: account.label, kind: account.kind, active: (engine === "claude" ? activeClaudeAccountId() : activeCodexAccountId()) === id, auth: { state: account.authPresent ? "authenticated" : "signed_out", method: null, email: null, plan: null, checkedAt: null }, limits: unavailableLimits(), login: null };
}

export class AccountAuthenticationRequiredError extends Error {
  constructor(readonly engine: "claude" | "codex" | "grok", readonly accountId: string) {
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
  resolveHeadlessSpawn(engine, requested, excludedIds = []) {
    const accounts = engine === "claude" ? listClaudeAccounts() : listCodexAccounts();
    const selected = selectHeadlessAccount(accounts, agentRegistry().quotaObservations(engine), requested ?? agentRegistry().engineRouting(engine).activeAccountId, excludedIds);
    return selected.kind === "available"
      ? { kind: "available", account: contextForSpawn(engine, selected.accountId) }
      : selected;
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
