import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";

import { statePath } from "@/lib/configDir";
import { procBackend } from "@/lib/proc";
import { withFileTransaction } from "@/lib/state/fileTransaction";

import type { TelegramConnectorRestarts, TelegramErrorCode, TelegramIdentity } from "./contracts";
import { connectorLaunchSpec, telegramApiCredentials, telegramMcpServerPath, telegramMcpUrl, telegramVenvPython, type ProcessSpec } from "./packaging";
import { ensureTelegramStateDir, readTelegramConnection, readTelegramSession, writeTelegramConnection, type StoredTelegramSession } from "./sessionStore";

/**
 * Supervisor for the ONE shared loopback connector process (issue #1059).
 *
 * Exactly one `telegram-mcp` serves the account: agent sessions and Viewer
 * candidates never start their own copy — they reach the registered
 * streamable-HTTP URL. Before a spawned process is considered ready (and
 * before an already-listening one is adopted), its advertised tool surface is
 * authenticated and verified before publication:
 *
 *  - every tool must carry `readOnlyHint: true`; and
 *  - every tool name must be on {@link TELEGRAM_READ_TOOL_ALLOWLIST}, the
 *    reviewed list of tools whose implementations were audited to perform no
 *    server-side mutation. The annotation alone is NOT trusted: upstream
 *    shipped `get_invite_link`/`export_chat_invite` annotated read-only while
 *    minting invite links (see vendor/telegram-mcp/PROVENANCE.md), which is
 *    exactly the failure an annotation-only check cannot catch.
 *
 * A surface violating either bound is refused and reported `not_read_only`.
 * A pre-auth HMAC challenge proves the listener knows the current generation's
 * bearer token before that token is sent. The MCP handshake must then return
 * the token-derived server identity.
 *
 * The spawned pid and its portable process identity persist in
 * `<state>/telegram/connector.json`, so a LATER Viewer generation — the one
 * actually handling the logout or local deletion — can stop the connector it
 * adopted rather than only one it spawned itself. Identity comes from the
 * platform `procBackend` (kernel start token on Linux, the darwin identity on
 * macOS), exact argv, credentialRef, and token digest, so a recycled pid or a
 * connector for another credential generation is never adopted or signaled.
 */

/** The audited read surface: every `readOnlyHint=True` tool in the vendored
    tree (post-patch), each verified to perform no server-side write. The
    parity test in `connector.test.ts` re-derives this set from the vendored
    registry, so a vendor bump cannot silently widen it. */
export const TELEGRAM_READ_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([
  "export_contacts", "get_admins", "get_banned_users", "get_blocked_users",
  "get_bot_info", "get_chat", "get_chats", "get_common_chats",
  "get_contact_chats", "get_contact_ids", "get_direct_chat_by_contact",
  "get_drafts", "get_folder", "get_full_chat", "get_full_user",
  "get_gif_search", "get_history", "get_last_interaction", "get_me",
  "get_media_info", "get_message_context", "get_message_link",
  "get_message_reactions", "get_message_read_by", "get_messages",
  "get_participants", "get_pinned_messages", "get_privacy_settings",
  "get_recent_actions", "get_scheduled_messages", "get_sticker_sets",
  "get_user_photos", "get_user_status", "incoming_feed_status",
  "list_accounts", "list_chats", "list_contact_aliases", "list_contacts",
  "list_folders", "list_inline_buttons", "list_messages", "list_topics",
  "resolve_username", "search_contacts", "search_global", "search_messages",
  "search_public_chats", "wait_for_new_message", "wait_for_settled_message",
]);

export type ConnectorProbe =
  | { ok: true; serverName: string; tools: Array<{ name: string; readOnly: boolean }> }
  | { ok: false };

export type ConnectorEnsureResult = { ok: true; url: string } | { ok: false; code: TelegramErrorCode };

/** What the RUNNING connector can prove about the account without being torn
    down (#1087): a `get_me` through the verified surface needs a live,
    authorized Telethon client, so a successful answer is a health reading.
    `null` means "this process cannot answer" — the caller then falls back to
    the destructive bridge check, which also classifies an expired session. */
export type ConnectorLiveHealth = { status: "connected"; identity: TelegramIdentity };

type ConnectorChild = {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  /** Present for children this Viewer generation actually spawned; an adopted
      process has no exit event to listen to. */
  onExit?(handler: (code: number | null, signal: NodeJS.Signals | null) => void): void;
};
type ConnectorBinding = Pick<StoredTelegramSession, "credentialRef" | "connectorToken">;

export interface TelegramConnectorPorts {
  spawn(spec: ProcessSpec): ConnectorChild | null;
  probe(url: string, connectorToken: string, signal?: AbortSignal): Promise<ConnectorProbe>;
  sleep(ms: number): Promise<void>;
  now(): number;
  ownsProcess?(binding: ConnectorBinding): boolean;
  recordProcess?(child: ConnectorChild, spec: ProcessSpec, binding: ConnectorBinding): boolean;
  stop?(): Promise<void> | void;
  beginOperation?(): () => boolean;
  probeTimeoutMs?: number;
  /** One read-only tool call over the verified surface; `null` for any
      failure. Used only by {@link telegramConnectorHealth}. */
  callTool?(url: string, connectorToken: string, tool: string, signal?: AbortSignal): Promise<string | null>;
  /** Backoff before a crash restart. */
  restartDelayMs?: number;
}

const READY_DEADLINE_MS = 30_000;
const PROBE_INTERVAL_MS = 500;
const PROBE_TIMEOUT_MS = 5_000;
const TERMINATION_GRACE_MS = 2_000;
const TERMINATION_KILL_MS = 2_000;
const TERMINATION_POLL_MS = 25;
const PID_FILE = "connector.json";
/* Crash bookkeeping (#1087). The stderr sink is the ONLY place the connector's
   own output is kept; it is Viewer-owned, owner-only, and truncated at every
   spawn so a recorded tail always belongs to the process that just died. */
