import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

import { statePath } from "@/lib/configDir";
import { procBackend } from "@/lib/proc";
import { withFileTransaction } from "@/lib/state/fileTransaction";

import type { TelegramConnectorRestarts, TelegramErrorCode, TelegramIdentity } from "./contracts";
import { connectorLaunchSpec, telegramApiCredentials, telegramMcpServerPath, telegramMcpUrl, telegramVenvPython, type ProcessSpec } from "./packaging";
import { ensureTelegramStateDir, readTelegramSession, type StoredTelegramSession } from "./sessionStore";

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
const STDERR_TAIL_LINES = 20;
const STDERR_TAIL_BYTES = 8_192;
const CRASH_LOG_KEEP_LINES = 50;
const DAY_MS = 24 * 60 * 60 * 1_000;
/* A crashing connector is restarted, but never in a hot loop: more than
   RESTART_BURST_LIMIT crashes inside RESTART_BURST_WINDOW_MS means the process
   cannot stay up, and hammering it would only add noise to the crash log. */
const RESTART_BURST_WINDOW_MS = 15 * 60 * 1_000;
const RESTART_BURST_LIMIT = 5;
const RESTART_DELAY_MS = 500;
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

/** Append-only owner-only sink for the connector's stderr, truncated at every
    spawn so the tail a crash record quotes is that process's own output. */
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

/** The last lines the connector printed before it died. Bounded twice (bytes
    read, then lines kept) so a runaway log can never be loaded whole. */
function connectorStderrTail(): string[] {
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
        .map((line) => (line.length > 400 ? `${line.slice(0, 400)}…` : line));
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
  stderr: string[];
};

type ConnectorRestartState = {
  version: 1;
  /** ISO timestamps of crash restarts, trimmed to the last 24 h. */
  restarts: string[];
  lastCrashAt: string | null;
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
  const empty: ConnectorRestartState = { version: 1, restarts: [], lastCrashAt: null };
  try {
    if (ensureTelegramStateDir(false) === null) return empty;
    const row = JSON.parse(fs.readFileSync(telegramStateFile(RESTART_STATE_FILE), "utf8")) as Partial<ConnectorRestartState>;
    if (row.version !== 1 || !Array.isArray(row.restarts)) return empty;
    return {
      version: 1,
      restarts: row.restarts.filter((value): value is string => typeof value === "string"),
      lastCrashAt: typeof row.lastCrashAt === "string" ? row.lastCrashAt : null,
    };
  } catch {
    return empty;
  }
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

function recordConnectorCrash(crash: ConnectorCrashRecord): void {
  try {
    if (ensureTelegramStateDir(true) === null) return;
    const path = telegramStateFile(CRASH_LOG_FILE);
    let existing: string[] = [];
    try {
      existing = fs.readFileSync(path, "utf8").split("\n").filter((line) => line.length > 0);
    } catch { /* first crash */ }
    const lines = [...existing, JSON.stringify(crash)].slice(-CRASH_LOG_KEEP_LINES);
    writeOwnerOnlyFile(path, `${lines.join("\n")}\n`);
  } catch { /* an unrecordable crash must not break the restart */ }
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

function noteCrashRestart(at: number): void {
  const state = readRestartState();
  const restarts = [...withinLast(state.restarts, DAY_MS, at), new Date(at).toISOString()];
  writeOwnerOnlyFile(telegramStateFile(RESTART_STATE_FILE), JSON.stringify({
    version: 1,
    restarts,
    lastCrashAt: new Date(at).toISOString(),
  } satisfies ConnectorRestartState));
}

/** True while the connector keeps crashing faster than restarting it can
    help — the restart stops there and the crash log holds the reason. */
function restartBurstExhausted(now: number): boolean {
  return withinLast(readRestartState().restarts, RESTART_BURST_WINDOW_MS, now).length >= RESTART_BURST_LIMIT;
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
    recordConnectorCrash({
      at: new Date(at).toISOString(),
      pid,
      exitCode: code,
      signal: signal ?? null,
      stderr: connectorStderrTail(),
    });
    void restartAfterCrash(binding, ports, at);
  });
}

async function restartAfterCrash(binding: ConnectorBinding, ports: TelegramConnectorPorts, at: number): Promise<void> {
  if (restartBurstExhausted(at)) return;
  restartsInFlight += 1;
  try {
    await ports.sleep(ports.restartDelayMs ?? RESTART_DELAY_MS);
    let session: StoredTelegramSession | null = null;
    try { session = readTelegramSession(); } catch { session = null; }
    /* A credential the operator deleted or replaced is never resurrected, and
       a restart that does not happen is not counted. */
    if (!session || session.credentialRef !== binding.credentialRef) return;
    noteCrashRestart(ports.now());
    await ensureTelegramConnector(session, ports);
  } catch { /* the crash log already carries why; the next status read retries */ }
  finally {
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
 */
export async function ensureTelegramConnector(
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
 * `null` means this process could not answer (not ours, not verifiable, the
 * call failed). The caller then falls back to the destructive bridge check —
 * which is free at that point, because a connector that cannot answer is not
 * serving anyone either.
 *
 * Only the account's display name and public username are lifted out of the
 * answer; `get_me` may also carry the account's phone number, which never
 * crosses this boundary.
 */
export async function telegramConnectorHealth(
  session: StoredTelegramSession,
  ports: TelegramConnectorPorts = realPorts,
): Promise<ConnectorLiveHealth | null> {
  const ownsProcess = ports.ownsProcess ?? ownsRecordedConnector;
  const binding = { credentialRef: session.credentialRef, connectorToken: session.connectorToken };
  if (!ownsProcess(binding)) return null;
  const callTool = ports.callTool;
  if (!callTool) return null;
  const url = telegramMcpUrl();
  const budget: TelegramConnectorPorts = { ...ports, probeTimeoutMs: ports.probeTimeoutMs ?? HEALTH_TIMEOUT_MS };
  const verified = await verifiedProbe(url, session.connectorToken, budget);
  if (verified === null || verified === "timeout" || !verified.ok) return null;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const answer = await Promise.race([
    callTool(url, session.connectorToken, "get_me", controller.signal).catch(() => null),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve(null); }, budget.probeTimeoutMs!);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
  controller.abort();
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
