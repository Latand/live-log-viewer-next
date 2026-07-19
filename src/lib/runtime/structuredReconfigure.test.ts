import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry } from "@/lib/agent/registry";
import { reconcileMigrations } from "@/lib/accounts/migration/coordinator";
import type { SuccessorProviderPort, ViewerConversationId } from "@/lib/accounts/migration/contracts";

import { applyStructuredReconfigure } from "./structuredReconfigure";
import type { StructuredReconfigureEffect } from "./structuredDeliveryQueue";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(profile: Partial<{ model: string | null; effort: string | null; fast: boolean | null }> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-reconfigure-"));
  roots.push(root);
  const registry = new AgentRegistry(path.join(root, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const sessionId = crypto.randomUUID();
  const transcript = path.join(root, `rollout-${sessionId}.jsonl`);
  fs.writeFileSync(transcript, "{}\n");
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd: root,
    accountId: "source",
    transport: "structured",
    launchProfile: { model: "gpt-5.5", effort: "medium", fast: false, ...profile },
  });
  if (begun.kind !== "created") throw new Error("fixture spawn was unavailable");
  const settled = registry.settleSpawn(begun.receipt.launchId, {
    key: { engine: "codex", sessionId },
    artifactPath: transcript,
    cwd: root,
    accountId: "source",
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "test:host",
      process: { pid: process.pid, startIdentity: "test" },
      eventCursor: 1,
      protocolVersion: "test",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: "structured-host:test",
    pendingAction: null,
    launchProfile: begun.receipt.launchProfile,
  });
  if (settled.kind !== "settled") throw new Error("fixture settlement failed");
  return { registry, conversationId: begun.receipt.conversationId, transcript };
}

function effect(overrides: Partial<StructuredReconfigureEffect> = {}): StructuredReconfigureEffect {
  return {
    kind: "reconfigure",
    operationId: "switch-one",
    conversationId: "conversation_fixture",
    model: "gpt-5.6-sol",
    effort: "high",
    fast: true,
    eventSeq: 1,
    ...overrides,
  };
}

test("idle model reconfigure restarts the same generation with the updated launch profile", async () => {
  const target = fixture();
  const generationId = target.registry.conversation(target.conversationId)!.generations.at(-1)!.id;
  const released: string[] = [];
  const recoveredProfiles: unknown[] = [];

  const outcome = await applyStructuredReconfigure(effect({ conversationId: target.conversationId }), {
    registry: target.registry,
    releaseHost: async (key) => { released.push(`${key.engine}:${key.sessionId}`); return true; },
    recover: async (request) => {
      recoveredProfiles.push(target.registry.conversation(request.conversationId as ViewerConversationId)?.generations.at(-1)?.launchProfile);
      return { target: null, path: target.transcript, conversationId: target.conversationId, spawned: true };
    },
  });

  expect(outcome).toBe("applied");
  expect(released).toEqual([`codex:${generationId}`]);
  expect(recoveredProfiles).toEqual([expect.objectContaining({ model: "gpt-5.6-sol", effort: "high", fast: true })]);
  expect(target.registry.conversation(target.conversationId)!.generations).toHaveLength(1);
});

test("unauthenticated account reconfigure leaves profile and host ownership untouched", async () => {
  const target = fixture();
  const before = target.registry.conversation(target.conversationId)!;
  const generationId = before.generations.at(-1)!.id;
  let releases = 0;

  await expect(applyStructuredReconfigure(effect({
    conversationId: target.conversationId,
    accountId: "signed-out",
  }), {
    registry: target.registry,
    validateAccount: async () => { throw new Error("target codex account is not authenticated"); },
    resolveAccount: () => ({}) as never,
    migrate: async () => target.registry.conversation(target.conversationId)!,
    releaseHost: async () => { releases += 1; return true; },
  })).rejects.toThrow("target codex account is not authenticated");

  const after = target.registry.conversation(target.conversationId)!;
  expect(after.generations.at(-1)?.launchProfile).toEqual(before.generations.at(-1)?.launchProfile);
  expect(after.generations.at(-1)?.accountId).toBe("source");
  expect(target.registry.snapshot().entries[`codex:${generationId}`]?.structuredHost?.process).not.toBeNull();
  expect(releases).toBe(0);
});

