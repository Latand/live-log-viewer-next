import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

import { statePath } from "@/lib/configDir";
import { procBackend } from "@/lib/proc";
import { withFileTransaction } from "@/lib/state/fileTransaction";

import type { TelegramErrorCode } from "./contracts";
import { connectorLaunchSpec, TELEGRAM_BURST_CONSUMING_TOOLS, telegramApiCredentials, telegramMcpServerPath, telegramMcpUrl, telegramVenvPython, type ProcessSpec } from "./packaging";
import { ensureTelegramStateDir, telegramIncomingFeedPath, type StoredTelegramSession } from "./sessionStore";

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
 *  - every tool name must be on {@link TELEGRAM_FEED_EXPOSED_TOOLS}: the
 *    reviewed list of tools whose implementations were audited to perform no
 *    server-side mutation ({@link TELEGRAM_READ_TOOL_ALLOWLIST}), MINUS the
 *    ones this connector withholds. The annotation alone is NOT trusted:
 *    upstream shipped `get_invite_link`/`export_chat_invite` annotated
 *    read-only while minting invite links (see
 *    vendor/telegram-mcp/PROVENANCE.md), which is exactly the failure an
 *    annotation-only check cannot catch.
 *
 * A surface violating either bound is refused and reported `not_read_only`.
 * That includes a still-advertised burst consumer (#1091): the connector runs
 * the incoming event feed, the entrypoint withholds the tools that would race
 * it for the same bursts, and this gate is what proves the withholding
 * happened rather than trusting that it did. A listener that predates the
 * withholding fails verification once and is replaced by one that has it.
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

/** The surface a connector running the incoming feed may advertise (#1091):
    the audited read set MINUS every tool that consumes a settled burst. The
    audited set itself stays whole — those tools write nothing, and they are
    the right surface for a connector with no feed to compete with — so the
    vendor-parity check above keeps meaning what it says. */
export const TELEGRAM_FEED_EXPOSED_TOOLS: ReadonlySet<string> = new Set(
  [...TELEGRAM_READ_TOOL_ALLOWLIST].filter((name) => !TELEGRAM_BURST_CONSUMING_TOOLS.includes(name)),
);

export type ConnectorProbe =
  | { ok: true; serverName: string; tools: Array<{ name: string; readOnly: boolean }> }
  | { ok: false };

export type ConnectorEnsureResult = { ok: true; url: string } | { ok: false; code: TelegramErrorCode };

type ConnectorChild = { pid?: number; kill(signal?: NodeJS.Signals): boolean };
type ConnectorBinding = Pick<StoredTelegramSession, "credentialRef" | "connectorToken">;

export interface TelegramConnectorPorts {
  spawn(spec: ProcessSpec): ConnectorChild | null;
  probe(url: string, connectorToken: string, signal?: AbortSignal): Promise<ConnectorProbe>;
  sleep(ms: number): Promise<void>;
  now(): number;
  ownsProcess?(binding: ConnectorBinding): boolean;
  /** Whether the recorded process is the generation that runs the incoming
      event feed the Daily Report reads (#1091). */
  runsFeed?(binding: ConnectorBinding): boolean;
  recordProcess?(child: ConnectorChild, spec: ProcessSpec, binding: ConnectorBinding): boolean;
  stop?(): Promise<void> | void;
  beginOperation?(): () => boolean;
  probeTimeoutMs?: number;
}

const READY_DEADLINE_MS = 30_000;
const PROBE_INTERVAL_MS = 500;
const PROBE_TIMEOUT_MS = 5_000;
const TERMINATION_GRACE_MS = 2_000;
const TERMINATION_KILL_MS = 2_000;
const TERMINATION_POLL_MS = 25;
const PID_FILE = "connector.json";
const CONNECTOR_LOG_FILE = "connector.log";
const CONNECTOR_LOG_TRIM_INTERVAL_MS = 1_000;
export const TELEGRAM_CONNECTOR_LOG_MAX_BYTES = 256 * 1024;

/** The read-only gate, pure so it is directly provable: one tool that lacks
    an affirmative readOnlyHint OR falls outside the exposed allowlist fails
    the whole surface; an empty surface proves nothing and fails too. Every
    connector the Viewer launches or adopts runs the feed, so the default
    allowlist is the withheld one. */
export function verifyReadOnlyTools(
  tools: Array<{ name: string; readOnly: boolean }>,
  allowlist: ReadonlySet<string> = TELEGRAM_FEED_EXPOSED_TOOLS,
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

const realPorts: TelegramConnectorPorts = {
  spawn(spec) {
    const logFd = connectorLogDescriptor();
    if (logFd === null) return null;
    try {
      const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["ignore", logFd, logFd], detached: true });
      child.unref();
      startConnectorLogMaintenance();
      return child;
    } catch {
      return null;
    } finally {
      try { fs.closeSync(logFd); } catch { /* already closed */ }
    }
  },
  probe: probeTelegramConnector,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  ownsProcess: ownsRecordedConnector,
  runsFeed: recordedConnectorRunsFeed,
  recordProcess: recordConnectorProcess,
  stop: stopRealConnectorUnlocked,
  beginOperation: beginConnectorOperation,
};

