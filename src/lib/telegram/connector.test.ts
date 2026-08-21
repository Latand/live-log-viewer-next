import { afterAll, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-telegram-connector-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
const OLD_API_ID = process.env.LLV_TELEGRAM_API_ID;
const OLD_API_HASH = process.env.LLV_TELEGRAM_API_HASH;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.LLV_TELEGRAM_API_ID = "12345";
process.env.LLV_TELEGRAM_API_HASH = "0123456789abcdef0123456789abcdef";
/* An ephemeral port claimed for this file alone. The supervisor now talks to
   the connector before it signals it (the pre-stop drain, #1087), so a test
   must never be able to reach whatever is listening on the real 8809. */
process.env.LLV_TELEGRAM_MCP_PORT = String(await new Promise<number>((resolve) => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1", () => {
    const port = (probe.address() as net.AddressInfo).port;
    probe.close(() => resolve(port));
  });
}));

const {
  TELEGRAM_READ_TOOL_ALLOWLIST,
  connectorServerName,
  ensureTelegramConnector,
  readTelegramConnectorCrashes,
  redactConnectorStderrLine,
  stopTelegramConnector,
  telegramConnectorActivity,
  telegramConnectorHealth,
  verifyReadOnlyTools,
} = await import("./connector");
const { telegramMcpUrl, vendoredConnectorDir } = await import("./packaging");
const { readTelegramConnection, readTelegramSession, saveTelegramSession, writeTelegramConnection } = await import("./sessionStore");

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
  const calls = { spawns: 0, probes: 0, stops: 0, records: 0, kills: [] as Array<NodeJS.Signals | undefined>, probeTokens: [] as string[] };
  let clock = 0;
  let owned = options.owned ?? false;
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
    ownsProcess: () => owned,
    stop: () => { calls.stops += 1; owned = false; },
    recordProcess: () => {
      calls.records += 1;
      if (options.recordFails) return false;
      owned = true;
      return true;
    },
  };
  return { ports, calls };
}

