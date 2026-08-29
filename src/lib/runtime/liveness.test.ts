import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import {
  conversationTurnLiveness,
  decideTurnLiveness,
  LIVENESS_OBSERVATION_WINDOW_MS,
  processLaunchedAt,
  readHostProcessEvidence,
  readTranscriptEvidence,
  transcriptEvidenceFromRecords,
  type TurnLivenessEvidence,
} from "./liveness";

const NOW = Date.parse("2026-08-29T04:02:00.000Z");
const MINUTE = 60_000;

function evidence(overrides: {
  transcriptTail?: Partial<TurnLivenessEvidence["transcriptTail"]>;
  host?: Partial<TurnLivenessEvidence["host"]>;
  delivery?: Partial<TurnLivenessEvidence["delivery"]>;
} = {}): TurnLivenessEvidence {
  return {
    now: NOW,
    transcriptTail: {
      lastEventAt: NOW - MINUTE,
      kind: "tool-call",
      lastWriteAt: NOW - MINUTE,
      turn: "busy",
      ...overrides.transcriptTail,
    },
    host: {
      expected: { pid: 4242, startIdentity: "4242:900" },
      present: true,
      observedIdentity: "4242:900",
      cpuMs: 4_700,
      launchedAt: NOW - 30 * MINUTE,
      ...overrides.host,
    },
    delivery: { outstandingSince: null, ...overrides.delivery },
  };
}

test("a ten-minute gap after a tool call this host wrote is still working", () => {
  const decision = decideTurnLiveness(evidence({
    transcriptTail: { lastEventAt: NOW - 10 * MINUTE, lastWriteAt: NOW - 10 * MINUTE, kind: "tool-call", turn: "busy" },
    host: { cpuMs: 12 },
  }));
  expect(decision.state).toBe("working");
  expect(decision.reason).toContain("after its own launch");
  expect(decision.since).toBeNull();
});

test("a host appending to a transcript whose tail cannot be parsed is still working", () => {
  const decision = decideTurnLiveness(evidence({
    transcriptTail: { lastEventAt: null, kind: null, lastWriteAt: NOW - 30_000, turn: "unknown" },
  }));
  expect(decision.state).toBe("working");
});

test("a host writing normally is working", () => {
  expect(decideTurnLiveness(evidence({
    transcriptTail: { lastEventAt: NOW - 2_000, lastWriteAt: NOW - 2_000 },
  })).state).toBe("working");
});

test("the #1281 specimen — nothing written and no CPU since its own launch — is severed", () => {
  const decision = decideTurnLiveness(evidence({
    /* The last transcript event is the pre-redeploy tool result, before this
       process existed: this host inherited the turn from a severed predecessor. */
    transcriptTail: { lastEventAt: NOW - 38 * MINUTE, lastWriteAt: NOW - 38 * MINUTE, kind: "tool-result", turn: "busy" },
    host: { launchedAt: NOW - 34 * MINUTE, cpuMs: 4_700 },
  }));
  expect(decision.state).toBe("severed");
  expect(decision.reason).toContain("written nothing since its own launch");
  expect(decision.reason).toContain("tool-result");
  expect(decision.lastEvent).toEqual({ kind: "tool-result", at: NOW - 38 * MINUTE });
  /* Stable, so a consumer's grace period does not restart on every read. */
  expect(decision.since).toBe(NOW - 34 * MINUTE);
});

test("an inherited turn whose host is burning CPU is working", () => {
  const decision = decideTurnLiveness(evidence({
    transcriptTail: { lastEventAt: NOW - 38 * MINUTE, lastWriteAt: NOW - 38 * MINUTE, kind: "tool-result", turn: "busy" },
    host: { launchedAt: NOW - 10 * MINUTE, cpuMs: 120_000 },
  }));
  expect(decision.state).toBe("working");
  expect(decision.reason).toContain("CPU");
});

test("a process that no longer exists is severed from the last thing it did", () => {
  const decision = decideTurnLiveness(evidence({
    host: { present: false, observedIdentity: null, cpuMs: null },
  }));
  expect(decision.state).toBe("severed");
  expect(decision.since).toBe(NOW - MINUTE);
  expect(decision.turn).toBe("busy");
});