function pidFilePath(): string {
  return statePath("telegram", PID_FILE);
}

export function telegramConnectorLogPath(): string {
  return statePath("telegram", CONNECTOR_LOG_FILE);
}

function openConnectorLog(flags: number): number | null {
  let fd: number | null = null;
  try {
    ensureTelegramStateDir(true);
    const noFollow = "O_NOFOLLOW" in fs.constants ? fs.constants.O_NOFOLLOW : 0;
    fd = fs.openSync(telegramConnectorLogPath(), flags | fs.constants.O_CREAT | noFollow, 0o600);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      fs.closeSync(fd);
      return null;
    }
    return fd;
  } catch {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
    return null;
  }
}

/** Keep the tail in place so an inherited append fd remains valid. */
export function trimTelegramConnectorLog(): boolean {
  const fd = openConnectorLog(fs.constants.O_RDWR);
  if (fd === null) return false;
  try {
    const stat = fs.fstatSync(fd);
    if (stat.size <= TELEGRAM_CONNECTOR_LOG_MAX_BYTES) return true;
    const tail = Buffer.alloc(TELEGRAM_CONNECTOR_LOG_MAX_BYTES);
    fs.readSync(fd, tail, 0, tail.length, stat.size - tail.length);
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, tail, 0, tail.length, 0);
    return true;
  } catch {
    return false;
  } finally {
    try { fs.closeSync(fd); } catch { /* already closed */ }
  }
}

function connectorLogDescriptor(): number | null {
  if (!trimTelegramConnectorLog()) return null;
  return openConnectorLog(fs.constants.O_WRONLY | fs.constants.O_APPEND);
}

type ConnectorRecord = {
  version: 1;
  pid: number;
  identity: string;
  credentialRef: string;
  connectorTokenSha256: string;
  command: string;
  entrypoint: string;
  /** The event feed file this process was launched with (#1091), absent on a
      record written before the feed existed. Optional on purpose: a record
      that cannot be parsed is a connector that cannot be STOPPED, so the
      feed is a condition of ADOPTION rather than of reading the record. */
  feedFile?: string;
  /** ISO instant this feed listener started, which is the earliest moment its
      feed can vouch for (#1091). Optional for the same reason as `feedFile`. */
  feedSince?: string;
};

let liveConnectorChild: {
  child: ConnectorChild;
  pid: number;
  identity: string;
} | null = null;
let supervisorGeneration = 0;
let connectorLogTrimTimer: ReturnType<typeof setInterval> | null = null;

function startConnectorLogMaintenance(): void {
  if (connectorLogTrimTimer) return;
  connectorLogTrimTimer = setInterval(() => { trimTelegramConnectorLog(); }, CONNECTOR_LOG_TRIM_INTERVAL_MS);
  connectorLogTrimTimer.unref?.();
}

function stopConnectorLogMaintenance(): void {
  if (!connectorLogTrimTimer) return;
  clearInterval(connectorLogTrimTimer);
  connectorLogTrimTimer = null;
}

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
    if (row.feedFile !== undefined && typeof row.feedFile !== "string") return null;
    if (row.feedSince !== undefined && typeof row.feedSince !== "string") return null;
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

/**
 * Whether the recorded connector is one that runs the incoming event feed
 * (#1091).
 *
 * The feed is child ENVIRONMENT, so no probe and no argv can prove it: the
 * record written at spawn is the evidence, and a record from a Viewer
 * generation that predates the feed simply has none. Such a process is fully
 * functional as a read surface, which is why it was adopted happily — and
 * exactly why it had to be caught: its `incoming_feed_status` reports a feed
 * that will never start, and the report's dialog discovery would fall back to
 * a bounded walk over a list that is not ordered by recency.
 *
 * The comparison is against THIS credential generation's feed, so a listener
 * still writing a previous account's file is ineligible on the same evidence
 * as a listener writing none.
 */
function recordedConnectorRunsFeed(binding: ConnectorBinding): boolean {
  const record = readConnectorRecord();
  return record?.feedFile === telegramIncomingFeedPath(binding.credentialRef);
}

/**
 * The earliest instant this credential generation's feed can vouch for, or
 * `null` when nothing proves one (#1091).
 *
 * A report asks the feed for "the dialogs active since the last run", and the
 * feed can only answer for the time it was LISTENING. The file itself cannot
 * say when that began — it is append-only across connector generations, so a
 * line older than the current listener proves nothing about the quiet stretch
 * between them — and `incoming_feed_status` reports only that a feed is
 * running, never since when. The record written at spawn is the durable
 * evidence, and a listener adopted across a Viewer restart keeps the record it
 * was spawned with, so an uninterrupted listener keeps its original coverage
 * while a replaced one starts a new one at its own spawn.
 *
 * Coverage is claimed from the spawn rather than from the readiness probe a
 * few seconds later, which is the only direction that can overstate it — by
 * the seconds a connector takes to reach Telegram. What the caller does with
 * this is decide whether a window is covered at all; a boundary that lands
 * inside those seconds is not the omission class this exists to catch.
 */
