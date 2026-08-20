import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-telegram-connector-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
const OLD_API_ID = process.env.LLV_TELEGRAM_API_ID;
const OLD_API_HASH = process.env.LLV_TELEGRAM_API_HASH;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.LLV_TELEGRAM_API_ID = "12345";
process.env.LLV_TELEGRAM_API_HASH = "0123456789abcdef0123456789abcdef";

const { TELEGRAM_READ_TOOL_ALLOWLIST, connectorServerName, ensureTelegramConnector, stopTelegramConnector, verifyReadOnlyTools } = await import("./connector");
const { telegramMcpUrl, vendoredConnectorDir } = await import("./packaging");

import type { ConnectorProbe, TelegramConnectorPorts } from "./connector";

/* A placeholder with the string-session shape; never a real credential. */
const PLACEHOLDER_SESSION = "1ApWapzMBu4placeholder-not-a-real-session";
const CONNECTOR_SESSION = {
  version: 1 as const,
  credentialRef: "credential-generation-a",
  connectorToken: "A".repeat(43),
  sessionString: PLACEHOLDER_SESSION,
  savedAt: "2026-08-20T12:00:00.000Z",
};

const READ_ONLY: ConnectorProbe = {
  ok: true,
  serverName: connectorServerName(CONNECTOR_SESSION.connectorToken),
  tools: [
    { name: "get_me", readOnly: true },
    { name: "list_chats", readOnly: true },
  ],
};

function fakePorts(script: Array<ConnectorProbe | null>, options: { spawnFails?: boolean; owned?: boolean; recordFails?: boolean } = {}) {
  const calls = { spawns: 0, probes: 0, stops: 0, kills: [] as Array<NodeJS.Signals | undefined>, probeTokens: [] as string[] };
  let clock = 0;
  const ports: TelegramConnectorPorts = {
    spawn: () => {
      calls.spawns += 1;
      /* A real pid this test owns, so the /proc start-token fence records it. */
      return options.spawnFails ? null : { pid: process.pid, kill: (signal?: NodeJS.Signals) => { calls.kills.push(signal); return true; } };
    },
    probe: async (_url, connectorToken) => {
      calls.probes += 1;
      calls.probeTokens.push(connectorToken);
      return script.shift() ?? { ok: false };
    },
    sleep: async () => { clock += 10_000; },
    now: () => clock,
    ownsProcess: () => options.owned ?? false,
    stop: () => { calls.stops += 1; stopTelegramConnector(); },
    ...(options.recordFails ? { recordProcess: () => false } : {}),
  };
  return { ports, calls };
}

beforeEach(() => {
  stopTelegramConnector();
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
});
afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = OLD_STATE;
  if (OLD_API_ID === undefined) delete process.env.LLV_TELEGRAM_API_ID; else process.env.LLV_TELEGRAM_API_ID = OLD_API_ID;
  if (OLD_API_HASH === undefined) delete process.env.LLV_TELEGRAM_API_HASH; else process.env.LLV_TELEGRAM_API_HASH = OLD_API_HASH;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("every advertised tool must carry an affirmative readOnlyHint AND be on the audited allowlist", () => {
  expect(verifyReadOnlyTools([{ name: "get_me", readOnly: true }]).ok).toBe(true);
  const mixed = verifyReadOnlyTools([
    { name: "get_me", readOnly: true },
    { name: "send_message", readOnly: false },
  ]);
  expect(mixed.ok).toBe(false);
  expect(mixed.offending).toEqual(["send_message"]);
  /* The annotation alone is NOT sufficient: a tool CLAIMING readOnly whose
     name is outside the audited allowlist is refused — this is exactly the
     upstream get_invite_link failure (a read-annotated invite-link mint). */
  const claimed = verifyReadOnlyTools([
    { name: "get_me", readOnly: true },
    { name: "get_invite_link", readOnly: true },
  ]);
  expect(claimed.ok).toBe(false);
  expect(claimed.offending).toEqual(["get_invite_link"]);
  expect(verifyReadOnlyTools([{ name: "export_chat_invite", readOnly: true }]).ok).toBe(false);
  /* An empty tool list proves nothing and fails closed. */
  expect(verifyReadOnlyTools([]).ok).toBe(false);
});