test("a settled turn whose host has since exited reads as settled", () => {
  /* An idle seat at a redeploy: nothing was in flight, so nothing was cut off
     and there is nothing to resume (#1276). */
  const decision = decideTurnLiveness(evidence({
    transcriptTail: { turn: "terminal", kind: "assistant-message" },
    host: { present: false, observedIdentity: null, cpuMs: null },
  }));
  expect(decision.state).toBe("settled");
});

test("a pid the registry no longer owns is severed", () => {
  const decision = decideTurnLiveness(evidence({ host: { observedIdentity: "4242:99999" } }));
  expect(decision.state).toBe("severed");
  expect(decision.reason).toContain("no longer the process the registry recorded");
});

test("a host too young to have written anything answers unknown", () => {
  const decision = decideTurnLiveness(evidence({
    transcriptTail: { lastEventAt: NOW - 38 * MINUTE, lastWriteAt: NOW - 38 * MINUTE, kind: "tool-result", turn: "busy" },
    host: { launchedAt: NOW - (LIVENESS_OBSERVATION_WINDOW_MS - 1_000), cpuMs: 0 },
  }));
  expect(decision.state).toBe("unknown");
});

test("a host waiting for a first prompt it never got is not called severed on CPU alone", () => {
  /* It inherited no turn: the transcript is empty because nothing has been
     delivered to it yet, which is a different fact from a severed turn. */
  const decision = decideTurnLiveness(evidence({
    transcriptTail: { lastEventAt: null, lastWriteAt: null, kind: null, turn: "unknown" },
    host: { launchedAt: NOW - 20 * MINUTE, cpuMs: 300 },
  }));
  expect(decision.state).toBe("unknown");
  const waited = decideTurnLiveness(evidence({
    transcriptTail: { lastEventAt: null, lastWriteAt: null, kind: null, turn: "unknown" },
    host: { launchedAt: NOW - 20 * MINUTE, cpuMs: 300 },
    delivery: { outstandingSince: NOW - 6 * MINUTE },
  }));
  expect(waited.state).toBe("severed");
});

test("without CPU accounting an idle inherited turn is unknown until a delivery has waited", () => {
  const platformBlind = {
    transcriptTail: { lastEventAt: NOW - 38 * MINUTE, lastWriteAt: NOW - 38 * MINUTE, kind: "tool-result" as const, turn: "busy" as const },
    host: { launchedAt: NOW - 34 * MINUTE, cpuMs: null },
  };
  expect(decideTurnLiveness(evidence(platformBlind)).state).toBe("unknown");
  const waited = decideTurnLiveness(evidence({
    ...platformBlind,
    delivery: { outstandingSince: NOW - 6 * MINUTE },
  }));
  expect(waited.state).toBe("severed");
  expect(waited.reason).toContain("outstanding");
});

test("a turn this host closed itself reads as settled", () => {
  const decision = decideTurnLiveness(evidence({
    transcriptTail: { lastEventAt: NOW - MINUTE, kind: "assistant-message", turn: "terminal" },
  }));
  expect(decision.state).toBe("settled");
});

test("a row with no recorded process says nothing about an open turn", () => {
  expect(decideTurnLiveness(evidence({ host: { expected: null } })).state).toBe("unknown");
});

test("the launch clock reads both start-time token shapes", () => {
  expect(processLaunchedAt("4242:1756000000:250000")).toBe(1756000000250);
  const linux = processLaunchedAt("4242:6000", { now: () => 1_000_000, uptimeSeconds: () => 100 });
  expect(linux).toBe(1_000_000 - 100_000 + 60_000);
  expect(processLaunchedAt(null)).toBeNull();
  expect(processLaunchedAt("nonsense")).toBeNull();
});

test("process evidence reads liveness, identity and CPU for one recorded pid", () => {
  const readings = readHostProcessEvidence({ pid: 77, startIdentity: "77:6000" }, {
    pidAlive: (pid) => pid === 77,
    processIdentity: () => "77:6000",
    processCpuMs: () => 812,
    now: () => 1_000_000,
    uptimeSeconds: () => 100,
  });
  expect(readings).toMatchObject({ present: true, observedIdentity: "77:6000", cpuMs: 812 });
  expect(readings.launchedAt).toBe(960_000);
  const gone = readHostProcessEvidence({ pid: 77, startIdentity: "77:6000" }, {
    pidAlive: () => false,
    processIdentity: () => null,
    processCpuMs: () => 812,
  });
  expect(gone).toMatchObject({ present: false, cpuMs: null });
});

