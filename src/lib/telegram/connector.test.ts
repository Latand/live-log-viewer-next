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

const { TELEGRAM_READ_TOOL_ALLOWLIST, ensureTelegramConnector, stopTelegramConnector, verifyReadOnlyTools } = await import("./connector");
const { telegramMcpUrl, vendoredConnectorDir } = await import("./packaging");

import type { ConnectorProbe, TelegramConnectorPorts } from "./connector";

/* A placeholder with the string-session shape; never a real credential. */
const PLACEHOLDER_SESSION = "1ApWapzMBu4placeholder-not-a-real-session";

const READ_ONLY: ConnectorProbe = {
  ok: true,
  serverName: "telegram",
  tools: [
    { name: "get_me", readOnly: true },
    { name: "list_chats", readOnly: true },
  ],
};

function fakePorts(script: Array<ConnectorProbe | null>, options: { spawnFails?: boolean } = {}) {
  const calls = { spawns: 0, probes: 0 };
  let clock = 0;
  const ports: TelegramConnectorPorts = {
    spawn: () => {
      calls.spawns += 1;
      /* A real pid this test owns, so the /proc start-token fence records it. */
      return options.spawnFails ? null : { pid: process.pid, kill: () => true };
    },
    probe: async () => {
      calls.probes += 1;
      return script.shift() ?? { ok: false };
    },
    sleep: async () => { clock += 10_000; },
    now: () => clock,
  };
  return { ports, calls };
}

beforeEach(() => {
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
  const { ports, calls } = fakePorts([READ_ONLY]);
  const result = await ensureTelegramConnector(PLACEHOLDER_SESSION, ports);
  expect(result).toEqual({ ok: true, url: telegramMcpUrl() });
  expect(calls.spawns).toBe(0);
});

test("spawns once, waits for readiness, records the pid for later generations", async () => {
  const { ports, calls } = fakePorts([null, null, READ_ONLY]);
  const result = await ensureTelegramConnector(PLACEHOLDER_SESSION, ports);
  expect(result.ok).toBe(true);
  expect(calls.spawns).toBe(1);
  const pidFile = path.join(process.env.LLV_STATE_DIR!, "telegram", "connector.json");
  const recorded = JSON.parse(fs.readFileSync(pidFile, "utf8")) as { pid: number; identity: string };
  expect(recorded.pid).toBe(process.pid);
  /* The portable backend's identity token, not a raw /proc read — the same
     value works on Linux and macOS. */
  expect(typeof recorded.identity).toBe("string");
  expect(recorded.identity.length).toBeGreaterThan(0);

  /* Stop clears the record; the fenced kill skips this non-connector pid. */
  stopTelegramConnector();
  expect(fs.existsSync(pidFile)).toBe(false);
});

test("a connector advertising a non-read-only tool is refused", async () => {
  const withWrite: ConnectorProbe = {
    ok: true,
    serverName: "telegram",
    tools: [{ name: "get_me", readOnly: true }, { name: "send_message", readOnly: false }],
  };
  const { ports, calls } = fakePorts([null, withWrite]);
  const result = await ensureTelegramConnector(PLACEHOLDER_SESSION, ports);
  expect(result).toEqual({ ok: false, code: "not_read_only" });
  expect(calls.spawns).toBe(1);
});

test("a connector that never becomes ready reports connector_failed", async () => {
  const { ports } = fakePorts([]);
  const result = await ensureTelegramConnector(PLACEHOLDER_SESSION, ports);
  expect(result).toEqual({ ok: false, code: "connector_failed" });
});

test("a spawn failure reports connector_failed without probing forever", async () => {
  const { ports } = fakePorts([null], { spawnFails: true });
  const result = await ensureTelegramConnector(PLACEHOLDER_SESSION, ports);
  expect(result).toEqual({ ok: false, code: "connector_failed" });
});

test("the launch env — not this test's env — carries the session; argv never does", async () => {
  const { connectorLaunchSpec } = await import("./packaging");
  const spec = connectorLaunchSpec({
    sessionString: PLACEHOLDER_SESSION,
    credentials: { apiId: "12345", apiHash: "0123456789abcdef0123456789abcdef" },
  });
  expect(spec.args.join(" ")).not.toContain(PLACEHOLDER_SESSION);
  expect(spec.env.TELEGRAM_SESSION_STRING).toBe(PLACEHOLDER_SESSION);
  expect(spec.env.TELEGRAM_EXPOSED_TOOLS).toBe("read-only");
  expect(spec.env.MCP_TRANSPORT).toBe("http");
  expect(spec.env.MCP_HOST).toBe("127.0.0.1");
});