test("account reconfigure stays pending until the durable successor commits", async () => {
  const target = fixture();
  let releases = 0;
  const outcome = await applyStructuredReconfigure(effect({
    conversationId: target.conversationId,
    accountId: "target",
  }), {
    registry: target.registry,
    validateAccount: async () => {},
    resolveAccount: () => ({}) as never,
    migrate: async () => target.registry.conversation(target.conversationId)!,
    releaseHost: async () => { releases += 1; return true; },
  });

  expect(outcome).toBe("pending");
  expect(releases).toBe(0);
  expect(target.registry.conversation(target.conversationId)!.generations).toHaveLength(1);
});

test("account reconfigure restores the admitted profile after a pending attempt later fails", async () => {
  const target = fixture();
  const request = effect({
    conversationId: target.conversationId,
    accountId: "target",
    previousProfile: { model: "gpt-5.5", effort: "medium", fast: false },
  } as never);
  const pending = await applyStructuredReconfigure(request, {
    registry: target.registry,
    validateAccount: async () => {},
    resolveAccount: () => ({}) as never,
    migrate: async () => target.registry.conversation(target.conversationId)!,
  });
  expect(pending).toBe("pending");
  expect(target.registry.conversation(target.conversationId)?.generations.at(-1)?.launchProfile).toMatchObject({
    model: "gpt-5.6-sol",
    effort: "high",
    fast: true,
  });

  await expect(applyStructuredReconfigure(request, {
    registry: target.registry,
    validateAccount: async () => {},
    resolveAccount: () => ({}) as never,
    migrate: async () => ({
      ...target.registry.conversation(target.conversationId)!,
      migration: { phase: "failed-recoverable", error: "successor authentication expired" },
    }) as never,
  })).rejects.toThrow("successor authentication expired");
  expect(target.registry.conversation(target.conversationId)?.generations.at(-1)?.launchProfile).toMatchObject({
    model: "gpt-5.5",
    effort: "medium",
    fast: false,
  });
});

test("a stale failed apply cannot roll its profile back over a newer reconfigure", async () => {
  const target = fixture();
  let releaseOldRecovery!: () => void;
  let oldRecoveryStarted!: () => void;
  const oldRecoveryGate = new Promise<void>((resolve) => { releaseOldRecovery = resolve; });
  const oldRecoveryEntered = new Promise<void>((resolve) => { oldRecoveryStarted = resolve; });
  let oldRecoveryAttempts = 0;
  const oldApply = applyStructuredReconfigure(effect({
    operationId: "switch-old",
    conversationId: target.conversationId,
    model: "gpt-5.6-sol",
    effort: "high",
    fast: false,
    previousProfile: { model: "gpt-5.5", effort: "medium", fast: false },
    eventSeq: 10,
  }), {
    registry: target.registry,
    releaseHost: async () => true,
    recover: async () => {
      oldRecoveryAttempts += 1;
      if (oldRecoveryAttempts === 1) {
        oldRecoveryStarted();
        await oldRecoveryGate;
        throw new Error("old target failed to start");
      }
      return { target: null, path: target.transcript, conversationId: target.conversationId, spawned: true };
    },
  });
  await oldRecoveryEntered;

  await applyStructuredReconfigure(effect({
    operationId: "switch-new",
    conversationId: target.conversationId,
    model: "gpt-5.6-terra",
    effort: "xhigh",
    fast: true,
    previousProfile: { model: "gpt-5.6-sol", effort: "high", fast: false },
    eventSeq: 11,
  }), {
    registry: target.registry,
    releaseHost: async () => true,
    recover: async () => ({ target: null, path: target.transcript, conversationId: target.conversationId, spawned: true }),
  });
  releaseOldRecovery();
  await expect(oldApply).rejects.toThrow();

  expect(target.registry.conversation(target.conversationId)?.generations.at(-1)?.launchProfile).toMatchObject({
    model: "gpt-5.6-terra",
    effort: "xhigh",
    fast: true,
  });
});

