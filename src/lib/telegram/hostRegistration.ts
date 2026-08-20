import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { legacyClaudeHome, listClaudeAccounts } from "@/lib/accounts/claude";

import { telegramMcpUrl } from "./packaging";

/**
 * Host registration of the shared connector as `telegram` (issue #1059).
 *
 * The #739 grant machinery selects from what the operator's host configuration
 * REGISTERS: Claude launches copy granted definitions out of `.claude.json`,
 * Codex threads enable names present in `config.toml`. So connecting Telegram
 * registers one streamable-HTTP definition under the exact name `telegram` in
 * both tables, and disconnecting removes it — which is what makes revocation
 * bite on the next dispatch: the enable tables are re-materialized per launch,
 * and a name with no registered definition grants nothing.
 *
 * Both writers are idempotent (re-registering an identical entry is a no-op)
 * and surgical: they touch only the `telegram` entry the Viewer manages. The
 * separately configured legacy transport (`telegram-readonly`) is a different
 * name and is never read or written here.
 */

const CLAUDE_ENTRY_NAME = "telegram";
const CODEX_BLOCK_BEGIN = "# >>> agent-log-viewer telegram >>>";
const CODEX_BLOCK_END = "# <<< agent-log-viewer telegram <<<";

export type TelegramRegistrationTargets = {
  claudeStatePaths: string[];
  codexConfigPaths: string[];
};

/** Claude: the legacy `~/.claude.json` plus each managed account home's own
    `.claude.json` (the exact files the spawn paths read definitions from).
    Codex: the legacy `~/.codex/config.toml` only — managed Codex homes symlink
    `config.toml` from the legacy home, so one real file covers them all. */
export function telegramRegistrationTargets(): TelegramRegistrationTargets {
  const claudeStatePaths = [path.join(path.dirname(legacyClaudeHome()), ".claude.json")];
  try {
    for (const account of listClaudeAccounts()) {
      if (account.kind === "managed") claudeStatePaths.push(path.join(account.home, ".claude.json"));
    }
  } catch { /* an unreadable account registry still registers the legacy path */ }
  const codexHome = path.resolve(process.env.LLV_CODEX_HOME || path.join(os.homedir(), ".codex"));
  return { claudeStatePaths: [...new Set(claudeStatePaths)], codexConfigPaths: [path.join(codexHome, "config.toml")] };
}

/** A symlinked target is somebody's overlay (managed Codex homes symlink
    config.toml); replacing it with a regular file would break the overlay, so
    such targets are skipped rather than rewritten. */
