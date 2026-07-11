import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { accountForSpawn, activeCodexAccountId, codexAccountsMutationLocked, codexHomeOwningSessionPath, CorruptCodexAccountsError, createManagedCodexAccount, listCodexAccounts, setActiveCodexAccount, UnknownAccountError } from "./codex";
import { activeClaudeAccountId, claudeAccountForSpawn, claudeAccountsMutationLocked, claudeHomeOwningTranscript, claudeManagedEnvironment, CorruptClaudeAccountsError, createManagedClaudeAccount, listClaudeAccounts, setActiveClaudeAccount, UnknownClaudeAccountError } from "./claude";
import { claudeLoginSupervisor } from "./claudeLogin";
import { managedCodexRuntime } from "./codexRuntime";
import type { AccountManager, AccountSummary } from "./contracts";
import { unavailableLimits } from "./contracts";
import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { procBackend } from "@/lib/proc";

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

const LIVE_CLAUDE_LOGIN_PHASES = new Set(["starting", "awaiting_browser", "awaiting_code", "verifying", "canceling"]);

type RoutingStore = Pick<AgentRegistry, "engineRouting" | "setEngineRouting">;

const ACCOUNT_SELECTION_LOCK_ATTEMPTS = 2_000;
const ACCOUNT_SELECTION_LOCK_WAIT_MS = 5;
const ACCOUNT_SELECTION_LOCK_STALE_MS = 30_000;

type AccountSelectionLockOwner = {
  pid: number;
  startIdentity: string | null;
  token: string;
};

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function accountSelectionLockOwnerIsStale(lock: string): boolean {
  try {
    const owner = JSON.parse(fs.readFileSync(lock, "utf8")) as Partial<AccountSelectionLockOwner>;
    if (typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0) {
      if (!procBackend.pidAlive(owner.pid)) return true;
      if (typeof owner.startIdentity !== "string") return false;
      const currentIdentity = procBackend.processIdentity(owner.pid);
      return currentIdentity !== null && currentIdentity !== owner.startIdentity;
    }
    return Date.now() - fs.statSync(lock).mtimeMs > ACCOUNT_SELECTION_LOCK_STALE_MS;
  } catch {
    try {
      return Date.now() - fs.statSync(lock).mtimeMs > ACCOUNT_SELECTION_LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
}

function removeAccountSelectionLockIfOwned(lock: string, token: string): void {
  try {
    const owner = JSON.parse(fs.readFileSync(lock, "utf8")) as { token?: unknown };
    if (owner.token === token) fs.rmSync(lock, { force: true });
  } catch { /* the lock was already recovered */ }
}

function withAccountSelectionLock<T>(operation: () => T): T {
  const lock = statePath("account-selection.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const owner: AccountSelectionLockOwner = {
    pid: process.pid,
    startIdentity: procBackend.processIdentity(process.pid),
    token: crypto.randomUUID(),
  };
  for (let attempt = 0; attempt < ACCOUNT_SELECTION_LOCK_ATTEMPTS; attempt += 1) {
    let descriptor: number;
    try {
      descriptor = fs.openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (accountSelectionLockOwnerIsStale(lock)) fs.rmSync(lock, { force: true });
      sleep(ACCOUNT_SELECTION_LOCK_WAIT_MS);
      continue;
    }
    try {
      fs.writeFileSync(descriptor, JSON.stringify(owner), "utf8");
      fs.fsyncSync(descriptor);
      return operation();
    } finally {
      fs.closeSync(descriptor);
      removeAccountSelectionLockIfOwned(lock, owner.token);
    }
  }
  throw new Error("account selection is busy; retry shortly");
}

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
        const codexAccount = listCodexAccounts().find((candidate) => candidate.id === id)!;
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

export function selectAccount(engine: "claude" | "codex", id: string, routing: RoutingStore = agentRegistry()): AccountSummary {
  return withAccountSelectionLock(() => selectAccountLocked(engine, id, routing));
}

/** Narrow boundary used by all launch paths. Filesystem account details remain behind it. */
export const accountManager: AccountManager = {
  async list() { return { claude: { active: activeClaudeAccountId(), accounts: listClaudeAccounts().map((item) => summary("claude", item.id)) }, codex: { active: activeCodexAccountId(), accounts: listCodexAccounts().map((item) => summary("codex", item.id)) } }; },
  async add(engine, label) { const item = engine === "claude" ? createManagedClaudeAccount(label) : createManagedCodexAccount(label); return summary(engine, item.id); },
  async select(engine, id) { return selectAccount(engine, id); },
  async status(engine, id) { return summary(engine, id); },
  async submitLoginInput() { throw new Error("login input is Claude-operation specific"); },
  async cancelLogin() { throw new Error("login cancellation is Claude-operation specific"); },
  resolveSpawn(engine, requested) {
    const routed = requested ?? agentRegistry().engineRouting(engine).activeAccountId ?? undefined;
    if (engine === "claude") { const item = claudeAccountForSpawn(routed); return { engine, accountId: item.id, kind: item.kind, home: item.home, transcriptRoot: item.projectsDir, env: item.kind === "managed" ? claudeManagedEnvironment(item.home) : process.env }; }
    const item = accountForSpawn(routed); return { engine, accountId: item.id, kind: item.kind, home: item.home, transcriptRoot: item.sessionsDir, env: { ...process.env, CODEX_HOME: item.home } };
  },
  resolveTranscriptOwner(engine, transcript) {
    if (engine === "claude") { const home = claudeHomeOwningTranscript(transcript); if (!home) return null; const item = listClaudeAccounts().find((candidate) => candidate.home === home); return item ? { engine, accountId: item.id, kind: item.kind, home, transcriptRoot: item.projectsDir, env: item.kind === "managed" ? claudeManagedEnvironment(home) : process.env } : null; }
    const home = codexHomeOwningSessionPath(transcript); if (!home) return null; const item = listCodexAccounts().find((candidate) => candidate.home === home); return item ? { engine, accountId: item.id, kind: item.kind, home, transcriptRoot: item.sessionsDir, env: { ...process.env, CODEX_HOME: home } } : null;
  },
};