test("a failed LWW reconfigure restores the last stable profile across an applying predecessor", () => {
  const target = fixture({ model: "gpt-5.5", effort: "medium", fast: false });
  const first = target.registry.claimConversationReconfigure(target.conversationId, {
    operationId: "optimistic-a",
    revision: 10,
    profile: { model: "gpt-5.6-sol", effort: "high", fast: false },
  });
  expect(first.kind).toBe("claimed");
  expect(target.registry.conversation(target.conversationId)?.generations.at(-1)?.launchProfile).toMatchObject({
    model: "gpt-5.6-sol",
    effort: "high",
    fast: false,
  });

  const second = target.registry.claimConversationReconfigure(target.conversationId, {
    operationId: "optimistic-b",
    revision: 11,
    profile: { model: "gpt-5.6-terra", effort: "xhigh", fast: true },
  });
  expect(second.kind).toBe("claimed");
  if (!second.state) throw new Error("second reconfigure claim did not persist ownership");
  expect(second.state.previousProfile).toEqual({ model: "gpt-5.5", effort: "medium", fast: false });

  target.registry.settleConversationReconfigure(
    target.conversationId,
    "optimistic-b",
    11,
    "failed",
    "replacement failed",
  );
  const reopened = new AgentRegistry(target.registry.filename, undefined, undefined, { sqliteMode: "off" });
  expect(reopened.conversation(target.conversationId)?.generations.at(-1)?.launchProfile).toMatchObject({
    model: "gpt-5.5",
    effort: "medium",
    fast: false,
  });
});

test("a newer account reconfigure supersedes an in-flight conversation migration", async () => {
  const target = fixture();
  let releaseMigrationB!: () => void;
  let migrationBStarted!: () => void;
  const migrationBGate = new Promise<void>((resolve) => { releaseMigrationB = resolve; });
  const migrationBEntered = new Promise<void>((resolve) => { migrationBStarted = resolve; });
  const common = {
    registry: target.registry,
    validateAccount: async () => {},
    resolveAccount: () => ({}) as never,
    releaseHost: async () => true,
  };
  const switchToB = applyStructuredReconfigure(effect({
    operationId: "switch-account-b",
    conversationId: target.conversationId,
    accountId: "b",
    eventSeq: 20,
  }), {
    ...common,
    migrate: async (conversationId, accountId, registry) => {
      registry.requestConversationReseat(conversationId, accountId);
      migrationBStarted();
      await migrationBGate;
      return registry.conversation(conversationId)!;
    },
  });
  await migrationBEntered;

  const switchToC = await applyStructuredReconfigure(effect({
    operationId: "switch-account-c",
    conversationId: target.conversationId,
    accountId: "c",
    model: "gpt-5.6-terra",
    effort: "xhigh",
    eventSeq: 21,
  }), {
    ...common,
    migrate: async (conversationId, accountId, registry) => {
      registry.requestConversationReseat(conversationId, accountId);
      return registry.conversation(conversationId)!;
    },
  });
  releaseMigrationB();
  await expect(switchToB).rejects.toThrow("superseded");

  expect(switchToC).toBe("pending");
  expect(target.registry.conversation(target.conversationId)?.migration).toMatchObject({ targetId: "c" });
  expect(Object.values(target.registry.snapshot().conversations)).toHaveLength(1);
});