const STDERR_FILE = "connector-stderr.log";
const CRASH_LOG_FILE = "connector-crashes.log";
const RESTART_STATE_FILE = "connector-restarts.json";
/* Written by the connector's own crash monitor (bin/telegram_connector_monitor.py)
   at the moment the server child dies, so the exit code — or the signal, which
   is the whole story for an OOM kill — outlives the Viewer generation that
   spawned it. */
const EXIT_FILE = "connector-exit.json";
const STDERR_TAIL_LINES = 20;
const STDERR_TAIL_BYTES = 8_192;
const STDERR_LINE_CHARS = 400;
const CRASH_LOG_KEEP_LINES = 50;
const DAY_MS = 24 * 60 * 60 * 1_000;
/* A crashing connector is restarted, but never in a hot loop: more than
   RESTART_BURST_LIMIT crashes inside RESTART_BURST_WINDOW_MS means the process
   cannot stay up, and hammering it would only add noise to the crash log. */
const RESTART_BURST_WINDOW_MS = 15 * 60 * 1_000;
const RESTART_BURST_LIMIT = 5;
const RESTART_DELAY_MS = 500;
/* The supervisor asks the connector to drain before it signals it, so an
   in-flight call is answered with a named error rather than cut short. A
   connector that cannot be asked inside this budget is signaled anyway. */
const DRAIN_PATH = "/llv-telegram-drain";
const DRAIN_TIMEOUT_MS = 1_500;
/* The non-destructive health check gets a longer budget than a readiness
   probe: a connector busy with a fan-out of large reads is healthy, and
   timing it out here would tear down exactly the process this change set out
   to protect. A connector that answers nothing inside this budget is wedged,
   and the destructive path may take over. */
const HEALTH_TIMEOUT_MS = 15_000;

/** The read-only gate, pure so it is directly provable: one tool that lacks
    an affirmative readOnlyHint OR falls outside the audited allowlist fails
    the whole surface; an empty surface proves nothing and fails too. */
export function verifyReadOnlyTools(
  tools: Array<{ name: string; readOnly: boolean }>,
  allowlist: ReadonlySet<string> = TELEGRAM_READ_TOOL_ALLOWLIST,
): { ok: boolean; offending: string[] } {
  const offending = tools
    .filter((tool) => !tool.readOnly || !allowlist.has(tool.name))
    .map((tool) => tool.name);
  return { ok: tools.length > 0 && offending.length === 0, offending };
}

/** One MCP initialize + tools/list against the loopback URL. Any failure is
    just "not ready yet" to the caller. */
export function connectorServerName(connectorToken: string): string {
  return `telegram-${crypto.createHash("sha256").update(connectorToken).digest("hex")}`;
}

async function proveConnectorOwnership(url: string, connectorToken: string, signal?: AbortSignal): Promise<boolean> {
  const nonce = crypto.randomBytes(32).toString("base64url");
  const proofUrl = new URL(url);
  proofUrl.pathname = "/llv-telegram-proof";
  proofUrl.search = "";
  try {
    const response = await fetch(proofUrl, { headers: { "x-llv-telegram-nonce": nonce }, signal });
    if (!response.ok) return false;
    const supplied = Buffer.from((await response.text()).trim(), "hex");
    const expected = Buffer.from(crypto.createHmac("sha256", connectorToken).update(nonce).digest("hex"), "hex");
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  } catch {
    return false;
  }
}

export async function probeTelegramConnector(url: string, connectorToken: string, signal?: AbortSignal): Promise<ConnectorProbe> {
  try {
    if (!await proveConnectorOwnership(url, connectorToken, signal)) return { ok: false };
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const client = new Client({ name: "agent-log-viewer", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${connectorToken}` }, signal },
    });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      return {
        ok: true,
        serverName: client.getServerVersion()?.name ?? "",
        tools: listed.tools.map((tool) => ({
          name: tool.name,
          readOnly: (tool.annotations as { readOnlyHint?: unknown } | undefined)?.readOnlyHint === true,
        })),
      };
    } finally {
      await client.close().catch(() => undefined);
    }
  } catch {
    return { ok: false };
  }
}

/** One read-only tool call over the authenticated loopback surface. Returns
    the tool's text output, or null for any failure — callers treat null as
    "this connector cannot answer" and never as a verdict about the account. */
export async function callTelegramConnectorTool(
  url: string,
  connectorToken: string,
  tool: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const client = new Client({ name: "agent-log-viewer", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${connectorToken}` }, signal },
    });
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: tool, arguments: {} });
      if (result.isError) return null;
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .filter((part): part is { type: "text"; text: string } =>
          typeof (part as { type?: unknown }).type === "string" && (part as { type: string }).type === "text"
          && typeof (part as { text?: unknown }).text === "string")
        .map((part) => part.text)
        .join("\n");
      return text.length > 0 ? text : null;
    } finally {
      await client.close().catch(() => undefined);
    }
  } catch {
    return null;
  }
}

const realPorts: TelegramConnectorPorts = {
  spawn(spec) {
    /* stderr goes to the Viewer-owned owner-only sink instead of /dev/null:
       when the process dies, its last lines are the only evidence of why
       (#1087). A sink that cannot be opened safely never blocks the spawn. */
    const sink = openConnectorStderrSink();
    try {
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ["ignore", "ignore", sink ?? "ignore"],
        detached: true,
      });
      child.unref();
      return {
        pid: child.pid,
        kill: (signal) => child.kill(signal),
        onExit: (handler) => { child.once("exit", (code, signal) => handler(code, signal)); },
      };
    } catch {
      return null;
    } finally {
      if (sink !== null) { try { fs.closeSync(sink); } catch { /* already closed */ } }
    }
  },
  probe: probeTelegramConnector,
  callTool: callTelegramConnectorTool,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  ownsProcess: ownsRecordedConnector,
  recordProcess: recordConnectorProcess,
  stop: stopRealConnectorUnlocked,
  beginOperation: beginConnectorOperation,
};

