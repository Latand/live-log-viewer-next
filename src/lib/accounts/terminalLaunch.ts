import { claudeEnvPrefix } from "@/lib/agent/cli";

import { listClaudeAccounts } from "./claude";
import { listCodexAccounts } from "./codex";

export class TerminalAccountUnavailableError extends Error {
  constructor(readonly status: 404 | 409, message: string) {
    super(message);
    this.name = "TerminalAccountUnavailableError";
  }
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Interactive boot command for an operator terminal on one account. Legacy
 * accounts run the CLI against its default home; managed homes get the same
 * env prefix agent spawns use (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`), so the
 * session is authenticated as that account and nothing else.
 */
export function accountTerminalCommand(engine: "claude" | "codex", account: { kind: "legacy" | "managed"; home: string }): string {
  if (engine === "claude") {
    return account.kind === "managed" ? `${claudeEnvPrefix(account.home)} claude` : "claude";
  }
  const store = account.kind === "managed" ? " -c cli_auth_credentials_store=file" : "";
  return `env -u LLV_TOKEN CODEX_HOME=${shellQuote(account.home)} codex${store}`;
}

/**
 * The Accounts panel's per-account quick action: the ready-to-paste command
 * that boots an interactive agent CLI bound to that account. tmux runs on the
 * operator's machine, so the viewer only composes the command — the panel
 * copies it and the operator pastes it into their own terminal or tmux window.
 */
export function resolveAccountTerminalCommand(engine: "claude" | "codex", accountId: string): { command: string } {
  const accounts = engine === "claude" ? listClaudeAccounts() : listCodexAccounts();
  const account = accounts.find((candidate) => candidate.id === accountId);
  if (!account) throw new TerminalAccountUnavailableError(404, `unknown ${engine} account: ${accountId}`);
  if (!account.authPresent) throw new TerminalAccountUnavailableError(409, `${engine} account requires authentication`);
  return { command: accountTerminalCommand(engine, account) };
}
