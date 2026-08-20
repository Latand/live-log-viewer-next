import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { legacyClaudeHome, listClaudeAccounts } from "@/lib/accounts/claude";
import { statePath } from "@/lib/configDir";

import { telegramMcpUrl } from "./packaging";
import { ensureTelegramStateDir } from "./sessionStore";

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
 *
 * OWNERSHIP. The Codex block carries its own markers, so ownership is in the
 * file. Claude JSON has no such place, so the Viewer records what it wrote
 * (path → url) in `<state>/telegram/registrations.json` and refuses to touch
 * anything else: a pre-existing `telegram` entry the Viewer did not write —
 * whatever its shape — is the operator's, registration backs off from it, and
 * removal deletes only an entry that still matches the Viewer's own record.
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

function isViewerEntry(entry: unknown, url: string | null): boolean {
  if (url === null || !entry || typeof entry !== "object") return false;
  const record = entry as { type?: unknown; url?: unknown };
  return record.type === "http" && record.url === url
    && Object.keys(record).length === 2;
}

export type ClaudeRegistrationResult = "registered" | "conflict" | "unwritable";

/** Upserts `mcpServers.telegram` in one Claude state file. Corrupt or
    symlinked files are left alone ("unwritable") — registration must never
    destroy state. A pre-existing entry that is NOT the Viewer's own — proven
    by `previousUrl`, the url this Viewer recorded for this exact file — is
    the operator's configuration and is refused ("conflict"), never
    overwritten, whatever its shape. */
export function registerTelegramInClaudeState(pathname: string, url: string, previousUrl: string | null = null): ClaudeRegistrationResult {
  if (!safeToRewrite(pathname)) return "unwritable";
  const state = claudeState(pathname);
  if (!state) return "unwritable";
  const servers = state.mcpServers && typeof state.mcpServers === "object" && !Array.isArray(state.mcpServers)
    ? { ...state.mcpServers as Record<string, unknown> }
    : {};
  const existing = servers[CLAUDE_ENTRY_NAME];
  if (existing !== undefined) {
    /* Identical bytes prove configuration equality, not Viewer ownership.
       Only the separately persisted record may authorize update/removal. */
    if (!isViewerEntry(existing, previousUrl)) return "conflict";
    if (isViewerEntry(existing, url)) return "registered";
  }
  servers[CLAUDE_ENTRY_NAME] = { type: "http", url };
  atomicWrite(pathname, JSON.stringify({ ...state, mcpServers: servers }, null, 2) + "\n", 0o600);
  return "registered";
}

/** Removes the Viewer's `telegram` entry. Only an entry still matching the
    Viewer's own record (`ownedUrl`) is removed; anything else — including an
    entry the operator edited after registration — is left exactly as found. */
export function removeTelegramFromClaudeState(pathname: string, ownedUrl: string | null): boolean {
  if (!safeToRewrite(pathname) || !fs.existsSync(pathname)) return true;
  const state = claudeState(pathname);
  if (!state) return false;
  const servers = state.mcpServers && typeof state.mcpServers === "object" && !Array.isArray(state.mcpServers)
    ? { ...state.mcpServers as Record<string, unknown> }
    : {};
  if (!isViewerEntry(servers[CLAUDE_ENTRY_NAME], ownedUrl)) return true;
  delete servers[CLAUDE_ENTRY_NAME];
  atomicWrite(pathname, JSON.stringify({ ...state, mcpServers: servers }, null, 2) + "\n", 0o600);
  return true;
}

/* What this Viewer wrote, per Claude state file. Removal consults it, so an
   operator-replaced entry is never deleted as if it were still ours. */
type RegistrationRecords = { version: 1; claude: Record<string, string> };

function registrationRecordsPath(): string {
  return statePath("telegram", "registrations.json");
}

function readRegistrationRecords(): RegistrationRecords {
  try {
    const parsed = JSON.parse(fs.readFileSync(registrationRecordsPath(), "utf8")) as Partial<RegistrationRecords>;
    if (parsed.version === 1 && parsed.claude && typeof parsed.claude === "object") {
      return { version: 1, claude: { ...parsed.claude as Record<string, string> } };
    }
  } catch { /* absent or corrupt records start empty */ }
  return { version: 1, claude: {} };
}

function writeRegistrationRecords(records: RegistrationRecords): void {
  ensureTelegramStateDir(true);
  atomicWrite(registrationRecordsPath(), JSON.stringify(records) + "\n", 0o600);
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
  const records = readRegistrationRecords();
  for (const pathname of targets.claudeStatePaths) {
    const result = registerTelegramInClaudeState(pathname, url, records.claude[pathname] ?? null);
    if (result === "registered") records.claude[pathname] = url;
    /* A conflict is the operator's entry — nothing of ours exists there. */
    else if (result === "conflict") delete records.claude[pathname];
  }
  writeRegistrationRecords(records);
  for (const pathname of targets.codexConfigPaths) registerTelegramInCodexConfig(pathname, url);
}

export function unregisterTelegramHosts(targets: TelegramRegistrationTargets = telegramRegistrationTargets()): void {
  const records = readRegistrationRecords();
  /* Recorded paths outside the current target list (a managed home removed
     since registration) still get their Viewer entry cleaned up. */
  for (const pathname of new Set([...targets.claudeStatePaths, ...Object.keys(records.claude)])) {
    if (removeTelegramFromClaudeState(pathname, records.claude[pathname] ?? null)) delete records.claude[pathname];
  }
  writeRegistrationRecords(records);
  for (const pathname of targets.codexConfigPaths) removeTelegramFromCodexConfig(pathname);
}