function pidFilePath(): string {
  return statePath("telegram", PID_FILE);
}

function telegramStateFile(name: string): string {
  return statePath("telegram", name);
}

/**
 * How the connector's server child actually went, as its monitor recorded it
 * (#1087).
 *
 * The Viewer spawns the monitor, and the monitor forks the server; the pid the
 * supervisor records and signals is the monitor's, so a record is only this
 * connector's when it names that pid. The monitor removes the file when it
 * starts, so nothing here can be a previous generation's verdict.
 */
type ConnectorExitRecord = { monitorPid: number; pid: number; exitCode: number | null; signal: string | null };

function readConnectorExitRecord(monitorPid: number): ConnectorExitRecord | null {
  try {
    const path = telegramStateFile(EXIT_FILE);
    const stat = fs.lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) return null;
    const row = JSON.parse(fs.readFileSync(path, "utf8")) as Partial<ConnectorExitRecord> & { version?: unknown };
    if (row.version !== 1 || row.monitorPid !== monitorPid || typeof row.pid !== "number") return null;
    return {
      monitorPid,
      pid: row.pid,
      exitCode: typeof row.exitCode === "number" ? row.exitCode : null,
      signal: typeof row.signal === "string" ? row.signal : null,
    };
  } catch {
    return null;
  }
}

/** Append-only owner-only sink for the connector's stderr, truncated at every
    spawn so the tail a crash record quotes is that process's own output. The
    monitor writes REDACTED lines here — it owns the server child's stderr and
    filters every line on the way to disk, so nothing raw is ever persisted. */
function openConnectorStderrSink(): number | null {
  try {
    if (ensureTelegramStateDir(true) === null) return null;
    const sink = fs.openSync(telegramStateFile(STDERR_FILE), "w", 0o600);
    /* The mode argument only applies to a file this call creates; an existing
       sink is re-tightened explicitly. */
    fs.fchmodSync(sink, 0o600);
    return sink;
  } catch {
    return null;
  }
}

/**
 * Redacts one connector stderr line before it is persisted.
 *
 * The crash log is Viewer-owned and owner-only, but it is still a durable
 * copy of upstream output, and that output is not innocent: the vendored
 * error helper logs the failing call's arguments verbatim
 * (`Error in <fn> (chat_id=…, query=…)`, see
 * `vendor/telegram-mcp/telegram_mcp/runtime.py`) and attaches a traceback
 * whose frames carry absolute paths under the operator's home. A crash
 * record has to say what died, never who was being read (#1087).
 *
 * `secrets` carries the values this Viewer already knows are credentials —
 * the connector bearer token and the Telegram string session — so an exact
 * echo of either is removed by value rather than by pattern.
 */
export function redactConnectorStderrLine(line: string, secrets: readonly string[] = []): string {
  let out = line;
  for (const secret of secrets) {
    if (secret.length >= 8) out = out.split(secret).join("<redacted>");
  }
  const home = os.homedir();
  if (home && home.length > 1) out = out.split(home).join("~");
  out = out
    /* Any other account's home, and the container's copy of this one. */
    .replace(/\/(home|Users)\/[^/\s:'"]+/g, "/$1/<user>")
    /* The vendored context format: `key=value` pairs lifted straight out of
       the tool arguments. Everything up to the next pair separator goes. */
    .replace(/\b([A-Za-z_]*(?:chat|user|peer|phone|contact|title|name|query|text|message|entity|alias|folder)[A-Za-z_]*)\s*=\s*[^,)]*/gi, "$1=<redacted>")
    /* Public handles. */
    .replace(/@[A-Za-z0-9_]{4,}/g, "@<user>")
    /* Chat/user/message ids and phone numbers. */
    .replace(/[+-]?\b\d{5,}\b/g, "<id>")
    /* Opaque high-entropy blobs — a session string, a token, a hash. */
    .replace(/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g, "<redacted>");
  return out.length > STDERR_LINE_CHARS ? `${out.slice(0, STDERR_LINE_CHARS)}…` : out;
}

/** The last lines the connector printed before it died, redacted. Bounded
    twice (bytes read, then lines kept) so a runaway log can never be loaded
    whole. */
function connectorStderrTail(secrets: readonly string[] = []): string[] {
  try {
    const path = telegramStateFile(STDERR_FILE);
    const stat = fs.statSync(path);
    const start = Math.max(0, stat.size - STDERR_TAIL_BYTES);
    const handle = fs.openSync(path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, STDERR_TAIL_BYTES));
      const read = fs.readSync(handle, buffer, 0, buffer.length, start);
      return buffer.subarray(0, read).toString("utf8")
        .split("\n")
        .map((line) => line.replace(/\s+$/, ""))
        .filter((line) => line.length > 0)
        .slice(-STDERR_TAIL_LINES)
        .map((line) => redactConnectorStderrLine(line, secrets));
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return [];
  }
}

type ConnectorRecord = {
  version: 1;
  pid: number;
  identity: string;
  credentialRef: string;
  connectorTokenSha256: string;
  command: string;
  entrypoint: string;
};

let liveConnectorChild: {
  child: ConnectorChild;
  pid: number;
  identity: string;
} | null = null;
let supervisorGeneration = 0;

function beginConnectorOperation(): () => boolean {
  const generation = ++supervisorGeneration;
  return () => generation === supervisorGeneration;
}

function connectorTokenSha256(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function readConnectorRecord(): ConnectorRecord | null {
  try {
    if (ensureTelegramStateDir(false) === null) return null;
    const stat = fs.lstatSync(pidFilePath());
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) return null;
    const row = JSON.parse(fs.readFileSync(pidFilePath(), "utf8")) as Partial<ConnectorRecord>;
    if (row.version !== 1 || typeof row.pid !== "number" || !Number.isInteger(row.pid) || row.pid <= 1
      || typeof row.identity !== "string" || typeof row.credentialRef !== "string"
      || typeof row.connectorTokenSha256 !== "string" || typeof row.command !== "string" || typeof row.entrypoint !== "string") return null;
    return row as ConnectorRecord;
  } catch {
    return null;
  }
}

