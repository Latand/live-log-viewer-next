import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry } from "@/lib/agent/registry";
import type { CodexAccount } from "@/lib/accounts/codex";
import { structuredContent, type StructuredImageRef } from "@/lib/runtime/structuredContent";
import { emptyLaunchProfile, type SuccessorProviderPort } from "./contracts";
import { QuotaController, type QuotaProbePort } from "./quotaController";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-controller-"));
const { AccountMigrationController, createMigrationDeliveryPort, reconcileAccountMigrationCycle } = await import("./controller");

afterAll(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("controller migration cycle reconciles and ticks both durable quota policy guards", async () => {
  const ticks: string[] = [];
  const quota = { tick: async (engine: string) => { ticks.push(engine); } };
  const registry = new AgentRegistry(path.join(stateDir, "registry.json"));
  registry.reconcileConversations([{
    engine: "codex",
    path: "/source.jsonl",
    accountId: "source",
    launchProfile: emptyLaunchProfile(),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-10T12:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath("/source.jsonl")!;
  registry.commitMigrationIntent({ engine: "codex", targetId: "target", origin: "manual", requestId: "controller-cycle", expectedRevision: registry.engineRouting("codex").revision });
  const provider: SuccessorProviderPort = {
    virtualSource: true,
    async create(input) { return { operationId: input.operationId, nativeId: "successor", path: "/target.jsonl", continuityPaths: [], historyHash: "hash", host: { kind: "codex-app-server", identity: "successor", epoch: 1, verifiedAt: "2026-07-10T12:01:00.000Z" } }; },
    async verify() {},
  };

  await reconcileAccountMigrationCycle(registry, quota as never, provider, { async deliver() { return "delivered"; } });

  expect(ticks.sort()).toEqual(["claude", "codex"]);
  expect(registry.conversation(conversation.id)?.migration?.phase).toBe("committed");
}, 20_000);

test("controller preserves durable image refs while draining a migration-held structured message", async () => {
  const registry = new AgentRegistry(path.join(stateDir, "structured-delivery-registry.json"));
  registry.reconcileConversations([{
    engine: "claude",
    path: "/structured-successor.jsonl",
    accountId: "target",
    launchProfile: emptyLaunchProfile(),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-10T12:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath("/structured-successor.jsonl")!;
  const imageRef: StructuredImageRef = { sha256: "a".repeat(64), mime: "image/png", bytes: 67 };
  const content = structuredContent("continue", [imageRef]);
  const assigned = registry.holdDelivery(conversation.id, "continue", "migration-message", "runtime-images", [imageRef], content.contentDigest);
  const claimed = registry.beginDeliveryAttempt(assigned.id, assigned.generationId!)!;
  const structured: unknown[] = [];
  let legacyCalls = 0;
  const port = createMigrationDeliveryPort({
    structuredDelivery: async (request) => {
      structured.push(request);
      return "delivered";
    },
    legacyDelivery: async () => {
      legacyCalls += 1;
      return "delivered";
    },
  });

  const outcome = await port.deliver({
    delivery: claimed,
    path: "/structured-successor.jsonl",
    clientMessageId: "migration-message",
  });

  expect(outcome).toBe("delivered");
  expect(structured).toEqual([{
    conversationId: conversation.id,
    runtimeConversationId: conversation.id,
    path: "/structured-successor.jsonl",
    deliveryId: claimed.id,
    clientMessageId: "migration-message",
    text: "continue",
    command: claimed.command,
    imageRefs: [imageRef],
  }]);
  expect(legacyCalls).toBe(0);
});

test("controller keeps an uncertain structured claim fenced when ownership cannot be reconciled", async () => {
  let legacyCalls = 0;
  const port = createMigrationDeliveryPort({
    structuredDelivery: async () => null,
    legacyDelivery: async () => {
      legacyCalls += 1;
      return "delivered";
    },
  });
  const delivery = {
    id: "held-one",
    conversationId: "conversation_11111111-1111-4111-8111-111111111111" as const,
    runtimeConversationId: "conversation_11111111-1111-4111-8111-111111111111" as const,
    text: "continue",
    createdAt: "2026-07-13T00:00:00.000Z",
    clientMessageId: "migration-message",
    payloadKind: "text" as const,
    runtimeImages: [],
    contentDigest: null,
    artifactPaths: [],
    command: {
      operationId: "held-one",
      kind: "send" as const,
      policy: "interrupt-active" as const,
    },
    requestDigest: "held-one-request-digest",
    state: "delivery-uncertain" as const,
    generationId: "generation-one",
    attempts: 1,
    assignedAt: "2026-07-13T00:00:00.000Z",
    deliveredAt: null,
    error: "delivery started; recovery requires an explicit outcome",
  };

  const outcome = await port.reconcileUncertain!({
    delivery,
    path: "/structured-successor.jsonl",
    clientMessageId: "migration-message",
  });

  expect(outcome).toBe("delivery-uncertain");
  expect(legacyCalls).toBe(0);
});

test("controller runs a trailing cycle when a signal arrives during reconciliation", async () => {
  const registry = new AgentRegistry(path.join(stateDir, "trailing-cycle-registry.json"));
  let releaseFirstCycle = () => {};
  const firstCycleBlocked = new Promise<void>((resolve) => { releaseFirstCycle = resolve; });
  let cycles = 0;
  let activeCycles = 0;
  let maxActiveCycles = 0;
  const controller = new AccountMigrationController(
    registry,
    { tick: async () => {} } as never,
    async () => {
      cycles += 1;
      activeCycles += 1;
      maxActiveCycles = Math.max(maxActiveCycles, activeCycles);
      try {
        if (cycles === 1) await firstCycleBlocked;
      } finally {
        activeCycles -= 1;
      }
    },
  );

  const firstTick = controller.tick();
  const trailingTick = controller.tick();
  const coalescedTick = controller.tick();
  releaseFirstCycle();
  await Promise.all([firstTick, trailingTick, coalescedTick]);

  expect(cycles).toBe(2);
  expect(maxActiveCycles).toBe(1);
});

test("periodic polling joins a running cycle without scheduling another full inventory", async () => {
  let release = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let cycles = 0;
  const controller = new AccountMigrationController(
    new AgentRegistry(path.join(stateDir, "poll-coalescing-registry.json")),
    { tick: async () => {} } as never,
    async () => { cycles += 1; await blocked; },
  );

  const running = controller.tick();
  const periodic = controller.poll();
  release();
  await Promise.all([running, periodic]);

  expect(cycles).toBe(1);
});

test("controller preserves one trailing cycle when the running cycle fails", async () => {
  let release = () => {};
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let cycles = 0;
  const controller = new AccountMigrationController(
    new AgentRegistry(path.join(stateDir, "failing-trailing-registry.json")),
    { tick: async () => {} } as never,
    async () => { cycles += 1; if (cycles === 1) { await blocked; throw new Error("cycle failed"); } },
  );
  const first = controller.tick();
  controller.tick();
  release();
  await expect(first).rejects.toThrow("cycle failed");
  expect(cycles).toBe(2);
});

test("controller reconciliation waits for a complete scanner inventory", async () => {
  const reconciliations: string[] = [];
  let complete = false;
  const registry = new AgentRegistry(path.join(stateDir, "incomplete-inventory-registry.json"));
  const controller = new AccountMigrationController(
    registry,
    { tick: async () => {} } as never,
    null,
    {
      scan: async () => ({ files: [], projectCatalog: [], complete }),
      reconcileInventory: async () => { reconciliations.push("inventory"); return registry.snapshot(); },
      reconcileFlowOwnership: async () => { reconciliations.push("flows"); },
      reconcileWorkflowOwnership: async () => { reconciliations.push("workflows"); },
      reconcileHandoffOwnership: async () => { reconciliations.push("handoffs"); },
      reconcileFiles: async () => { reconciliations.push("files"); },
      reconcileRuntime: async () => { reconciliations.push("runtime"); },
      reconcileTaskStore: async () => { reconciliations.push("tasks"); },
      syncRouting: async () => { reconciliations.push("routing"); },
      reconcileMigrationCycle: async () => { reconciliations.push("migration"); },
    },
  );

  await controller.tick();
  expect(reconciliations).toEqual([]);

  complete = true;
  await controller.tick();
  expect(reconciliations).toEqual([
    "inventory",
    "flows",
    "workflows",
    "handoffs",
    "files",
    "runtime",
    "tasks",
    "routing",
    "migration",
  ]);
});

test("quota controller cycles preserve routing and transcript ownership", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-controller-auto-"));
  try {
    const registry = new AgentRegistry(path.join(root, "registry.json"));
    let current = Date.parse("2026-07-10T12:00:00.000Z");
    const main: CodexAccount = { id: "default", label: "Main", kind: "legacy", home: "/homes/main", sessionsDir: "/homes/main/sessions", authPresent: true, loginPane: null, createdAt: 0 };
    const managed: CodexAccount = { id: "managed", label: "Managed", kind: "managed", home: "/homes/managed", sessionsDir: "/homes/managed/sessions", authPresent: true, loginPane: null, createdAt: 1 };
    const probe: QuotaProbePort = {
      list: (engine) => engine === "codex" ? [main, managed] : [],
      active: () => "default",
      async probe(engine, candidate, observedAt) {
        const used = candidate.id === "default" ? 80 : 20;
        return {
          engine,
          accountId: candidate.id,
          authenticated: true,
          authCheckedAt: observedAt,
          limits: { session: { usedPercent: used, resetsAt: null }, weekly: null, plan: "pro", capturedAt: Math.floor(observedAt / 1000) },
          provenance: { source: "live", reason: null, staleSince: null },
          observedAt,
        };
      },
    };
    const quota = new QuotaController(registry, probe, "00000000-0000-4000-8000-000000000040", () => current);
    registry.setAutoBalancePolicy("codex", true);
    registry.setEngineRouting("codex", "default");
    registry.reconcileConversations([{
      engine: "codex",
      path: "/main.jsonl",
      accountId: "default",
      launchProfile: emptyLaunchProfile({ title: "Main card" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: new Date(current).toISOString(),
    }]);
    registry.upsert({
      key: { engine: "codex", sessionId: "019f4906-3f67-7b72-9fbc-9ec3b5ad1326" },
      artifactPath: "/main.jsonl",
      cwd: "/repo",
      accountId: "default",
      status: "idle",
      host: null,
      claimEpoch: 0,
      claimOwner: null,
      pendingAction: null,
    });
    const conversationId = registry.conversationForPath("/main.jsonl")!.id;
    let successorStarts = 0;
    const provider: SuccessorProviderPort = {
      virtualSource: true,
      async create(input) {
        successorStarts += 1;
        return {
          operationId: input.operationId,
          nativeId: "managed-successor",
          path: "/managed.jsonl",
          continuityPaths: [],
          historyHash: "managed-history",
          host: { kind: "codex-app-server", identity: "managed-successor", epoch: 1, verifiedAt: new Date(current).toISOString() },
        };
      },
      async verify() {},
    };

    await reconcileAccountMigrationCycle(registry, quota, provider, { async deliver() { return "delivered"; } });
    current += 60_000;
    await reconcileAccountMigrationCycle(registry, quota, provider, { async deliver() { return "delivered"; } });
    current += 60_000;
    await reconcileAccountMigrationCycle(registry, quota, provider, { async deliver() { return "delivered"; } });
    const snapshot = registry.snapshot();
    expect(snapshot.quotaObservations.codex.default).toMatchObject({ authenticated: true, bootId: "00000000-0000-4000-8000-000000000040" });
    expect(snapshot.quotaObservations.codex.managed).toMatchObject({ authenticated: true, bootId: "00000000-0000-4000-8000-000000000040" });
    expect(snapshot.engineRouting.codex.activeAccountId).toBe("default");
    expect(snapshot.conversations[conversationId]?.migration).toBeNull();
    expect(snapshot.conversations[conversationId]?.generations.at(-1)?.accountId).toBe("default");
    expect(Object.values(snapshot.migrationIntents)).toHaveLength(0);
    expect(successorStarts).toBe(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
