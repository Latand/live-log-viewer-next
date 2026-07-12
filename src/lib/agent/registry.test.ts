import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

import { AgentRegistry, conversationLookupFromSnapshot } from "@/lib/agent/registry";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";

const KEY = { engine: "codex" as const, sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1326" };

function registry(ownerAlive: (owner: { pid: number; startIdentity: string | null }) => boolean = () => true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-registry-"));
  return new AgentRegistry(path.join(dir, "agent-registry.json"), ownerAlive);
}

function spawnEntry(pathname: string, accountId = "terra") {
  return {
    key: { engine: "codex" as const, sessionId: pathname.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ?? "019f4906-3f67-7b72-9fbc-9ec3b5ad1326" },
    artifactPath: pathname,
    cwd: "/repo",
    accountId,
    status: "live" as const,
    host: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  };
}

describe("agent registry", () => {
  test("snapshot lookup preserves aliases and first path ownership without disk reads", () => {
    const store = registry();
    const first = store.ensureConversation("codex", "/shared.jsonl", "default");
    const second = store.ensureConversation("codex", "/second.jsonl", "default");
    const snapshot = store.snapshot();
    snapshot.conversations[second.id]!.continuityPaths.push("/shared.jsonl");
    snapshot.conversationAliases["conversation_alias"] = first.id;

    const lookup = conversationLookupFromSnapshot(snapshot);

    expect(lookup.conversationForPath("/shared.jsonl")?.id).toBe(first.id);
    expect(lookup.canonicalConversationId("conversation_alias")).toBe(first.id);
    expect(lookup.conversation("conversation_alias")?.id).toBe(first.id);
  });

  test("startup compaction bounds legacy delivered reservations per conversation", () => {
    const store = registry();
    const conversation = store.ensureConversation("codex", "/legacy-deliveries.jsonl", "default");
    const snapshot = store.snapshot();
    for (let index = 0; index < 105; index += 1) {
      const id = `legacy-${String(index).padStart(3, "0")}`;
      snapshot.heldDeliveries[id] = {
        id,
        conversationId: conversation.id,
        text: `legacy body ${index}`,
        createdAt: `2026-07-11T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
        clientMessageId: id,
        payloadKind: "text",
        artifactPaths: [],
        state: "delivered",
        generationId: conversation.generations.at(-1)!.id,
        attempts: 1,
        assignedAt: null,
        deliveredAt: `2026-07-11T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
        error: null,
      };
    }
    fs.writeFileSync(store.filename, JSON.stringify(snapshot));

    const upgraded = new AgentRegistry(store.filename);
    expect(upgraded.compactDeliveryReservations()).toBe(5);
    const restarted = new AgentRegistry(store.filename);
    const retained = Object.values(restarted.snapshot().heldDeliveries);
    expect(retained).toHaveLength(100);
    expect(retained.every((delivery) => delivery.text === "")).toBe(true);
    expect(retained.map((delivery) => delivery.id)).not.toContain("legacy-000");
    expect(retained.map((delivery) => delivery.id)).toContain("legacy-104");
  });

  test("startup compaction bounds abandoned failed reservations and leaves capacity", () => {
    const store = registry();
    const conversation = store.ensureConversation("codex", "/failed-deliveries.jsonl", "default");
    const generationId = conversation.generations.at(-1)!.id;
    for (let index = 0; index < 105; index += 1) {
      const queued = store.holdDelivery(conversation.id, `failed body ${index}`, `failed-${index}`);
      store.beginDeliveryAttempt(queued.id, generationId);
      store.recordDeliveryOutcome(queued.id, "failed", "host unavailable");
    }

    const failed = store.pendingDeliveries(conversation.id);
    expect(failed).toHaveLength(50);
    expect(failed.every((delivery) => delivery.state === "failed")).toBe(true);
    expect(store.holdDelivery(conversation.id, "new body", "new-after-failures")).toMatchObject({ state: "assigned" });
  });

  test("account-retirement compensation preserves unrelated concurrent mutations", () => {
    const store = registry();
    store.setEngineRouting("codex", "work");
    const before = store.snapshot();
    store.retireAccount("codex", "work", "default");
    const retired = store.snapshot();
    store.setAutoBalancePolicy("claude", false, store.autoBalancePolicy("claude").revision);

    store.restoreSnapshot(retired, before);

    expect(store.engineRouting("codex").activeAccountId).toBe("work");
    expect(store.autoBalancePolicy("claude").enabled).toBeFalse();
  });

  test("writes receipts and a canonical atomic entry", () => {
    const store = registry();
    const receipt = store.beginSpawn("codex", "/repo");
    const entry = store.completeSpawn(receipt.launchId, {
      key: KEY, artifactPath: "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl", cwd: "/repo", accountId: null,
      status: "starting", host: null, claimEpoch: 0, claimOwner: null, pendingAction: "spawn",
    });
    expect(entry.key).toEqual(KEY);
    expect(store.snapshot().receipts[receipt.launchId]?.state).toBe("completed");
  });

  test("route settlement recovers when observation completed the same spawn first", () => {
    const store = registry();
    const receipt = store.beginSpawn("codex", "/repo");
    const entry = spawnEntry("/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl");

    expect(store.completeObservedSpawn(receipt.launchId, entry).kind).toBe("settled");
    const route = store.settleSpawn(receipt.launchId, entry);

    expect(route.kind).toBe("settled");
    expect(route.receipt.state).toBe("completed");
    expect(route.receipt.completionMode).toBe("route-recovered");
  });

  test("serializes durable operations", async () => {
    const store = registry();
    store.upsert({ key: KEY, artifactPath: "/a", cwd: "/repo", accountId: null, status: "live", host: null, claimEpoch: 0, claimOwner: null, pendingAction: null });
    expect(await store.withOperationLock(KEY, { pid: 1, startIdentity: "1:one" }, async () => "done")).toBe("done");
    await expect(store.withOperationLock(KEY, { pid: 1, startIdentity: "1:one" }, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  });

  test("reclaims a lock only after its recorded process identity is stale", () => {
    const store = registry(() => false);
    const lock = `${store.filename}.write-lock`;
    fs.mkdirSync(lock, { recursive: true });
    fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: 42, startIdentity: "42:old" }));
    expect(() => store.beginSpawn("codex", "/repo")).not.toThrow();
  });

  test("preserves corrupt registry bytes and rejects mutation", () => {
    const store = registry();
    fs.mkdirSync(path.dirname(store.filename), { recursive: true });
    fs.writeFileSync(store.filename, "{ broken");
    expect(() => store.beginSpawn("codex", "/repo")).toThrow("cannot be read");
    expect(fs.readFileSync(store.filename, "utf8")).toBe("{ broken");
  });

  test("upgrades v1, retains stable identity, and commits an A to B to A generation chain", () => {
    const store = registry();
    fs.writeFileSync(store.filename, JSON.stringify({ version: 1, entries: {}, receipts: {}, importedResumePanes: false, legacyResumePanes: { serverPid: null, panes: {} } }));
    const conversation = store.ensureConversation("codex", "/a.jsonl", "a");
    expect(store.snapshot().version).toBe(2);
    store.setConversationMigration(conversation.id, { intentId: "intent-a", phase: "verifying", targetId: "b", revision: 1, error: null, updatedAt: new Date().toISOString() });
    store.commitSuccessor(conversation.id, { id: "native-b", path: "/b.jsonl", accountId: "b" }, 1);
    store.setConversationMigration(conversation.id, { intentId: "intent-b", phase: "verifying", targetId: "a", revision: 2, error: null, updatedAt: new Date().toISOString() });
    const final = store.commitSuccessor(conversation.id, { id: "native-a2", path: "/a2.jsonl", accountId: "a" }, 2);
    expect(final.id).toBe(conversation.id);
    expect(final.generations.map((generation) => generation.path)).toEqual(["/a.jsonl", "/b.jsonl", "/a2.jsonl"]);
    expect(store.canonicalPath("/a.jsonl")).toBe("/a2.jsonl");
  });

  test("provisional migration paths retain one stable conversation owner", () => {
    const store = registry();
    const source = store.ensureConversation("codex", "/source.jsonl", "a");
    store.setConversationMigration(source.id, {
      intentId: "intent",
      phase: "successor-starting",
      targetId: "b",
      revision: 1,
      error: null,
      updatedAt: "2026-07-10T12:00:00.000Z",
    });
    store.recordConversationContinuityPath(source.id, "/source-account/fork.jsonl");

    store.reconcileConversations([{
      engine: "codex",
      path: "/source-account/fork.jsonl",
      accountId: "a",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-10T12:01:00.000Z",
    }]);

    expect(Object.values(store.snapshot().conversations)).toHaveLength(1);
    expect(store.conversationForPath("/source-account/fork.jsonl")?.id).toBe(source.id);
    expect(store.canonicalPath("/source-account/fork.jsonl")).toBe("/source.jsonl");

    store.setConversationMigration(source.id, {
      intentId: "later-intent",
      phase: "requested",
      targetId: "c",
      revision: 2,
      error: null,
      updatedAt: "2026-07-10T12:02:00.000Z",
    });
    expect(store.conversationForPath("/source-account/fork.jsonl")?.id).toBe(source.id);
  });

  test("migration provenance adopts a path allocated by a concurrent inventory scan", () => {
    const store = registry();
    const source = store.ensureConversation("codex", "/source.jsonl", "a");
    store.setConversationMigration(source.id, {
      intentId: "intent",
      phase: "successor-starting",
      targetId: "b",
      revision: 1,
      error: null,
      updatedAt: "2026-07-10T12:00:00.000Z",
    });
    const targetPath = "/target-account/fork.jsonl";
    store.reconcileConversations([{
      engine: "codex",
      path: targetPath,
      accountId: "b",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-10T12:01:00.000Z",
    }]);
    expect(Object.values(store.snapshot().conversations)).toHaveLength(2);

    const beforeAdoption = store.snapshot();
    store.recordConversationContinuityPath(source.id, targetPath);

    const adopted = store.snapshot();
    expect(Object.values(adopted.conversations)).toHaveLength(1);
    expect(store.conversationForPath(targetPath)?.id).toBe(source.id);
    expect(store.canonicalPath(targetPath)).toBe("/source.jsonl");
    expect(adopted.conversationRevision.codex).toBe(beforeAdoption.conversationRevision.codex + 1);
    expect(adopted.engineRouting.codex.revision).toBe(beforeAdoption.engineRouting.codex.revision + 1);
  });

  test("validated provider provenance survives migration retarget and stop", () => {
    const store = registry();
    const source = store.ensureConversation("codex", "/source.jsonl", "a");
    store.setConversationMigration(source.id, {
      intentId: "intent",
      phase: "successor-starting",
      targetId: "b",
      revision: 1,
      error: null,
      updatedAt: "2026-07-10T12:00:00.000Z",
    });
    store.setConversationMigration(source.id, {
      intentId: "replacement",
      phase: "rolled-back",
      targetId: "c",
      revision: 2,
      error: null,
      updatedAt: "2026-07-10T12:01:00.000Z",
    });

    store.recordConversationContinuityPath(source.id, "/late-provider-artifact.jsonl");

    expect(store.conversationForPath("/late-provider-artifact.jsonl")?.id).toBe(source.id);
  });

  test("coalesces durable intents and enforces policy compare-and-set", () => {
    const store = registry();
    const first = store.upsertMigrationIntent("claude", "a", "auto", "first");
    const latest = store.upsertMigrationIntent("claude", "b", "manual", "second");
    expect(latest.id).toBe(first.id);
    expect(latest.targetId).toBe("b");
    expect(latest.revision).toBe(2);
    expect(() => store.setAutoBalancePolicy("claude", true, 1)).toThrow("revision is stale");
    expect(store.setAutoBalancePolicy("claude", true, 0).enabled).toBe(true);
  });

  test("normalizes legacy v2 migration fields for restart recovery", () => {
    const store = registry();
    const conversation = store.ensureConversation("codex", "/legacy.jsonl", "a");
    store.setConversationMigration(conversation.id, {
      intentId: "legacy-intent",
      phase: "requested",
      targetId: "b",
      revision: 3,
      error: null,
      updatedAt: "2026-07-10T00:00:00.000Z",
    });
    const raw = JSON.parse(fs.readFileSync(store.filename, "utf8")) as { conversations: Record<string, { migration: Record<string, unknown> }> };
    delete raw.conversations[conversation.id]!.migration.operationId;
    delete raw.conversations[conversation.id]!.migration.sourceGenerationId;
    delete raw.conversations[conversation.id]!.migration.providerReceipt;
    delete raw.conversations[conversation.id]!.migration.errorCode;
    fs.writeFileSync(store.filename, JSON.stringify(raw));

    const recovered = new AgentRegistry(store.filename).conversation(conversation.id)!;
    expect(recovered.migration).toMatchObject({
      operationId: `legacy-intent:${conversation.id}:3`,
      sourceGenerationId: recovered.generations[0]!.id,
      providerReceipt: null,
      errorCode: null,
    });
  });

  test("replays one client attempt, reserves its stable conversation, and rejects a changed request", () => {
    const store = registry();
    const first = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "terra", clientAttemptId: "attempt_0001", requestDigest: "digest-a" });
    expect(first.kind).toBe("created");
    if (first.kind !== "created") throw new Error("expected create");
    const replay = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "terra", clientAttemptId: "attempt_0001", requestDigest: "digest-a" });
    expect(replay).toMatchObject({ kind: "replay", receipt: { launchId: first.receipt.launchId, conversationId: first.receipt.conversationId } });
    const conflict = store.beginSpawnRequest({ engine: "codex", cwd: "/other", accountId: "terra", clientAttemptId: "attempt_0001", requestDigest: "digest-b" });
    expect(conflict.kind).toBe("conflict");
  });

  test("restart inventory recovers a path-pending Codex receipt after its pane exits", () => {
    const store = registry();
    const parentPath = "/sessions/parent-019f4906-3f67-7b72-9fbc-9ec3b5ad1325.jsonl";
    const childPath = "/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const parent = store.ensureConversation("codex", parentPath, "terra");
    const begun = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      accountId: "terra",
      parentConversationId: parent.id,
      parentSessionKey: { engine: "codex", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1325" },
      parentArtifactPath: parentPath,
      launchProfile: emptyLaunchProfile({ cwd: "/repo", parentConversationId: parent.id }),
    });
    if (begun.kind !== "created") throw new Error("expected create");
    store.bindSpawnPane(begun.receipt.launchId, {
      endpoint: "/tmp",
      server: { pid: 9, startIdentity: "9:a" },
      paneId: "%9",
      panePid: { pid: 99, startIdentity: "99:a" },
      target: "agents:9.0",
    });
    store.markSpawnHostVerified(begun.receipt.launchId, {
      kind: "tmux",
      endpoint: "/tmp",
      server: { pid: 9, startIdentity: "9:a" },
      paneId: "%9",
      panePid: { pid: 99, startIdentity: "99:a" },
      windowName: "codex-new",
      agent: { pid: 100, startIdentity: "100:a" },
      argv: ["codex"],
    });
    store.markSpawnPromptDelivered(begun.receipt.launchId);
    const pending = store.markSpawnPathPending(begun.receipt.launchId);
    const startedAt = new Date(Date.parse(pending.pathCorrelation!.startedAt) + 1_000).toISOString();

    const restarted = new AgentRegistry(store.filename);
    restarted.reconcileConversations([{
      engine: "codex",
      path: childPath,
      accountId: "terra",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", parentConversationId: parent.id }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      startedAt,
      observedAt: "2026-07-12T12:00:00.000Z",
    }]);

    expect(restarted.conversationForPath(childPath)?.id).toBe(begun.receipt.conversationId);
    expect(restarted.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
      state: "completed",
      artifactPath: childPath,
      completionMode: "observed-completed",
    });
    expect(restarted.snapshot().lineageEdges[begun.receipt.conversationId]).toMatchObject({
      childConversationId: begun.receipt.conversationId,
      parentConversationId: parent.id,
      childArtifactPath: childPath,
      parentArtifactPath: parentPath,
      evidence: { launchId: begun.receipt.launchId },
    });
  });

  test("restart inventory pairs distinct same-cwd Codex windows and repairs provisional owners", () => {
    const store = registry();
    const parentPath = "/sessions/parent-019f4906-3f67-7b72-9fbc-9ec3b5ad1325.jsonl";
    const childPaths = [
      "/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl",
      "/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl",
    ];
    const parent = store.ensureConversation("codex", parentPath, "terra");
    const receipts = childPaths.map(() => store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      accountId: "terra",
      parentConversationId: parent.id,
      parentSessionKey: { engine: "codex", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1325" },
      parentArtifactPath: parentPath,
      launchProfile: emptyLaunchProfile({ cwd: "/repo", parentConversationId: parent.id }),
    }));
    if (receipts.some((receipt) => receipt.kind !== "created")) throw new Error("expected creates");
    const created = receipts.map((receipt) => {
      if (receipt.kind !== "created") throw new Error("expected create");
      return receipt.receipt;
    });
    const persisted = store.snapshot();
    const launchStarts = ["2026-07-12T12:00:00.000Z", "2026-07-12T12:00:40.000Z"];
    for (const [index, receipt] of created.entries()) {
      persisted.receipts[receipt.launchId]!.state = "path-pending";
      persisted.receipts[receipt.launchId]!.pathCorrelation = { cwd: "/repo", startedAt: launchStarts[index]! };
    }
    fs.writeFileSync(store.filename, JSON.stringify(persisted));

    const observations = childPaths.map((childPath, index) => ({
      engine: "codex" as const,
      path: childPath,
      accountId: "terra",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", parentConversationId: parent.id }),
      turn: { state: "idle" as const, source: "empty" as const, terminalAt: null },
      startedAt: index === 0 ? "2026-07-12T12:00:00.250Z" : "2026-07-12T12:00:40.250Z",
      observedAt: "2026-07-12T12:01:00.000Z",
    }));
    const restarted = new AgentRegistry(store.filename);
    restarted.reconcileConversations(observations.map((observation) => ({
      engine: observation.engine,
      path: observation.path,
      accountId: observation.accountId,
      launchProfile: observation.launchProfile,
      turn: observation.turn,
      observedAt: observation.observedAt,
    })));
    const provisionalIds = childPaths.map((childPath) => restarted.conversationForPath(childPath)!.id);
    expect(provisionalIds).not.toContain(created[0]!.conversationId);
    expect(provisionalIds).not.toContain(created[1]!.conversationId);

    restarted.reconcileConversations([...observations].reverse());
    expect(restarted.conversationForPath(childPaths[0]!)?.id).toBe(created[0]!.conversationId);
    expect(restarted.conversationForPath(childPaths[1]!)?.id).toBe(created[1]!.conversationId);
    expect(restarted.snapshot().receipts[created[0]!.launchId]).toMatchObject({ state: "completed", artifactPath: childPaths[0] });
    expect(restarted.snapshot().receipts[created[1]!.launchId]).toMatchObject({ state: "completed", artifactPath: childPaths[1] });
    expect(restarted.snapshot().lineageEdges[created[0]!.conversationId]).toMatchObject({
      parentConversationId: parent.id,
      childArtifactPath: childPaths[0],
      source: "viewer-spawn",
    });
    expect(restarted.snapshot().lineageEdges[created[1]!.conversationId]).toMatchObject({
      parentConversationId: parent.id,
      childArtifactPath: childPaths[1],
      source: "viewer-spawn",
    });

    restarted.reconcileConversations(observations);
    expect(restarted.conversationForPath(childPaths[0]!)?.id).toBe(created[0]!.conversationId);
    expect(restarted.conversationForPath(childPaths[1]!)?.id).toBe(created[1]!.conversationId);
    expect(Object.keys(restarted.snapshot().conversations)).not.toContain(provisionalIds[0]);
    expect(Object.keys(restarted.snapshot().conversations)).not.toContain(provisionalIds[1]);
  });

  test("path-pending adoption preserves a provisional owner's stopped-migration opt-out", () => {
    const store = registry();
    const begun = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "source" });
    if (begun.kind !== "created") throw new Error("expected create");
    const persisted = store.snapshot();
    persisted.receipts[begun.receipt.launchId]!.state = "path-pending";
    persisted.receipts[begun.receipt.launchId]!.pathCorrelation = {
      cwd: "/repo",
      startedAt: "2026-07-12T12:00:00.000Z",
    };
    fs.writeFileSync(store.filename, JSON.stringify(persisted));
    const childPath = "/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const observation = {
      engine: "codex" as const,
      path: childPath,
      accountId: "source",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle" as const, source: "empty" as const, terminalAt: null },
      observedAt: "2026-07-12T12:01:00.000Z",
    };

    store.reconcileConversations([observation]);
    const provisional = store.conversationForPath(childPath)!;
    const intent = store.commitMigrationIntent({
      engine: "codex",
      targetId: "target",
      origin: "auto",
      requestId: "auto-before-correlation",
      expectedRevision: store.engineRouting("codex").revision,
      scope: "active",
    });
    store.setMigrationIntentState(intent.id, "stopped", intent.revision);
    expect(store.conversation(provisional.id)?.migrationOptOut).toMatchObject({ targetId: "target" });

    store.reconcileConversations([{ ...observation, startedAt: "2026-07-12T12:00:01.000Z" }]);

    expect(store.conversationForPath(childPath)?.id).toBe(begun.receipt.conversationId);
    expect(store.conversation(begun.receipt.conversationId)?.migrationOptOut).toMatchObject({ targetId: "target" });
    const later = store.commitMigrationIntent({
      engine: "codex",
      targetId: "target",
      origin: "auto",
      requestId: "auto-after-correlation",
      expectedRevision: store.engineRouting("codex").revision,
      scope: "all",
    });
    expect(later.state).toBe("complete");
    expect(store.conversation(begun.receipt.conversationId)).toMatchObject({
      migration: null,
      migrationOptOut: { targetId: "target" },
    });
  });

  test("path-pending recovery partitions reversed Codex startup by birth account", () => {
    const store = registry();
    const first = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "a" });
    const second = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "b" });
    if (first.kind !== "created" || second.kind !== "created") throw new Error("expected creates");
    const persisted = store.snapshot();
    persisted.receipts[first.receipt.launchId]!.state = "path-pending";
    persisted.receipts[first.receipt.launchId]!.pathCorrelation = { cwd: "/repo", startedAt: "2026-07-12T12:00:00.000Z" };
    persisted.receipts[second.receipt.launchId]!.state = "path-pending";
    persisted.receipts[second.receipt.launchId]!.pathCorrelation = { cwd: "/repo", startedAt: "2026-07-12T12:00:01.000Z" };
    fs.writeFileSync(store.filename, JSON.stringify(persisted));
    const firstPath = "/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const secondPath = "/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl";

    const restarted = new AgentRegistry(store.filename);
    restarted.reconcileConversations([{
      engine: "codex",
      path: secondPath,
      accountId: "b",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      startedAt: "2026-07-12T12:00:02.000Z",
      observedAt: "2026-07-12T12:01:00.000Z",
    }, {
      engine: "codex",
      path: firstPath,
      accountId: "a",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      startedAt: "2026-07-12T12:00:10.000Z",
      observedAt: "2026-07-12T12:01:00.000Z",
    }]);

    expect(restarted.conversationForPath(firstPath)?.id).toBe(first.receipt.conversationId);
    expect(restarted.conversationForPath(secondPath)?.id).toBe(second.receipt.conversationId);
    expect(restarted.conversationForPath(firstPath)?.generations.at(-1)?.accountId).toBe("a");
    expect(restarted.conversationForPath(secondPath)?.generations.at(-1)?.accountId).toBe("b");
  });

  test("path-pending recovery leaves indistinguishable same-account launches unresolved", () => {
    const store = registry();
    const first = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "a" });
    const second = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "a" });
    if (first.kind !== "created" || second.kind !== "created") throw new Error("expected creates");
    const persisted = store.snapshot();
    for (const [index, receipt] of [first.receipt, second.receipt].entries()) {
      persisted.receipts[receipt.launchId]!.state = "path-pending";
      persisted.receipts[receipt.launchId]!.pathCorrelation = {
        cwd: "/repo",
        startedAt: index === 0 ? "2026-07-12T12:00:00.000Z" : "2026-07-12T12:00:01.000Z",
      };
    }
    fs.writeFileSync(store.filename, JSON.stringify(persisted));
    const observations = [
      "/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl",
      "/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl",
    ].map((pathname, index) => ({
      engine: "codex" as const,
      path: pathname,
      accountId: "a",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle" as const, source: "empty" as const, terminalAt: null },
      startedAt: index === 0 ? "2026-07-12T12:00:10.000Z" : "2026-07-12T12:00:02.000Z",
      observedAt: "2026-07-12T12:01:00.000Z",
    }));

    const restarted = new AgentRegistry(store.filename);
    restarted.reconcileConversations(observations);

    expect(restarted.snapshot().receipts[first.receipt.launchId]).toMatchObject({ state: "path-pending", artifactPath: null });
    expect(restarted.snapshot().receipts[second.receipt.launchId]).toMatchObject({ state: "path-pending", artifactPath: null });
    expect(observations.map((observation) => restarted.conversationForPath(observation.path)?.id)).not.toContain(first.receipt.conversationId);
    expect(observations.map((observation) => restarted.conversationForPath(observation.path)?.id)).not.toContain(second.receipt.conversationId);
  });

  test("settles observer then route exactly once with receipt-owned account and profile", () => {
    const store = registry();
    const begun = store.beginSpawnRequest({
      engine: "codex", cwd: "/repo", accountId: "terra", parentConversationId: "conversation_parent",
      parentSessionKey: { engine: "codex", sessionId: "parent-session" }, parentArtifactPath: "/sessions/parent-session.jsonl",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", model: "gpt-5.6", parentConversationId: "conversation_parent" }),
    });
    if (begun.kind !== "created") throw new Error("expected create");
    const born = new AgentRegistry(store.filename).snapshot();
    expect(born.lineageEdges[begun.receipt.conversationId]).toMatchObject({
      childConversationId: begun.receipt.conversationId,
      parentConversationId: "conversation_parent",
      childSessionKey: null,
      parentSessionKey: { engine: "codex", sessionId: "parent-session" },
      childArtifactPath: null,
      parentArtifactPath: "/sessions/parent-session.jsonl",
      source: "viewer-spawn",
      evidence: { launchId: begun.receipt.launchId },
    });
    const receipt = store.bindSpawnPane(begun.receipt.launchId, { endpoint: "/tmp", server: { pid: 9, startIdentity: "9:a" }, paneId: "%9", panePid: { pid: 99, startIdentity: "99:a" }, target: "agents:9.0" });
    expect(receipt.state).toBe("pane-bound");
    store.markSpawnPromptDelivered(receipt.launchId);
    const path = "/sessions/019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const observed = store.completeObservedSpawn(receipt.launchId, {
      ...spawnEntry(path, "wrong-account"),
      host: { kind: "tmux", endpoint: "/tmp", server: { pid: 9, startIdentity: "9:a" }, paneId: "%9", panePid: { pid: 99, startIdentity: "99:a" }, windowName: "codex", agent: { pid: 100, startIdentity: "100:a" }, argv: ["codex"] },
    });
    expect(observed.kind).toBe("settled");
    const revisionAfterObservedSettlement = store.snapshot().conversationRevision.codex;
    const route = store.settleSpawn(receipt.launchId, spawnEntry(path));
    expect(route).toMatchObject({ kind: "settled", receipt: { completionMode: "route-recovered", accountId: "terra", conversationId: begun.receipt.conversationId } });
    const snapshot = store.snapshot();
    expect(snapshot.conversations[begun.receipt.conversationId]?.generations).toHaveLength(1);
    expect(snapshot.conversationRevision.codex).toBe(revisionAfterObservedSettlement);
    expect(snapshot.entries["codex:019f4906-3f67-7b72-9fbc-9ec3b5ad1326"]?.launchProfile?.parentConversationId).toBe("conversation_parent");
    expect(snapshot.lineageEdges[begun.receipt.conversationId]).toMatchObject({
      childSessionKey: { engine: "codex", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1326" },
      childArtifactPath: path,
    });
  });

  test("keeps one conversation identity through a controlled resume chain", () => {
    const store = registry();
    const firstPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const secondPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl";
    const thirdPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1328.jsonl";
    const conversation = store.ensureConversation("codex", firstPath, "terra");

    for (const pathname of [secondPath, thirdPath]) {
      const begun = store.beginSpawnRequest({
        engine: "codex",
        cwd: "/repo",
        accountId: "terra",
        conversationId: conversation.id,
        purpose: "resume-successor",
      });
      if (begun.kind !== "created") throw new Error("expected create");
      expect(store.settleSpawn(begun.receipt.launchId, spawnEntry(pathname))).toMatchObject({
        kind: "settled",
        conversation: { id: conversation.id },
      });
    }

    const resumed = store.conversation(conversation.id)!;
    expect(resumed.generations.map((generation) => generation.path)).toEqual([firstPath, secondPath, thirdPath]);
    expect(Object.values(store.snapshot().conversations)).toHaveLength(1);
    for (const pathname of [firstPath, secondPath, thirdPath]) {
      expect(store.conversationForPath(pathname)?.id).toBe(conversation.id);
    }
  });

  test("freezes a resume receipt after its first successor settlement", () => {
    const store = registry();
    const firstPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const secondPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl";
    const unrelatedPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1328.jsonl";
    const conversation = store.ensureConversation("codex", firstPath, "terra");
    const begun = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      accountId: "terra",
      conversationId: conversation.id,
      purpose: "resume-successor",
    });
    if (begun.kind !== "created") throw new Error("expected create");

    expect(store.settleSpawn(begun.receipt.launchId, spawnEntry(secondPath))).toMatchObject({ kind: "settled" });
    expect(store.settleSpawn(begun.receipt.launchId, spawnEntry(unrelatedPath))).toMatchObject({
      kind: "conflict",
      code: "spawn_artifact_conflict",
      receipt: { state: "completed", artifactPath: secondPath },
    });

    expect(store.conversation(conversation.id)?.generations.map((generation) => generation.path)).toEqual([firstPath, secondPath]);
    expect(store.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
      state: "completed",
      artifactPath: secondPath,
      key: { engine: "codex", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1327" },
      error: null,
    });
  });

  test("replaces an owned registry entry when a Codex resume keeps its native session id", () => {
    const store = registry();
    const nativeId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1326";
    const firstPath = `/sessions/2026/07/11/rollout-2026-07-11T10-00-00-${nativeId}.jsonl`;
    const secondPath = `/sessions/2026/07/12/rollout-2026-07-12T10-00-00-${nativeId}.jsonl`;
    const conversation = store.ensureConversation("codex", firstPath, "terra");
    store.upsert({
      ...spawnEntry(firstPath),
      status: "unhosted",
      host: null,
    });
    const begun = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      accountId: "terra",
      conversationId: conversation.id,
      purpose: "resume-successor",
    });
    if (begun.kind !== "created") throw new Error("expected create");

    expect(store.settleSpawn(begun.receipt.launchId, spawnEntry(secondPath))).toMatchObject({
      kind: "settled",
      conversation: { id: conversation.id },
      receipt: { state: "completed", artifactPath: secondPath },
    });
    expect(store.snapshot().entries[`codex:${nativeId}`]?.artifactPath).toBe(secondPath);
    expect(store.conversation(conversation.id)).toMatchObject({
      continuityPaths: [firstPath],
      generations: [{ id: nativeId, path: secondPath }],
    });
  });

  test("same-session resume preserves durable launch metadata through default overrides", () => {
    const store = registry();
    const nativeId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1326";
    const firstPath = `/sessions/2026/07/11/rollout-2026-07-11T10-00-00-${nativeId}.jsonl`;
    const secondPath = `/sessions/2026/07/12/rollout-2026-07-12T10-00-00-${nativeId}.jsonl`;
    const parent = store.ensureConversation("codex", "/sessions/parent-019f4906-3f67-7b72-9fbc-9ec3b5ad1325.jsonl", "terra");
    const conversation = store.ensureConversation("codex", firstPath, "terra");
    store.reconcileConversations([{
      engine: "codex",
      path: firstPath,
      accountId: "terra",
      launchProfile: emptyLaunchProfile({
        cwd: "/repo/original",
        model: "gpt-original",
        effort: "medium",
        title: "Durable title",
        project: "durable-project",
        parentConversationId: parent.id,
        role: "root",
        goal: { objective: "Preserve lineage", status: "active", tokensUsed: null, timeUsedSeconds: null },
      }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-12T12:00:00.000Z",
    }]);
    const begun = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo/resumed",
      accountId: "terra",
      conversationId: conversation.id,
      purpose: "resume-successor",
      launchProfile: emptyLaunchProfile({ cwd: "/repo/resumed", model: "gpt-resumed", effort: "high" }),
    });
    if (begun.kind !== "created") throw new Error("expected create");

    expect(begun.receipt.launchProfile).toMatchObject({
      cwd: "/repo/resumed",
      model: "gpt-resumed",
      effort: "high",
      title: "Durable title",
      project: "durable-project",
      parentConversationId: parent.id,
      role: "root",
      goal: { objective: "Preserve lineage", status: "active" },
    });
    expect(store.settleSpawn(begun.receipt.launchId, { ...spawnEntry(secondPath), cwd: "/repo/resumed" })).toMatchObject({ kind: "settled" });
    expect(store.conversation(conversation.id)?.generations[0]?.launchProfile).toMatchObject({
      cwd: "/repo/resumed",
      model: "gpt-resumed",
      effort: "high",
      title: "Durable title",
      project: "durable-project",
      parentConversationId: parent.id,
      role: "root",
      goal: { objective: "Preserve lineage", status: "active" },
    });
  });

  test("settles a same-session successor after inventory moves the generation first", () => {
    const store = registry();
    const nativeId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1326";
    const firstPath = `/sessions/2026/07/11/rollout-2026-07-11T10-00-00-${nativeId}.jsonl`;
    const secondPath = `/sessions/2026/07/12/rollout-2026-07-12T10-00-00-${nativeId}.jsonl`;
    const conversation = store.ensureConversation("codex", firstPath, "terra");
    store.upsert({
      ...spawnEntry(firstPath),
      status: "unhosted",
      host: null,
    });
    const begun = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      accountId: "terra",
      conversationId: conversation.id,
      purpose: "resume-successor",
    });
    if (begun.kind !== "created") throw new Error("expected create");
    store.reconcileConversations([{
      engine: "codex",
      path: secondPath,
      accountId: "terra",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-12T12:00:00.000Z",
    }]);

    expect(store.snapshot()).toMatchObject({
      entries: { [`codex:${nativeId}`]: { artifactPath: firstPath } },
      conversations: {
        [conversation.id]: {
          continuityPaths: [firstPath],
          generations: [{ id: nativeId, path: secondPath }],
        },
      },
    });
    expect(store.settleSpawn(begun.receipt.launchId, spawnEntry(secondPath))).toMatchObject({
      kind: "settled",
      conversation: { id: conversation.id },
      receipt: { state: "completed", artifactPath: secondPath },
    });
    expect(store.snapshot().entries[`codex:${nativeId}`]?.artifactPath).toBe(secondPath);
  });

  test("fresh newest-first inventory keeps the newest same-session rollout current", () => {
    const store = registry();
    const nativeId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1326";
    const newestPath = `/sessions/2026/07/12/rollout-2026-07-12T10-00-00-${nativeId}.jsonl`;
    const olderPath = `/sessions/2026/07/11/rollout-2026-07-11T10-00-00-${nativeId}.jsonl`;
    const observation = (pathname: string, observedAt: string) => ({
      engine: "codex" as const,
      path: pathname,
      accountId: "terra",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle" as const, source: "empty" as const, terminalAt: null },
      observedAt,
    });

    store.reconcileConversations([
      observation(newestPath, "2026-07-12T12:00:00.000Z"),
      observation(olderPath, "2026-07-12T12:01:00.000Z"),
    ]);

    const conversation = store.conversationForPath(newestPath)!;
    expect(conversation).toMatchObject({
      continuityPaths: [olderPath],
      generations: [{ id: nativeId, path: newestPath }],
    });
    expect(store.conversationForPath(olderPath)?.id).toBe(conversation.id);
  });

  test("completed resume receipt advances after observing its source path first", () => {
    const store = registry();
    const nativeId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1326";
    const sourcePath = `/sessions/2026/07/11/rollout-2026-07-11T10-00-00-${nativeId}.jsonl`;
    const successorPath = `/sessions/2026/07/12/rollout-2026-07-12T10-00-00-${nativeId}.jsonl`;
    const unrelatedPath = `/sessions/2026/07/13/rollout-2026-07-13T10-00-00-${nativeId}.jsonl`;
    const conversation = store.ensureConversation("codex", sourcePath, "terra");
    const begun = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      accountId: "terra",
      conversationId: conversation.id,
      purpose: "resume-successor",
    });
    if (begun.kind !== "created") throw new Error("expected create");
    expect(store.completeObservedSpawn(begun.receipt.launchId, spawnEntry(sourcePath))).toMatchObject({
      kind: "settled",
      receipt: { state: "completed", artifactPath: sourcePath },
    });
    store.reconcileConversations([{
      engine: "codex",
      path: successorPath,
      accountId: "terra",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-12T12:00:00.000Z",
    }]);

    expect(store.completeObservedSpawn(begun.receipt.launchId, spawnEntry(successorPath))).toMatchObject({
      kind: "settled",
      conversation: { id: conversation.id },
      receipt: { state: "completed", artifactPath: successorPath },
    });
    expect(store.snapshot().entries[`codex:${nativeId}`]?.artifactPath).toBe(successorPath);
    expect(store.conversation(conversation.id)).toMatchObject({
      continuityPaths: [sourcePath],
      generations: [{ id: nativeId, path: successorPath }],
    });
    store.reconcileConversations([{
      engine: "codex",
      path: unrelatedPath,
      accountId: "terra",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-13T12:00:00.000Z",
    }]);
    expect(store.completeObservedSpawn(begun.receipt.launchId, spawnEntry(unrelatedPath))).toMatchObject({
      kind: "conflict",
      code: "spawn_artifact_conflict",
      receipt: { state: "completed", artifactPath: successorPath, resumeSourcePath: sourcePath },
    });
  });

  test("resume succession rebases a migration before provider work", () => {
    const store = registry();
    const firstPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const resumedPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl";
    const conversation = store.ensureConversation("codex", firstPath, "terra");
    store.setConversationMigration(conversation.id, {
      intentId: "resume-rebase",
      phase: "requested",
      targetId: "work",
      revision: 1,
      error: null,
      sourceGenerationId: conversation.generations[0]!.id,
      updatedAt: "2026-07-12T12:00:00.000Z",
    });
    const begun = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      accountId: "terra",
      conversationId: conversation.id,
      purpose: "resume-successor",
    });
    if (begun.kind !== "created") throw new Error("expected create");

    const settled = store.settleSpawn(begun.receipt.launchId, spawnEntry(resumedPath));

    expect(settled.kind).toBe("settled");
    const resumed = store.conversation(conversation.id)!;
    expect(resumed.generations.at(-1)?.path).toBe(resumedPath);
    expect(resumed.migration?.sourceGenerationId).toBe(resumed.generations.at(-1)?.id);
  });

  test("resume succession is fenced after migration provider work starts", () => {
    const store = registry();
    const firstPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const resumedPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl";
    const conversation = store.ensureConversation("codex", firstPath, "terra");
    const begun = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      accountId: "terra",
      conversationId: conversation.id,
      purpose: "resume-successor",
    });
    if (begun.kind !== "created") throw new Error("expected create");
    store.setConversationMigration(conversation.id, {
      intentId: "resume-fence",
      phase: "successor-starting",
      targetId: "work",
      revision: 1,
      error: null,
      sourceGenerationId: conversation.generations[0]!.id,
      updatedAt: "2026-07-12T12:00:00.000Z",
    });

    expect(store.settleSpawn(begun.receipt.launchId, spawnEntry(resumedPath))).toMatchObject({
      kind: "conflict",
      code: "spawn_identity_conflict",
    });
    expect(store.conversation(conversation.id)?.generations.map((generation) => generation.path)).toEqual([firstPath]);
  });

  test("inventory cannot canonicalize a same-session resume after migration provider work starts", () => {
    const store = registry();
    const nativeId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1326";
    const sourcePath = `/sessions/2026/07/11/rollout-2026-07-11T10-00-00-${nativeId}.jsonl`;
    const resumedPath = `/sessions/2026/07/12/rollout-2026-07-12T10-00-00-${nativeId}.jsonl`;
    const conversation = store.ensureConversation("codex", sourcePath, "terra");
    const begun = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      accountId: "terra",
      conversationId: conversation.id,
      purpose: "resume-successor",
    });
    if (begun.kind !== "created") throw new Error("expected create");
    store.setConversationMigration(conversation.id, {
      intentId: "inventory-resume-fence",
      phase: "successor-starting",
      targetId: "work",
      revision: 1,
      error: null,
      sourceGenerationId: conversation.generations[0]!.id,
      updatedAt: "2026-07-12T12:00:00.000Z",
    });

    store.reconcileConversations([{
      engine: "codex",
      path: resumedPath,
      accountId: "terra",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-12T12:01:00.000Z",
    }]);

    expect(store.conversation(conversation.id)).toMatchObject({
      continuityPaths: [],
      generations: [{ id: nativeId, path: sourcePath }],
    });
    expect(store.conversationForPath(resumedPath)).toBeNull();
    expect(store.settleSpawn(begun.receipt.launchId, spawnEntry(resumedPath))).toMatchObject({
      kind: "conflict",
      code: "spawn_identity_conflict",
    });
    expect(store.conversation(conversation.id)).toMatchObject({
      continuityPaths: [],
      generations: [{ id: nativeId, path: sourcePath }],
    });
  });

  test("treats a second rollout path with the same native session key as one conversation", () => {
    const store = registry();
    const nativeId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1326";
    const firstPath = `/sessions/2026/07/11/rollout-2026-07-11T10-00-00-${nativeId}.jsonl`;
    const secondPath = `/sessions/2026/07/12/rollout-2026-07-12T10-00-00-${nativeId}.jsonl`;
    const conversation = store.ensureConversation("codex", firstPath, "terra");

    store.reconcileConversations([{
      engine: "codex",
      path: secondPath,
      accountId: "terra",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-12T10:00:00.000Z",
    }]);

    expect(store.conversationForPath(firstPath)?.id).toBe(conversation.id);
    expect(store.conversationForPath(secondPath)?.id).toBe(conversation.id);
    expect(store.conversation(conversation.id)?.generations.at(-1)?.path).toBe(secondPath);
    expect(Object.values(store.snapshot().conversations)).toHaveLength(1);
  });

  test("repairs an exact-path provisional owner split in favor of receipt-owned identity", () => {
    const store = registry();
    const pathname = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const begun = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "terra" });
    if (begun.kind !== "created") throw new Error("expected create");
    const settled = store.settleSpawn(begun.receipt.launchId, spawnEntry(pathname));
    if (settled.kind !== "settled") throw new Error("expected settlement");
    const snapshot = store.snapshot();
    const provisionalId = "conversation_00000000-0000-4000-8000-000000000001";
    snapshot.conversations[provisionalId] = {
      ...structuredClone(settled.conversation),
      id: provisionalId,
      createdAt: "2026-07-12T11:00:00.000Z",
      updatedAt: "2026-07-12T11:00:00.000Z",
    };
    fs.writeFileSync(store.filename, JSON.stringify(snapshot));

    store.reconcileConversations([{
      engine: "codex",
      path: pathname,
      accountId: "terra",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-12T12:00:00.000Z",
    }]);

    expect(Object.values(store.snapshot().conversations)).toHaveLength(1);
    expect(store.conversationForPath(pathname)?.id).toBe(settled.conversation.id);
    expect(store.canonicalConversationId(provisionalId)).toBe(settled.conversation.id);
  });

  test("transfers an adopted successor path during the same reconciliation", () => {
    const store = registry();
    const nativeId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1326";
    const sourcePath = `/sessions/2026/07/11/rollout-2026-07-11T10-00-00-${nativeId}.jsonl`;
    const successorPath = `/sessions/2026/07/12/rollout-2026-07-12T10-00-00-${nativeId}.jsonl`;
    const canonical = store.ensureConversation("codex", sourcePath, "terra");
    const snapshot = store.snapshot();
    snapshot.conversations[canonical.id]!.createdAt = "2026-07-12T10:00:00.000Z";
    snapshot.conversations[canonical.id]!.updatedAt = "2026-07-12T10:00:00.000Z";
    const provisionalId = "conversation_00000000-0000-4000-8000-000000000002";
    snapshot.conversations[provisionalId] = {
      ...structuredClone(canonical),
      id: provisionalId,
      generations: [{ ...structuredClone(canonical.generations[0]!), path: successorPath }],
      createdAt: "2026-07-12T11:00:00.000Z",
      updatedAt: "2026-07-12T11:00:00.000Z",
    };
    fs.writeFileSync(store.filename, JSON.stringify(snapshot));

    store.reconcileConversations([{
      engine: "codex",
      path: successorPath,
      accountId: "terra",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-12T12:00:00.000Z",
    }]);

    expect(store.conversationForPath(successorPath)?.id).toBe(canonical.id);
    expect(store.conversationForPath(sourcePath)?.id).toBe(canonical.id);
    expect(store.conversation(canonical.id)).toMatchObject({
      generations: [{ path: successorPath }],
      continuityPaths: [sourcePath],
    });
    expect(store.canonicalConversationId(provisionalId)).toBe(canonical.id);
  });

  test("persists engine-native lineage by stable conversation identity", () => {
    const store = registry();
    const parentPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const childPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl";
    const parent = store.ensureConversation("codex", parentPath, "terra");

    store.reconcileConversations([{
      engine: "codex",
      path: childPath,
      accountId: "terra",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", parentConversationId: parent.id }),
      turn: { state: "busy", source: "assistant", terminalAt: null },
      observedAt: "2026-07-12T12:00:00.000Z",
    }]);

    const child = store.conversationForPath(childPath)!;
    expect(new AgentRegistry(store.filename).snapshot().lineageEdges[child.id]).toMatchObject({
      childConversationId: child.id,
      parentConversationId: parent.id,
      childArtifactPath: childPath,
      parentArtifactPath: parentPath,
      source: "engine-native",
    });
  });

  test("provisional successor adoption discards lineage that canonicalizes to a self-edge", () => {
    const store = registry();
    const sourcePath = "/sessions/source-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const successorPath = "/sessions/successor-019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl";
    const canonical = store.ensureConversation("codex", sourcePath, "terra");
    store.reconcileConversations([{
      engine: "codex",
      path: successorPath,
      accountId: "work",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", parentConversationId: canonical.id }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-12T12:00:00.000Z",
    }]);
    const provisional = store.conversationForPath(successorPath)!;
    expect(store.snapshot().lineageEdges[provisional.id]).toMatchObject({
      childConversationId: provisional.id,
      parentConversationId: canonical.id,
      source: "engine-native",
    });
    const migration = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      accountId: "work",
      conversationId: canonical.id,
      purpose: "migration-successor",
      expectedArtifactPath: successorPath,
    });
    if (migration.kind !== "created") throw new Error("expected migration receipt");

    expect(store.settleSpawn(migration.receipt.launchId, spawnEntry(successorPath, "work"))).toMatchObject({
      kind: "settled",
      conversation: { id: canonical.id },
    });
    const snapshot = store.snapshot();
    expect(snapshot.conversationAliases[provisional.id]).toBe(canonical.id);
    expect(snapshot.lineageEdges[canonical.id]).toBeUndefined();
    expect(Object.values(snapshot.lineageEdges).some((edge) => edge.childConversationId === edge.parentConversationId)).toBe(false);
  });

  test("stronger engine-native evidence corrects an inferred parent", () => {
    const store = registry();
    const parentA = store.ensureConversation("codex", "/sessions/parent-a-019f4906-3f67-7b72-9fbc-9ec3b5ad1301.jsonl", "terra");
    const parentB = store.ensureConversation("codex", "/sessions/parent-b-019f4906-3f67-7b72-9fbc-9ec3b5ad1302.jsonl", "terra");
    const childPath = "/sessions/child-019f4906-3f67-7b72-9fbc-9ec3b5ad1303.jsonl";
    const observation = (parentConversationId: `conversation_${string}`, observedAt: string) => ({
      engine: "codex" as const,
      path: childPath,
      accountId: "terra",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", parentConversationId }),
      turn: { state: "idle" as const, source: "empty" as const, terminalAt: null },
      observedAt,
    });

    store.reconcileConversations([observation(parentA.id, "2026-07-12T12:00:00.000Z")]);
    const child = store.conversationForPath(childPath)!;
    store.reconcileConversations([observation(parentB.id, "2026-07-12T12:01:00.000Z")]);

    expect(store.conversation(child.id)?.generations[0]?.launchProfile.parentConversationId).toBe(parentB.id);
    expect(store.snapshot().lineageEdges[child.id]).toMatchObject({
      source: "engine-native",
      parentConversationId: parentB.id,
      parentArtifactPath: parentB.generations[0]?.path,
    });
  });

  test("inventory refresh preserves authoritative viewer-spawn lineage evidence", () => {
    const store = registry();
    const parentPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const childPath = "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl";
    const parent = store.ensureConversation("codex", parentPath, "terra");
    const begun = store.beginSpawnRequest({
      engine: "codex",
      cwd: "/repo",
      accountId: "terra",
      parentConversationId: parent.id,
      parentArtifactPath: parentPath,
      clientAttemptId: "viewer_spawn_evidence",
      requestDigest: "digest",
    });
    if (begun.kind !== "created") throw new Error("expected create");
    const settled = store.settleSpawn(begun.receipt.launchId, spawnEntry(childPath));
    if (settled.kind !== "settled") throw new Error("expected settlement");

    store.reconcileConversations([{
      engine: "codex",
      path: childPath,
      accountId: "terra",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", parentConversationId: parent.id }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-12T12:00:00.000Z",
    }]);

    expect(store.snapshot().lineageEdges[settled.conversation.id]).toMatchObject({
      source: "viewer-spawn",
      parentConversationId: parent.id,
      childArtifactPath: childPath,
      evidence: {
        launchId: begun.receipt.launchId,
        clientAttemptId: "viewer_spawn_evidence",
      },
    });
  });

  test("keeps simultaneous same-engine same-cwd receipts isolated and fails conflicting artifacts closed", () => {
    const store = registry();
    const first = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "a" });
    const second = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "b" });
    if (first.kind !== "created" || second.kind !== "created") throw new Error("expected creates");
    const firstPath = "/sessions/019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const secondPath = "/sessions/019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl";
    expect(store.settleSpawn(first.receipt.launchId, spawnEntry(firstPath)).kind).toBe("settled");
    expect(store.settleSpawn(second.receipt.launchId, spawnEntry(secondPath, "b")).kind).toBe("settled");
    const conflict = store.settleSpawn(second.receipt.launchId, spawnEntry(firstPath, "b"));
    expect(conflict).toMatchObject({ kind: "conflict", code: "spawn_artifact_conflict" });
    expect(store.snapshot().receipts[first.receipt.launchId]?.artifactPath).toBe(firstPath);
    expect(store.snapshot().receipts[second.receipt.launchId]?.artifactPath).toBe(secondPath);
  });

  test("keeps a conflicted spawn receipt terminal across later settlement", () => {
    const store = registry();
    const begun = store.beginSpawnRequest({ engine: "codex", cwd: "/repo" });
    if (begun.kind !== "created") throw new Error("expected create");
    const pathname = "/sessions/019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";
    const conflict = store.settleSpawn(begun.receipt.launchId, { ...spawnEntry(pathname), cwd: "/wrong" });
    const replay = store.settleSpawn(begun.receipt.launchId, spawnEntry(pathname));

    expect(conflict).toMatchObject({ kind: "conflict", code: "spawn_identity_conflict" });
    expect(replay).toMatchObject({ kind: "conflict", receipt: { state: "conflicted", error: "spawn_identity_conflict" } });
    expect(store.snapshot().receipts[begun.receipt.launchId]).toMatchObject({ state: "conflicted", error: "spawn_identity_conflict" });
  });

  test("migration settlement atomically reassigns durable provisional references", () => {
    const store = registry();
    const original = store.ensureConversation("claude", "/source.jsonl", "source");
    const targetPath = "/target.jsonl";
    store.reconcileConversations([{
      engine: "claude",
      path: targetPath,
      accountId: "target",
      launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-10T12:00:00.000Z",
    }]);
    const provisional = store.conversationForPath(targetPath)!;
    const childReceipt = store.beginSpawnRequest({ engine: "claude", cwd: "/repo", parentConversationId: provisional.id });
    const held = store.holdDelivery(provisional.id, "deliver after migration");
    store.reconcileConversations([{
      engine: "claude",
      path: "/child.jsonl",
      accountId: "target",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", parentConversationId: provisional.id }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-10T12:00:01.000Z",
    }]);
    const migration = store.beginSpawnRequest({
      engine: "claude",
      cwd: "/repo",
      conversationId: original.id,
      purpose: "migration-successor",
      expectedArtifactPath: targetPath,
    });
    if (migration.kind !== "created") throw new Error("expected create");

    const settled = store.settleSpawn(migration.receipt.launchId, {
      key: { engine: "claude", sessionId: "target" },
      artifactPath: targetPath,
      cwd: "/repo",
      accountId: "target",
      status: "live",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });

    expect(settled).toMatchObject({ kind: "settled", conversation: { id: original.id } });
    expect(store.conversationForPath(targetPath)?.id).toBe(original.id);
    expect(store.conversation(original.id)?.continuityPaths).toEqual([targetPath]);
    expect(Object.values(store.snapshot().conversations)).toHaveLength(2);
    const snapshot = store.snapshot();
    expect(snapshot.receipts[childReceipt.receipt.launchId]).toMatchObject({ parentConversationId: original.id });
    expect(snapshot.lineageEdges[childReceipt.receipt.conversationId]).toMatchObject({ parentConversationId: original.id });
    expect(snapshot.heldDeliveries[held.id]).toMatchObject({ conversationId: original.id });
    expect(store.conversationForPath("/child.jsonl")?.generations[0]?.launchProfile.parentConversationId).toBe(original.id);
    expect(snapshot.conversationAliases[provisional.id]).toBe(original.id);
    expect(store.canonicalConversationId(provisional.id)).toBe(original.id);
    expect(store.conversation(provisional.id)?.id).toBe(original.id);
    expect(new AgentRegistry(store.filename).conversation(provisional.id)?.id).toBe(original.id);
  });

  test("normalizes a legacy receipt after restart without changing its schema version", () => {
    const store = registry();
    fs.writeFileSync(store.filename, JSON.stringify({
      version: 2, entries: {}, receipts: { legacy: { launchId: "legacy", engine: "codex", cwd: "/repo", createdAt: "2026-07-10T00:00:00.000Z", state: "starting", artifactPath: null, error: null, launchProfile: { cwd: "/repo" } } },
      importedResumePanes: false, legacyResumePanes: { serverPid: null, panes: {} }, conversations: {}, conversationRevision: { claude: 0, codex: 0 }, migrationIntents: {}, engineRouting: { claude: { activeAccountId: null, revision: 0 }, codex: { activeAccountId: null, revision: 0 } }, autoBalance: {}, quotaObservations: {}, heldDeliveries: {},
    }));
    const restarted = new AgentRegistry(store.filename).snapshot();
    expect(restarted.version).toBe(2);
    expect(restarted.receipts.legacy).toMatchObject({ clientAttemptId: null, pane: null, key: null, state: "starting" });
    expect(restarted.receipts.legacy?.conversationId.startsWith("conversation_")).toBe(true);
  });

  test("keeps birth-account provenance while attaching an active migration intent", () => {
    const store = registry();
    const receipt = store.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: "birth" });
    if (receipt.kind !== "created") throw new Error("expected create");
    const intent = store.upsertMigrationIntent("codex", "target", "manual", "move-after-spawn");
    const path = "/sessions/019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl";

    const settled = store.settleSpawn(receipt.receipt.launchId, spawnEntry(path, "target"));

    expect(settled).toMatchObject({ kind: "settled", entry: { accountId: "birth" }, conversation: { migration: { intentId: intent.id, targetId: "target" } } });
  });
});
