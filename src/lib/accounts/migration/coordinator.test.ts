import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry, MigrationRevisionError, type ConversationObservation } from "@/lib/agent/registry";

import { advanceConversationMigration, drainHeldDeliveries } from "./coordinator";
import { emptyLaunchProfile, type ProviderReceipt, type SuccessorProviderPort } from "./contracts";

const roots: string[] = [];

function registry(): AgentRegistry {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-migration-coordinator-"));
  roots.push(root);
  return new AgentRegistry(path.join(root, "registry.json"));
}

function observation(pathname: string, accountId: string, state: "idle" | "busy" | "terminal", role: "root" | "worker" = "worker"): ConversationObservation {
  return {
    engine: "codex",
    path: pathname,
    accountId,
    launchProfile: emptyLaunchProfile({
      cwd: "/repo",
      model: "gpt-5.6-terra",
      effort: "high",
      fast: true,
      permissionMode: "never",
      title: `Title ${pathname}`,
      project: "repo",
      role,
      goal: { objective: "Ship", status: "active", tokensUsed: 12, timeUsedSeconds: 4 },
      plan: { steps: [{ text: "Implement", status: "in_progress" }], done: 0, total: 1, current: "Implement", updatedAt: "2026-07-10T12:00:00.000Z" },
    }),
    turn: { state, source: state === "terminal" ? "lifecycle" : "empty", terminalAt: state === "terminal" ? "2026-07-10T12:00:00.000Z" : null },
    observedAt: "2026-07-10T12:00:00.000Z",
  };
}