function connectorArgvMatches(record: ConnectorRecord): boolean {
  const argv = procBackend.readArgv(record.pid);
  return argv[0] === record.command && argv[1] === record.entrypoint
    && record.command === telegramVenvPython() && record.entrypoint === telegramMcpServerPath();
}

function ownsRecordedConnector(binding: ConnectorBinding): boolean {
  const record = readConnectorRecord();
  return Boolean(record
    && record.credentialRef === binding.credentialRef
    && record.connectorTokenSha256 === connectorTokenSha256(binding.connectorToken)
    && procBackend.processIdentity(record.pid) === record.identity
    && connectorArgvMatches(record));
}

function terminateChildImmediately(child: ConnectorChild): void {
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
}

function recordConnectorProcess(child: ConnectorChild, spec: ProcessSpec, binding: ConnectorBinding): boolean {
  const pid = child.pid;
  const identity = pid ? procBackend.processIdentity(pid) : null;
  if (!pid || !identity || !spec.args[0]) {
    terminateChildImmediately(child);
    return false;
  }
  liveConnectorChild = { child, pid, identity };
  const record: ConnectorRecord = {
    version: 1,
    pid,
    identity,
    credentialRef: binding.credentialRef,
    connectorTokenSha256: connectorTokenSha256(binding.connectorToken),
    command: spec.command,
    entrypoint: spec.args[0],
  };
  const tmp = `${pidFilePath()}.${process.pid}.tmp`;
  try {
    const directory = ensureTelegramStateDir(true)!;
    fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    const fd = fs.openSync(tmp, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, pidFilePath());
    const directoryFd = fs.openSync(directory, "r");
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    const persisted = fs.lstatSync(pidFilePath());
    if (!persisted.isFile() || persisted.isSymbolicLink() || (persisted.mode & 0o077) !== 0) throw new Error("unsafe connector record");
    return true;
  } catch {
    fs.rmSync(tmp, { force: true });
    try { fs.rmSync(pidFilePath(), { force: true }); } catch { /* unsafe/missing state */ }
    liveConnectorChild = null;
    terminateChildImmediately(child);
    return false;
  }
}

function removeConnectorRecord(): void {
  try {
    if (ensureTelegramStateDir(false) !== null) fs.rmSync(pidFilePath(), { force: true });
  } catch { /* unsafe/missing state */ }
}

/* ------------------------------------------------------------------ #1087
   Crash bookkeeping. A connector that dies takes every in-flight agent call
   with it; before this, the exit left no trace at all (stderr went to
   /dev/null and the status file kept saying "connected"). Two owner-only
   files under the telegram state dir carry the evidence: an ndjson crash log
   with exit code/signal and the last stderr lines, and a small restart state
   the status payload reads. Deliberate stops (logout, local deletion, a
   refused surface) are NOT crashes and appear in neither.
   ------------------------------------------------------------------------ */

type ConnectorCrashRecord = {
  at: string;
  pid: number;
  exitCode: number | null;
  signal: string | null;
  /** How the exit was noticed. `exit` is an exit somebody waited for — this
      Viewer's own child, or (for a connector spawned by an earlier generation)
      the crash monitor that stayed its parent and wrote the status down.
      `vanished` is the residue: the process is gone and no verdict was
      recorded for it, so the code and signal are genuinely unknowable and
      both stay null. */
  observed: "exit" | "vanished";
  stderr: string[];
};

type ConnectorRestartState = {
  version: 1;
  /** ISO timestamps of VERIFIED crash restarts — a replacement connector that
      came back up and passed the read-only verification. A respawn that
      failed is not a restart and is never counted here. Trimmed to 24 h. */
  restarts: string[];
  /** ISO timestamps of the crashes themselves, whether or not the restart
      that followed succeeded. This is what the burst limiter reads: a
      connector that dies five times and never comes back must stop being
      restarted just as surely as one that comes back and dies again. */
  crashes: string[];
  lastCrashAt: string | null;
  /** The pid of the last crash written, so an exit seen both by the child's
      own exit event and by the reaper below is recorded exactly once. */
  lastCrashPid: number | null;
};

/** Pids this Viewer generation is terminating on purpose, each with the time
    it was marked. Entries are pruned so a process whose exit event never
    arrives (an adopted connector has none) cannot grow this map. */
const deliberateStops = new Map<number, number>();
const DELIBERATE_STOP_TTL_MS = 60_000;

function markDeliberateStop(pid: number, now: number): void {
  for (const [marked, at] of deliberateStops) {
    if (now - at > DELIBERATE_STOP_TTL_MS) deliberateStops.delete(marked);
  }
  deliberateStops.set(pid, now);
}
/** Non-zero while a crash restart is in flight — the `restarting` phase. */
let restartsInFlight = 0;

function writeOwnerOnlyFile(path: string, contents: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, contents, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, path);
  } catch {
    fs.rmSync(tmp, { force: true });
  }
}

function readRestartState(): ConnectorRestartState {
  const empty: ConnectorRestartState = { version: 1, restarts: [], crashes: [], lastCrashAt: null, lastCrashPid: null };
  try {
    if (ensureTelegramStateDir(false) === null) return empty;
    const row = JSON.parse(fs.readFileSync(telegramStateFile(RESTART_STATE_FILE), "utf8")) as Partial<ConnectorRestartState>;
    if (row.version !== 1 || !Array.isArray(row.restarts)) return empty;
    const strings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
    return {
      version: 1,
      restarts: strings(row.restarts),
      crashes: strings(row.crashes),
      lastCrashAt: typeof row.lastCrashAt === "string" ? row.lastCrashAt : null,
      lastCrashPid: typeof row.lastCrashPid === "number" ? row.lastCrashPid : null,
    };
  } catch {
    return empty;
  }
}

