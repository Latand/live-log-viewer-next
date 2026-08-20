import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { legacyClaudeHome, listClaudeAccounts } from "@/lib/accounts/claude";
import { statePath } from "@/lib/configDir";

import { telegramMcpUrl } from "./packaging";
import { ensureTelegramStateDir, TELEGRAM_CONNECTOR_TOKEN_ENV } from "./sessionStore";

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

export type TelegramHostRegistrationResult = {
  ok: boolean;
  claude: Record<ClaudeRegistrationResult, number>;
  codex: { registered: number; failed: number };
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
  const record = entry as { type?: unknown; url?: unknown; headers?: unknown };
  return record.type === "http" && record.url === url
    && record.headers !== null && typeof record.headers === "object" && !Array.isArray(record.headers)
    && (record.headers as Record<string, unknown>).Authorization === `Bearer \${${TELEGRAM_CONNECTOR_TOKEN_ENV}}`
    && Object.keys(record.headers as Record<string, unknown>).length === 1
    && Object.keys(record).length === 3;
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
  servers[CLAUDE_ENTRY_NAME] = {
    type: "http",
    url,
    headers: { Authorization: `Bearer \${${TELEGRAM_CONNECTOR_TOKEN_ENV}}` },
  };
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
type ClaudeStateSnapshot = { pathname: string; existed: boolean; contents: string; mode: number };

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

function snapshotClaudeState(pathname: string): ClaudeStateSnapshot | null {
  try {
    const stat = fs.lstatSync(pathname);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    return { pathname, existed: true, contents: fs.readFileSync(pathname, "utf8"), mode: stat.mode & 0o777 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { pathname, existed: false, contents: "", mode: 0o600 };
    }
    return null;
  }
}

function restoreClaudeState(snapshot: ClaudeStateSnapshot): void {
  if (snapshot.existed) atomicWrite(snapshot.pathname, snapshot.contents, snapshot.mode);
  else if (safeToRewrite(snapshot.pathname)) fs.rmSync(snapshot.pathname, { force: true });
}

function codexManagedBlock(url: string): string {
  return `${CODEX_BLOCK_BEGIN}\n[mcp_servers.telegram]\nurl = "${url}"\nbearer_token_env_var = "${TELEGRAM_CONNECTOR_TOKEN_ENV}"\n${CODEX_BLOCK_END}\n`;
}

type CodexManagedBlockState =
  | { status: "none" | "valid"; contents: string }
  | { status: "invalid" };

function codexManagedBlockState(contents: string): CodexManagedBlockState {
  const begins = [...contents.matchAll(/^# >>> agent-log-viewer telegram >>>\r?$/gm)];
  const ends = [...contents.matchAll(/^# <<< agent-log-viewer telegram <<<\r?$/gm)];
  if (begins.length === 0 && ends.length === 0) return { status: "none", contents };
  if (begins.length !== 1 || ends.length !== 1) return { status: "invalid" };
  const begin = begins[0]!;
  const end = ends[0]!;
  if (begin.index >= end.index) return { status: "invalid" };
  const block = contents.slice(begin.index, end.index + end[0].length).replaceAll("\r\n", "\n");
  const lines = block.split("\n");
  if (lines.length !== 5
    || lines[0] !== CODEX_BLOCK_BEGIN
    || lines[1] !== "[mcp_servers.telegram]"
    || !/^url = "[^"\r\n]+"$/.test(lines[2]!)
    || lines[3] !== `bearer_token_env_var = "${TELEGRAM_CONNECTOR_TOKEN_ENV}"`
    || lines[4] !== CODEX_BLOCK_END) return { status: "invalid" };
  const after = end.index + end[0].length;
  /* Registration separates the block with one blank line; removal collapses
     exactly that back, so register → remove restores the original bytes. */
  const prefix = contents.slice(0, begin.index).replace(/\n+$/, "\n");
  const tail = contents.slice(after).replace(/^\n+/, "");
  const stripped = prefix === "" || prefix === "\n" ? tail || "\n" : prefix + tail;
  return { status: "valid", contents: stripped };
}

function validCodexToml(contents: string): boolean {
  try {
    Bun.TOML.parse(contents);
    return true;
  } catch {
    return false;
  }
}

function hasCodexTelegramTable(contents: string): boolean {
  try {
    const parsed = Bun.TOML.parse(contents) as Record<string, unknown>;
    const servers = parsed.mcp_servers;
    return Boolean(servers && typeof servers === "object" && !Array.isArray(servers)
      && Object.prototype.hasOwnProperty.call(servers, CLAUDE_ENTRY_NAME));
  } catch {
    return false;
  }
}

/** Upserts a marker-delimited `[mcp_servers.telegram]` block in config.toml.
    Markers keep the edit reversible and byte-surgical without a TOML rewriter;
    everything outside the block is preserved verbatim. An operator-authored
    `[mcp_servers.telegram]` table outside the markers wins — the writer backs
    off rather than fight the operator's own configuration. */
export function registerTelegramInCodexConfig(pathname: string, url: string): boolean {
  if (!safeToRewrite(pathname)) return false;
  const contents = fs.existsSync(pathname) ? fs.readFileSync(pathname, "utf8") : "";
  if (!validCodexToml(contents)) return false;
  const managed = codexManagedBlockState(contents);
  if (managed.status === "invalid") return false;
  const stripped = managed.contents;
  if (hasCodexTelegramTable(stripped)) return false;
  const block = codexManagedBlock(url);
  if (contents.includes(block)) return true;
  const base = stripped === "" ? "" : stripped.replace(/\n*$/, "\n\n");
  const candidate = base + block;
  if (!validCodexToml(candidate)) return false;
  atomicWrite(pathname, candidate, 0o600);
  return true;
}

export function removeTelegramFromCodexConfig(pathname: string): boolean {
  if (!safeToRewrite(pathname) || !fs.existsSync(pathname)) return true;
  const contents = fs.readFileSync(pathname, "utf8");
  if (!validCodexToml(contents)) return false;
  const managed = codexManagedBlockState(contents);
  if (managed.status === "invalid") return false;
  if (managed.status === "none") return true;
  atomicWrite(pathname, managed.contents, 0o600);
  return true;
}

export function registerTelegramHosts(
  targets: TelegramRegistrationTargets = telegramRegistrationTargets(),
  url: string = telegramMcpUrl(),
): TelegramHostRegistrationResult {
  const records = readRegistrationRecords();
  const result: TelegramHostRegistrationResult = {
    ok: false,
    claude: { registered: 0, conflict: 0, unwritable: 0 },
    codex: { registered: 0, failed: 0 },
  };
  const publishedClaude: ClaudeStateSnapshot[] = [];
  for (const pathname of targets.claudeStatePaths) {
    const snapshot = snapshotClaudeState(pathname);
    const registration = registerTelegramInClaudeState(pathname, url, records.claude[pathname] ?? null);
    result.claude[registration] += 1;
    if (registration === "registered") {
      records.claude[pathname] = url;
      if (snapshot) publishedClaude.push(snapshot);
    }
    /* A conflict is the operator's entry — nothing of ours exists there. */
    else if (registration === "conflict") delete records.claude[pathname];
  }
  try {
    writeRegistrationRecords(records);
  } catch (error) {
    for (const snapshot of publishedClaude.reverse()) {
      try { restoreClaudeState(snapshot); } catch { /* keep rolling back other targets */ }
    }
    throw error;
  }
  for (const pathname of targets.codexConfigPaths) {
    if (registerTelegramInCodexConfig(pathname, url)) result.codex.registered += 1;
    else result.codex.failed += 1;
  }
  result.ok = result.claude.conflict === 0
    && result.claude.unwritable === 0
    && result.codex.failed === 0;
  return result;
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
