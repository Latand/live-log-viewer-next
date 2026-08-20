import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";

import { statePath } from "@/lib/configDir";
import { procBackend } from "@/lib/proc";
import { withFileTransaction } from "@/lib/state/fileTransaction";

import type { TelegramErrorCode } from "./contracts";
import { connectorLaunchSpec, telegramApiCredentials, telegramMcpServerPath, telegramMcpUrl, telegramVenvPython, type ProcessSpec } from "./packaging";
import { ensureTelegramStateDir, type StoredTelegramSession } from "./sessionStore";

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

type ConnectorChild = { pid?: number; kill(signal?: NodeJS.Signals): boolean };
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
}

const READY_DEADLINE_MS = 30_000;
const PROBE_INTERVAL_MS = 500;
const PROBE_TIMEOUT_MS = 5_000;
const TERMINATION_GRACE_MS = 2_000;
const TERMINATION_KILL_MS = 2_000;
const TERMINATION_POLL_MS = 25;
const PID_FILE = "connector.json";

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

const realPorts: TelegramConnectorPorts = {
  spawn(spec) {
    try {
      const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["ignore", "ignore", "ignore"], detached: true });
      child.unref();
      return child;
    } catch {
      return null;
    }
  },
  probe: probeTelegramConnector,
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