function writeRestartState(state: ConnectorRestartState): void {
  writeOwnerOnlyFile(telegramStateFile(RESTART_STATE_FILE), JSON.stringify(state));
}

function withinLast(timestamps: string[], windowMs: number, now: number): string[] {
  return timestamps.filter((value) => {
    const at = Date.parse(value);
    return Number.isFinite(at) && now - at <= windowMs;
  });
}

/** Crash restarts of the shared connector as the status payload reports them
    (#1087), plus whether one is happening right now. */
export function telegramConnectorActivity(now: number = Date.now()): TelegramConnectorRestarts & { restarting: boolean } {
  const state = readRestartState();
  const recent = withinLast(state.restarts, DAY_MS, now);
  return {
    restarting: restartsInFlight > 0,
    last24h: recent.length,
    lastAt: recent.length > 0 ? recent[recent.length - 1]! : null,
  };
}

/** Writes the crash to the owner-only ndjson log and stamps it into the
    restart state, which is what makes the record idempotent per pid: the same
    exit seen twice (once by the child's exit event, once by the reaper) is
    logged once. Returns false when this pid was already recorded. */
function recordConnectorCrash(crash: ConnectorCrashRecord, at: number): boolean {
  const state = readRestartState();
  if (state.lastCrashPid === crash.pid) return false;
  try {
    if (ensureTelegramStateDir(true) === null) return false;
    const path = telegramStateFile(CRASH_LOG_FILE);
    let existing: string[] = [];
    try {
      existing = fs.readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0);
    } catch { /* first crash */ }
    const lines = [...existing, JSON.stringify(crash)].slice(-CRASH_LOG_KEEP_LINES);
    writeOwnerOnlyFile(path, `${lines.join("\n")}\n`);
  } catch { /* an unrecordable crash must not break the restart */ }
  writeRestartState({
    ...state,
    restarts: withinLast(state.restarts, DAY_MS, at),
    crashes: [...withinLast(state.crashes, DAY_MS, at), crash.at],
    lastCrashAt: crash.at,
    lastCrashPid: crash.pid,
  });
  return true;
}

/** Reads the crash log newest-last; exported for the focused tests and any
    future operator surface. */
export function readTelegramConnectorCrashes(): ConnectorCrashRecord[] {
  try {
    return fs.readFileSync(telegramStateFile(CRASH_LOG_FILE), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as ConnectorCrashRecord);
  } catch {
    return [];
  }
}

/** A crash restart that came back VERIFIED. Only these are counted: a respawn
    that failed left the operator with no connector, and reporting it as a
    completed restart would say the opposite of what happened (#1087). */
function noteVerifiedRestart(at: number): void {
  const state = readRestartState();
  writeRestartState({
    ...state,
    restarts: [...withinLast(state.restarts, DAY_MS, at), new Date(at).toISOString()],
    crashes: withinLast(state.crashes, DAY_MS, at),
    /* A replacement is serving, so the next exit is a NEW event whatever pid
       the kernel hands it — including a recycled one. */
    lastCrashPid: null,
  });
}

/**
 * A crash whose restart did not come back leaves the durable connection
 * saying `connected` for a process that no longer exists. Downgrade it to the
 * error the next reader needs to see. Only a connection that still names the
 * SAME credential is touched — a logout or a re-enrollment racing the restart
 * owns the file, not this path.
 */
function markConnectorRestartFailed(code: TelegramErrorCode, credentialRef: string): void {
  try {
    const connection = readTelegramConnection();
    if (connection.status !== "connected" || connection.credentialRef !== credentialRef) return;
    writeTelegramConnection({ ...connection, status: "error", errorCode: code });
  } catch { /* an unsafe or unreadable connection keeps its own contract */ }
}

/** True while the connector keeps crashing faster than restarting it can
    help — the restart stops there and the crash log holds the reason. Read
    from the CRASHES, not the successful restarts: a connector that dies and
    never comes back must stop being respawned just as surely as one that
    comes back and dies again. */
function restartBurstExhausted(now: number): boolean {
  return withinLast(readRestartState().crashes, RESTART_BURST_WINDOW_MS, now).length >= RESTART_BURST_LIMIT;
}

/** The secrets a crash tail must never echo: this generation's bearer token
    and the Telegram string session behind it. */
function connectorSecrets(binding: ConnectorBinding): string[] {
  const secrets = [binding.connectorToken];
  try {
    const session = readTelegramSession();
    if (session) secrets.push(session.sessionString, session.connectorToken);
  } catch { /* an unreadable session store contributes no known value */ }
  return secrets;
}

/**
 * The one automatic recovery path: a connector that exited on its own (not
 * because this Viewer stopped it) is brought back for the SAME stored
 * credential. A deleted or replaced session cancels the restart — recovery
 * never resurrects a credential the operator removed.
 */
function watchConnectorExit(child: ConnectorChild, binding: ConnectorBinding, ports: TelegramConnectorPorts): void {
  const pid = child.pid;
  if (!pid || !child.onExit) return;
  child.onExit((code, signal) => {
    if (deliberateStops.delete(pid)) return;
    if (liveConnectorChild?.pid === pid) liveConnectorChild = null;
    const at = ports.now();
    /* The monitor waited on the SERVER child; what the kernel handed us is the
       monitor's own mirrored status. Prefer the recorded verdict, and fall
       back to ours when the connector ran unmonitored. */
    const monitored = readConnectorExitRecord(pid);
    const recorded = recordConnectorCrash({
      at: new Date(at).toISOString(),
      pid,
      exitCode: monitored ? monitored.exitCode : code,
      signal: monitored ? monitored.signal : signal ?? null,
      observed: "exit",
      stderr: connectorStderrTail(connectorSecrets(binding)),
    }, at);
    if (recorded) void restartAfterCrash(binding, ports, at);
  });
}