test("post-commit supersedence still releases the captured predecessor generation", async () => {
  const target = fixture();
  const predecessor = target.registry.conversation(target.conversationId)!.generations.at(-1)!;
  const successorPath = path.join(path.dirname(target.transcript), "post-commit-superseded.jsonl");
  fs.writeFileSync(successorPath, "{}\n");
  let migrationCommitted!: () => void;
  let releaseMigrationReturn!: () => void;
  const committed = new Promise<void>((resolve) => { migrationCommitted = resolve; });
  const migrationReturnGate = new Promise<void>((resolve) => { releaseMigrationReturn = resolve; });
  let activeOperation = "post-commit-old";
  const released: string[] = [];

  const oldApply = applyStructuredReconfigure(effect({
    operationId: "post-commit-old",
    conversationId: target.conversationId,
    accountId: "target",
    eventSeq: 22,
  }), {
    registry: target.registry,
    validateAccount: async () => {},
    resolveAccount: () => ({}) as never,
    ownsOperation: async () => activeOperation === "post-commit-old",
    releaseHost: async (key) => { released.push(key.sessionId); return true; },
    migrate: async (conversationId, accountId, registry) => {
      let migration = registry.conversation(conversationId)!.migration!;
      if (migration.phase === "waiting-turn") {
        migration = registry.transitionConversationMigration(conversationId, migration.revision, ["waiting-turn"], { phase: "requested" }).migration!;
      }
      migration = registry.transitionConversationMigration(conversationId, migration.revision, ["requested"], { phase: "preparing" }).migration!;
      migration = registry.transitionConversationMigration(conversationId, migration.revision, ["preparing"], { phase: "successor-starting" }).migration!;
      const receipt = {
        operationId: migration.operationId,
        nativeId: "thread-post-commit-successor",
        path: successorPath,
        continuityPaths: [successorPath],
        historyHash: "post-commit-successor-history",
        host: { kind: "codex-app-server" as const, identity: "post-commit-successor-host", epoch: 1, verifiedAt: "2026-07-20T12:00:00.000Z" },
      };
      registry.persistMigrationProviderReceipt(conversationId, migration.revision, migration.operationId, receipt);
      const result = registry.commitSuccessor(conversationId, {
        id: receipt.nativeId,
        path: receipt.path,
        accountId,
        historyHash: receipt.historyHash,
        host: receipt.host,
      }, migration.revision);
      migrationCommitted();
      await migrationReturnGate;
      return result;
    },
  });
  await committed;

  activeOperation = "post-commit-new";
  target.registry.claimConversationReconfigure(target.conversationId, {
    operationId: "post-commit-new",
    revision: 23,
    profile: { model: "gpt-5.6-terra", effort: "xhigh", fast: true },
    accountId: "target",
  });
  releaseMigrationReturn();

  await expect(oldApply).rejects.toThrow("superseded");
  expect(released).toEqual([predecessor.id]);
  expect(target.registry.snapshot().entries[`codex:${predecessor.id}`]?.structuredHost).toBeNull();
  expect(target.registry.conversation(target.conversationId)?.generations.at(-1)?.id).toBe("thread-post-commit-successor");
});

test("a profile-only reconfigure retires its superseded account migration before reconciliation", async () => {
  const target = fixture();
  const successorPath = path.join(path.dirname(target.transcript), "profile-only-superseded.jsonl");
  fs.writeFileSync(successorPath, "{}\n");
  const receipt = {
    operationId: "pending",
    nativeId: "thread-profile-only-superseded",
    path: successorPath,
    continuityPaths: [successorPath],
    historyHash: "profile-only-superseded-history",
    host: { kind: "codex-app-server" as const, identity: "profile-only-superseded-host", epoch: 1, verifiedAt: "2026-07-19T12:00:00.000Z" },
  };

  const pending = await applyStructuredReconfigure(effect({
    operationId: "switch-account-before-profile",
    conversationId: target.conversationId,
    accountId: "target",
    eventSeq: 40,
  }), {
    registry: target.registry,
    validateAccount: async () => {},
    resolveAccount: () => ({}) as never,
    migrate: async (conversationId, _accountId, registry) => {
      let migration = registry.conversation(conversationId)!.migration!;
      if (migration.phase === "waiting-turn") {
        migration = registry.transitionConversationMigration(conversationId, migration.revision, ["waiting-turn"], { phase: "requested" }).migration!;
      }
      migration = registry.transitionConversationMigration(conversationId, migration.revision, ["requested"], { phase: "preparing" }).migration!;
      migration = registry.transitionConversationMigration(conversationId, migration.revision, ["preparing"], { phase: "successor-starting" }).migration!;
      receipt.operationId = migration.operationId;
      return registry.persistMigrationProviderReceipt(conversationId, migration.revision, migration.operationId, receipt);
    },
  });
  expect(pending).toBe("pending");
  expect(target.registry.conversation(target.conversationId)?.migration?.phase).toBe("verifying");

  await applyStructuredReconfigure(effect({
    operationId: "profile-wins",
    conversationId: target.conversationId,
    model: "gpt-5.6-terra",
    effort: "xhigh",
    eventSeq: 41,
  }), {
    registry: target.registry,
    releaseHost: async () => true,
    recover: async () => ({ target: null, path: target.transcript, conversationId: target.conversationId, spawned: true }),
  });

  const calls = { create: 0, verify: 0, publish: 0, cleanup: 0 };
  const provider: SuccessorProviderPort = {
    virtualSource: true,
    async create() { calls.create += 1; return receipt; },
    async verify() { calls.verify += 1; },
    async publishHost() { calls.publish += 1; },
    async cleanup() { calls.cleanup += 1; },
  };
  const delivery = { async deliver() { return "delivered" as const; } };
  await reconcileMigrations(provider, delivery, target.registry);
  await reconcileMigrations(provider, delivery, target.registry);

  expect(target.registry.conversation(target.conversationId)?.migration?.phase).toBe("rolled-back");
  expect(calls).toEqual({ create: 0, verify: 0, publish: 0, cleanup: 1 });
});

