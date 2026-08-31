import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { AgentRegistry } from "@/lib/agent/registry";
import { beginLegacySpawnFixture } from "@/lib/agent/registryTestFixtures";
import type { FileEntry } from "@/lib/types";

import { projectStructuredFileLiveness } from "./livenessProjection";

const NOW = Date.parse("2026-08-30T03:00:00.000Z");
const LAST_WRITE = new Date(NOW - 5 * 60_000);

function structuredFile(
  registry: AgentRegistry,
  directory: string,
  process: { pid: number; startIdentity: string | null },
): FileEntry {
  const sessionId = crypto.randomUUID();
  const transcript = path.join(directory, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, [
    JSON.stringify({ type: "assistant", timestamp: new Date(NOW - 6 * 60_000).toISOString(), message: { content: [{ type: "tool_use", id: "t1", name: "Bash" }] } }),
    JSON.stringify({ type: "user", timestamp: LAST_WRITE.toISOString(), message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } }),
    "",
  ].join("\n"));
  fs.utimesSync(transcript, LAST_WRITE, LAST_WRITE);
  const begun = beginLegacySpawnFixture(registry, { engine: "claude", cwd: directory, transport: "structured", accountId: null });
  if (begun.kind !== "created") throw new Error("spawn fixture was unavailable");
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
    claimOwner: null,
    pendingAction: null,
  });
  if (settled.kind !== "settled") throw new Error("structured conversation was unavailable");
  return {
    path: transcript,
    root: "claude-projects",
    name: path.basename(transcript),
    project: "fixture",
    title: "Pipeline builder",
    engine: "claude",
    kind: "session",
    fmt: "claude",
    parent: null,
    mtime: LAST_WRITE.getTime() / 1_000,
    size: fs.statSync(transcript).size,
    activity: "live",
    activityReason: "jsonl_turn_open",
    proc: "running",
    pid: process.pid,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

test("a CPU-flat structured host projects stalled while its verified process remains running", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-liveness-projection-flat-"));
  try {
    const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    const file = structuredFile(registry, directory, { pid: 71, startIdentity: "71:1000" });

    await projectStructuredFileLiveness([file], registry, registry.readOnlySnapshot(), {
      now: () => NOW,
      uptimeSeconds: () => 250,
      pidAlive: () => true,
      processIdentity: () => "71:1000",
      processCpuMs: () => 1_700,
      observeCpuProgress: () => ({ consumedMs: 200, observedMs: 100_000 }),
    });

    expect(file).toMatchObject({
      activity: "stalled",
      activityReason: "turn_evidence_severed",
      proc: "running",
      pid: 71,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a structured pid that has exited never projects running", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-liveness-projection-gone-"));
  try {
    const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    const file = structuredFile(registry, directory, { pid: 72, startIdentity: "72:1000" });

    await projectStructuredFileLiveness([file], registry, registry.readOnlySnapshot(), {
      now: () => NOW,
      pidAlive: () => false,
      processIdentity: () => null,
      processCpuMs: () => null,
    });

    expect(file).toMatchObject({ activity: "stalled", proc: "killed", pid: null });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test.each([
  { name: "platform identity is unavailable", recorded: "73:1000", observed: null },
  { name: "registry recorded no start identity", recorded: null, observed: "73:1000" },
] as const)("an existing pid clears its process readout when the $name", async ({ recorded, observed }) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-liveness-projection-unverified-"));
  try {
    const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    const file = structuredFile(registry, directory, { pid: 73, startIdentity: recorded });

    await projectStructuredFileLiveness([file], registry, registry.readOnlySnapshot(), {
      now: () => NOW,
      uptimeSeconds: () => 250,
      pidAlive: () => true,
      processIdentity: () => observed,
      processCpuMs: () => 1_700,
    });

    expect(file).toMatchObject({ activity: "recent", activityReason: "turn_evidence_unknown", proc: null, pid: null });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("unreadable turn evidence removes a stale live activity word", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-liveness-projection-unknown-"));
  try {
    const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    const file = structuredFile(registry, directory, { pid: 76, startIdentity: "76:1000" });
    fs.writeFileSync(file.path, '{"type":"assistant"');
    fs.utimesSync(file.path, LAST_WRITE, LAST_WRITE);

    await projectStructuredFileLiveness([file], registry, registry.readOnlySnapshot(), {
      now: () => NOW,
      uptimeSeconds: () => 250,
      pidAlive: () => true,
      processIdentity: () => "76:1000",
      processCpuMs: () => 1_700,
      observeCpuProgress: () => ({ consumedMs: 0, observedMs: 100_000 }),
    });

    expect(file).toMatchObject({
      activity: "recent",
      activityReason: "turn_evidence_unknown",
      proc: "running",
      pid: 76,
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test.each(["dead", "unhosted"] as const)(
  "a %s registry row keeps the terminal projection applied before liveness",
  async (status) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-liveness-projection-terminal-"));
    try {
      const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
      const file = structuredFile(registry, directory, { pid: 74, startIdentity: "74:1000" });
      const conversation = registry.conversationForPath(file.path)!;
      const generation = conversation.generations.at(-1)!;
      const entry = registry.readOnlySnapshot().entries[`claude:${generation.id}`]!;
      registry.upsert({ ...entry, status, structuredHost: { ...entry.structuredHost!, process: null } });
      Object.assign(file, { activity: "idle", activityReason: "registry_terminal", proc: "killed", pid: null });

      await projectStructuredFileLiveness([file], registry, registry.readOnlySnapshot(), {
        now: () => NOW,
        pidAlive: () => true,
        processIdentity: () => "74:1000",
        processCpuMs: () => 1_700,
      });

      expect(file).toMatchObject({ activity: "idle", activityReason: "registry_terminal", proc: "killed", pid: null });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("a superseded conversation keeps its terminal projection", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-liveness-projection-superseded-"));
  try {
    const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    const file = structuredFile(registry, directory, { pid: 75, startIdentity: "75:1000" });
    const snapshot = registry.readOnlySnapshot();
    const conversation = Object.values(snapshot.conversations).find((candidate) => candidate.generations.at(-1)?.path === file.path)!;
    conversation.supersededBy = {
      conversationId: "conversation_replacement",
      at: new Date(NOW).toISOString(),
      reason: "stage-retry",
    };
    Object.assign(file, { activity: "idle", activityReason: "superseded", proc: "killed", pid: null });

    await projectStructuredFileLiveness([file], registry, snapshot, {
      now: () => NOW,
      pidAlive: () => true,
      processIdentity: () => "75:1000",
      processCpuMs: () => 10_000,
    });

    expect(file).toMatchObject({ activity: "idle", activityReason: "superseded", proc: "killed", pid: null });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
