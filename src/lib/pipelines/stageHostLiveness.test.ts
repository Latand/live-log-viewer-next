import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";

/* Isolated state only: this suite seats registry rows and reads the pipeline
   ports against them. It starts no agent, signals no process, and must never
   touch the operator's live state directory. Structured hosting is pinned off
   so nothing here can reach a runtime host at all. */
const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stage-host-liveness-"));
const isolatedEnvironment = {
  HOME: path.join(isolated, "home"),
  XDG_CONFIG_HOME: path.join(isolated, "config"),
  LLV_STATE_DIR: path.join(isolated, "state"),
  TMPDIR: path.join(isolated, "tmp"),
  LLV_STRUCTURED_HOSTS: "0",
};
const ambientEnvironment = Object.fromEntries(
  Object.keys(isolatedEnvironment).map((name) => [name, process.env[name]]),
);
for (const [name, value] of Object.entries(isolatedEnvironment)) {
  if (name !== "LLV_STRUCTURED_HOSTS") fs.mkdirSync(value, { recursive: true });
  process.env[name] = value;
}

const { AgentRegistry, setAgentRegistryForTests } = await import("@/lib/agent/registry");
const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
const { procBackend } = await import("@/lib/proc");
const { defaultPipelinePorts } = await import("./engine");

afterAll(() => {
  setAgentRegistryForTests(null);
  for (const [name, value] of Object.entries(ambientEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(isolated, { recursive: true, force: true });
});

const TOOL_CALL_AT = "2026-08-29T03:24:00.000Z";
const TOOL_RESULT_AT = "2026-08-29T03:24:05.000Z";

const OPEN_TURN_TRANSCRIPT = [
  JSON.stringify({ type: "assistant", timestamp: TOOL_CALL_AT, message: { content: [{ type: "tool_use", id: "t1", name: "Bash" }] } }),
  JSON.stringify({ type: "user", timestamp: TOOL_RESULT_AT, message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } }),
  "",
].join("\n");

/** A tail no reader can parse: the record is cut off mid-object. */
const UNREADABLE_TRANSCRIPT = '{"type":"assistant","timestamp":"2026-08-29T03:24:0';

/**
 * A structured stage conversation whose host row names `process`, with the
 * transcript's last write placed at `lastWrite` — before the host's launch for
 * a severed turn, after it for one that is working.
 */
function stageConversation(
  name: string,
  process: { pid: number; startIdentity: string | null },
  lastWrite: Date,
  options: { body?: string; recordedTurn?: "busy" | "terminal" } = {},
) {
  const directory = fs.mkdtempSync(path.join(isolated, `${name}-`));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
  const sessionId = crypto.randomUUID();
  const transcript = path.join(directory, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, options.body ?? OPEN_TURN_TRANSCRIPT);
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
    claimOwner: "structured-host:stage-liveness-fixture",
    pendingAction: null,
  });
  if (settled.kind !== "settled") throw new Error("structured conversation was unavailable");
  if (options.recordedTurn) {
    /* The turn word the durable record carries, inherited from whoever wrote it
       last. A stage retry is never decided on it (#1281), and a case that means
       to prove that has to put the word there. */
    registry.reconcileConversations([{
      engine: "claude",
      path: transcript,
      accountId: null,
      launchProfile: settled.conversation.generations.at(-1)!.launchProfile,
      turn: {
        state: options.recordedTurn,
        source: "lifecycle",
        terminalAt: options.recordedTurn === "terminal" ? TOOL_RESULT_AT : null,
      },
      observedAt: "2026-08-29T03:30:00.000Z",
    }]);
  }
  setAgentRegistryForTests(registry);
  return { registry, conversationId: settled.conversation.id, transcript };
}

test("a stage host whose process is gone reports the moment it stopped, so the attempt can be retried", async () => {
  /* A pid this machine cannot be running: the row still reads `live`, which is
     exactly the state a redeploy leaves behind (#1282). */
  const { conversationId } = stageConversation("gone", { pid: 2_000_000_001, startIdentity: "pre-restart-host" }, new Date(TOOL_RESULT_AT));

  const unavailableSince = await defaultPipelinePorts().conversationHostUnavailableSince!(conversationId);

  expect(unavailableSince).toBe(TOOL_RESULT_AT);
});

test("a stage host still writing to its transcript is not reported unavailable, however long the step takes", async () => {
  /* This process stands in for a live host, and the transcript's last write is
     ten minutes old — a long tool call, which must never read as stalled. */
  const identity = procBackend.processIdentity(process.pid);
  const { conversationId } = stageConversation(
    "working",
    { pid: process.pid, startIdentity: identity },
    new Date(Date.now() - 10 * 60_000),
  );

  const unavailableSince = await defaultPipelinePorts().conversationHostUnavailableSince!(conversationId);

  expect(unavailableSince).toBeNull();
});

test("a row already retired keeps reporting its own retirement stamp", async () => {
  const { registry, conversationId } = stageConversation("retired", { pid: 2_000_000_002, startIdentity: "pre-restart-host" }, new Date(TOOL_RESULT_AT));
  const entry = Object.values(registry.readOnlySnapshot().entries)[0]!;
  registry.upsert({ ...entry, status: "dead" });

  const unavailableSince = await defaultPipelinePorts().conversationHostUnavailableSince!(conversationId);

  expect(unavailableSince).toBe(registry.readOnlySnapshot().entries[`claude:${entry.key.sessionId}`]!.updatedAt);
});

test.each(["terminal", "busy"] as const)(
  "a stage whose host is gone and whose transcript cannot be read is not retryable on a stale %s turn word",
  async (recordedTurn) => {
    /* The redeploy leftover, both ways round: the row still reads `live`, the
       recorded process is gone, the transcript that would say what the turn was
       doing cannot be parsed, and the word on the row says either that a turn is
       in flight or that one finished.

       The missing process is what used to decide this — it is definitive about
       the pid and silent about the turn, since a turn cut off mid-work and a
       turn that ended hours ago under a row nobody updated both leave a pid that
       is gone. Retrying the first is recovery; retrying the second re-runs
       finished work. With nothing separating them, the stage keeps its attempt
       and reports no moment of unavailability at all (#1281). The word is varied
       across both cases because it is not read either way. */
    const { conversationId } = stageConversation(
      `stale-${recordedTurn}`,
      { pid: recordedTurn === "terminal" ? 2_000_000_003 : 2_000_000_004, startIdentity: "pre-restart-host" },
      new Date(TOOL_RESULT_AT),
      { body: UNREADABLE_TRANSCRIPT, recordedTurn },
    );

    const unavailableSince = await defaultPipelinePorts().conversationHostUnavailableSince!(conversationId);

    expect(unavailableSince).toBeNull();
  },
);

test("a live stage host whose transcript cannot be read keeps its attempt", async () => {
  /* The same refusal with the process still there and a turn word claiming work
     is in flight: nothing about an unreadable transcript becomes actionable
     because the pid answers. */
  const identity = procBackend.processIdentity(process.pid);
  const { conversationId } = stageConversation(
    "stale-busy-live",
    { pid: process.pid, startIdentity: identity },
    new Date(TOOL_RESULT_AT),
    { body: UNREADABLE_TRANSCRIPT, recordedTurn: "busy" },
  );

  const unavailableSince = await defaultPipelinePorts().conversationHostUnavailableSince!(conversationId);

  expect(unavailableSince).toBeNull();
});
