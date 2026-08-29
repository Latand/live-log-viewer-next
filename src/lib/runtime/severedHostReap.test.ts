import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

/* Isolated state only: this suite seats registry rows and signals processes it
   started itself. It must never read the operator's live state directory, and
   the only pid it can ever signal is one of its own children. */
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "llv-severed-host-reap-"));
const isolatedEnvironment = {
  HOME: path.join(isolated, "home"),
  XDG_CONFIG_HOME: path.join(isolated, "config"),
  LLV_STATE_DIR: path.join(isolated, "state"),
  TMPDIR: path.join(isolated, "tmp"),
};
const ambientEnvironment = Object.fromEntries(
  Object.keys(isolatedEnvironment).map((name) => [name, process.env[name]]),
);
for (const [name, directory] of Object.entries(isolatedEnvironment)) {
  fs.mkdirSync(directory, { recursive: true });
  process.env[name] = directory;
}

const { AgentRegistry } = await import("@/lib/agent/registry");
const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
const { procBackend } = await import("@/lib/proc");
const { reapSeveredStructuredHost } = await import("./registry");

afterAll(() => {
  for (const [name, value] of Object.entries(ambientEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(isolated, { recursive: true, force: true });
});

const AN_HOUR_AGO = new Date(Date.now() - 60 * 60_000);
/* The incident's own interval: the host had been up 34 minutes. Both clocks
   move together, because a wall clock 34 minutes ahead is a machine that has
   been up 34 minutes longer — the launch is derived from the two. */
const LATER_MS = 34 * 60_000;
const later = {
  now: () => Date.now() + LATER_MS,
  uptimeSeconds: () => os.uptime() + LATER_MS / 1_000,
};

/** A child of this test process, standing in for a structured host. */
function childProcess() {
  const child = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });
  const identity = procBackend.processIdentity(child.pid);
  if (!identity) throw new Error("the fixture child has no start identity to fence on");
  return { pid: child.pid, startIdentity: identity, kill: () => { try { child.kill("SIGKILL"); } catch { /* gone */ } } };
}

async function settles(assertion: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (assertion()) return;
    await Bun.sleep(5);
  }
  throw new Error(`${what} did not settle`);
}

const OPEN_TURN_TRANSCRIPT = [
  JSON.stringify({ type: "assistant", timestamp: "2026-08-29T03:24:00.000Z", message: { content: [{ type: "tool_use", id: "t1", name: "Bash" }] } }),
  JSON.stringify({ type: "user", timestamp: "2026-08-29T03:24:05.000Z", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } }),
  "",
].join("\n");

/** A tail no reader can parse: the record is cut off mid-object. */
const UNREADABLE_TRANSCRIPT = '{"type":"assistant","timestamp":"2026-08-29T03:24:0';

