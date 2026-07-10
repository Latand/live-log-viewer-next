import { accountForSpawn, activeCodexAccountId, codexHomeOwningSessionPath, createManagedCodexAccount, listCodexAccounts, setActiveCodexAccount } from "./codex";
import { activeClaudeAccountId, claudeAccountForSpawn, claudeHomeOwningTranscript, claudeManagedEnvironment, createManagedClaudeAccount, listClaudeAccounts, setActiveClaudeAccount } from "./claude";
import type { AccountManager, AccountSummary } from "./contracts";
import { unavailableLimits } from "./contracts";

function summary(engine: "claude" | "codex", id: string): AccountSummary {
  const account = (engine === "claude" ? listClaudeAccounts() : listCodexAccounts()).find((item) => item.id === id);
  if (!account) throw new Error(`unknown ${engine} account: ${id}`);
  return { id: account.id, label: account.label, kind: account.kind, active: (engine === "claude" ? activeClaudeAccountId() : activeCodexAccountId()) === id, auth: { state: account.authPresent ? "authenticated" : "signed_out", method: null, email: null, plan: null, checkedAt: null }, limits: unavailableLimits(), login: null };
}

/** Narrow boundary used by all launch paths. Filesystem account details remain behind it. */
export const accountManager: AccountManager = {
  async list() { return { claude: { active: activeClaudeAccountId(), accounts: listClaudeAccounts().map((item) => summary("claude", item.id)) }, codex: { active: activeCodexAccountId(), accounts: listCodexAccounts().map((item) => summary("codex", item.id)) } }; },
  async add(engine, label) { const item = engine === "claude" ? createManagedClaudeAccount(label) : createManagedCodexAccount(label); return summary(engine, item.id); },
  async select(engine, id) { if (engine === "claude") setActiveClaudeAccount(id); else setActiveCodexAccount(id); return summary(engine, id); },
  async status(engine, id) { return summary(engine, id); },
  async submitLoginInput() { throw new Error("login input is Claude-operation specific"); },
  async cancelLogin() { throw new Error("login cancellation is Claude-operation specific"); },
  resolveSpawn(engine, requested) {
    if (engine === "claude") { const item = claudeAccountForSpawn(requested); return { engine, accountId: item.id, kind: item.kind, home: item.home, transcriptRoot: item.projectsDir, env: item.kind === "managed" ? claudeManagedEnvironment(item.home) : process.env }; }
    const item = accountForSpawn(requested); return { engine, accountId: item.id, kind: item.kind, home: item.home, transcriptRoot: item.sessionsDir, env: { ...process.env, CODEX_HOME: item.home } };
  },
  resolveTranscriptOwner(engine, transcript) {
    if (engine === "claude") { const home = claudeHomeOwningTranscript(transcript); if (!home) return null; const item = listClaudeAccounts().find((candidate) => candidate.home === home); return item ? { engine, accountId: item.id, kind: item.kind, home, transcriptRoot: item.projectsDir, env: item.kind === "managed" ? claudeManagedEnvironment(home) : process.env } : null; }
    const home = codexHomeOwningSessionPath(transcript); if (!home) return null; const item = listCodexAccounts().find((candidate) => candidate.home === home); return item ? { engine, accountId: item.id, kind: item.kind, home, transcriptRoot: item.sessionsDir, env: { ...process.env, CODEX_HOME: home } } : null;
  },
};