export function connectorFeedCoverageSince(credentialRef: string): number | null {
  const record = readConnectorRecord();
  if (!record || record.feedFile !== telegramIncomingFeedPath(credentialRef) || !record.feedSince) return null;
  const since = Date.parse(record.feedSince);
  return Number.isFinite(since) ? since : null;
}

function ownsRecordedConnector(binding: ConnectorBinding): boolean {
  const record = readConnectorRecord();
  return Boolean(record
    && record.credentialRef === binding.credentialRef
    && record.connectorTokenSha256 === connectorTokenSha256(binding.connectorToken)
    && procBackend.processIdentity(record.pid) === record.identity
    && connectorArgvMatches(record));
}

/** Whether this credential generation still owns the recorded live process. */
export function telegramConnectorOwnsSession(session: ConnectorBinding): boolean {
  return ownsRecordedConnector(session);
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
    /* The feed and the instant it starts covering are recorded together: a
       feed file with no start stamp vouches for nothing (#1091). */
    ...(spec.env?.TELEGRAM_EVENT_FEED_FILE
      ? { feedFile: spec.env.TELEGRAM_EVENT_FEED_FILE, feedSince: new Date().toISOString() }
      : {}),
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
  stopConnectorLogMaintenance();
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
 * one across Viewer restarts — PROVIDED its record proves it runs the incoming
 * event feed (#1091). One that does not is replaced, once.
 */
export async function ensureTelegramConnector(
  session: StoredTelegramSession,
  ports: TelegramConnectorPorts = realPorts,
): Promise<ConnectorEnsureResult> {
  if (ports === realPorts) startConnectorLogMaintenance();
  const url = telegramMcpUrl();
  const binding = { credentialRef: session.credentialRef, connectorToken: session.connectorToken };
  const stop = ports.stop ?? stopRealConnectorUnlocked;
  const ownsProcess = ports.ownsProcess ?? ownsRecordedConnector;
  const runsFeed = ports.runsFeed ?? recordedConnectorRunsFeed;
  let isCurrent = ports.beginOperation?.() ?? (() => true);
  const prepared = await withConnectorSupervisorLock(async (): Promise<ConnectorEnsureResult | "spawned"> => {
    if (ownsProcess(binding) && runsFeed(binding)) {
      const adopted = await verifiedProbe(url, session.connectorToken, ports);
      if (!isCurrent()) return { ok: false, code: "connector_failed" };
      if (adopted && adopted !== "timeout") {
        if (!adopted.ok) await stop();
        return adopted;
      }
    }
    /* Missing ownership, a credential-generation mismatch, or a process
       launched without the incoming event feed (#1091) makes any current
       listener ineligible for adoption — the last of those because the report's
       dialog discovery reads that feed, and a connector that records nothing
       would send it back to a bounded walk over a list ordered by pins. Stop
       and record the replacement while holding the cross-process supervisor
       lock, so another Viewer generation can only adopt the one durable
       winner. */
    await stop();
    isCurrent = ports.beginOperation?.() ?? (() => true);
    const credentials = telegramApiCredentials();
    if (!credentials) return { ok: false, code: "credentials_missing" };
    const spec = connectorLaunchSpec({ credentialRef: session.credentialRef, sessionString: session.sessionString, connectorToken: session.connectorToken, credentials });
    if (!isCurrent()) return { ok: false, code: "connector_failed" };
    const child = ports.spawn(spec);
    if (!child) return { ok: false, code: "connector_failed" };
    const recordProcess = ports.recordProcess ?? recordConnectorProcess;
    if (!recordProcess(child, spec, binding)) {
      terminateChildImmediately(child);
      return { ok: false, code: "connector_failed" };
    }
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

/** Stops the shared connector — the recorded process, whichever Viewer
    generation spawned it. Idempotent; a stale or recycled pid is ignored. */
export async function stopTelegramConnector(): Promise<void> {
  await withConnectorSupervisorLock(stopRealConnectorUnlocked);
}

/** Stops the recorded connector only while it still belongs to this
    credential generation. The ownership check and stop share the supervisor
    lock so another Viewer cannot replace the connector between them. */
export async function stopTelegramConnectorForSession(
  session: ConnectorBinding,
  ports: Pick<TelegramConnectorPorts, "ownsProcess" | "stop"> = {},
): Promise<boolean> {
  const ownsProcess = ports.ownsProcess ?? ownsRecordedConnector;
  const stop = ports.stop ?? stopRealConnectorUnlocked;
  return await withConnectorSupervisorLock(async () => {
    if (!ownsProcess(session)) return false;
    await stop();
    return true;
  });
}