test("the allowlist equals the vendored registry's read-only surface, minus nothing", () => {
  /* Re-derive the read-annotated tool set from the ACTUAL vendored source, so
     a vendor bump that adds or re-annotates a tool cannot silently diverge
     from the audited allowlist — parity failure forces a fresh audit. */
  const toolsDir = path.join(vendoredConnectorDir(), "telegram_mcp", "tools");
  const registry = new Set<string>();
  for (const file of fs.readdirSync(toolsDir).filter((name) => name.endsWith(".py"))) {
    const text = fs.readFileSync(path.join(toolsDir, file), "utf8");
    for (const chunk of text.split(/(?=@mcp\.tool\()/)) {
      const head = chunk.split("async def")[0]!;
      if (!head.includes("readOnlyHint=True")) continue;
      const name = chunk.match(/async def (\w+)\(/)?.[1];
      if (name) registry.add(name);
    }
  }
  expect([...registry].sort()).toEqual([...TELEGRAM_READ_TOOL_ALLOWLIST].sort());
  /* The two disproven upstream annotations stay patched off the read surface
     (vendor/telegram-mcp/PROVENANCE.md) and off the allowlist. */
  for (const disproven of ["get_invite_link", "export_chat_invite"]) {
    expect(registry.has(disproven)).toBe(false);
    expect(TELEGRAM_READ_TOOL_ALLOWLIST.has(disproven)).toBe(false);
  }
});

test("an already-listening read-only connector is adopted, never duplicated", async () => {
  const { ports, calls } = fakePorts([READ_ONLY], { owned: true });
  const result = await ensureTelegramConnector(CONNECTOR_SESSION, ports);
  expect(result).toEqual({ ok: true, url: telegramMcpUrl() });
  expect(calls.spawns).toBe(0);
  expect(calls.probeTokens).toEqual([CONNECTOR_SESSION.connectorToken]);
});

test("spawns once, waits for readiness, records the pid for later generations", async () => {
  const { ports, calls } = fakePorts([null, null, READ_ONLY]);
  const result = await ensureTelegramConnector(CONNECTOR_SESSION, ports);
  expect(result.ok).toBe(true);
  expect(calls.spawns).toBe(1);
  const pidFile = path.join(process.env.LLV_STATE_DIR!, "telegram", "connector.json");
  const recorded = JSON.parse(fs.readFileSync(pidFile, "utf8")) as { pid: number; identity: string; credentialRef: string; connectorTokenSha256: string };
  expect(recorded.pid).toBe(process.pid);
  expect(recorded.credentialRef).toBe(CONNECTOR_SESSION.credentialRef);
  expect(recorded.connectorTokenSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(fs.readFileSync(pidFile, "utf8")).not.toContain(CONNECTOR_SESSION.connectorToken);
  /* The portable backend's identity token, not a raw /proc read — the same
     value works on Linux and macOS. */
  expect(typeof recorded.identity).toBe("string");
  expect(recorded.identity.length).toBeGreaterThan(0);

  /* Even if the durable record disappears later, the retained child handle
     still makes local deletion able to terminate this generation. */
  fs.rmSync(pidFile);
  stopTelegramConnector();
  expect(fs.existsSync(pidFile)).toBe(false);
  expect(calls.kills).toContain("SIGTERM");
});

test("a connector advertising a non-read-only tool is refused", async () => {
  const withWrite: ConnectorProbe = {
    ok: true,
    serverName: connectorServerName(CONNECTOR_SESSION.connectorToken),
    tools: [{ name: "get_me", readOnly: true }, { name: "send_message", readOnly: false }],
  };
  const { ports, calls } = fakePorts([null, withWrite]);
  const result = await ensureTelegramConnector(CONNECTOR_SESSION, ports);
  expect(result).toEqual({ ok: false, code: "not_read_only" });
  expect(calls.spawns).toBe(1);
});

test("a connector that never becomes ready reports connector_failed", async () => {
  const { ports } = fakePorts([]);
  const result = await ensureTelegramConnector(CONNECTOR_SESSION, ports);
  expect(result).toEqual({ ok: false, code: "connector_failed" });
});

test("a spawn failure reports connector_failed without probing forever", async () => {
  const { ports } = fakePorts([null], { spawnFails: true });
  const result = await ensureTelegramConnector(CONNECTOR_SESSION, ports);
  expect(result).toEqual({ ok: false, code: "connector_failed" });
});

test("the launch env — not this test's env — carries the session; argv never does", async () => {
  const { connectorLaunchSpec } = await import("./packaging");
  const spec = connectorLaunchSpec({
    sessionString: PLACEHOLDER_SESSION,
    connectorToken: CONNECTOR_SESSION.connectorToken,
    credentials: { apiId: "12345", apiHash: "0123456789abcdef0123456789abcdef" },
  });
  expect(spec.args.join(" ")).not.toContain(PLACEHOLDER_SESSION);
  expect(spec.args.join(" ")).not.toContain(CONNECTOR_SESSION.connectorToken);
  expect(spec.env.TELEGRAM_SESSION_STRING).toBe(PLACEHOLDER_SESSION);
  expect(spec.env.TELEGRAM_EXPOSED_TOOLS).toBe("read-only");
  expect(spec.env.MCP_TRANSPORT).toBe("http");
  expect(spec.env.MCP_HOST).toBe("127.0.0.1");
  expect(spec.env.LLV_TELEGRAM_MCP_TOKEN).toBe(CONNECTOR_SESSION.connectorToken);
  expect(spec.args).toEqual([expect.stringContaining("telegram-mcp-server.py")]);
});

test("an allowlisted foreign listener is never adopted", async () => {
  const foreign: ConnectorProbe = { ...READ_ONLY, serverName: "telegram" };
  const { ports, calls } = fakePorts([foreign]);
  const result = await ensureTelegramConnector(CONNECTOR_SESSION, ports);
  expect(result).toEqual({ ok: false, code: "connector_failed" });
  expect(calls.spawns).toBe(1);
  expect(calls.stops).toBeGreaterThanOrEqual(2);
});

test("a credential-generation mismatch stops the old record before spawning", async () => {
  const { ports, calls } = fakePorts([READ_ONLY], { owned: false });
  const result = await ensureTelegramConnector(CONNECTOR_SESSION, ports);
  expect(result.ok).toBe(true);
  expect(calls.stops).toBeGreaterThanOrEqual(1);
  expect(calls.spawns).toBe(1);
});

test("failed durable recording kills the live child before any probe", async () => {
  const { ports, calls } = fakePorts([READ_ONLY], { recordFails: true });
  const result = await ensureTelegramConnector(CONNECTOR_SESSION, ports);
  expect(result).toEqual({ ok: false, code: "connector_failed" });
  expect(calls.probes).toBe(0);
  expect(calls.kills).toContain("SIGKILL");
});

test("stop invalidates an in-flight connector operation", async () => {
  let generation = 0;
  let resolveProbe!: (probe: ConnectorProbe) => void;
  const probe = new Promise<ConnectorProbe>((resolve) => { resolveProbe = resolve; });
  let spawns = 0;
  const ports: TelegramConnectorPorts = {
    spawn: () => { spawns += 1; return null; },
    probe: async () => await probe,
    sleep: async () => {},
    now: () => 0,
    ownsProcess: () => true,
    beginOperation: () => {
      const current = ++generation;
      return () => current === generation;
    },
    stop: () => { generation += 1; },
  };

  const pending = ensureTelegramConnector(CONNECTOR_SESSION, ports);
  ports.stop!();
  resolveProbe(READ_ONLY);
  expect(await pending).toEqual({ ok: false, code: "connector_failed" });
  expect(spawns).toBe(0);
});

test("a stalled readiness probe is bounded and terminates the spawned child", async () => {
  const kills: Array<NodeJS.Signals | undefined> = [];
  let probeSignal: AbortSignal | undefined;
  const child = { pid: process.pid, kill: (signal?: NodeJS.Signals) => { kills.push(signal); return true; } };
  const ports: TelegramConnectorPorts = {
    spawn: () => child,
    probe: async (_url, _token, signal) => {
      probeSignal = signal;
      return await new Promise<ConnectorProbe>(() => {});
    },
    sleep: async () => {},
    now: () => 0,
    ownsProcess: () => false,
    recordProcess: () => true,
    stop: () => { child.kill("SIGTERM"); },
    probeTimeoutMs: 10,
  };

  expect(await ensureTelegramConnector(CONNECTOR_SESSION, ports)).toEqual({ ok: false, code: "connector_failed" });
  expect(probeSignal?.aborted).toBe(true);
  expect(kills).toContain("SIGTERM");
}, 1_000);