function safeToRewrite(pathname: string): boolean {
  try {
    const stat = fs.lstatSync(pathname);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function atomicWrite(pathname: string, contents: string, mode: number): void {
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  const tmp = path.join(path.dirname(pathname), `.${path.basename(pathname)}.${process.pid}.telegram.tmp`);
  try {
    fs.writeFileSync(tmp, contents, { mode });
    fs.renameSync(tmp, pathname);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function claudeState(pathname: string): Record<string, unknown> | null {
  if (!fs.existsSync(pathname)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(pathname, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** Upserts `mcpServers.telegram` in one Claude state file. Corrupt or
    symlinked files are left alone — registration must never destroy state. */
export function registerTelegramInClaudeState(pathname: string, url: string): boolean {
  if (!safeToRewrite(pathname)) return false;
  const state = claudeState(pathname);
  if (!state) return false;
  const servers = state.mcpServers && typeof state.mcpServers === "object" && !Array.isArray(state.mcpServers)
    ? { ...state.mcpServers as Record<string, unknown> }
    : {};
  const entry = { type: "http", url };
  const existing = servers[CLAUDE_ENTRY_NAME] as { type?: unknown; url?: unknown } | undefined;
  if (existing && existing.type === "http" && existing.url === url) return true;
  servers[CLAUDE_ENTRY_NAME] = entry;
  atomicWrite(pathname, JSON.stringify({ ...state, mcpServers: servers }, null, 2) + "\n", 0o600);
  return true;
}

/** Removes the Viewer-managed `telegram` entry. Only an `http` entry is ours
    to remove; an operator's hand-written stdio entry under the same name is
    not touched. */
export function removeTelegramFromClaudeState(pathname: string): boolean {
  if (!safeToRewrite(pathname) || !fs.existsSync(pathname)) return true;
  const state = claudeState(pathname);
  if (!state) return false;
  const servers = state.mcpServers && typeof state.mcpServers === "object" && !Array.isArray(state.mcpServers)
    ? { ...state.mcpServers as Record<string, unknown> }
    : {};
  const existing = servers[CLAUDE_ENTRY_NAME] as { type?: unknown } | undefined;
  if (!existing || existing.type !== "http") return true;
  delete servers[CLAUDE_ENTRY_NAME];
  atomicWrite(pathname, JSON.stringify({ ...state, mcpServers: servers }, null, 2) + "\n", 0o600);
  return true;
}

function codexManagedBlock(url: string): string {
  return `${CODEX_BLOCK_BEGIN}\n[mcp_servers.telegram]\nurl = "${url}"\n${CODEX_BLOCK_END}\n`;
}

function withoutCodexManagedBlock(contents: string): string {
  const begin = contents.indexOf(CODEX_BLOCK_BEGIN);
  if (begin === -1) return contents;
  const end = contents.indexOf(CODEX_BLOCK_END, begin);
  if (end === -1) return contents;
  const after = end + CODEX_BLOCK_END.length;
  /* Registration separates the block with one blank line; removal collapses
     exactly that back, so register → remove restores the original bytes. */
  const prefix = contents.slice(0, begin).replace(/\n+$/, "\n");
  const tail = contents.slice(after).replace(/^\n+/, "");
  if (prefix === "" || prefix === "\n") return tail || "\n";
  return prefix + tail;
}

/** Upserts a marker-delimited `[mcp_servers.telegram]` block in config.toml.
    Markers keep the edit reversible and byte-surgical without a TOML rewriter;
    everything outside the block is preserved verbatim. An operator-authored
    `[mcp_servers.telegram]` table outside the markers wins — the writer backs
    off rather than fight the operator's own configuration. */
export function registerTelegramInCodexConfig(pathname: string, url: string): boolean {
  if (!safeToRewrite(pathname)) return false;
  const contents = fs.existsSync(pathname) ? fs.readFileSync(pathname, "utf8") : "";
  const stripped = withoutCodexManagedBlock(contents);
  if (/^\s*\[mcp_servers\.telegram(\.|])/m.test(stripped)) return true;
  const block = codexManagedBlock(url);
  if (contents.includes(block)) return true;
  const base = stripped === "" ? "" : stripped.replace(/\n*$/, "\n\n");
  atomicWrite(pathname, base + block, 0o600);
  return true;
}

export function removeTelegramFromCodexConfig(pathname: string): boolean {
  if (!safeToRewrite(pathname) || !fs.existsSync(pathname)) return true;
  const contents = fs.readFileSync(pathname, "utf8");
  const stripped = withoutCodexManagedBlock(contents);
  if (stripped === contents) return true;
  atomicWrite(pathname, stripped, 0o600);
  return true;
}

export function registerTelegramHosts(targets: TelegramRegistrationTargets = telegramRegistrationTargets(), url: string = telegramMcpUrl()): void {
  for (const pathname of targets.claudeStatePaths) registerTelegramInClaudeState(pathname, url);
  for (const pathname of targets.codexConfigPaths) registerTelegramInCodexConfig(pathname, url);
}

export function unregisterTelegramHosts(targets: TelegramRegistrationTargets = telegramRegistrationTargets()): void {
  for (const pathname of targets.claudeStatePaths) removeTelegramFromClaudeState(pathname);
  for (const pathname of targets.codexConfigPaths) removeTelegramFromCodexConfig(pathname);
}