test("a profile-only reconfigure retires a migration after a newer same-target account claim", async () => {
  const target = fixture();
  const successorPath = path.join(path.dirname(target.transcript), "same-target-superseded.jsonl");
  fs.writeFileSync(successorPath, "{}\n");
  const receipt = {
    operationId: "pending",
    nativeId: "thread-same-target-superseded",
    path: successorPath,
    continuityPaths: [successorPath],
    historyHash: "same-target-superseded-history",
    host: { kind: "codex-app-server" as const, identity: "same-target-superseded-host", epoch: 1, verifiedAt: "2026-07-19T12:00:00.000Z" },
  };
  const common = {
    registry: target.registry,
    validateAccount: async () => {},
    resolveAccount: () => ({}) as never,
  };

  const first = await applyStructuredReconfigure(effect({
    operationId: "same-target-first",
    conversationId: target.conversationId,
    accountId: "target",
    eventSeq: 50,
  }), {
    ...common,
    migrate: async (conversationId, _accountId, registry) => {
      let migration = registry.conversation(conversationId)!.migration!;
      if (migration.phase === "waiting-turn") {
        migration = registry.transitionConversationMigration(conversationId, migration.revision, ["waiting-turn"], { phase: "requested" }).migration!;
      }
      migration = registry.transitionConversationMigration(conversationId, migration.revision, ["requested"], { phase: "preparing" }).migration!;
      migration = registry.transitionConversationMigration(conversationId, migration.revision, ["preparing"], { phase: "successor-starting" }).migration!;
      receipt.operationId = migration.operationId;
      return registry.persistMigrationProviderReceipt(conversationId, migration.revision, migration.operationId, receipt);
    },
  });
  expect(first).toBe("pending");

  const second = await applyStructuredReconfigure(effect({
    operationId: "same-target-second",
    conversationId: target.conversationId,
    accountId: "target",
    model: "gpt-5.6-terra",
    effort: "xhigh",
    eventSeq: 51,
  }), {
    ...common,
    migrate: async (conversationId, _accountId, registry) => registry.conversation(conversationId)!,
  });
  expect(second).toBe("pending");
  expect(target.registry.conversation(target.conversationId)?.reconfigure).toMatchObject({
    operationId: "same-target-second",
    revision: 51,
    status: "applying",
  });
  const migrationIntentId = target.registry.conversation(target.conversationId)!.migration!.intentId;
  expect(target.registry.snapshot().migrationIntents[migrationIntentId]?.requestIds).toEqual([
    "reconfigure:same-target-second:51",
  ]);

  await applyStructuredReconfigure(effect({
    operationId: "same-target-profile-wins",
    conversationId: target.conversationId,
    model: "gpt-5.6-sol",
    effort: "ultra",
    eventSeq: 52,
  }), {
    registry: target.registry,
    releaseHost: async () => true,
    recover: async () => ({ target: null, path: target.transcript, conversationId: target.conversationId, spawned: true }),
  });

  const calls = { create: 0, verify: 0, publish: 0, cleanup: 0 };
  const provider: SuccessorProviderPort = {
    virtualSource: true,
    async create() { calls.create += 1; return receipt; },
    async verify() { calls.verify += 1; },
    async publishHost() { calls.publish += 1; },
    async cleanup() { calls.cleanup += 1; },
  };
  const delivery = { async deliver() { return "delivered" as const; } };
  await reconcileMigrations(provider, delivery, target.registry);
  await reconcileMigrations(provider, delivery, target.registry);

  expect(target.registry.conversation(target.conversationId)?.migration?.phase).toBe("rolled-back");
  expect(calls).toEqual({ create: 0, verify: 0, publish: 0, cleanup: 1 });
});

