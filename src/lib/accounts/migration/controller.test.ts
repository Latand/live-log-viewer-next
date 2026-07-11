import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry } from "@/lib/agent/registry";
import type { CodexAccount } from "@/lib/accounts/codex";
import { emptyLaunchProfile, type SuccessorProviderPort } from "./contracts";
import { QuotaController, type QuotaProbePort } from "./quotaController";

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-controller-"));
const { AccountMigrationController, reconcileAccountMigrationCycle } = await import("./controller");

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
    async create(input) { return { operationId: input.operationId, nativeId: "successor", path: "/target.jsonl", continuityPaths: [], historyHash: "hash", host: { kind: "codex-app-server", identity: "successor", epoch: 1, verifiedAt: "2026-07-10T12:01:00.000Z" } }; },
    async verify() {},
  };

  await reconcileAccountMigrationCycle(registry, quota as never, provider, { async deliver() { return "delivered"; } });

  expect(ticks.sort()).toEqual(["claude", "codex"]);
  expect(registry.conversation(conversation.id)?.migration?.phase).toBe("committed");
}, 20_000);

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

test("three controller cycles move depleted Main to a stronger managed account and suppress a bounce", async () => {
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
    const provider: SuccessorProviderPort = {
      async create(input) {
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
    expect(registry.snapshot().autoBalance.codex.sustain).toMatchObject({ bootId: "00000000-0000-4000-8000-000000000040" });

    current += 60_000;
    await reconcileAccountMigrationCycle(registry, quota, provider, { async deliver() { return "delivered"; } });
    const intent = Object.values(registry.snapshot().migrationIntents).find((item) => item.engine === "codex");
    expect(intent).toMatchObject({ origin: "auto", targetId: "managed", state: "draining" });
    expect(registry.engineRouting("codex").activeAccountId).toBe("managed");

    current += 60_000;
    await reconcileAccountMigrationCycle(registry, quota, provider, { async deliver() { return "delivered"; } });
    const snapshot = registry.snapshot();
    expect(snapshot.conversations[conversationId]?.migration?.phase).toBe("committed");
    expect(snapshot.conversations[conversationId]?.generations.at(-1)?.accountId).toBe("managed");
    expect(snapshot.migrationIntents[intent!.id]?.state).toBe("complete");
    expect(snapshot.autoBalance.codex.cooldownUntil).toBeTruthy();
    expect(Object.values(snapshot.migrationIntents)).toHaveLength(1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