function seat(
  name: string,
  process: { pid: number; startIdentity: string },
  lastWrite: Date,
  body: string = OPEN_TURN_TRANSCRIPT,
) {
  const directory = fs.mkdtempSync(path.join(isolated, `${name}-`));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
  const sessionId = crypto.randomUUID();
  const transcript = path.join(directory, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, body);
  fs.utimesSync(transcript, lastWrite, lastWrite);
  const begun = beginLegacySpawnFixture(registry, { engine: "claude", cwd: directory, transport: "structured", accountId: null });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  const settled = registry.settleSpawn(begun.receipt.launchId, {
    key: { engine: "claude", sessionId },
    artifactPath: transcript,
    cwd: directory,
    accountId: null,
    status: "live",
    host: null,
    structuredHost: {
      kind: "claude-broker",
      endpoint: `stdio:${process.pid}`,
      process,
      eventCursor: 0,
      protocolVersion: "test",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: "structured-host:severed-reap-fixture",
    pendingAction: null,
  });
  if (settled.kind !== "settled") throw new Error("structured conversation was unavailable");
  /* The turn word the row carries. It is inherited from whoever wrote it last
     and is never what a kill is decided on (#1281); a case that means to prove
     that has to put the word there. */
  registry.reconcileConversations([{
    engine: "claude",
    path: transcript,
    accountId: null,
    launchProfile: settled.conversation.generations.at(-1)!.launchProfile,
    turn: { state: "busy", source: "lifecycle", terminalAt: null },
    observedAt: new Date(lastWrite.getTime() + 60_000).toISOString(),
  }]);
  return { registry, conversationId: settled.conversation.id, key: { engine: "claude" as const, sessionId }, directory };
}

test("a kill on a severed host nothing owns reaps the process so its row can retire", async () => {
  const child = childProcess();
  const { registry, conversationId, key } = seat("severed", child, AN_HOUR_AGO);
  try {
    const outcome = await reapSeveredStructuredHost(registry, conversationId, key, {
      ...later,
      /* 4.7 s in 34 minutes: what resuming a transcript costs. */
      processCpuMs: () => 4_700,
    });
    expect(outcome).toMatchObject({ reaped: true });
    expect(outcome?.reason).toContain("written nothing since its own launch");
    expect(procBackend.pidAlive(child.pid)).toBe(false);
    /* The registry refuses to retire a row whose process is alive, which is
       exactly why an unclaimed host was unkillable before the reap (#1282). */
    expect(registry.terminateInactiveStructuredHost(conversationId, key)).toBe("current");
    expect(registry.readOnlySnapshot().entries[`claude:${key.sessionId}`]).toMatchObject({
      status: "dead",
      structuredHost: null,
    });
  } finally {
    child.kill();
  }
});

test("a host that has written since its own launch is never reaped", async () => {
  const child = childProcess();
  const { registry, conversationId, key } = seat("working", child, new Date());
  try {
    const outcome = await reapSeveredStructuredHost(registry, conversationId, key, {
      ...later,
      processCpuMs: () => 4_700,
    });
    expect(outcome).toBeNull();
    expect(procBackend.pidAlive(child.pid)).toBe(true);
    expect(registry.readOnlySnapshot().entries[`claude:${key.sessionId}`]).toMatchObject({ status: "live" });
  } finally {
    child.kill();
    await settles(() => !procBackend.pidAlive(child.pid), "fixture child exit");
  }
});

test("a pid the registry no longer owns is reported severed but never signalled", async () => {
  const child = childProcess();
  /* Same pid, a start-time token from some earlier process: the kernel says
     this is not the process the row was written about. */
  const { registry, conversationId, key } = seat("reused", { pid: child.pid, startIdentity: `${child.pid}:1` }, AN_HOUR_AGO);
  try {
    const outcome = await reapSeveredStructuredHost(registry, conversationId, key, later);
    expect(outcome).toMatchObject({ reaped: false });
    expect(outcome?.reason).toContain("no longer the process the registry recorded");
    expect(procBackend.pidAlive(child.pid)).toBe(true);
  } finally {
    child.kill();
    await settles(() => !procBackend.pidAlive(child.pid), "fixture child exit");
  }
});


test("a live host whose transcript cannot be read is never reaped on the row's own turn word", async () => {
  const child = childProcess();
  /* Every other fact matches the specimen reaped above — a live child, nothing
     written since its launch, 4.7 s of CPU in 34 minutes — and the row reads
     `busy`. The one difference is that the transcript says nothing, and that is
     the whole difference: unreadable evidence authorises no kill (#1281). */
  const { registry, conversationId, key } = seat("unreadable", child, AN_HOUR_AGO, UNREADABLE_TRANSCRIPT);
  try {
    const outcome = await reapSeveredStructuredHost(registry, conversationId, key, {
      ...later,
      processCpuMs: () => 4_700,
    });

    expect(outcome).toBeNull();
    expect(procBackend.pidAlive(child.pid)).toBe(true);
    expect(registry.readOnlySnapshot().entries[`claude:${key.sessionId}`]).toMatchObject({ status: "live" });
  } finally {
    child.kill();
    await settles(() => !procBackend.pidAlive(child.pid), "fixture child exit");
  }
});