/**
 * The crash record for an exit THIS Viewer was not listening to (#1087).
 *
 * A connector spawned by an earlier Viewer generation is adopted, not
 * re-parented: there is no exit event, so {@link watchConnectorExit} can never
 * fire for it — and after a Viewer restart that is EVERY connector the
 * operator has. Two things cover that gap. The connector's own crash monitor
 * stayed its parent across the Viewer restart and wrote the exit code or the
 * killing signal down, so the record is complete. And the disappearance itself
 * is noticed on the paths that already run on every status read, before the
 * replacement spawn truncates the stderr sink.
 *
 * A process that died with no monitor at all (an older connector still running
 * from before this change, a platform that could not fork) is still recorded —
 * as `vanished`, with a null code and signal, because nothing observed them.
 *
 * Returns true when a crash was recorded, so the caller can count the restart
 * it is about to perform.
 */
function reapVanishedConnector(binding: ConnectorBinding, ports: TelegramConnectorPorts): boolean {
  const record = readConnectorRecord();
  if (!record) return false;
  if (record.credentialRef !== binding.credentialRef) return false;
  if (procBackend.processIdentity(record.pid) === record.identity) return false;
  if (deliberateStops.delete(record.pid)) return false;
  const at = ports.now();
  const monitored = readConnectorExitRecord(record.pid);
  return recordConnectorCrash({
    at: new Date(at).toISOString(),
    pid: record.pid,
    exitCode: monitored?.exitCode ?? null,
    signal: monitored?.signal ?? null,
    observed: monitored ? "exit" : "vanished",
    stderr: connectorStderrTail(connectorSecrets(binding)),
  }, at);
}

/**
 * Records the crash of a connector that is already gone, BEFORE a caller tears
 * the bookkeeping down (#1087).
 *
 * The health path stops the connector and deletes its record whenever the
 * process cannot answer — including when it cannot answer because it is dead.
 * Deleting the record first erases the only pointer to the crashed pid, and
 * the crash then goes unrecorded, uncounted, and invisible. So the reap runs
 * first, and the crash it writes is what the following
 * {@link ensureTelegramConnector} recognises as the restart it is performing.
 */
export function reapTelegramConnectorCrash(
  session: StoredTelegramSession,
  ports: TelegramConnectorPorts = realPorts,
): boolean {
  return reapVanishedConnector(
    { credentialRef: session.credentialRef, connectorToken: session.connectorToken },
    ports,
  );
}

/** A crash was recorded and no verified restart has followed it. The pid stamp
    is cleared by {@link noteVerifiedRestart}, so this is exactly "the operator
    is still missing the connector that died". */
function crashAwaitingRestart(): boolean {
  return readRestartState().lastCrashPid !== null;
}

async function restartAfterCrash(binding: ConnectorBinding, ports: TelegramConnectorPorts, at: number): Promise<void> {
  if (restartBurstExhausted(at)) {
    markConnectorRestartFailed("connector_failed", binding.credentialRef);
    return;
  }
  restartsInFlight += 1;
  try {
    await ports.sleep(ports.restartDelayMs ?? RESTART_DELAY_MS);
    let session: StoredTelegramSession | null = null;
    try { session = readTelegramSession(); } catch { session = null; }
    /* A credential the operator deleted or replaced is never resurrected, and
       a restart that does not happen is not counted. */
    if (!session || session.credentialRef !== binding.credentialRef) return;
    const result = await ensureConnectorNow(session, ports);
    /* Counted only once the replacement is verified; a respawn that failed is
       surfaced durably instead, so the next status read says error rather
       than connected-over-a-corpse. */
    if (result.ok) noteVerifiedRestart(ports.now());
    else markConnectorRestartFailed(result.code, binding.credentialRef);
  } catch {
    markConnectorRestartFailed("connector_failed", binding.credentialRef);
  } finally {
    restartsInFlight -= 1;
  }
}

type TerminationTarget = {
  pid: number;
  identity: string;
  term(): void;
  kill(): void;
};

function targetIsAlive(target: Pick<TerminationTarget, "pid" | "identity">): boolean {
  return procBackend.processIdentity(target.pid) === target.identity;
}

async function waitForTargetsToExit(targets: TerminationTarget[], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (targets.some(targetIsAlive) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, TERMINATION_POLL_MS));
  }
  return targets.every((target) => !targetIsAlive(target));
}

/**
 * Tells the connector it is about to be stopped (#1087).
 *
 * The distinguishable error a dropped call needs cannot be produced after the
 * process is gone, and it must not depend on the shutdown reaching a
 * particular code path first — a SIGKILL escalation reaches none. So the
 * supervisor asks first, over the same authenticated loopback surface it
 * already uses: the connector completes every response it has started with a
 * JSON-RPC error naming the restart, and answers later arrivals 503. Only
 * then does the signal go out.
 *
 * Best effort by construction. A connector that is wedged, unauthenticated to
 * us, or already dead is signaled anyway; that is the pre-existing behaviour,
 * not a regression.
 */