test("a failed apply durably restores a sparse profile with its operation fence", async () => {
  const target = fixture({ model: null, effort: null, fast: null });
  const request = effect({
    operationId: "sparse-profile-failure",
    conversationId: target.conversationId,
    previousProfile: { model: null, effort: null, fast: null },
    eventSeq: 30,
  });

  await expect(applyStructuredReconfigure(request, {
    registry: target.registry,
    releaseHost: async () => true,
    recover: async () => { throw new Error("replacement host failed"); },
  })).rejects.toThrow("replacement host failed");

  const reopened = new AgentRegistry(target.registry.filename, undefined, undefined, { sqliteMode: "off" });
  const persisted = reopened.conversation(target.conversationId)!;
  expect(persisted.generations.at(-1)?.launchProfile).toMatchObject({ model: null, effort: null, fast: null });
  expect(persisted.reconfigure).toMatchObject({
    operationId: "sparse-profile-failure",
    revision: 30,
    status: "failed",
    previousProfile: { model: null, effort: null, fast: null },
    error: "replacement host failed",
  });
});

test("a host release failure durably restores a sparse profile", async () => {
  const target = fixture({ model: null, effort: null, fast: null });
  const request = effect({
    operationId: "sparse-profile-release-failure",
    conversationId: target.conversationId,
    previousProfile: { model: null, effort: null, fast: null },
    eventSeq: 31,
  });
  const recoveredProfiles: unknown[] = [];

  await expect(applyStructuredReconfigure(request, {
    registry: target.registry,
    releaseHost: async () => { throw new Error("host release failed"); },
    recover: async () => {
      recoveredProfiles.push(target.registry.conversation(target.conversationId)?.generations.at(-1)?.launchProfile);
      return { target: null, path: target.transcript, conversationId: target.conversationId, spawned: true };
    },
  })).rejects.toThrow("host release failed");

  const reopened = new AgentRegistry(target.registry.filename, undefined, undefined, { sqliteMode: "off" });
  expect(recoveredProfiles).toEqual([expect.objectContaining({ model: null, effort: null, fast: null })]);
  expect(reopened.conversation(target.conversationId)?.generations.at(-1)?.launchProfile).toMatchObject({
    model: null,
    effort: null,
    fast: null,
  });
  expect(reopened.conversation(target.conversationId)?.reconfigure).toMatchObject({
    operationId: request.operationId,
    revision: request.eventSeq,
    status: "failed",
    previousProfile: { model: null, effort: null, fast: null },
    error: "host release failed",
  });
});

test("an account-switch release failure durably restores a sparse profile", async () => {
  const target = fixture({ model: null, effort: null, fast: null });
  const sourceGenerationId = target.registry.conversation(target.conversationId)!.generations.at(-1)!.id;
  const successorPath = path.join(path.dirname(target.transcript), "successor-release-failure.jsonl");
  fs.writeFileSync(successorPath, "{}\n");
  const request = effect({
    operationId: "sparse-account-release-failure",
    conversationId: target.conversationId,
    accountId: "target",
    previousProfile: { model: null, effort: null, fast: null },
    eventSeq: 32,
  });
  const released: string[] = [];
  let liveSuccessorProfile: unknown = null;

  await expect(applyStructuredReconfigure(request, {
    registry: target.registry,
    validateAccount: async () => {},
    resolveAccount: () => ({}) as never,
    releaseHost: async (key) => {
      released.push(key.sessionId);
      if (key.sessionId === sourceGenerationId) throw new Error("source host release failed");
      return true;
    },
    recover: async () => {
      liveSuccessorProfile = target.registry.conversation(target.conversationId)?.generations.at(-1)?.launchProfile;
      return { target: null, path: successorPath, conversationId: target.conversationId, spawned: true };
    },
    migrate: async (conversationId, accountId, registry) => {
      let migration = registry.conversation(conversationId)!.migration!;
      if (migration.phase === "waiting-turn") {
        migration = registry.transitionConversationMigration(conversationId, migration.revision, ["waiting-turn"], { phase: "requested" }).migration!;
      }
      migration = registry.transitionConversationMigration(conversationId, migration.revision, ["requested"], { phase: "preparing" }).migration!;
      migration = registry.transitionConversationMigration(conversationId, migration.revision, ["preparing"], { phase: "successor-starting" }).migration!;
      const receipt = {
        operationId: migration.operationId,
        nativeId: "thread-successor-release-failure",
        path: successorPath,
        continuityPaths: [successorPath],
        historyHash: "successor-release-failure-history",
        host: { kind: "codex-app-server" as const, identity: "successor-release-failure-host", epoch: 1, verifiedAt: "2026-07-19T12:00:00.000Z" },
      };
      registry.persistMigrationProviderReceipt(conversationId, migration.revision, migration.operationId, receipt);
      const committed = registry.commitSuccessor(conversationId, {
        id: receipt.nativeId,
        path: receipt.path,
        accountId,
        historyHash: receipt.historyHash,
        host: receipt.host,
      }, migration.revision);
      liveSuccessorProfile = committed.generations.at(-1)?.launchProfile;
      return committed;
    },
  })).rejects.toThrow("source host release failed");

  const reopened = new AgentRegistry(target.registry.filename, undefined, undefined, { sqliteMode: "off" });
  const persisted = reopened.conversation(target.conversationId)!;
  expect(persisted.generations.at(-1)).toMatchObject({
    id: "thread-successor-release-failure",
    accountId: "target",
    launchProfile: { model: null, effort: null, fast: null },
  });
  expect(persisted.reconfigure).toMatchObject({
    operationId: request.operationId,
    revision: request.eventSeq,
    status: "failed",
    previousProfile: { model: null, effort: null, fast: null },
    error: "source host release failed",
  });
  expect(released).toEqual([sourceGenerationId, "thread-successor-release-failure"]);
  expect(liveSuccessorProfile).toMatchObject({ model: null, effort: null, fast: null });
});