function provider(paths: string[], counts = { create: 0, verify: 0 }): SuccessorProviderPort {
  return {
    async create(input) {
      counts.create += 1;
      const next = paths.shift() ?? `/successor-${counts.create}.jsonl`;
      return {
        operationId: input.operationId,
        nativeId: path.basename(next, ".jsonl"),
        path: next,
        historyHash: `hash-${counts.create}`,
        host: { kind: "codex-app-server", identity: `host-${counts.create}`, epoch: counts.create, verifiedAt: "2026-07-10T12:01:00.000Z" },
      };
    },
    async verify() { counts.verify += 1; },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("durable account migration coordinator", () => {
  test("commits routing, intent, scope, root exclusions, and request id atomically", () => {
    const store = registry();
    store.reconcileConversations([
      observation("/idle.jsonl", "a", "idle"),
      observation("/busy.jsonl", "a", "busy"),
      observation("/root.jsonl", "a", "idle", "root"),
    ]);
    const previewRevision = store.engineRouting("codex").revision;
    const intent = store.commitMigrationIntent({ engine: "codex", targetId: "b", origin: "manual", requestId: "request-1", expectedRevision: previewRevision });
    const snapshot = store.snapshot();
    expect(snapshot.engineRouting.codex.activeAccountId).toBe("b");
    expect(Object.values(snapshot.conversations).find((item) => item.generations[0]?.path === "/idle.jsonl")?.migration?.phase).toBe("requested");
    expect(Object.values(snapshot.conversations).find((item) => item.generations[0]?.path === "/busy.jsonl")?.migration?.phase).toBe("waiting-turn");
    expect(Object.values(snapshot.conversations).find((item) => item.generations[0]?.path === "/root.jsonl")?.migration).toBeNull();
    expect(store.commitMigrationIntent({ engine: "codex", targetId: "b", origin: "manual", requestId: "request-1", expectedRevision: previewRevision }).id).toBe(intent.id);
    expect(() => store.commitMigrationIntent({ engine: "codex", targetId: "a", origin: "manual", requestId: "request-2", expectedRevision: previewRevision }))
      .toThrow(MigrationRevisionError);
  });

  test("A to B to A preserves one owner, the full profile, and drains held input once", async () => {
    const store = registry();
    store.reconcileConversations([observation("/a.jsonl", "a", "idle")]);
    const conversation = store.conversationForPath("/a.jsonl")!;
    const firstRevision = store.engineRouting("codex").revision;
    const firstIntent = store.commitMigrationIntent({ engine: "codex", targetId: "b", origin: "manual", requestId: "to-b", expectedRevision: firstRevision });
    const held = store.holdDelivery(conversation.id, "continue", "client-1");
    expect(store.holdDelivery(conversation.id, "continue", "client-1").id).toBe(held.id);
    await advanceConversationMigration(conversation.id, store, provider(["/b.jsonl"]));
    const committedOnce = store.conversation(conversation.id)!;
    const successor = committedOnce.generations.at(-1)!;
    expect(store.commitSuccessor(conversation.id, { id: successor.id, path: successor.path, accountId: successor.accountId }, committedOnce.migration!.revision).generations).toHaveLength(2);
    const delivered: string[] = [];
    await drainHeldDeliveries(conversation.id, { async deliver(input) { delivered.push(input.clientMessageId); return "delivered"; } }, store);
    expect(delivered).toEqual(["client-1"]);
    expect(store.pendingDeliveries(conversation.id)).toEqual([]);
    store.setMigrationIntentState(firstIntent.id, "complete");

    store.reconcileConversations([observation("/b.jsonl", "b", "idle")]);
    const secondRevision = store.engineRouting("codex").revision;
    store.commitMigrationIntent({ engine: "codex", targetId: "a", origin: "manual", requestId: "to-a", expectedRevision: secondRevision });
    const final = await advanceConversationMigration(conversation.id, store, provider(["/a2.jsonl"]));
    expect(final.id).toBe(conversation.id);
    expect(final.generations.map((generation) => generation.path)).toEqual(["/a.jsonl", "/b.jsonl", "/a2.jsonl"]);
    expect(final.generations.at(-1)?.launchProfile).toMatchObject({ cwd: "/repo", model: "gpt-5.6-terra", effort: "high", fast: true, permissionMode: "never", title: "Title /a.jsonl" });
    expect(final.generations.at(-1)?.launchProfile.goal?.objective).toBe("Ship");
    expect(final.generations.at(-1)?.launchProfile.plan?.current).toBe("Implement");
  });

  test("restart adopts a persisted provider receipt without creating another successor", async () => {
    const store = registry();
    store.reconcileConversations([observation("/source.jsonl", "a", "idle")]);
    const conversation = store.conversationForPath("/source.jsonl")!;
    store.commitMigrationIntent({ engine: "codex", targetId: "b", origin: "manual", requestId: "restart", expectedRevision: store.engineRouting("codex").revision });
    const revision = store.conversation(conversation.id)!.migration!.revision;
    store.transitionConversationMigration(conversation.id, revision, ["requested"], { phase: "preparing" });
    store.transitionConversationMigration(conversation.id, revision, ["preparing"], { phase: "successor-starting" });
    const receipt: ProviderReceipt = {
      operationId: store.conversation(conversation.id)!.migration!.operationId,
      nativeId: "native-b",
      path: "/b.jsonl",
      historyHash: "hash",
      host: { kind: "codex-app-server", identity: "host", epoch: 1, verifiedAt: "2026-07-10T12:01:00.000Z" },
    };
    store.transitionConversationMigration(conversation.id, revision, ["successor-starting"], { phase: "verifying", providerReceipt: receipt });

    const restarted = new AgentRegistry(store.filename);
    const counts = { create: 0, verify: 0 };
    const final = await advanceConversationMigration(conversation.id, restarted, provider([], counts));
    expect(counts).toEqual({ create: 0, verify: 1 });
    expect(final.generations.at(-1)?.path).toBe("/b.jsonl");
  });

  test("busy sessions wait for authoritative terminal evidence", async () => {
    const store = registry();
    store.reconcileConversations([observation("/busy.jsonl", "a", "busy")]);
    const conversation = store.conversationForPath("/busy.jsonl")!;
    store.commitMigrationIntent({ engine: "codex", targetId: "b", origin: "manual", requestId: "terminal", expectedRevision: store.engineRouting("codex").revision });
    const counts = { create: 0, verify: 0 };
    await advanceConversationMigration(conversation.id, store, provider(["/b.jsonl"], counts));
    expect(counts.create).toBe(0);
    store.reconcileConversations([observation("/busy.jsonl", "a", "terminal")]);
    const final = await advanceConversationMigration(conversation.id, store, provider(["/b.jsonl"], counts));
    expect(counts.create).toBe(1);
    expect(final.migration?.phase).toBe("committed");
  });

  test("inventory changes fence stale previews and preserve durable profile ownership", () => {
    const store = registry();
    const initial = observation("/owned.jsonl", "a", "idle");
    store.reconcileConversations([initial]);
    const staleRevision = store.engineRouting("codex").revision;
    const refreshed = observation("/owned.jsonl", "b", "busy", "root");
    refreshed.launchProfile.goal = null;
    refreshed.launchProfile.plan = null;
    store.reconcileConversations([refreshed]);

    const current = store.conversationForPath("/owned.jsonl")!;
    expect(current.generations.at(-1)?.launchProfile).toMatchObject({ role: "root" });
    expect(current.generations.at(-1)?.launchProfile.goal?.objective).toBe("Ship");
    expect(current.generations.at(-1)?.launchProfile.plan?.current).toBe("Implement");
    expect(store.engineRouting("codex").revision).toBeGreaterThan(staleRevision);
    expect(() => store.commitMigrationIntent({ engine: "codex", targetId: "c", origin: "manual", requestId: "stale-scope", expectedRevision: staleRevision }))
      .toThrow(MigrationRevisionError);
  });

  test("rollback reassigns held delivery to the healthy source generation", async () => {
    const store = registry();
    store.reconcileConversations([observation("/source.jsonl", "a", "idle")]);
    const conversation = store.conversationForPath("/source.jsonl")!;
    store.commitMigrationIntent({ engine: "codex", targetId: "b", origin: "manual", requestId: "rollback", expectedRevision: store.engineRouting("codex").revision });
    store.holdDelivery(conversation.id, "safe retry", "client-rollback");
    const revision = store.conversation(conversation.id)!.migration!.revision;
    store.rollbackConversationMigration(conversation.id, revision);
    const assigned = store.pendingDeliveries(conversation.id)[0]!;
    expect(assigned).toMatchObject({ state: "assigned", generationId: conversation.generations[0]?.id });
    await drainHeldDeliveries(conversation.id, { async deliver() { return "delivered"; } }, store);
    expect(store.pendingDeliveries(conversation.id)).toEqual([]);
  });

  test("an ambiguous held delivery is claimed once and never replayed automatically", async () => {
    const store = registry();
    store.reconcileConversations([observation("/source.jsonl", "a", "idle")]);
    const conversation = store.conversationForPath("/source.jsonl")!;
    store.commitMigrationIntent({ engine: "codex", targetId: "b", origin: "manual", requestId: "uncertain", expectedRevision: store.engineRouting("codex").revision });
    store.holdDelivery(conversation.id, "send once", "client-uncertain");
    await advanceConversationMigration(conversation.id, store, provider(["/target.jsonl"]));
    let attempts = 0;
    const uncertain = { async deliver() { attempts += 1; throw new Error("transport result lost"); } };

    await drainHeldDeliveries(conversation.id, uncertain, store);
    await drainHeldDeliveries(conversation.id, uncertain, store);

    expect(attempts).toBe(1);
    expect(store.pendingDeliveries(conversation.id)[0]).toMatchObject({ state: "delivery-uncertain", attempts: 1 });
    store.rollbackConversationMigration(conversation.id, store.conversation(conversation.id)!.migration!.revision);
    expect(store.pendingDeliveries(conversation.id)[0]?.state).toBe("delivery-uncertain");
  });

  test("a rapid retarget fences a stale provider result", async () => {
    const store = registry();
    store.reconcileConversations([observation("/source.jsonl", "a", "idle")]);
    const conversation = store.conversationForPath("/source.jsonl")!;
    store.commitMigrationIntent({ engine: "codex", targetId: "b", origin: "manual", requestId: "to-b", expectedRevision: store.engineRouting("codex").revision });
    const staleProvider: SuccessorProviderPort = {
      async create(input) {
        store.commitMigrationIntent({ engine: "codex", targetId: "c", origin: "manual", requestId: "to-c", expectedRevision: store.engineRouting("codex").revision });
        return {
          operationId: input.operationId,
          nativeId: "stale-b",
          path: "/stale-b.jsonl",
          historyHash: "stale",
          host: { kind: "codex-app-server", identity: "stale", epoch: 1, verifiedAt: "2026-07-10T12:01:00.000Z" },
        };
      },
      async verify() {},
    };
    const latest = await advanceConversationMigration(conversation.id, store, staleProvider);
    expect(latest.migration).toMatchObject({ targetId: "c", phase: "requested" });
    expect(latest.generations).toHaveLength(1);
  });
});