beforeEach(async () => {
  await stopTelegramConnector();
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  /* #1084: the connector runs from the provisioner's staged source copy;
     tests provide the directory the way a completed provision would. */
  fs.mkdirSync(path.join(process.env.LLV_STATE_DIR!, "telegram"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(process.env.LLV_STATE_DIR!, "telegram", "vendor-src"), { mode: 0o700 });
});
afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = OLD_STATE;
  if (OLD_API_ID === undefined) delete process.env.LLV_TELEGRAM_API_ID; else process.env.LLV_TELEGRAM_API_ID = OLD_API_ID;
  if (OLD_API_HASH === undefined) delete process.env.LLV_TELEGRAM_API_HASH; else process.env.LLV_TELEGRAM_API_HASH = OLD_API_HASH;
  delete process.env.LLV_TELEGRAM_MCP_PORT;
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

test("spawns once, waits for readiness, and records the winner before probing", async () => {
  const { ports, calls } = fakePorts([null, null, READ_ONLY]);
  const result = await ensureTelegramConnector(CONNECTOR_SESSION, ports);
  expect(result.ok).toBe(true);
  expect(calls.spawns).toBe(1);
  expect(calls.records).toBe(1);
  expect(calls.probes).toBe(3);
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

test("concurrent Viewer generations serialize adoption and spawn one recorded connector", async () => {
  let owned = false;
  let spawns = 0;
  let records = 0;
  const ports: TelegramConnectorPorts = {
    ownsProcess: () => owned,
    stop: async () => { await Promise.resolve(); owned = false; },
    spawn: () => {
      spawns += 1;
      return { pid: process.pid, kill: () => true };
    },
    recordProcess: () => {
      records += 1;
      owned = true;
      return true;
    },
    probe: async () => READ_ONLY,
    sleep: async () => {},
    now: () => Date.now(),
  };

  const [first, second] = await Promise.all([
    ensureTelegramConnector(CONNECTOR_SESSION, ports),
    ensureTelegramConnector(CONNECTOR_SESSION, ports),
  ]);

  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  expect(spawns).toBe(1);
  expect(records).toBe(1);
});

test("an older failed readiness probe cannot stop a newer credential generation", async () => {
  const newerSession = {
    ...CONNECTOR_SESSION,
    credentialRef: "credential-generation-b",
    connectorToken: "B".repeat(43),
  };
  let binding: { credentialRef: string; connectorToken: string } | null = null;
  let spawns = 0;
  let stops = 0;
  let clock = 0;
  let firstProbeStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { firstProbeStarted = resolve; });
  let resolveFirstProbe!: (probe: ConnectorProbe) => void;
  const firstProbe = new Promise<ConnectorProbe>((resolve) => { resolveFirstProbe = resolve; });
  const ports: TelegramConnectorPorts = {
    ownsProcess: (candidate) => binding?.credentialRef === candidate.credentialRef
      && binding.connectorToken === candidate.connectorToken,
    stop: () => { stops += 1; binding = null; },
    spawn: () => { spawns += 1; return { pid: process.pid, kill: () => true }; },
    recordProcess: (_child, _spec, candidate) => { binding = { ...candidate }; return true; },
    probe: async (_url, token) => {
      if (token === CONNECTOR_SESSION.connectorToken) {
        firstProbeStarted();
        return await firstProbe;
      }
      return {
        ok: true,
        serverName: connectorServerName(token),
        tools: [{ name: "get_me", readOnly: true }],
      };
    },
    sleep: async () => { clock += 30_001; },
    now: () => clock,
  };

  const older = ensureTelegramConnector(CONNECTOR_SESSION, ports);
  await firstStarted;
  const newer = await ensureTelegramConnector(newerSession, ports);
  expect(newer.ok).toBe(true);
  expect((binding as { credentialRef: string; connectorToken: string } | null)?.credentialRef).toBe(newerSession.credentialRef);

  resolveFirstProbe({ ok: false });
  expect(await older).toEqual({ ok: false, code: "connector_failed" });
  expect((binding as { credentialRef: string; connectorToken: string } | null)?.credentialRef).toBe(newerSession.credentialRef);
  expect(spawns).toBe(2);
  expect(stops).toBe(2);
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
  let owned = false;
  const child = { pid: process.pid, kill: (signal?: NodeJS.Signals) => { kills.push(signal); return true; } };
  const ports: TelegramConnectorPorts = {
    spawn: () => child,
    probe: async (_url, _token, signal) => {
      probeSignal = signal;
      return await new Promise<ConnectorProbe>(() => {});
    },
    sleep: async () => {},
    now: () => 0,
    ownsProcess: () => owned,
    recordProcess: () => { owned = true; return true; },
    stop: () => { owned = false; child.kill("SIGTERM"); },
    probeTimeoutMs: 10,
  };

  expect(await ensureTelegramConnector(CONNECTOR_SESSION, ports)).toEqual({ ok: false, code: "connector_failed" });
  expect(probeSignal?.aborted).toBe(true);
  expect(kills).toContain("SIGTERM");
}, 1_000);

test("stop waits through SIGKILL escalation until a TERM-resistant connector exits", async () => {
  const script = path.join(SANDBOX, "term-resistant-connector.mjs");
  const readyFile = path.join(SANDBOX, "term-resistant-ready");
  fs.writeFileSync(script, [
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');`,
    "process.on('SIGTERM', () => undefined);",
    "setInterval(() => undefined, 1000);",
    "",
  ].join("\n"));
  process.env.LLV_TELEGRAM_PYTHON = process.execPath;
  process.env.LLV_TELEGRAM_SERVER_BRIDGE = script;
  let childPid = 0;
  try {
    const result = await ensureTelegramConnector(CONNECTOR_SESSION, {
      spawn: (spec) => {
        const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: "ignore" });
        childPid = child.pid ?? 0;
        return child;
      },
      probe: async () => {
        while (!fs.existsSync(readyFile)) await new Promise((resolve) => setTimeout(resolve, 5));
        return READ_ONLY;
      },
      sleep: async () => {},
      now: () => Date.now(),
      ownsProcess: () => false,
    });
    expect(result.ok).toBe(true);
    expect(childPid).toBeGreaterThan(1);
    const pidFile = path.join(process.env.LLV_STATE_DIR!, "telegram", "connector.json");
    const recorded = JSON.parse(fs.readFileSync(pidFile, "utf8")) as {
      pid: number; identity: string; credentialRef: string; connectorTokenSha256: string;
    };
    expect(recorded.pid).toBe(childPid);
    expect(recorded.credentialRef).toBe(CONNECTOR_SESSION.credentialRef);
    expect(recorded.connectorTokenSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fs.readFileSync(pidFile, "utf8")).not.toContain(CONNECTOR_SESSION.connectorToken);

    await stopTelegramConnector();
    expect(() => process.kill(childPid, 0)).toThrow();
    expect(fs.existsSync(pidFile)).toBe(false);
  } finally {
    delete process.env.LLV_TELEGRAM_PYTHON;
    delete process.env.LLV_TELEGRAM_SERVER_BRIDGE;
    if (childPid > 1) {
      try { process.kill(childPid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
}, 5_000);

/* ----------------------------------------------------------------- #1087
   Crash visibility. Before this, the connector's stderr went to /dev/null and
   an exit left no record at all: the operator saw "connected" throughout a
   ~20 s outage. These tests use a REAL child process (a node script standing
   in for the packaged python server) so the exit code, the signal and the
   stderr tail are the ones the kernel actually delivered.
   --------------------------------------------------------------------- */

function connectorScript(name: string, body: string[]): string {
  const script = path.join(SANDBOX, `${name}.mjs`);
  fs.writeFileSync(script, [...body, ""].join("\n"));
  return script;
}

/** Ports that spawn the given script for real and report readiness from a
    marker file, so the supervisor's own process bookkeeping runs unchanged. */
function realChildPorts(
  script: string,
  readyFile: string,
  overrides: Partial<TelegramConnectorPorts> = {},
  options: { adopted?: boolean } = {},
) {
  const spawns: number[] = [];
  const ports: TelegramConnectorPorts = {
    spawn: (spec) => {
      const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ["ignore", "ignore", "pipe"] });
      /* The real port writes stderr into the owner-only sink; here the test
         owns the pipe and forwards it to the same file the supervisor reads. */
      const sink = fs.openSync(path.join(process.env.LLV_STATE_DIR!, "telegram", "connector-stderr.log"), "w", 0o600);
      child.stderr?.on("data", (chunk: Buffer) => { try { fs.writeSync(sink, chunk); } catch { /* closed */ } });
      if (child.pid) spawns.push(child.pid);
      child.on("error", () => undefined);
      return {
        pid: child.pid,
        kill: (signal) => child.kill(signal),
        /* `adopted` models the connector a LATER Viewer generation inherits
           through the pid file: it is a real running process, but this
           generation never spawned it, so there is no exit event to hear. */
        ...(options.adopted ? {} : {
          onExit: (handler: (code: number | null, signal: NodeJS.Signals | null) => void) => {
            child.once("exit", (code, signal) => handler(code, signal));
          },
        }),
      };
    },
    probe: async (_url, connectorToken) => {
      const deadline = Date.now() + 3_000;
      while (!fs.existsSync(readyFile) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      return fs.existsSync(readyFile) ? { ...READ_ONLY, serverName: connectorServerName(connectorToken) } : { ok: false };
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    ownsProcess: () => false,
    restartDelayMs: 10,
    ...overrides,
  };
  process.env.LLV_TELEGRAM_PYTHON = process.execPath;
  process.env.LLV_TELEGRAM_SERVER_BRIDGE = script;
  return { ports, spawns };
}

async function until(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
}

test("a connector that dies on its own is recorded: exit code, and the stderr nobody could read before", async () => {
  const readyFile = path.join(SANDBOX, "crash-ready");
  fs.rmSync(readyFile, { force: true });
  const script = connectorScript("crashing-connector", [
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');`,
    "console.error('Telegram client(s) started (default). Running MCP server (http)...');",
    "console.error('Error starting client: session lock refused');",
    "setTimeout(() => process.exit(7), 40);",
  ]);
  const { ports, spawns } = realChildPorts(script, readyFile);
  try {
    expect((await ensureTelegramConnector(CONNECTOR_SESSION, ports)).ok).toBe(true);
    await until(() => readTelegramConnectorCrashes().length > 0);
    const crashes = readTelegramConnectorCrashes();
    expect(crashes).toHaveLength(1);
    expect(crashes[0]!.pid).toBe(spawns[0]!);
    expect(crashes[0]!.exitCode).toBe(7);
    expect(crashes[0]!.signal).toBeNull();
    expect(crashes[0]!.stderr).toContain("Error starting client: session lock refused");
    expect(Date.parse(crashes[0]!.at)).toBeGreaterThan(0);
    /* No stored session to restart for: the crash is still recorded, and a
       restart that never happened is not counted. */
    expect(telegramConnectorActivity().last24h).toBe(0);
  } finally {
    delete process.env.LLV_TELEGRAM_PYTHON;
    delete process.env.LLV_TELEGRAM_SERVER_BRIDGE;
  }
}, 10_000);

test("the crash log and the restart counter are owner-only files under the telegram state dir", async () => {
  const readyFile = path.join(SANDBOX, "modes-ready");
  fs.rmSync(readyFile, { force: true });
  const script = connectorScript("mode-connector", [
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');`,
    "console.error('boom');",
    "setTimeout(() => process.exit(3), 30);",
  ]);
  const { ports } = realChildPorts(script, readyFile);
  try {
    await ensureTelegramConnector(CONNECTOR_SESSION, ports);
    await until(() => readTelegramConnectorCrashes().length > 0);
    for (const file of ["connector-crashes.log", "connector-stderr.log"]) {
      const stat = fs.lstatSync(path.join(process.env.LLV_STATE_DIR!, "telegram", file));
      expect(stat.isFile()).toBe(true);
      expect(stat.mode & 0o077).toBe(0);
    }
  } finally {
    delete process.env.LLV_TELEGRAM_PYTHON;
    delete process.env.LLV_TELEGRAM_SERVER_BRIDGE;
  }
}, 10_000);

test("a crash restarts the connector for the SAME stored credential, and the restart is counted", async () => {
  const readyFile = path.join(SANDBOX, "restart-ready");
  const crashOnce = path.join(SANDBOX, "restart-crashed-once");
  fs.rmSync(readyFile, { force: true });
  fs.rmSync(crashOnce, { force: true });
  const script = connectorScript("restarting-connector", [
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');`,
    `if (!fs.existsSync(${JSON.stringify(crashOnce)})) {`,
    `  fs.writeFileSync(${JSON.stringify(crashOnce)}, '1');`,
    "  console.error('first process dies');",
    "  setTimeout(() => process.exit(1), 30);",
    "} else {",
    "  setInterval(() => undefined, 1000);",
    "}",
  ]);
  const { ports, spawns } = realChildPorts(script, readyFile);
  saveTelegramSession(PLACEHOLDER_SESSION);
  const stored = readTelegramSession()!;
  try {
    expect((await ensureTelegramConnector(stored, ports)).ok).toBe(true);
    await until(() => spawns.length === 2);
    expect(spawns).toHaveLength(2);
    expect(spawns[1]).not.toBe(spawns[0]);
    await until(() => telegramConnectorActivity().restarting === false);
    const activity = telegramConnectorActivity();
    expect(activity.last24h).toBe(1);
    expect(Date.parse(activity.lastAt!)).toBeGreaterThan(0);
    expect(readTelegramConnectorCrashes()).toHaveLength(1);
  } finally {
    delete process.env.LLV_TELEGRAM_PYTHON;
    delete process.env.LLV_TELEGRAM_SERVER_BRIDGE;
    await stopTelegramConnector();
    for (const pid of spawns) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
}, 15_000);

test("a connector this Viewer stopped on purpose is not a crash and is not restarted", async () => {
  const readyFile = path.join(SANDBOX, "stopped-ready");
  fs.rmSync(readyFile, { force: true });
  const script = connectorScript("stopped-connector", [
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');`,
    "setInterval(() => undefined, 1000);",
  ]);
  const { ports, spawns } = realChildPorts(script, readyFile);
  saveTelegramSession(PLACEHOLDER_SESSION);
  try {
    expect((await ensureTelegramConnector(readTelegramSession()!, ports)).ok).toBe(true);
    await stopTelegramConnector();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(readTelegramConnectorCrashes()).toHaveLength(0);
    expect(telegramConnectorActivity().last24h).toBe(0);
    expect(spawns).toHaveLength(1);
  } finally {
    delete process.env.LLV_TELEGRAM_PYTHON;
    delete process.env.LLV_TELEGRAM_SERVER_BRIDGE;
    for (const pid of spawns) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
}, 10_000);

test("a connector that cannot stay up stops being restarted after the burst limit", async () => {
  const readyFile = path.join(SANDBOX, "burst-ready");
  fs.rmSync(readyFile, { force: true });
  /* Five crashes already inside the burst window: the sixth records but must
     not spawn again. The limiter counts CRASHES, not the restarts that
     succeeded — a connector that dies and never comes back has to stop being
     respawned just as surely as one that comes back and dies again. */
  const now = Date.now();
  const stamps = Array.from({ length: 5 }, (_, index) => new Date(now - index * 1_000).toISOString());
  fs.writeFileSync(
    path.join(process.env.LLV_STATE_DIR!, "telegram", "connector-restarts.json"),
    JSON.stringify({
      version: 1,
      restarts: stamps,
      crashes: stamps,
      lastCrashAt: new Date(now).toISOString(),
      lastCrashPid: null,
    }),
    { mode: 0o600 },
  );
  const script = connectorScript("burst-connector", [
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');`,
    "console.error('crash loop');",
    "setTimeout(() => process.exit(1), 30);",
  ]);
  const { ports, spawns } = realChildPorts(script, readyFile);
  saveTelegramSession(PLACEHOLDER_SESSION);
  try {
    await ensureTelegramConnector(readTelegramSession()!, ports);
    await until(() => readTelegramConnectorCrashes().length > 0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(spawns).toHaveLength(1);
    expect(telegramConnectorActivity().last24h).toBe(5);
    expect(telegramConnectorActivity().restarting).toBe(false);
  } finally {
    delete process.env.LLV_TELEGRAM_PYTHON;
    delete process.env.LLV_TELEGRAM_SERVER_BRIDGE;
  }
}, 10_000);

test("health comes from the RUNNING connector, so a healthy account costs no teardown", async () => {
  const calls = { stops: 0, tools: [] as string[] };
  const health = await telegramConnectorHealth(CONNECTOR_SESSION, {
    spawn: () => null,
    probe: async () => READ_ONLY,
    sleep: async () => {},
    now: () => 0,
    ownsProcess: () => true,
    stop: () => { calls.stops += 1; },
    callTool: async (_url, _token, tool) => {
      calls.tools.push(tool);
      /* The vendored get_me shape; the phone field it can carry must not
         travel any further than this parse. */
      return JSON.stringify({ id: 777, name: "Account A", type: "user", username: "account_a", phone: "0000000000" });
    },
  });
  expect(health).toEqual({ status: "connected", identity: { name: "Account A", username: "account_a" } });
  expect(JSON.stringify(health)).not.toContain("0000000000");
  expect(calls.tools).toEqual(["get_me"]);
  expect(calls.stops).toBe(0);
});

test("a connector that cannot prove the account is no health verdict at all", async () => {
  const base: TelegramConnectorPorts = {
    spawn: () => null,
    probe: async () => READ_ONLY,
    sleep: async () => {},
    now: () => 0,
    ownsProcess: () => true,
    callTool: async () => "An error occurred (code: GEN-ERR-001). Check mcp_errors.log for details.",
  };
  /* A tool error, a dead call, and a connector that is not ours all mean the
     same thing: fall back to the bridge check, never guess. */
  expect(await telegramConnectorHealth(CONNECTOR_SESSION, base)).toBeNull();
  expect(await telegramConnectorHealth(CONNECTOR_SESSION, { ...base, callTool: async () => null })).toBeNull();
  expect(await telegramConnectorHealth(CONNECTOR_SESSION, { ...base, ownsProcess: () => false })).toBeNull();
  expect(await telegramConnectorHealth(CONNECTOR_SESSION, { ...base, probe: async () => ({ ok: false }) })).toBeNull();
  /* A connector that accepts the call and then answers nothing must not hold
     the lifecycle queue open: the health call is bounded like the probe. It
     is reported BUSY rather than dead, though — see the burst test below. */
  const hung = await telegramConnectorHealth(CONNECTOR_SESSION, {
    ...base,
    probeTimeoutMs: 20,
    callTool: () => new Promise<string | null>(() => {}),
  });
  expect(hung).toBe("busy");
}, 2_000);

test("a crash tail is redacted: no ids, handles, home paths, or credentials reach the log", () => {
  const secrets = ["1ApWapzMBu4placeholder-not-a-real-session", "A".repeat(43)];
  const home = os.homedir();

  /* The vendored error helper logs the failing call's own arguments and a
     traceback whose frames carry absolute paths (see
     vendor/telegram-mcp/telegram_mcp/runtime.py). A crash record has to say
     what died, never who was being read. */
  const context = redactConnectorStderrLine(
    "ERROR Error in get_messages (chat_id=-1001234567890, query=secret project brief) - Code: MSG-ERR-042",
    secrets,
  );
  expect(context).not.toContain("1001234567890");
  expect(context).not.toContain("secret project brief");
  expect(context).toContain("Code: MSG-ERR-042");

  expect(redactConnectorStderrLine(`  File "${home}/.config/agent-log-viewer/state/telegram/x.py", line 5`, secrets))
    .not.toContain(home);
  /* A traceback frame from some OTHER account's checkout. The path is
     assembled rather than written out because the publication gate rejects a
     literal `/home/<name>/` in tracked source, and the invented placeholder
     here would trip it exactly like a real one would. */
  const foreignHome = `/${"home"}/another-account`;
  expect(redactConnectorStderrLine(`  File "${foreignHome}/telethon/client.py", line 5`, secrets))
    .not.toContain("another-account");
  expect(redactConnectorStderrLine("resolved @a_real_handle for +380501234567", secrets))
    .toBe("resolved @<user> for <id>");
  for (const secret of secrets) {
    expect(redactConnectorStderrLine(`session=${secret} refused`, secrets)).not.toContain(secret);
  }

  /* Still readable as a crash report. */
  expect(redactConnectorStderrLine("Traceback (most recent call last):", secrets))
    .toBe("Traceback (most recent call last):");
  expect(redactConnectorStderrLine("MemoryError", secrets)).toBe("MemoryError");
});

test("the stderr a crash record quotes is redacted before it is written", async () => {
  const readyFile = path.join(SANDBOX, "redact-ready");
  fs.rmSync(readyFile, { force: true });
  const script = connectorScript("redacting-connector", [
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');`,
    "console.error('ERROR Error in get_messages (chat_id=-1009876543210) - Code: MSG-ERR-042');",
    "setTimeout(() => process.exit(4), 40);",
  ]);
  const { ports } = realChildPorts(script, readyFile);
  try {
    expect((await ensureTelegramConnector(CONNECTOR_SESSION, ports)).ok).toBe(true);
    await until(() => readTelegramConnectorCrashes().length > 0);
    const tail = readTelegramConnectorCrashes()[0]!.stderr.join("\n");
    expect(tail).toContain("MSG-ERR-042");
    expect(tail).not.toContain("1009876543210");
    /* And the on-disk log, not just the parsed view. */
    const raw = fs.readFileSync(path.join(process.env.LLV_STATE_DIR!, "telegram", "connector-crashes.log"), "utf8");
    expect(raw).not.toContain("1009876543210");
  } finally {
    delete process.env.LLV_TELEGRAM_PYTHON;
    delete process.env.LLV_TELEGRAM_SERVER_BRIDGE;
  }
}, 10_000);

test("an ADOPTED connector's crash is recorded too — the exit nobody was listening to", async () => {
  const readyFile = path.join(SANDBOX, "adopted-ready");
  const diedOnce = path.join(SANDBOX, "adopted-died-once");
  fs.rmSync(readyFile, { force: true });
  fs.rmSync(diedOnce, { force: true });
  const script = connectorScript("adopted-connector", [
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');`,
    `if (!fs.existsSync(${JSON.stringify(diedOnce)})) {`,
    `  fs.writeFileSync(${JSON.stringify(diedOnce)}, '1');`,
    "  console.error('adopted connector died with nobody listening');",
    "  setTimeout(() => process.exit(9), 40);",
    "} else {",
    "  setInterval(() => undefined, 1000);",
    "}",
  ]);
  /* No exit event, exactly like a connector inherited through the pid file. */
  const { ports, spawns } = realChildPorts(script, readyFile, {}, { adopted: true });
  saveTelegramSession(PLACEHOLDER_SESSION);
  const stored = readTelegramSession()!;
  try {
    expect((await ensureTelegramConnector(stored, ports)).ok).toBe(true);
    await until(() => { try { process.kill(spawns[0]!, 0); return false; } catch { return true; } });
    /* Nothing could have heard this exit: before the reaper, the record and
       the counter stayed empty forever and the status said connected. */
    expect(readTelegramConnectorCrashes()).toHaveLength(0);

    /* The next supervisor pass notices the recorded process is gone. */
    expect((await ensureTelegramConnector(stored, ports)).ok).toBe(true);
    const crashes = readTelegramConnectorCrashes();
    expect(crashes).toHaveLength(1);
    expect(crashes[0]!.pid).toBe(spawns[0]!);
    expect(crashes[0]!.observed).toBe("vanished");
    /* Not our child, so the kernel told us nothing about how it went. */
    expect(crashes[0]!.exitCode).toBeNull();
    expect(crashes[0]!.signal).toBeNull();
    expect(crashes[0]!.stderr.join("\n")).toContain("adopted connector died with nobody listening");
    expect(spawns).toHaveLength(2);
    expect(telegramConnectorActivity().last24h).toBe(1);
  } finally {
    delete process.env.LLV_TELEGRAM_PYTHON;
    delete process.env.LLV_TELEGRAM_SERVER_BRIDGE;
    await stopTelegramConnector();
    for (const pid of spawns) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
}, 20_000);

test("a respawn that fails is NOT counted as a restart, and the status stops saying connected", async () => {
  const readyFile = path.join(SANDBOX, "failed-respawn-ready");
  fs.rmSync(readyFile, { force: true });
  const script = connectorScript("failing-respawn-connector", [
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');`,
    "console.error('cannot stay up');",
    "setTimeout(() => process.exit(2), 40);",
  ]);
  saveTelegramSession(PLACEHOLDER_SESSION);
  const stored = readTelegramSession()!;
  writeTelegramConnection({
    version: 1,
    status: "connected",
    credentialRef: stored.credentialRef,
    identity: { name: "Account A", username: "account_a" },
    lastHealthCheckAt: new Date().toISOString(),
    errorCode: null,
  });
  /* The replacement never becomes ready: the readiness loop runs out on a
     fake clock instead of holding the test for the real 30 s deadline. */
  let clock = Date.now();
  const { ports, spawns } = realChildPorts(script, readyFile, {
    probe: async () => ({ ok: false }),
    sleep: async () => { clock += 10_000; },
    now: () => clock,
  }, { adopted: true });
  try {
    /* First pass: the process starts and dies with nobody listening. */
    await ensureTelegramConnector(stored, ports);
    await until(() => { try { process.kill(spawns[0]!, 0); return false; } catch { return true; } });
    const result = await ensureTelegramConnector(stored, ports);
    expect(result.ok).toBe(false);
    /* The crash is on the record, the restart that never completed is not. */
    expect(readTelegramConnectorCrashes()).toHaveLength(1);
    expect(telegramConnectorActivity(clock).last24h).toBe(0);
    expect(telegramConnectorActivity(clock).restarting).toBe(false);
    /* And the durable status no longer claims a connector that is not there. */
    const connection = readTelegramConnection();
    expect(connection.status).toBe("error");
    expect(connection.errorCode).toBe("connector_failed");
  } finally {
    delete process.env.LLV_TELEGRAM_PYTHON;
    delete process.env.LLV_TELEGRAM_SERVER_BRIDGE;
    for (const pid of spawns) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
}, 20_000);

test("a connector busy with a burst of reads is BUSY, never torn down", async () => {
  const base: TelegramConnectorPorts = {
    spawn: () => null,
    probe: async () => READ_ONLY,
    sleep: async () => {},
    now: () => 0,
    ownsProcess: () => true,
    probeTimeoutMs: 30,
  };
  const calls = { stops: 0 };
  /* Several bounded reads are still in flight, so `get_me` waits behind them
     and the health budget runs out. That is a busy connector, not a dead one:
     a missed deadline says nothing about the account and nothing about the
     reads, so no verdict is reached and nothing is stopped (#1087). */
  const inFlight = [0, 1, 2].map(() => new Promise<string | null>(() => {}));
  const busy = await telegramConnectorHealth(CONNECTOR_SESSION, {
    ...base,
    stop: () => { calls.stops += 1; },
    callTool: () => inFlight[0]!,
  });
  expect(busy).toBe("busy");
  expect(calls.stops).toBe(0);

  /* The same when the handshake itself cannot get a slice of the event loop:
     a request that timed out was not refused. */
  expect(await telegramConnectorHealth(CONNECTOR_SESSION, {
    ...base,
    probe: () => new Promise<ConnectorProbe>(() => {}),
    callTool: async () => null,
  })).toBe("busy");

  /* A refusal is still a refusal — the bridge check has to get its chance to
     classify an expired session, which `get_me` cannot. */
  expect(await telegramConnectorHealth(CONNECTOR_SESSION, {
    ...base,
    probe: async () => ({ ok: false }),
    callTool: async () => null,
  })).toBeNull();
  expect(inFlight).toHaveLength(3);
}, 5_000);

test("a stop asks the connector to drain BEFORE it signals it", async () => {
  const readyFile = path.join(SANDBOX, "drain-ready");
  const drainLog = path.join(SANDBOX, "drain-log.json");
  fs.rmSync(readyFile, { force: true });
  fs.rmSync(drainLog, { force: true });
  /* A stand-in connector that serves the loopback port and records what it
     was asked, in the order it was asked. */
  const script = connectorScript("drainable-connector", [
    "import fs from 'node:fs';",
    "import http from 'node:http';",
    "const events = [];",
    `const log = () => fs.writeFileSync(${JSON.stringify(drainLog)}, JSON.stringify(events));`,
    "process.on('SIGTERM', () => { events.push('sigterm'); log(); process.exit(0); });",
    "const server = http.createServer((req, res) => {",
    "  events.push(`${req.method} ${req.url} auth=${req.headers.authorization ? 'yes' : 'no'}`);",
    "  log();",
    "  res.writeHead(200, { 'content-type': 'application/json' });",
    "  res.end('{\"draining\": true}');",
    "});",
    "server.listen(Number(process.env.MCP_PORT), '127.0.0.1', () => {",
    `  fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');`,
    "});",
  ]);
  const { ports, spawns } = realChildPorts(script, readyFile);
  saveTelegramSession(PLACEHOLDER_SESSION);
  const stored = readTelegramSession()!;
  try {
    expect((await ensureTelegramConnector(stored, ports)).ok).toBe(true);
    await stopTelegramConnector();
    const events = JSON.parse(fs.readFileSync(drainLog, "utf8")) as string[];
    /* The drain arrives first, authenticated, so a call in flight is answered
       with the named error while the process is still alive — the SIGTERM (and
       the SIGKILL escalation behind it) can no longer be what a caller meets. */
    expect(events[0]).toBe("POST /llv-telegram-drain auth=yes");
    expect(events).toContain("sigterm");
    expect(events.indexOf("sigterm")).toBeGreaterThan(0);
    /* A deliberate stop is still not a crash. */
    expect(readTelegramConnectorCrashes()).toHaveLength(0);
  } finally {
    delete process.env.LLV_TELEGRAM_PYTHON;
    delete process.env.LLV_TELEGRAM_SERVER_BRIDGE;
    for (const pid of spawns) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  }
}, 15_000);