test("a committed account-switch replay restores the live successor profile after predecessor cleanup fails", async () => {
  const target = fixture({ model: null, effort: null, fast: null });
  const predecessorId = target.registry.conversation(target.conversationId)!.generations.at(-1)!.id;
  const successorPath = path.join(path.dirname(target.transcript), "successor-replay-release-failure.jsonl");
  fs.writeFileSync(successorPath, "{}\n");
  let migration = target.registry.requestConversationReseat(target.conversationId, "target").migration!;
  if (migration.phase === "waiting-turn") {
    migration = target.registry.transitionConversationMigration(target.conversationId, migration.revision, ["waiting-turn"], { phase: "requested" }).migration!;
  }
  migration = target.registry.transitionConversationMigration(target.conversationId, migration.revision, ["requested"], { phase: "preparing" }).migration!;
  migration = target.registry.transitionConversationMigration(target.conversationId, migration.revision, ["preparing"], { phase: "successor-starting" }).migration!;
  const receipt = {
    operationId: migration.operationId,
    nativeId: "thread-successor-replay-release-failure",
    path: successorPath,
    continuityPaths: [successorPath],
    historyHash: "successor-replay-release-failure-history",
    host: { kind: "codex-app-server" as const, identity: "successor-replay-release-failure-host", epoch: 1, verifiedAt: "2026-07-19T12:00:00.000Z" },
  };
  target.registry.persistMigrationProviderReceipt(target.conversationId, migration.revision, migration.operationId, receipt);
  target.registry.commitSuccessor(target.conversationId, {
    id: receipt.nativeId,
    path: receipt.path,
    accountId: "target",
    historyHash: receipt.historyHash,
    host: receipt.host,
  }, migration.revision);
  const released: string[] = [];
  let liveSuccessorProfile: unknown = null;

  await expect(applyStructuredReconfigure(effect({
    operationId: "committed-replay-release-failure",
    conversationId: target.conversationId,
    accountId: "target",
    previousProfile: { model: null, effort: null, fast: null },
    eventSeq: 33,
  }), {
    registry: target.registry,
    releaseHost: async (key) => {
      released.push(key.sessionId);
      if (key.sessionId === predecessorId) {
        liveSuccessorProfile = target.registry.conversation(target.conversationId)?.generations.at(-1)?.launchProfile;
        throw new Error("predecessor cleanup failed");
      }
      return true;
    },
    recover: async () => {
      liveSuccessorProfile = target.registry.conversation(target.conversationId)?.generations.at(-1)?.launchProfile;
      return { target: null, path: successorPath, conversationId: target.conversationId, spawned: true };
    },
  })).rejects.toThrow("predecessor cleanup failed");

  expect(released).toEqual([predecessorId, receipt.nativeId]);
  expect(liveSuccessorProfile).toMatchObject({ model: null, effort: null, fast: null });
});