async function requestConnectorDrain(recorded: ConnectorRecord | null): Promise<void> {
  let token: string | null = null;
  try { token = readTelegramSession()?.connectorToken ?? null; } catch { token = null; }
  /* Never send this generation's bearer token to a listener that a different
     credential generation recorded. */
  if (!token || !recorded || recorded.connectorTokenSha256 !== connectorTokenSha256(token)) return;
  const drainUrl = new URL(telegramMcpUrl());
  drainUrl.pathname = DRAIN_PATH;
  drainUrl.search = "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DRAIN_TIMEOUT_MS);
  timer.unref?.();
  try {
    await fetch(drainUrl, { method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
  } catch { /* the signal below is the fallback it always was */ }
  finally { clearTimeout(timer); }
}

async function stopRealConnectorUnlocked(): Promise<void> {
  supervisorGeneration += 1;
  const targets = new Map<number, TerminationTarget>();
  const child = liveConnectorChild;
  if (child && targetIsAlive(child)) {
    targets.set(child.pid, {
      pid: child.pid,
      identity: child.identity,
      term: () => { try { child.child.kill("SIGTERM"); } catch { /* already gone */ } },
      kill: () => terminateChildImmediately(child.child),
    });
  }
  const recorded = readConnectorRecord();
  let unverifiedRecordedProcess = false;
  if (recorded && targetIsAlive(recorded) && !targets.has(recorded.pid)) {
    if (connectorArgvMatches(recorded)) {
      targets.set(recorded.pid, {
        pid: recorded.pid,
        identity: recorded.identity,
        term: () => { try { process.kill(recorded.pid, "SIGTERM"); } catch { /* already gone */ } },
        kill: () => { try { process.kill(recorded.pid, "SIGKILL"); } catch { /* already gone */ } },
      });
    } else {
      /* Identity still matches but argv cannot prove the packaged connector.
         Preserve the record and fail closed: deleting it here would orphan a
         possibly credential-bearing process that a later retry could inspect. */
      unverifiedRecordedProcess = true;
    }
  }
  const active = [...targets.values()];
  /* Marked BEFORE the first signal: an exit this call caused is a stop, not a
     crash, and must neither be logged nor restarted (#1087). */
  for (const target of active) markDeliberateStop(target.pid, Date.now());
  /* Asked to drain BEFORE the first signal too, so every call in flight is
     answered with the named restart error while the process is still alive
     and its event loop still runs — the SIGKILL escalation below can no
     longer be what a caller meets first (#1087). */
  if (active.length > 0) await requestConnectorDrain(recorded);
  for (const target of active) target.term();
  if (!await waitForTargetsToExit(active, TERMINATION_GRACE_MS)) {
    for (const target of active.filter(targetIsAlive)) target.kill();
    if (!await waitForTargetsToExit(active, TERMINATION_KILL_MS)) {
      throw new Error("Telegram connector did not terminate");
    }
  }
  if (unverifiedRecordedProcess) throw new Error("Telegram connector ownership could not be verified");
  liveConnectorChild = null;
  removeConnectorRecord();
}

async function withConnectorSupervisorLock<T>(operation: () => Promise<T>): Promise<T> {
  ensureTelegramStateDir(true);
  return await withFileTransaction(
    statePath("telegram", "connector-supervisor"),
    "Telegram connector supervisor is busy",
    operation,
  );
}

async function verifiedProbe(
  url: string,
  connectorToken: string,
  ports: TelegramConnectorPorts,
  timeoutLimitMs = Number.POSITIVE_INFINITY,
): Promise<ConnectorEnsureResult | null | "timeout"> {
  const controller = new AbortController();
  const timeoutMs = Math.max(1, Math.min(ports.probeTimeoutMs ?? PROBE_TIMEOUT_MS, timeoutLimitMs));
  const probePromise = ports.probe(url, connectorToken, controller.signal).catch((): ConnectorProbe => ({ ok: false }));
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, timeoutMs);
    timer.unref?.();
  });
  const probe = await Promise.race([probePromise, timeoutPromise]);
  if (timer) clearTimeout(timer);
  if (probe === "timeout") return "timeout";
  controller.abort();
  if (!probe.ok) return null;
  if (probe.serverName !== connectorServerName(connectorToken)) return { ok: false, code: "connector_failed" };
  const readOnly = verifyReadOnlyTools(probe.tools);
  if (!readOnly.ok) return { ok: false, code: "not_read_only" };
  return { ok: true, url };
}

/**
 * Brings the shared connector up for the stored session and resolves only
 * once its read-only surface is verified. A process already listening on the
 * shared port (a previous Viewer generation's connector, still recorded in
 * the pid file) is adopted, not duplicated — that keeps the process count at
 * one across Viewer restarts.
 *
 * This is also where an exit nobody was listening to is noticed (#1087): an
 * adopted connector has no exit event, so its crash is reaped here, before
 * the replacement spawn truncates the stderr sink. When that happens, this
 * call IS the restart — it reads as `restarting` while it runs, counts only
 * if the replacement verifies, and marks the durable connection with the
 * failure code if it does not.
 */
export async function ensureTelegramConnector(
  session: StoredTelegramSession,
  ports: TelegramConnectorPorts = realPorts,
): Promise<ConnectorEnsureResult> {
  const binding = { credentialRef: session.credentialRef, connectorToken: session.connectorToken };
  /* This call IS a restart when it follows a crash: one this pass just reaped,
     or one already on the record that nothing has brought a connector back
     from. The second case is the health path, which reaps and then tears the
     pid record down before getting here (#1087). `restartsInFlight` keeps a
     crash the exit watcher is already restarting from being counted twice. */
  const isRestart = reapVanishedConnector(binding, ports)
    || (restartsInFlight === 0 && crashAwaitingRestart());
  if (!isRestart) return await ensureConnectorNow(session, ports);
  if (restartBurstExhausted(ports.now())) {
    markConnectorRestartFailed("connector_failed", binding.credentialRef);
    return { ok: false, code: "connector_failed" };
  }
  restartsInFlight += 1;
  try {
    const result = await ensureConnectorNow(session, ports);
    if (result.ok) noteVerifiedRestart(ports.now());
    else markConnectorRestartFailed(result.code, binding.credentialRef);
    return result;
  } finally {
    restartsInFlight -= 1;
  }
}