test("the last transcript event carries its kind for both engines", () => {
  const claudeToolCall = transcriptEvidenceFromRecords([
    { type: "user", timestamp: "2026-08-29T03:00:00.000Z", message: { content: "go" } },
    { type: "assistant", timestamp: "2026-08-29T03:01:00.000Z", message: { content: [{ type: "tool_use", id: "t1", name: "Bash" }] } },
  ], "claude", null);
  expect(claudeToolCall).toMatchObject({ kind: "tool-call", turn: "busy" });
  expect(claudeToolCall.lastEventAt).toBe(Date.parse("2026-08-29T03:01:00.000Z"));

  const claudeToolResult = transcriptEvidenceFromRecords([
    { type: "assistant", timestamp: "2026-08-29T03:01:00.000Z", message: { content: [{ type: "tool_use", id: "t1", name: "Bash" }] } },
    { type: "user", timestamp: "2026-08-29T03:02:00.000Z", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } },
  ], "claude", null);
  expect(claudeToolResult).toMatchObject({ kind: "tool-result", turn: "busy" });

  const codex = transcriptEvidenceFromRecords([
    { timestamp: "2026-08-29T03:00:00.000Z", payload: { type: "user_message" } },
    { timestamp: "2026-08-29T03:01:00.000Z", payload: { type: "function_call", call_id: "c1" } },
  ], "codex", null);
  expect(codex).toMatchObject({ kind: "tool-call", turn: "busy" });
});

test("an unreadable transcript reports no evidence rather than an empty turn", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-liveness-transcript-"));
  try {
    const missing = await readTranscriptEvidence("claude", path.join(directory, "absent.jsonl"));
    expect(missing).toEqual({ lastEventAt: null, kind: null, lastWriteAt: null, turn: "unknown" });
    const pathname = path.join(directory, "session.jsonl");
    fs.writeFileSync(pathname, [
      JSON.stringify({ type: "assistant", timestamp: "2026-08-29T03:01:00.000Z", message: { content: [{ type: "tool_use", id: "t1" }] } }),
      "",
    ].join("\n"));
    expect(await readTranscriptEvidence("claude", pathname)).toMatchObject({ kind: "tool-call", turn: "busy" });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("conversation liveness reads the registry row and its outstanding delivery", async () => {
  const { AgentRegistry } = await import("@/lib/agent/registry");
  const { beginLegacySpawnFixture } = await import("@/lib/agent/registryTestFixtures");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-liveness-conversation-"));
  try {
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
    /* The generation id is read back out of the transcript file name, so the
       fixture has to name the file after the session it seats. */
    const sessionId = crypto.randomUUID();
    const transcript = path.join(directory, `${sessionId}.jsonl`);
    fs.writeFileSync(transcript, `${JSON.stringify({
      type: "user",
      timestamp: "2026-08-29T03:24:05.000Z",
      message: { content: [{ type: "tool_result", tool_use_id: "t1" }] },
    })}\n`);
    /* The artifact's own clock is evidence too: it has to predate the host's
       launch, or the file counts as written since. */
    const lastWrite = new Date("2026-08-29T03:24:05.000Z");
    fs.utimesSync(transcript, lastWrite, lastWrite);
    const begun = beginLegacySpawnFixture(registry, {
      engine: "claude",
      cwd: directory,
      transport: "structured",
      accountId: null,
    });
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
        endpoint: "stdio:4242",
        process: { pid: 4242, startIdentity: "4242:900" },
        eventCursor: 0,
        protocolVersion: "test",
        writerClaimEpoch: 1,
        activeTurnRef: null,
        pendingAttention: [],
        activeFlags: [],
      },
      claimEpoch: 1,
      claimOwner: "structured-host:test",
      pendingAction: null,
    });
    if (settled.kind !== "settled") throw new Error("structured conversation was unavailable");
    const decision = await conversationTurnLiveness(registry, settled.conversation.id, {
      now: () => NOW,
      pidAlive: () => true,
      processIdentity: () => "4242:900",
      processCpuMs: () => 4_700,
      /* The recorded start-time token is 900 ticks (9s) into an uptime chosen so
         the launch lands at 03:28:15 — inside the redeploy window. */
      uptimeSeconds: () => (NOW - Date.parse("2026-08-29T03:28:15.000Z")) / 1_000 + 9,
    });
    expect(decision?.state).toBe("severed");
    expect(decision?.reason).toContain("tool-result");
    expect(decision?.key).toEqual({ engine: "claude", sessionId });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
