import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import type { FileEntry } from "@/lib/types";

import { AgentRegistry } from "./registry";
import { preallocatedStructuredSpawnCards } from "./spawnProjection";

function scannedFile(pathname: string): FileEntry {
  return {
    path: pathname,
    root: "codex-sessions",
    name: path.basename(pathname),
    project: "repo",
    title: "Settled spawn",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

function observeArtifact(registry: AgentRegistry, artifactPath: string, cwd: string): void {
  registry.reconcileConversations([{
    engine: "codex",
    path: artifactPath,
    accountId: "work",
    launchProfile: emptyLaunchProfile({ cwd }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-17T10:00:00.000Z",
  }]);
}

test("a settled artifact stays projected across restart until inventory observes it", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-projection-scan-lag-"));
  const filename = path.join(directory, "agent-registry.json");
  const artifactPath = path.join(directory, "019f7b8a-9f75-7dc0-b231-17f7eadd7fe0.jsonl");
  try {
    fs.writeFileSync(artifactPath, `${JSON.stringify({ type: "user", message: "scan lag" })}\n`);
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const begun = registry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      transport: "structured",
      accountId: "work",
      clientAttemptId: "scan_lag_20260717_a1",
      requestDigest: "c".repeat(64),
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    if (begun.kind !== "created") throw new Error("expected structured launch creation");
    registry.settleSpawn(begun.receipt.launchId, {
      key: { engine: "codex", sessionId: "019f7b8a-9f75-7dc0-b231-17f7eadd7fe0" },
      artifactPath,
      cwd: directory,
      accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
      status: "unhosted",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });

    const restarted = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    expect(preallocatedStructuredSpawnCards([], restarted.snapshot())).toHaveLength(1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("terminal synthetic spawn cards join compact history after the scanner freshness horizon", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-projection-terminal-age-"));
  const filename = path.join(directory, "agent-registry.json");
  const artifactPath = path.join(directory, "019f7b8a-9f75-7dc0-b231-17f7eadd7fe4.jsonl");
  try {
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const recovered = registry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      transport: "structured",
      accountId: "work",
      clientAttemptId: "terminal_age_recovered_20260717_a1",
      requestDigest: "1".repeat(64),
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    const failed = registry.beginSpawnRequest({
      engine: "claude",
      cwd: directory,
      transport: "structured",
      accountId: "work",
      clientAttemptId: "terminal_age_failed_20260717_a1",
      requestDigest: "2".repeat(64),
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    if (recovered.kind !== "created" || failed.kind !== "created") throw new Error("expected structured launch creation");
    registry.settleSpawn(recovered.receipt.launchId, {
      key: { engine: "codex", sessionId: "019f7b8a-9f75-7dc0-b231-17f7eadd7fe4" },
      artifactPath,
      cwd: directory,
      accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
      status: "unhosted",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });
    registry.failSpawn(failed.receipt.launchId, "runtime host request timed out");

    const createdMs = Math.max(Date.parse(recovered.receipt.createdAt), Date.parse(failed.receipt.createdAt));
    const fresh = preallocatedStructuredSpawnCards([], registry.snapshot(), createdMs + 14 * 60 * 1_000);
    expect(fresh.find((card) => card.path === `spawn:${recovered.receipt.launchId}`)?.activity).toBe("recent");
    expect(fresh.find((card) => card.path === `spawn:${failed.receipt.launchId}`)?.activity).toBe("stalled");

    const historical = preallocatedStructuredSpawnCards([], registry.snapshot(), createdMs + 16 * 60 * 1_000);
    expect(historical.find((card) => card.path === `spawn:${recovered.receipt.launchId}`)?.activity).toBe("idle");
    expect(historical.find((card) => card.path === `spawn:${failed.receipt.launchId}`)?.activity).toBe("idle");
    expect(historical.map((card) => card.spawn?.retrySafe)).toContain(true);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a legacy completed receipt with a recorded transcript stays materialized after restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-projection-legacy-materialized-"));
  const filename = path.join(directory, "agent-registry.json");
  const artifactPath = path.join(directory, "019f678d-951e-77f1-bc6a-c3175a6a7bd4.jsonl");
  try {
    fs.writeFileSync(artifactPath, `${JSON.stringify({ type: "user", message: "legacy completed transcript" })}\n`);
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const begun = registry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      transport: "structured",
      accountId: "work",
      clientAttemptId: "legacy_materialized_20260717_a1",
      requestDigest: "b".repeat(64),
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    if (begun.kind !== "created") throw new Error("expected structured launch creation");
    registry.settleSpawn(begun.receipt.launchId, {
      key: { engine: "codex", sessionId: "019f678d-951e-77f1-bc6a-c3175a6a7bd4" },
      artifactPath,
      cwd: directory,
      accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
      status: "unhosted",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });
    observeArtifact(registry, artifactPath, directory);

    const legacy = JSON.parse(fs.readFileSync(filename, "utf8")) as {
      receipts: Record<string, { artifactLifecycle?: string; createdAt: string }>;
    };
    delete legacy.receipts[begun.receipt.launchId]?.artifactLifecycle;
    legacy.receipts[begun.receipt.launchId]!.createdAt = "2026-07-15T20:00:00.000Z";
    fs.writeFileSync(filename, JSON.stringify(legacy));

    const restarted = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    expect(restarted.snapshot().receipts[begun.receipt.launchId]?.artifactLifecycle).toBe("materialized");
    expect(preallocatedStructuredSpawnCards([], restarted.snapshot())).toEqual([]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite import backfills a rollout-era pending lifecycle from durable inventory evidence", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-projection-legacy-sqlite-"));
  const filename = path.join(directory, "agent-registry.json");
  const artifactPath = path.join(directory, "019f678d-951e-77f1-bc6a-c3175a6a7bd5.jsonl");
  try {
    fs.writeFileSync(artifactPath, `${JSON.stringify({ type: "user", message: "legacy sqlite transcript" })}\n`);
    const jsonRegistry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const begun = jsonRegistry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      transport: "structured",
      accountId: "work",
      clientAttemptId: "legacy_sqlite_materialized_20260717_a1",
      requestDigest: "7".repeat(64),
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    if (begun.kind !== "created") throw new Error("expected structured launch creation");
    jsonRegistry.settleSpawn(begun.receipt.launchId, {
      key: { engine: "codex", sessionId: "019f678d-951e-77f1-bc6a-c3175a6a7bd5" },
      artifactPath,
      cwd: directory,
      accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
      status: "unhosted",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });
    observeArtifact(jsonRegistry, artifactPath, directory);

    const rolloutEra = JSON.parse(fs.readFileSync(filename, "utf8")) as {
      receipts: Record<string, { artifactLifecycle: string; createdAt: string }>;
    };
    rolloutEra.receipts[begun.receipt.launchId]!.artifactLifecycle = "pending";
    rolloutEra.receipts[begun.receipt.launchId]!.createdAt = "2026-07-15T20:00:00.000Z";
    fs.writeFileSync(filename, JSON.stringify(rolloutEra));

    const imported = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
    expect(imported.snapshot().receipts[begun.receipt.launchId]?.artifactLifecycle).toBe("materialized");
    const restarted = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
    expect(preallocatedStructuredSpawnCards([], restarted.snapshot())).toEqual([]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("another generation's newer observation cannot materialize a pending launch", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-projection-existing-scan-lag-"));
  const filename = path.join(directory, "agent-registry.json");
  const firstPath = path.join(directory, "019f678d-951e-77f1-bc6a-c3175a6a7bd6.jsonl");
  const successorPath = path.join(directory, "019f678d-951e-77f1-bc6a-c3175a6a7bd7.jsonl");
  try {
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const conversation = registry.ensureConversation("codex", firstPath, "work");
    observeArtifact(registry, firstPath, directory);
    const begun = registry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      transport: "structured",
      accountId: "work",
      conversationId: conversation.id,
      clientAttemptId: "successor_scan_lag_20260717_a1",
      requestDigest: "8".repeat(64),
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    if (begun.kind !== "created") throw new Error("expected structured launch creation");
    registry.settleSpawn(begun.receipt.launchId, {
      key: { engine: "codex", sessionId: "019f678d-951e-77f1-bc6a-c3175a6a7bd7" },
      artifactPath: successorPath,
      cwd: directory,
      accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
      status: "unhosted",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });

    const persisted = JSON.parse(fs.readFileSync(filename, "utf8")) as {
      receipts: Record<string, { createdAt: string }>;
      conversations: Record<string, {
        generations: Array<{ path: string; createdAt: string }>;
        turn: { observedAt: string | null };
      }>;
    };
    persisted.receipts[begun.receipt.launchId]!.createdAt = "2026-07-17T08:00:00.000Z";
    persisted.conversations[conversation.id]!.turn.observedAt = "2026-07-17T11:00:00.000Z";
    persisted.conversations[conversation.id]!.generations
      .find((generation) => generation.path === successorPath)!.createdAt = "2026-07-17T10:00:00.000Z";
    fs.writeFileSync(filename, JSON.stringify(persisted));

    const restarted = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    expect(restarted.snapshot().receipts[begun.receipt.launchId]?.artifactLifecycle).toBe("pending");
    expect(preallocatedStructuredSpawnCards([], restarted.snapshot())).toHaveLength(1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a deleted settled structured transcript stays absent after JSON restart", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-projection-delete-"));
  const filename = path.join(directory, "agent-registry.json");
  const artifactPath = path.join(directory, "019f7b8a-9f75-7dc0-b231-17f7eadd7fe1.jsonl");
  try {
    fs.writeFileSync(artifactPath, `${JSON.stringify({ type: "user", message: "settled" })}\n`);
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const begun = registry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      transport: "structured",
      accountId: "work",
      clientAttemptId: "settled_delete_20260717_a1",
      requestDigest: "d".repeat(64),
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    if (begun.kind !== "created") throw new Error("expected structured launch creation");
    const settled = registry.settleSpawn(begun.receipt.launchId, {
      key: { engine: "codex", sessionId: "019f7b8a-9f75-7dc0-b231-17f7eadd7fe1" },
      artifactPath,
      cwd: directory,
      accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
      status: "unhosted",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });
    expect(settled.kind).toBe("settled");
    expect(preallocatedStructuredSpawnCards([scannedFile(artifactPath)], registry.snapshot())).toEqual([]);
    observeArtifact(registry, artifactPath, directory);

    fs.unlinkSync(artifactPath);
    const restarted = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });

    expect(preallocatedStructuredSpawnCards([], restarted.snapshot())).toEqual([]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a pending launch remains visible until inventory materializes its transcript", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-projection-pending-"));
  const filename = path.join(directory, "agent-registry.json");
  const artifactPath = path.join(directory, "019f7b8a-9f75-7dc0-b231-17f7eadd7fe2.jsonl");
  try {
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    const begun = registry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      transport: "structured",
      accountId: "work",
      clientAttemptId: "pending_materialize_20260717_a1",
      requestDigest: "e".repeat(64),
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    if (begun.kind !== "created") throw new Error("expected structured launch creation");
    registry.settleSpawn(begun.receipt.launchId, {
      key: { engine: "codex", sessionId: "019f7b8a-9f75-7dc0-b231-17f7eadd7fe2" },
      artifactPath,
      cwd: directory,
      accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
      status: "unhosted",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });

    expect(preallocatedStructuredSpawnCards([], registry.snapshot())).toHaveLength(1);

    fs.writeFileSync(artifactPath, `${JSON.stringify({ type: "user", message: "materialized" })}\n`);
    observeArtifact(registry, artifactPath, directory);
    fs.unlinkSync(artifactPath);

    const restarted = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "off" });
    expect(preallocatedStructuredSpawnCards([], restarted.snapshot())).toEqual([]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite restart preserves materialized transcript deletion and pending launch visibility", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-projection-sqlite-"));
  const filename = path.join(directory, "agent-registry.json");
  const artifactPath = path.join(directory, "019f7b8a-9f75-7dc0-b231-17f7eadd7fe3.jsonl");
  try {
    fs.writeFileSync(artifactPath, `${JSON.stringify({ type: "user", message: "sqlite" })}\n`);
    const registry = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
    const settled = registry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      transport: "structured",
      accountId: "work",
      clientAttemptId: "sqlite_delete_20260717_a1",
      requestDigest: "f".repeat(64),
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    const pending = registry.beginSpawnRequest({
      engine: "claude",
      cwd: directory,
      transport: "structured",
      accountId: "work",
      clientAttemptId: "sqlite_pending_20260717_a1",
      requestDigest: "a".repeat(64),
      launchProfile: emptyLaunchProfile({ cwd: directory }),
    });
    if (settled.kind !== "created" || pending.kind !== "created") throw new Error("expected structured launch creation");
    registry.settleSpawn(settled.receipt.launchId, {
      key: { engine: "codex", sessionId: "019f7b8a-9f75-7dc0-b231-17f7eadd7fe3" },
      artifactPath,
      cwd: directory,
      accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: directory }),
      status: "unhosted",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });
    observeArtifact(registry, artifactPath, directory);
    fs.unlinkSync(artifactPath);

    const restarted = new AgentRegistry(filename, undefined, undefined, { sqliteMode: "sqlite" });
    const cards = preallocatedStructuredSpawnCards([], restarted.snapshot());

    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      path: `spawn:${pending.receipt.launchId}`,
      spawn: { state: "starting", initialMessage: "pending" },
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("inventory materialization stays scoped to the observed engine", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-spawn-projection-engine-scope-"));
  const artifactPath = path.join(directory, "shared.jsonl");
  try {
    const registry = new AgentRegistry(path.join(directory, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    const codex = registry.beginSpawnRequest({
      engine: "codex",
      cwd: directory,
      transport: "structured",
      expectedArtifactPath: artifactPath,
      clientAttemptId: "engine_scope_codex_20260717_a1",
      requestDigest: "1".repeat(64),
    });
    const claude = registry.beginSpawnRequest({
      engine: "claude",
      cwd: directory,
      transport: "structured",
      expectedArtifactPath: artifactPath,
      clientAttemptId: "engine_scope_claude_20260717_a1",
      requestDigest: "2".repeat(64),
    });
    if (codex.kind !== "created" || claude.kind !== "created") throw new Error("expected structured launch creation");

    observeArtifact(registry, artifactPath, directory);
    const snapshot = registry.snapshot();

    expect(snapshot.receipts[codex.receipt.launchId]?.artifactLifecycle).toBe("materialized");
    expect(snapshot.receipts[claude.receipt.launchId]?.artifactLifecycle).toBe("pending");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