test("an applying reconfigure resumes from its durable operation after registry recovery", async () => {
  const target = fixture({ model: null, effort: null, fast: null });
  const request = effect({
    operationId: "recover-applying-profile",
    conversationId: target.conversationId,
    previousProfile: { model: null, effort: null, fast: null },
    eventSeq: 31,
  });
  target.registry.claimConversationReconfigure(target.conversationId, {
    operationId: request.operationId,
    revision: request.eventSeq,
    profile: { model: request.model, effort: request.effort, fast: request.fast },
    previousProfile: request.previousProfile,
  });

  const recoveredRegistry = new AgentRegistry(target.registry.filename, undefined, undefined, { sqliteMode: "off" });
  const recoveredProfiles: unknown[] = [];
  const outcome = await applyStructuredReconfigure(request, {
    registry: recoveredRegistry,
    releaseHost: async () => true,
    recover: async () => {
      recoveredProfiles.push(recoveredRegistry.conversation(target.conversationId)?.generations.at(-1)?.launchProfile);
      return { target: null, path: target.transcript, conversationId: target.conversationId, spawned: true };
    },
  });

  expect(outcome).toBe("applied");
  expect(recoveredProfiles).toEqual([expect.objectContaining({ model: request.model, effort: request.effort, fast: request.fast })]);
  expect(recoveredRegistry.conversation(target.conversationId)?.reconfigure).toMatchObject({
    operationId: request.operationId,
    revision: request.eventSeq,
    status: "applied",
  });
});

test("account migration preserves conversation continuity without a duplicate card", async () => {
  const target = fixture();
  const successorPath = path.join(path.dirname(target.transcript), "successor-c.jsonl");
  fs.writeFileSync(successorPath, "{}\n");

  const outcome = await applyStructuredReconfigure(effect({
    operationId: "switch-with-continuity",
    conversationId: target.conversationId,
    accountId: "c",
    model: "gpt-5.6-terra",
    effort: "xhigh",
    eventSeq: 40,
  }), {
    registry: target.registry,
    validateAccount: async () => {},
    resolveAccount: () => ({}) as never,
    releaseHost: async () => true,
    migrate: async (conversationId, accountId, registry) => {
      let migration = registry.conversation(conversationId)!.migration!;
      if (migration.phase === "waiting-turn") {
        migration = registry.transitionConversationMigration(conversationId, migration.revision, ["waiting-turn"], { phase: "requested" }).migration!;
      }
      migration = registry.transitionConversationMigration(conversationId, migration.revision, ["requested"], { phase: "preparing" }).migration!;
      migration = registry.transitionConversationMigration(conversationId, migration.revision, ["preparing"], { phase: "successor-starting" }).migration!;
      const receipt = {
        operationId: migration.operationId,
        nativeId: "thread-successor-c",
        path: successorPath,
        continuityPaths: [successorPath],
        historyHash: "successor-c-history",
        host: { kind: "codex-app-server" as const, identity: "successor-c-host", epoch: 1, verifiedAt: "2026-07-19T12:00:00.000Z" },
      };
      registry.recordConversationContinuityPath(conversationId, successorPath);
      registry.persistMigrationProviderReceipt(conversationId, migration.revision, migration.operationId, receipt);
      return registry.commitSuccessor(conversationId, {
        id: receipt.nativeId,
        path: receipt.path,
        accountId,
        historyHash: receipt.historyHash,
        host: receipt.host,
      }, migration.revision);
    },
  });

  const settled = target.registry.conversation(target.conversationId)!;
  expect(outcome).toBe("applied");
  expect(settled.generations).toHaveLength(2);
  expect(settled.generations.at(-1)).toMatchObject({ id: "thread-successor-c", accountId: "c", path: successorPath });
  expect(target.registry.conversationForPath(target.transcript)?.id).toBe(target.conversationId);
  expect(target.registry.conversationForPath(successorPath)?.id).toBe(target.conversationId);
  expect(target.registry.canonicalPath(target.transcript)).toBe(successorPath);
  expect(Object.values(target.registry.snapshot().conversations)).toHaveLength(1);
});
