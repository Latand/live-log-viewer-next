import { spawn } from "node:child_process";
import fs from "node:fs";

import { statePath } from "@/lib/configDir";
import { procBackend } from "@/lib/proc";

import type { TelegramErrorCode } from "./contracts";
import { connectorLaunchSpec, telegramApiCredentials, telegramMcpUrl, type ProcessSpec } from "./packaging";
import { ensureTelegramStateDir } from "./sessionStore";

/**
 * Supervisor for the ONE shared loopback connector process (issue #1059).
 *
 * Exactly one `telegram-mcp` serves the account: agent sessions and Viewer
 * candidates never start their own copy — they reach the registered
 * streamable-HTTP URL. Before a spawned process is considered ready (and
 * before an already-listening one is adopted), its advertised tool surface is
 * verified against TWO independent bounds:
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
 *
 * The spawned pid and its portable process identity persist in
 * `<state>/telegram/connector.json`, so a LATER Viewer generation — the one
 * actually handling the logout or local deletion — can stop the connector it
 * adopted rather than only one it spawned itself. Identity comes from the
 * platform `procBackend` (kernel start token on Linux, the darwin identity on
 * macOS), plus an argv check, so a recycled pid is never signaled.
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

export interface TelegramConnectorPorts {
  spawn(spec: ProcessSpec): { pid?: number; kill(signal?: NodeJS.Signals): boolean } | null;
  probe(url: string): Promise<ConnectorProbe>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

const READY_DEADLINE_MS = 30_000;
const PROBE_INTERVAL_MS = 500;
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
export async function probeTelegramConnector(url: string): Promise<ConnectorProbe> {
  try {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const client = new Client({ name: "agent-log-viewer", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(url));
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
};

function pidFilePath(): string {
  return statePath("telegram", PID_FILE);
}

function looksLikeConnector(pid: number): boolean {
  const argv = procBackend.readArgv(pid);
  return argv.some((part) => /python/.test(part) || /main\.py$/.test(part));
}

function recordConnectorPid(pid: number | undefined): void {
  if (!pid) return;
  const identity = procBackend.processIdentity(pid);
  if (!identity) return;
  try {
    ensureTelegramStateDir(true);
    fs.writeFileSync(pidFilePath(), JSON.stringify({ pid, identity }), { mode: 0o600 });
  } catch { /* an unrecorded pid only weakens cross-generation stop */ }
}

function killRecordedConnector(): void {
  let recorded: { pid?: unknown; identity?: unknown };
  try { recorded = JSON.parse(fs.readFileSync(pidFilePath(), "utf8")) as { pid?: unknown; identity?: unknown }; }
  catch { return; }
  fs.rmSync(pidFilePath(), { force: true });
  const pid = recorded.pid;
  const identity = recorded.identity;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1 || typeof identity !== "string") return;
  if (procBackend.processIdentity(pid) !== identity || !looksLikeConnector(pid)) return;
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  setTimeout(() => {
    if (procBackend.processIdentity(pid) === identity) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }, 2_000).unref?.();
}

async function verifiedProbe(url: string, ports: TelegramConnectorPorts): Promise<ConnectorEnsureResult | null> {
  const probe = await ports.probe(url);
  if (!probe.ok) return null;
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
  sessionString: string,
  ports: TelegramConnectorPorts = realPorts,
): Promise<ConnectorEnsureResult> {
  const url = telegramMcpUrl();
  const adopted = await verifiedProbe(url, ports);
  if (adopted) {
    if (!adopted.ok) stopTelegramConnector();
    return adopted;
  }
  const credentials = telegramApiCredentials();
  if (!credentials) return { ok: false, code: "credentials_missing" };
  const child = ports.spawn(connectorLaunchSpec({ sessionString, credentials }));
  if (!child) return { ok: false, code: "connector_failed" };
  recordConnectorPid(child.pid);
  const deadline = ports.now() + READY_DEADLINE_MS;
  while (ports.now() < deadline) {
    const ready = await verifiedProbe(url, ports);
    if (ready) {
      if (!ready.ok) stopTelegramConnector();
      return ready;
    }
    await ports.sleep(PROBE_INTERVAL_MS);
  }
  stopTelegramConnector();
  return { ok: false, code: "connector_failed" };
}

/** Stops the shared connector — the recorded process, whichever Viewer
    generation spawned it. Idempotent; a stale or recycled pid is ignored. */
export function stopTelegramConnector(): void {
  killRecordedConnector();
}