async function ensureConnectorNow(
  session: StoredTelegramSession,
  ports: TelegramConnectorPorts = realPorts,
): Promise<ConnectorEnsureResult> {
  const url = telegramMcpUrl();
  const binding = { credentialRef: session.credentialRef, connectorToken: session.connectorToken };
  const stop = ports.stop ?? stopRealConnectorUnlocked;
  const ownsProcess = ports.ownsProcess ?? ownsRecordedConnector;
  let isCurrent = ports.beginOperation?.() ?? (() => true);
  const prepared = await withConnectorSupervisorLock(async (): Promise<ConnectorEnsureResult | "spawned"> => {
    if (ownsProcess(binding)) {
      const adopted = await verifiedProbe(url, session.connectorToken, ports);
      if (!isCurrent()) return { ok: false, code: "connector_failed" };
      if (adopted && adopted !== "timeout") {
        if (!adopted.ok) await stop();
        return adopted;
      }
    }
    /* Missing ownership or a credential-generation mismatch makes any current
       listener ineligible for adoption. Stop and record the replacement while
       holding the cross-process supervisor lock, so another Viewer generation
       can only adopt the one durable winner. */
    await stop();
    isCurrent = ports.beginOperation?.() ?? (() => true);
    const credentials = telegramApiCredentials();
    if (!credentials) return { ok: false, code: "credentials_missing" };
    const spec = connectorLaunchSpec({ sessionString: session.sessionString, connectorToken: session.connectorToken, credentials });
    if (!isCurrent()) return { ok: false, code: "connector_failed" };
    const child = ports.spawn(spec);
    if (!child) return { ok: false, code: "connector_failed" };
    const recordProcess = ports.recordProcess ?? recordConnectorProcess;
    if (!recordProcess(child, spec, binding)) {
      terminateChildImmediately(child);
      return { ok: false, code: "connector_failed" };
    }
    watchConnectorExit(child, binding, ports);
    return "spawned";
  });
  if (prepared !== "spawned") return prepared;
  const stopThisGeneration = async (): Promise<void> => {
    await withConnectorSupervisorLock(async () => {
      if (ownsProcess(binding)) await stop();
    });
  };
  const deadline = ports.now() + READY_DEADLINE_MS;
  while (ports.now() < deadline) {
    const ready = await verifiedProbe(url, session.connectorToken, ports, deadline - ports.now());
    if (!isCurrent()) return { ok: false, code: "connector_failed" };
    if (ready === "timeout") {
      await stopThisGeneration();
      return { ok: false, code: "connector_failed" };
    }
    if (ready) {
      if (!ready.ok) await stopThisGeneration();
      return ready;
    }
    await ports.sleep(PROBE_INTERVAL_MS);
  }
  await stopThisGeneration();
  return { ok: false, code: "connector_failed" };
}

/**
 * Health WITHOUT tearing the connector down (#1087).
 *
 * The bridge health check has to own the Telegram session, so running it
 * means killing the shared connector and taking every in-flight agent call
 * with it. When the connector is up and ours, ask IT instead: `get_me` over
 * the verified read-only surface needs a live, authorized Telethon client, so
 * a parseable answer proves exactly what the bridge would have proved.
 *
 * `null` means this process could not answer at all (not ours, not
 * verifiable, the handshake failed). The caller then falls back to the
 * destructive bridge check — which is free at that point, because a connector
 * that cannot even complete an MCP handshake is not serving anyone either.
 *
 * `"busy"` is the case that used to be conflated with `null` and cost exactly
 * the outage this issue reports: the connector answered the handshake, so it
 * is alive, ours, and still serving — it just did not finish `get_me` inside
 * the budget, which is what a process in the middle of a fan-out of large
 * reads looks like. A missed health deadline is not evidence that anything
 * finished, so nothing may be torn down and no verdict is reached; the caller
 * leaves the durable status alone and asks again later.
 *
 * Only the account's display name and public username are lifted out of the
 * answer; `get_me` may also carry the account's phone number, which never
 * crosses this boundary.
 */
export async function telegramConnectorHealth(
  session: StoredTelegramSession,
  ports: TelegramConnectorPorts = realPorts,
): Promise<ConnectorLiveHealth | "busy" | null> {
  const ownsProcess = ports.ownsProcess ?? ownsRecordedConnector;
  const binding = { credentialRef: session.credentialRef, connectorToken: session.connectorToken };
  if (!ownsProcess(binding)) return null;
  const callTool = ports.callTool;
  if (!callTool) return null;
  const url = telegramMcpUrl();
  const budget: TelegramConnectorPorts = { ...ports, probeTimeoutMs: ports.probeTimeoutMs ?? HEALTH_TIMEOUT_MS };
  const verified = await verifiedProbe(url, session.connectorToken, budget);
  /* A handshake that ran out of budget did not get refused: the listener is
     there and the event loop is simply saturated, which is the fan-out this
     issue is about. A handshake that failed outright (refused socket, wrong
     proof, a surface that is no longer read-only) is a real refusal. */
  if (verified === "timeout") return "busy";
  if (verified === null || !verified.ok) return null;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const answer = await Promise.race([
    callTool(url, session.connectorToken, "get_me", controller.signal).catch(() => null),
    new Promise<"busy">((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve("busy"); }, budget.probeTimeoutMs!);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  controller.abort();
  if (answer === "busy") return "busy";
  /* An answer that is not the account — an upstream error string, a dead
     call — is no verdict: the bridge check must still get its chance to
     classify an expired or deauthorized session, which `get_me` cannot. */
  const identity = parseConnectorIdentity(answer);
  return identity ? { status: "connected", identity } : null;
}

/** `get_me` answers with the vendored `format_entity` JSON. Anything else —
    an error string, a truncated body — is not a health verdict. */
function parseConnectorIdentity(answer: string | null): TelegramIdentity | null {
  if (!answer) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(answer); } catch { return null; }
  if (!parsed || typeof parsed !== "object") return null;
  const row = parsed as { id?: unknown; name?: unknown; username?: unknown };
  if (typeof row.id !== "number" && typeof row.id !== "string") return null;
  return {
    name: typeof row.name === "string" && row.name ? row.name : "Telegram account",
    username: typeof row.username === "string" && row.username ? row.username : null,
  };
}

/** Stops the shared connector — the recorded process, whichever Viewer
    generation spawned it. Idempotent; a stale or recycled pid is ignored. */
export async function stopTelegramConnector(): Promise<void> {
  await withConnectorSupervisorLock(stopRealConnectorUnlocked);
}
