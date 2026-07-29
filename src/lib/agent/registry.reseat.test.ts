import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile, type ProviderReceipt, type ViewerConversationId } from "@/lib/accounts/migration/contracts";

import { AgentRegistry, type AgentRegistrySqliteMode, type ConversationObservation } from "./registry";

/*
 * Issue #97 — one-click successor reseat of a rate-limited conversation.
 * The registry seam must be lineage-safe (no duplicate successor, ever) and
 * durable across a viewer restart in both persistence modes.
 */

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function registryFile(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-reseat-"));
  roots.push(root);
  return path.join(root, "agent-registry.json");
}

function observation(pathname: string, accountId: string): ConversationObservation {
  return {
    engine: "codex",
    path: pathname,
    accountId,
    launchProfile: emptyLaunchProfile({
      cwd: "/repo/checkout",
      model: "gpt-5.6-terra",
      title: "Implementer",
      project: "repo",
      role: "worker",
      parentConversationId: "conversation_parent",
    }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-10T18:00:00.000Z",
  };
}

function providerReceipt(operationId: string, nativeId: string, pathname: string): ProviderReceipt {
  return {
    operationId,
    nativeId,
    path: pathname,
    continuityPaths: [pathname],
    historyHash: `history-${nativeId}`,
    host: {
      kind: "codex-app-server",
      identity: nativeId,
      epoch: 1,
      verifiedAt: "2026-07-20T12:00:00.000Z",
    },
  };
}

function seededRegistry(mode: AgentRegistrySqliteMode, filename: string): { store: AgentRegistry; id: ViewerConversationId } {
  const store = new AgentRegistry(filename, undefined, undefined, { sqliteMode: mode });
  store.reconcileConversations([observation("/sessions/limited.jsonl", "limited")]);
  const id = store.conversationForPath("/sessions/limited.jsonl")!.id;
  return { store, id };
}

for (const mode of ["off", "sqlite"] as const) {
  test(`a requested reseat survives a ${mode === "off" ? "JSON" : "SQLite"} registry restart with cwd and parentage intact`, () => {
    const filename = registryFile();
    const { store, id } = seededRegistry(mode, filename);
    const requested = store.requestConversationReseat(id, "healthy");
    expect(requested.migration).toMatchObject({ targetId: "healthy", phase: "requested" });

    const reopened = new AgentRegistry(filename, undefined, undefined, { sqliteMode: mode });
    const restored = reopened.conversation(id)!;
    expect(restored.migration).toMatchObject({
      targetId: "healthy",
      phase: "requested",
      operationId: requested.migration!.operationId,
      sourceGenerationId: requested.migration!.sourceGenerationId,
    });
    /* The successor inherits the source launch profile at commit time — the
       restart must not lose the cwd/parent lineage the fork will copy. */
    const source = restored.generations.at(-1)!;
    expect(source.launchProfile.cwd).toBe("/repo/checkout");
    expect(source.launchProfile.parentConversationId).toBe("conversation_parent");
    const intents = Object.values(reopened.snapshot().migrationIntents);
    expect(intents).toHaveLength(1);
    /* The reseat rides a conversation-scoped intent and must still be one
       after restart — an engine-scoped survivor would drain the whole engine. */
    expect(intents[0]).toMatchObject({ scope: "conversation", targetId: "healthy", state: "draining" });
  });

  test(`stopped migration delivery settlement survives a ${mode === "off" ? "JSON" : "SQLite"} registry restart`, () => {
    const filename = registryFile();
    const { store, id } = seededRegistry(mode, filename);
    const intent = store.commitMigrationIntent({
      engine: "codex",
      targetId: "healthy",
      origin: "manual",
      requestId: `stop-parity-${mode}`,
      expectedRevision: store.engineRouting("codex").revision,
    });
    const held = store.holdDelivery(id, "fixture", `stop-parity-${mode}`);
    store.setMigrationIntentState(intent.id, "stopped", intent.revision);

    const reopened = new AgentRegistry(filename, undefined, undefined, { sqliteMode: mode });
    expect(reopened.snapshot().migrationIntents[intent.id]).toMatchObject({ state: "stopped" });
    expect(reopened.snapshot().heldDeliveries[held.id]).toMatchObject({
      state: "failed",
      attempts: 0,
      generationId: null,
      deliveredAt: null,
      error: expect.stringContaining("migration was stopped"),
    });
  });
}

test("a conversation reseat never reuses or retargets the single engine drain intent", () => {
  const { store, id } = seededRegistry("off", registryFile());
  const reseated = store.requestConversationReseat(id, "healthy");
  const reseatIntentId = reseated.migration!.intentId;
  expect(store.snapshot().migrationIntents[reseatIntentId]).toMatchObject({ scope: "conversation", targetId: "healthy", state: "draining" });

  /* An engine-wide drain that starts while the reseat is in flight must mint
     its own intent instead of adopting and retargeting the reseat's. */
  const engineIntent = store.upsertMigrationIntent("codex", "engine-target", "manual", "engine-drain-request");
  expect(engineIntent.id).not.toBe(reseatIntentId);
  expect(store.snapshot().migrationIntents[reseatIntentId]).toMatchObject({ scope: "conversation", targetId: "healthy", requestIds: [`reseat:${id}:${reseated.migration!.sourceGenerationId}`] });

  /* Single engine-drain invariant: exactly one engine-scoped draining intent,
     and repeat engine requests keep converging on it. */
  const engineDrains = Object.values(store.snapshot().migrationIntents)
    .filter((intent) => intent.state === "draining" && (intent.scope ?? "engine") === "engine");
  expect(engineDrains).toHaveLength(1);
  expect(engineDrains[0]!.id).toBe(engineIntent.id);
  expect(store.upsertMigrationIntent("codex", "engine-target", "manual", "engine-drain-repeat").id).toBe(engineIntent.id);
});

test("a new spawn during a conversation reseat is never adopted into the drain", () => {
  const { store, id } = seededRegistry("off", registryFile());
  store.requestConversationReseat(id, "healthy");

  const spawnEntry = (sessionId: string, artifactPath: string) => ({
    key: { engine: "codex" as const, sessionId },
    artifactPath,
    cwd: "/repo/checkout",
    accountId: "limited",
    status: "live" as const,
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  const spawn = store.beginSpawn("codex", "/repo/checkout");
  const settled = store.settleSpawn(spawn.launchId, spawnEntry("019f4906-3f67-\x37b72-9fbc-9ec3b5ad1326", "/sessions/unrelated-spawn.jsonl"));
  expect(settled.kind).toBe("settled");
  expect(store.conversationForPath("/sessions/unrelated-spawn.jsonl")!.migration).toBeNull();

  /* The engine-wide contract is untouched: once a real engine drain is
     active, a spawn born on the departed account is still adopted. */
  store.commitMigrationIntent({
    engine: "codex",
    targetId: "engine-target",
    origin: "manual",
    requestId: "engine-wide-after-reseat",
    expectedRevision: store.engineRouting("codex").revision,
  });
  const second = store.beginSpawn("codex", "/repo/checkout");
  expect(store.settleSpawn(second.launchId, spawnEntry("019f4906-3f67-\x37b72-9fbc-9ec3b5ad1327", "/sessions/adopted-spawn.jsonl")).kind).toBe("settled");
  expect(store.conversationForPath("/sessions/adopted-spawn.jsonl")!.migration).toMatchObject({ targetId: "engine-target" });
});

test("a stale engine intent cannot adopt a future spawn", () => {
  const filename = registryFile();
  const { store } = seededRegistry("off", filename);
  const intent = store.commitMigrationIntent({
    engine: "codex",
    targetId: "target",
    origin: "manual",
    requestId: "stale-engine-intent",
    expectedRevision: store.engineRouting("codex").revision,
  });
  const snapshot = store.snapshot();
  snapshot.migrationIntents[intent.id]!.updatedAt = "2026-07-01T00:00:00.000Z";
  snapshot.migrationIntents[intent.id]!.createdAt = "2026-07-01T00:00:00.000Z";
  for (const conversation of Object.values(snapshot.conversations)) {
    if (conversation.migration?.intentId === intent.id) {
      conversation.migration.updatedAt = "2026-07-01T00:00:00.000Z";
    }
  }
  fs.writeFileSync(filename, JSON.stringify(snapshot));

  const restarted = new AgentRegistry(filename);
  const spawn = restarted.beginSpawn("codex", "/repo/checkout");
  const settled = restarted.settleSpawn(spawn.launchId, {
    key: { engine: "codex", sessionId: "future-spawn" },
    artifactPath: "/sessions/future-spawn.jsonl",
    cwd: "/repo/checkout",
    accountId: "source",
    status: "live",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });

  expect(settled.kind).toBe("settled");
  expect(restarted.conversationForPath("/sessions/future-spawn.jsonl")?.migration).toBeNull();
});

test("stopped and non-active-target intents cannot adopt unrelated spawns", () => {
  for (const state of ["stopped", "non-active-target"] as const) {
    const { store } = seededRegistry("off", registryFile());
    const intent = store.commitMigrationIntent({
      engine: "codex",
      targetId: "target",
      origin: "manual",
      requestId: `${state}-intent`,
      expectedRevision: store.engineRouting("codex").revision,
    });
    if (state === "stopped") store.setMigrationIntentState(intent.id, "stopped", intent.revision);
    else store.setEngineRouting("codex", "other-active-account");

    const pathname = `/sessions/${state}-spawn.jsonl`;
    const spawn = store.beginSpawn("codex", "/repo/checkout");
    const settled = store.settleSpawn(spawn.launchId, {
      key: { engine: "codex", sessionId: `${state}-spawn` },
      artifactPath: pathname,
      cwd: "/repo/checkout",
      accountId: "source",
      status: "live",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });

    expect(settled.kind).toBe("settled");
    expect(store.conversationForPath(pathname)?.migration).toBeNull();
  }
});

test("resume generation rollover cannot revive delivery cancelled by Stop", () => {
  const { store, id } = seededRegistry("off", registryFile());
  const intent = store.commitMigrationIntent({
    engine: "codex",
    targetId: "healthy",
    origin: "manual",
    requestId: "stop-before-resume",
    expectedRevision: store.engineRouting("codex").revision,
  });
  const held = store.holdDelivery(id, "fixture", "held-before-resume");
  store.setMigrationIntentState(intent.id, "stopped", intent.revision);
  const resume = store.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo/checkout",
    accountId: "limited",
    conversationId: id,
    purpose: "resume-successor",
  });
  if (resume.kind !== "created") throw new Error("expected resume create");
  expect(store.settleSpawn(resume.receipt.launchId, {
    key: { engine: "codex", sessionId: "resumed-generation" },
    artifactPath: "/sessions/resumed-generation.jsonl",
    cwd: "/repo/checkout",
    accountId: "limited",
    status: "live",
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  }).kind).toBe("settled");

  expect(store.conversation(id)?.generations.at(-1)?.path).toBe("/sessions/resumed-generation.jsonl");
  expect(store.snapshot().heldDeliveries[held.id]).toMatchObject({
    state: "failed",
    attempts: 0,
    generationId: null,
    error: expect.stringContaining("migration was stopped"),
  });
});

test("one hundred cancelled deliveries stay auditable without blocking a fresh action", () => {
  const { store, id } = seededRegistry("off", registryFile());
  const intent = store.commitMigrationIntent({
    engine: "codex",
    targetId: "healthy",
    origin: "manual",
    requestId: "retain-cancelled-history",
    expectedRevision: store.engineRouting("codex").revision,
  });
  const ids = Array.from({ length: 100 }, (_, index) =>
    store.holdDelivery(id, "fixture", `cancelled-history-${index}`).id);
  store.setMigrationIntentState(intent.id, "stopped", intent.revision);

  store.compactDeliveryReservations();
  const fresh = store.holdDelivery(id, "fresh fixture", "fresh-after-cancelled-history");

  expect(ids.every((deliveryId) =>
    store.snapshot().heldDeliveries[deliveryId]?.state === "failed")).toBe(true);
  expect(fresh).toMatchObject({ state: "assigned", attempts: 0 });
});

test("migration cancellation blanks payload text while preserving audit metadata", () => {
  const { store, id } = seededRegistry("off", registryFile());
  const intent = store.commitMigrationIntent({
    engine: "codex",
    targetId: "healthy",
    origin: "manual",
    requestId: "redact-cancelled-payload",
    expectedRevision: store.engineRouting("codex").revision,
  });
  const held = store.holdDelivery(id, "fixture payload", "redact-cancelled-payload");

  store.setMigrationIntentState(intent.id, "stopped", intent.revision);

  expect(store.snapshot().heldDeliveries[held.id]).toMatchObject({
    state: "failed",
    text: "",
    createdAt: held.createdAt,
    clientMessageId: held.clientMessageId,
    requestDigest: held.requestDigest,
    attempts: 0,
    assignedAt: null,
    deliveredAt: null,
    error: expect.stringContaining("migration was stopped"),
  });
});

test("stopping a migration records that an uncertain delivery may already have landed", () => {
  const { store, id } = seededRegistry("off", registryFile());
  const generation = store.conversation(id)!.generations.at(-1)!;
  const assigned = store.holdDelivery(id, "fixture payload", "uncertain-before-stop");
  expect(store.beginDeliveryAttempt(assigned.id, generation.id)).toMatchObject({
    state: "delivery-uncertain",
    attempts: 1,
  });
  const intent = store.commitMigrationIntent({
    engine: "codex",
    targetId: "healthy",
    origin: "manual",
    requestId: "stop-uncertain",
    expectedRevision: store.engineRouting("codex").revision,
  });

  store.setMigrationIntentState(intent.id, "stopped", intent.revision);

  expect(store.snapshot().heldDeliveries[assigned.id]).toMatchObject({
    state: "failed",
    text: "",
    attempts: 1,
    generationId: null,
    error: expect.stringContaining("may have been delivered"),
  });
});

test("repeat reseat clicks never mint a second successor operation", () => {
  const { store, id } = seededRegistry("off", registryFile());
  const first = store.requestConversationReseat(id, "healthy");
  const second = store.requestConversationReseat(id, "healthy");
  expect(second.migration!.operationId).toBe(first.migration!.operationId);
  expect(Object.values(store.snapshot().migrationIntents)).toHaveLength(1);

  /* Even a click that races the coordinator mid-fork (any in-flight phase, any
     target) must not re-request: the running operation owns the successor. */
  const inFlight = store.transitionConversationMigration(id, first.migration!.revision, ["requested"], { phase: "successor-starting" });
  const raced = store.requestConversationReseat(id, "other-healthy");
  expect(raced.migration).toMatchObject({
    targetId: "healthy",
    phase: "successor-starting",
    operationId: inFlight.migration!.operationId,
  });
});

test("a stale successor cannot commit through a same-revision retarget", () => {
  const { store, id } = seededRegistry("off", registryFile());
  const profile = store.conversation(id)!.generations.at(-1)!.launchProfile;
  const ownerB = { operationId: "reconfigure-b", revision: 20 };
  store.claimConversationReconfigure(id, {
    ...ownerB,
    profile: { model: profile.model, effort: profile.effort, fast: profile.fast },
    accountId: "healthy",
  });
  let migrationB = store.requestConversationReseat(id, "healthy", ownerB).migration!;
  migrationB = store.transitionConversationMigration(id, migrationB.revision, ["requested"], { phase: "preparing" }).migration!;
  migrationB = store.transitionConversationMigration(id, migrationB.revision, ["preparing"], { phase: "successor-starting" }).migration!;
  const receiptB = providerReceipt(migrationB.operationId, "successor-b", "/sessions/successor-b.jsonl");
  store.persistMigrationProviderReceipt(id, migrationB.revision, migrationB.operationId, receiptB);

  const ownerC = { operationId: "reconfigure-c", revision: 21 };
  store.claimConversationReconfigure(id, {
    ...ownerC,
    profile: { model: profile.model, effort: profile.effort, fast: profile.fast },
    accountId: "alternate",
  });
  let migrationC = store.requestConversationReseat(id, "alternate", ownerC).migration!;
  expect(migrationC.revision).toBe(migrationB.revision);
  migrationC = store.transitionConversationMigration(id, migrationC.revision, ["requested"], { phase: "preparing" }).migration!;
  migrationC = store.transitionConversationMigration(id, migrationC.revision, ["preparing"], { phase: "successor-starting" }).migration!;
  const receiptC = providerReceipt(migrationC.operationId, "successor-c", "/sessions/successor-c.jsonl");
  store.persistMigrationProviderReceipt(id, migrationC.revision, migrationC.operationId, receiptC);

  expect(() => store.commitSuccessor(id, {
    id: receiptB.nativeId,
    path: receiptB.path,
    accountId: "healthy",
    historyHash: receiptB.historyHash,
    host: receiptB.host,
  }, migrationB.revision, migrationB.operationId, receiptB)).toThrow("migration succession ownership is stale");
  expect(store.conversation(id)?.generations).toHaveLength(1);
  expect(store.conversation(id)?.migration).toMatchObject({
    targetId: "alternate",
    operationId: migrationC.operationId,
    phase: "verifying",
  });
});

test("a thread a migration already forked is never reseated again", () => {
  const { store, id } = seededRegistry("off", registryFile());
  const requested = store.requestConversationReseat(id, "healthy");
  const revision = requested.migration!.revision;
  store.transitionConversationMigration(id, revision, ["requested"], { phase: "preparing" });
  store.transitionConversationMigration(id, revision, ["preparing"], { phase: "successor-starting" });
  const committedReceipt = providerReceipt(
    store.conversation(id)!.migration!.operationId,
    "successor-native-id",
    "/sessions/successor.jsonl",
  );
  store.transitionConversationMigration(id, revision, ["successor-starting"], { phase: "verifying", providerReceipt: committedReceipt });
  const committed = store.commitSuccessor(id, {
    id: "successor-native-id",
    path: "/sessions/successor.jsonl",
    accountId: "healthy",
  }, revision, store.conversation(id)!.migration!.operationId, committedReceipt);
  expect(committed.migration!.phase).toBe("committed");
  expect(committed.generations).toHaveLength(2);
  expect(committed.generations.at(-1)!.launchProfile.cwd).toBe("/repo/checkout");

  const repeated = store.requestConversationReseat(id, "healthy");
  expect(repeated.migration!.phase).toBe("committed");
  expect(repeated.migration!.operationId).toBe(committed.migration!.operationId);
  expect(repeated.generations).toHaveLength(2);
});
