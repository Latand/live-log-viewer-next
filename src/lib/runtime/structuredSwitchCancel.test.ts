import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import { advanceConversationMigration, reconcileMigrations, type HeldDeliveryPort } from "@/lib/accounts/migration/coordinator";
import { applyConversationMigration } from "@/lib/accounts/migration/conversationCommand";
import { emptyLaunchProfile, type HeldDelivery, type ProviderReceipt, type SuccessorProviderPort } from "@/lib/accounts/migration/contracts";
import { AgentRegistry, type RegistryConversation, type RegistryFile } from "@/lib/agent/registry";
import type { SessionKey } from "@/lib/agent/sessionKey";
import { boardFor, setBoardFileForTests } from "@/lib/board/store";
import { procBackend } from "@/lib/proc";
import { terminalizeStaleUndeliverableHeldDeliveries } from "@/lib/reaperRuntime";

import type { StructuredReconfigureEffect } from "./structuredDeliveryQueue";
import { applyStructuredReconfigure } from "./structuredReconfigure";

/*
 * Cancelling an account switch without losing anything (#1695 K6b, #1705).
 * These cases state the contract of `evidence/issue-1695/k6b-plan.md`; they
 * were written before the implementation and failed on main 098932f8. They use
 * the account-switch fixture of `structuredAccountSwitch.test.ts`: a structured
 * Claude conversation on account A running a turn, with three deliveries
 * around a switch to account B that waits for that turn. The first was
 * assigned to the source before the switch, the second began an attempt
 * before it (uncertain), and the third was held while the switch waited.
 * Isolated registry and board files; no host, runtime socket or account is
 * touched.
 */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-switch-cancel-"));
let caseNumber = 0;

afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function claudeTranscript(pathname: string): void {
  fs.writeFileSync(pathname, [
    JSON.stringify({ type: "user", timestamp: "2026-07-21T10:00:00.000Z", message: { role: "user", content: "go" } }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-21T10:00:26.000Z",
      message: { role: "assistant", model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: "worked for 26s" }] },
    }),
  ].join("\n") + "\n");
}

/** The broker process the registry row describes. Structured turn evidence
    only counts while its engine process is verifiably alive, so the fixture
    names this test process. */
function liveProcessIdentity() {
  return { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) };
}

function recordStructuredHost(
  registry: AgentRegistry,
  key: SessionKey,
  artifactPath: string,
  accountId: string,
  activeTurnRef: string | null,
  status: "live" | "idle" | "dead" = activeTurnRef ? "live" : "idle",
): void {
  registry.upsert({
    key,
    artifactPath,
    cwd: "/repo",
    accountId,
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    status,
    host: null,
    structuredHost: {
      kind: "claude-broker",
      endpoint: "stdio:broker",
      process: liveProcessIdentity(),
      eventCursor: 12,
      protocolVersion: "v1",
      writerClaimEpoch: 1,
      activeTurnRef,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: `structured-host:${JSON.stringify(liveProcessIdentity())}`,
    pendingAction: null,
  });
}

function successorProvider(successorPath: string, onCreate?: () => void): SuccessorProviderPort {
  return {
    async create(input): Promise<ProviderReceipt> {
      onCreate?.();
      fs.writeFileSync(successorPath, "");
      return {
        operationId: input.operationId,
        nativeId: "successor-native",
        path: successorPath,
        continuityPaths: [],
        historyHash: "successor-history",
        host: { kind: "claude-stream", identity: "successor-host", epoch: 1, verifiedAt: "2026-07-21T10:01:00.000Z" },
      };
    },
    async verify() {},
  };
}

interface PendingSwitch {
  registry: AgentRegistry;
  registryFile: string;
  id: RegistryConversation["id"];
  sourceGenerationId: string;
  effect: StructuredReconfigureEffect;
  profileBefore: RegistryConversation["generations"][number]["launchProfile"];
  apply: (effect?: StructuredReconfigureEffect) => Promise<"applied" | "pending">;
  deliveries: { before: HeldDelivery; uncertain: HeldDelivery; held: HeldDelivery | null };
}

/** A switch to account B requested while account A's turn runs; `claim: false` stops before the queue claims it. */
async function pendingSwitch(options: { claim?: boolean } = {}): Promise<PendingSwitch> {
  const root = path.join(sandbox, `case-${caseNumber += 1}`);
  fs.mkdirSync(root);
  setBoardFileForTests(path.join(root, "board.json"));
  const registry = new AgentRegistry(path.join(root, "registry.json"));
  const sourcePath = path.join(root, "source.jsonl");
  const successorPath = path.join(root, "successor.jsonl");
  claudeTranscript(sourcePath);
  registry.reconcileConversations([{
    engine: "claude",
    path: sourcePath,
    accountId: "account-a",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "busy", source: "assistant", terminalAt: null },
    observedAt: "2026-07-21T10:00:10.000Z",
  }]);
  const admitted = registry.conversationForPath(sourcePath)!;
  const source = admitted.generations.at(-1)!;
  const sourceKey: SessionKey = { engine: "claude", sessionId: source.id };
  recordStructuredHost(registry, sourceKey, sourcePath, "account-a", "turn-source");
  /* Admitted before any migration exists. The first began its attempt (uncertain); the one after it is still
     assigned to the source generation, since no attempt may start ahead of an earlier admission (#1709). */
  const attempted = registry.holdDelivery(admitted.id, "attempted before the switch", "attempted-before-switch");
  const uncertain = registry.beginDeliveryAttempt(attempted.id, source.id)!;
  const before = registry.holdDelivery(admitted.id, "sent before the switch", "before-switch");
  const effect: StructuredReconfigureEffect = {
    operationId: "reconfigure-to-b",
    conversationId: admitted.id,
    kind: "reconfigure",
    model: "claude-opus-5",
    effort: "high",
    fast: false,
    accountId: "account-b",
    eventSeq: 7,
  };
  const apply = (next: StructuredReconfigureEffect = effect) => applyStructuredReconfigure(next, {
    registry,
    validateAccount: async () => {},
    resolveAccount: ((engine: string, accountId: string) => ({ accountId, home: root, engine })) as never,
    releaseHost: async () => true,
    recover: (async () => true) as never,
    migrate: (conversationId, _target, store, ownsOperation, reconfigureOperationId) =>
      advanceConversationMigration(conversationId, store, successorProvider(successorPath), { ownsOperation, reconfigureOperationId, deferBoardRepair: true }),
  });
  let held: HeldDelivery | null = null;
  if (options.claim !== false) {
    expect(await apply()).toBe("pending");
    expect(registry.conversation(admitted.id)!.migration).toMatchObject({ phase: "waiting-turn", targetId: "account-b" });
    /* Sent while the switch waits: fenced by its migration. */
    held = registry.holdDelivery(admitted.id, "sent while the switch waits", "during-switch");
    expect(held.state).toBe("held");
  }
  return {
    registry,
    registryFile: path.join(root, "registry.json"),
    id: admitted.id,
    sourceGenerationId: source.id,
    effect,
    profileBefore: structuredClone(source.launchProfile),
    apply,
    deliveries: { before: registry.snapshot().heldDeliveries[before.id]!, uncertain, held },
  };
}

const delivery = (fixture: PendingSwitch, id: string) => structuredClone(fixture.registry.snapshot().heldDeliveries[id]!);
const failedDeliveries = (fixture: PendingSwitch) => Object.values(fixture.registry.snapshot().heldDeliveries).filter((entry) => entry.state === "failed");


test("cancelling a claimed switch that waits for the turn rolls it back, settles its owner, and re-arms only the delivery it held", async () => {
  const fixture = await pendingSwitch();
  const { registry, id } = fixture;
  const before = delivery(fixture, fixture.deliveries.before.id);
  const uncertain = delivery(fixture, fixture.deliveries.uncertain.id);
  const held = delivery(fixture, fixture.deliveries.held!.id);
  const migration = registry.conversation(id)!.migration!;

  const answer = registry.cancelConversationSwitch(id, migration.revision);
  const cancelled = answer.conversation;

  expect(answer.kind).toBe("cancelled");
  expect(cancelled.migration?.phase).toBe("rolled-back");
  expect(cancelled.reconfigure?.operationId).toBe(fixture.effect.operationId);
  expect(String(cancelled.reconfigure?.status)).toBe("cancelled");
  expect(registry.snapshot().migrationIntents[migration.intentId]?.state).toBe("stopped");
  expect(cancelled.generations.at(-1)?.launchProfile).toEqual(fixture.profileBefore);
  /* The held delivery goes back to the source with its payload and identity; nothing else moves. */
  const rearmed = delivery(fixture, held.id);
  expect({ state: rearmed.state, generationId: rearmed.generationId, text: rearmed.text, operationId: rearmed.command.operationId, clientMessageId: rearmed.clientMessageId, attempts: rearmed.attempts })
    .toEqual({ state: "assigned", generationId: fixture.sourceGenerationId, text: held.text, operationId: held.command.operationId, clientMessageId: held.clientMessageId, attempts: held.attempts });
  expect(delivery(fixture, before.id)).toEqual(before);
  expect(delivery(fixture, uncertain.id)).toEqual(uncertain);
  expect(failedDeliveries(fixture)).toEqual([]);

  /* The queue retries the effect it had left pending: nothing is requested again. */
  await expect(fixture.apply()).rejects.toThrow(/cancel/);
  const after = registry.conversation(id)!;
  expect(after.migration?.phase).toBe("rolled-back");
  expect(after.generations.at(-1)?.accountId).toBe("account-a");
  expect(delivery(fixture, held.id).state).toBe("assigned");
  expect(failedDeliveries(fixture)).toEqual([]);
});

test("a claimed cancel is refused with nothing changed when its revision is stale or the switch has started", async () => {
  const fixture = await pendingSwitch();
  const { registry, id } = fixture;
  const migration = registry.conversation(id)!.migration!;
  const heldId = fixture.deliveries.held!.id;
  expect(() => registry.cancelConversationSwitch(id, migration.revision + 1)).toThrow(/stale/);
  expect(registry.conversation(id)!.migration?.phase).toBe("waiting-turn");

  registry.transitionConversationMigration(id, migration.revision, ["waiting-turn"], { phase: "preparing" });
  expect(() => registry.cancelConversationSwitch(id, migration.revision)).toThrow(/started/);
  const current = registry.conversation(id)!;
  expect(current.migration?.phase).toBe("preparing");
  expect(current.reconfigure?.status).toBe("applying");
  expect(delivery(fixture, heldId).state).toBe("held");
});

test("a switch withdrawn before the queue claims it is never claimed: no profile is written and no migration is created", async () => {
  const fixture = await pendingSwitch({ claim: false });
  const { registry, id } = fixture;

  expect(registry.withdrawConversationReconfigure(id, fixture.effect.operationId).kind).toBe("withdrawn");
  expect(registry.withdrawConversationReconfigure(id, fixture.effect.operationId).kind).toBe("replayed");

  await expect(fixture.apply()).rejects.toThrow(/cancel/);
  const after = registry.conversation(id)!;
  expect(after.reconfigure ?? null).toBeNull();
  expect(after.migration ?? null).toBeNull();
  expect(after.generations.at(-1)?.launchProfile).toEqual(fixture.profileBefore);
  expect(failedDeliveries(fixture)).toEqual([]);
});

test("a withdrawal that arrives after the claim writes nothing and leaves the switch to a claimed cancel", async () => {
  const fixture = await pendingSwitch();
  const { registry, id } = fixture;
  expect(registry.withdrawConversationReconfigure(id, fixture.effect.operationId).kind).toBe("claimed");
  const after = registry.conversation(id)!;
  expect(after.migration?.phase).toBe("waiting-turn");
  expect(after.reconfigure?.status).toBe("applying");
  /* The queue's retry keeps the switch pending: the withdrawal fenced nothing. */
  expect(await fixture.apply()).toBe("pending");
});

test("a newer switch to another account keeps the held delivery held, with its payload, for the new migration", async () => {
  const fixture = await pendingSwitch();
  const { registry, id } = fixture;
  const held = delivery(fixture, fixture.deliveries.held!.id);

  expect(await fixture.apply({ ...fixture.effect, operationId: "reconfigure-to-c", accountId: "account-c", eventSeq: 8 })).toBe("pending");

  const after = registry.conversation(id)!;
  expect(after.migration).toMatchObject({ phase: "waiting-turn", targetId: "account-c" });
  const kept = delivery(fixture, held.id) as HeldDelivery & { fencedBy?: string | null };
  expect({ state: kept.state, text: kept.text, operationId: kept.command.operationId, fencedBy: kept.fencedBy ?? null })
    .toEqual({ state: "held", text: held.text, operationId: held.command.operationId, fencedBy: after.migration!.operationId });
  expect(failedDeliveries(fixture)).toEqual([]);
});

test("a newer switch back to the source account re-arms the held delivery with its payload, never failing it", async () => {
  const fixture = await pendingSwitch();
  const { registry, id } = fixture;
  const held = delivery(fixture, fixture.deliveries.held!.id);

  await fixture.apply({ ...fixture.effect, operationId: "reconfigure-back-to-a", accountId: "account-a", eventSeq: 8 });

  expect(registry.conversation(id)!.migration?.phase).toBe("rolled-back");
  const rearmed = delivery(fixture, held.id);
  expect({ state: rearmed.state, text: rearmed.text, operationId: rearmed.command.operationId })
    .toEqual({ state: "assigned", text: held.text, operationId: held.command.operationId });
  expect(failedDeliveries(fixture)).toEqual([]);
});

test("the migration route: cancel needs expectedRevision and rolls back a waiting switch; withdraw needs an operation id; rollback keeps its guard", async () => {
  const fixture = await pendingSwitch();
  const { registry, id } = fixture;
  const delivered: string[] = [];
  const kicks: number[] = [];
  const dependencies = {
    registry: () => registry,
    kick: () => { kicks.push(1); },
    /* Records what a drain hands to delivery; nothing reaches a host. */
    deliveryPort: { deliver: async ({ delivery }: { delivery: HeldDelivery }) => { delivered.push(delivery.id); return "held" as const; } },
  } as never;
  const revision = registry.conversation(id)!.migration!.revision;

  expect(await applyConversationMigration({ conversationId: id, action: "rollback" }, dependencies)).toMatchObject({ status: 400 });
  const withdrawn = await applyConversationMigration({ conversationId: id, action: "withdraw", operationId: "" } as never, dependencies);
  expect(withdrawn.status).toBe(400);
  expect(String(withdrawn.body.error)).toMatch(/operationId/);
  const unguarded = await applyConversationMigration({ conversationId: id, action: "cancel" }, dependencies);
  expect(unguarded.status).toBe(400);
  expect(String(unguarded.body.error)).toMatch(/expectedRevision/);
  expect(registry.conversation(id)!.migration?.phase).toBe("waiting-turn");

  const cancelled = await applyConversationMigration({ conversationId: id, action: "cancel", expectedRevision: revision }, dependencies);
  expect(cancelled).toMatchObject({ status: 200, body: { cancel: "cancelled" } });
  expect(registry.conversation(id)!.migration?.phase).toBe("rolled-back");
  expect(String(registry.conversation(id)!.reconfigure?.status)).toBe("cancelled");
  expect(kicks).toHaveLength(1);
  /* The same cancel again, from a page that did not see the first: the switch is cancelled, and nothing is written twice. */
  const before = registry.snapshot();
  const again = await applyConversationMigration({ conversationId: id, action: "cancel", expectedRevision: revision }, dependencies);
  expect(again).toMatchObject({ status: 200, body: { cancel: "replayed" } });
  expect(registry.snapshot().conversations[id]).toEqual(before.conversations[id]);
  expect(failedDeliveries(fixture)).toEqual([]);
});

test("a cancel of a switch that ended without one is refused as no longer pending, never as started", async () => {
  const fixture = await pendingSwitch();
  const { registry, id } = fixture;
  const revision = registry.conversation(id)!.migration!.revision;
  /* A newer switch back to the source retired it: rolled back, and not by a cancel. */
  await fixture.apply({ ...fixture.effect, operationId: "reconfigure-back-to-a", accountId: "account-a", eventSeq: 8 });
  expect(registry.conversation(id)!.migration?.phase).toBe("rolled-back");

  const answer = await applyConversationMigration({ conversationId: id, action: "cancel", expectedRevision: revision }, { registry: () => registry, kick: () => {} } as never);
  expect(answer).toMatchObject({ status: 409, body: { code: "SWITCH_NOT_PENDING" } });
});

test("a committed cancel answers cancelled even when kicking the queue or delivering what it re-armed throws", async () => {
  const fixture = await pendingSwitch();
  const { registry, id } = fixture;
  const answer = await applyConversationMigration({ conversationId: id, action: "cancel", expectedRevision: registry.conversation(id)!.migration!.revision }, {
    registry: () => registry,
    kick: () => { throw new Error("runtime host socket closed"); },
    deliveryPort: { deliver: async () => { throw new Error("delivery port unavailable"); } },
  } as never);
  expect(answer).toMatchObject({ status: 200, body: { cancel: "cancelled" } });
  expect(registry.conversation(id)!.migration?.phase).toBe("rolled-back");
});

test("the migration route withdraws a queued switch only after reading it from the runtime journal", async () => {
  const fixture = await pendingSwitch({ claim: false });
  const { registry, id } = fixture;
  const receipt = (status: string, over: Record<string, unknown> = {}) => ({ operationId: fixture.effect.operationId, replayed: false, receipt: { operationId: fixture.effect.operationId, idempotencyKey: fixture.effect.operationId, conversationId: id, kind: "reconfigure", status, at: "2026-07-21T10:00:20.000Z", revision: 1, ...over } });
  const kicks: number[] = [];
  const route = (read: unknown) => applyConversationMigration({ conversationId: id, action: "withdraw", operationId: fixture.effect.operationId }, {
    registry: () => registry,
    kick: () => { kicks.push(1); },
    operationStatus: async () => read,
  } as never);

  expect(await route("unreadable")).toMatchObject({ status: 503, body: { code: "RUNTIME_UNREADABLE" } });
  expect(await route(null)).toMatchObject({ status: 404 });
  expect(await route(receipt("queued", { kind: "send" }))).toMatchObject({ status: 404 });
  expect(await route(receipt("failed"))).toMatchObject({ status: 409, body: { code: "SWITCH_SETTLED" } });
  expect(registry.reconfigureCancelled(id, fixture.effect.operationId)).toBe(false);

  expect(await route(receipt("queued"))).toMatchObject({ status: 200, body: { withdraw: "withdrawn" } });
  expect(await route(receipt("queued"))).toMatchObject({ status: 200, body: { withdraw: "replayed" } });
  expect(kicks).toHaveLength(2);
  expect(registry.reconfigureCancelled(id, fixture.effect.operationId)).toBe(true);
  await expect(fixture.apply()).rejects.toThrow(/cancel/);
  /* The queue has failed the withdrawn operation; the same withdrawal again still answers that it is cancelled. */
  expect(await route(receipt("failed", { reason: "cancelled" }))).toMatchObject({ status: 200, body: { withdraw: "replayed" } });
});

test("a withdrawal of a switch the queue already claimed is refused with the migration's revision to cancel it by", async () => {
  const fixture = await pendingSwitch();
  const { registry, id } = fixture;
  const answer = await applyConversationMigration({ conversationId: id, action: "withdraw", operationId: fixture.effect.operationId }, {
    registry: () => registry,
    kick: () => {},
    operationStatus: async () => ({ operationId: fixture.effect.operationId, replayed: false, receipt: { operationId: fixture.effect.operationId, idempotencyKey: fixture.effect.operationId, conversationId: id, kind: "reconfigure", status: "queued", at: "2026-07-21T10:00:20.000Z", revision: 1 } }),
  } as never);
  expect(answer).toMatchObject({ status: 409, body: { code: "SWITCH_CLAIMED", expectedRevision: registry.conversation(id)!.migration!.revision } });
  expect(registry.conversation(id)!.migration?.phase).toBe("waiting-turn");
  expect(registry.reconfigureCancelled(id, fixture.effect.operationId)).toBe(false);
});

test("a rollback through the route of a reconfigure-owned switch still waiting for its turn is the cancel: the queue's retry stays rolled back", async () => {
  const fixture = await pendingSwitch();
  const { registry, id } = fixture;
  const answer = await applyConversationMigration({ conversationId: id, action: "rollback", expectedRevision: registry.conversation(id)!.migration!.revision }, {
    registry: () => registry,
    kick: () => {},
    deliveryPort: { deliver: async () => "held" as const },
  } as never);
  expect(answer.status).toBe(200);
  await expect(fixture.apply()).rejects.toThrow(/cancel/);
  expect(registry.conversation(id)!.migration?.phase).toBe("rolled-back");
  expect(registry.conversation(id)!.generations.at(-1)?.accountId).toBe("account-a");
});

test("a newer switch that fails before it creates a migration gives back the deliveries it kept held, payload intact", async () => {
  const fixture = await pendingSwitch();
  const { registry, id } = fixture;
  const held = delivery(fixture, fixture.deliveries.held!.id);
  const failing = applyStructuredReconfigure({ ...fixture.effect, operationId: "reconfigure-to-signed-out", accountId: "account-c", eventSeq: 8 }, {
    registry,
    validateAccount: async () => { throw new Error("claude account requires authentication"); },
    resolveAccount: (() => ({})) as never,
    releaseHost: async () => true,
    recover: (async () => true) as never,
  });
  await expect(failing).rejects.toThrow(/authentication/);
  const after = registry.conversation(id)!;
  expect(after.reconfigure?.status).toBe("failed");
  const rearmed = delivery(fixture, held.id);
  expect({ state: rearmed.state, generationId: rearmed.generationId, text: rearmed.text, operationId: rearmed.command.operationId })
    .toEqual({ state: "assigned", generationId: fixture.sourceGenerationId, text: held.text, operationId: held.command.operationId });
  expect(failedDeliveries(fixture)).toEqual([]);
});

type MutableRegistry = { mutate<T>(fn: (file: RegistryFile) => T): T };

/** One pass of what runs on its own while nobody acts: the migration tick, then the reaper's delivery hygiene. */
async function migrationTickAndReaper(registry: AgentRegistry, port: HeldDeliveryPort = { deliver: async () => "held" }): Promise<void> {
  await reconcileMigrations(successorProvider(path.join(sandbox, "tick-never.jsonl")), port, registry, {
    remapBoardPaths: (project) => boardFor(project),
    transferBoardPathPlacements: () => {},
  });
  terminalizeStaleUndeliverableHeldDeliveries(registry);
}

test("a held record from before fencedBy existed, admitted after the switch's own intent began, is re-armed by its cancel", async () => {
  const fixture = await pendingSwitch();
  const { registry, id } = fixture;
  const heldId = fixture.deliveries.held!.id;
  const intentId = registry.conversation(id)!.migration!.intentId;
  /* The legacy row: no owner recorded, admitted a second after the switch's conversation intent began. */
  (registry as unknown as MutableRegistry).mutate((file) => {
    const row = file.heldDeliveries[heldId]!;
    delete row.fencedBy;
    row.createdAt = new Date(Date.parse(file.migrationIntents[intentId]!.createdAt) + 1000).toISOString();
  });
  registry.cancelConversationSwitch(id, registry.conversation(id)!.migration!.revision);
  expect(delivery(fixture, heldId)).toMatchObject({ state: "assigned", text: fixture.deliveries.held!.text });
});

test("a held record whose owner cannot be proven is left as it is by the cancel, the migration tick and the reaper", async () => {
  const fixture = await pendingSwitch();
  const { registry, id } = fixture;
  const heldId = fixture.deliveries.held!.id;
  const intentId = registry.conversation(id)!.migration!.intentId;
  /* A legacy row admitted before the switch's intent began could have been held by an earlier migration. */
  (registry as unknown as MutableRegistry).mutate((file) => {
    const row = file.heldDeliveries[heldId]!;
    delete row.fencedBy;
    row.createdAt = new Date(Date.parse(file.migrationIntents[intentId]!.createdAt) - 1000).toISOString();
  });
  const legacy = delivery(fixture, heldId);
  registry.cancelConversationSwitch(id, registry.conversation(id)!.migration!.revision);
  await migrationTickAndReaper(registry);
  expect(delivery(fixture, heldId)).toEqual(legacy);
});

test("a held delivery fenced by another operation is not the cancelled switch's: the cancel, the migration tick and the reaper leave it as it is", async () => {
  const fixture = await pendingSwitch();
  const { registry, id } = fixture;
  const heldId = fixture.deliveries.held!.id;
  (registry as unknown as MutableRegistry).mutate((file) => { file.heldDeliveries[heldId]!.fencedBy = "another-switch"; });
  const foreign = delivery(fixture, heldId);
  registry.cancelConversationSwitch(id, registry.conversation(id)!.migration!.revision);
  expect(delivery(fixture, heldId)).toEqual(foreign);
  await migrationTickAndReaper(registry);
  expect(delivery(fixture, heldId)).toEqual(foreign);
});

for (const answer of ["held", "delivery-uncertain"] as const) {
  test(`after a cancel through the route whose drain answers ${answer}, the migration tick and the reaper keep the deliveries from before the switch and the re-armed one`, async () => {
    const fixture = await pendingSwitch();
    const { registry, id } = fixture;
    const port: HeldDeliveryPort = { deliver: async () => answer };
    const cancelled = await applyConversationMigration(
      { conversationId: id, action: "cancel", expectedRevision: registry.conversation(id)!.migration!.revision },
      { registry: () => registry, kick: () => {}, deliveryPort: port } as never,
    );
    expect(cancelled.status).toBe(200);
    const settled = (deliveryId: string): { state: string; text: string } => {
      const row = delivery(fixture, deliveryId);
      return { state: row.state, text: row.text };
    };
    /* What the route's own drain left: an attempt answered `held` goes back to assigned, one answered uncertain stays uncertain. */
    const expected = {
      before: { state: answer === "held" ? "assigned" : "delivery-uncertain", text: fixture.deliveries.before.text },
      uncertain: { state: "delivery-uncertain", text: fixture.deliveries.uncertain.text },
      held: { state: answer === "held" ? "assigned" : "delivery-uncertain", text: fixture.deliveries.held!.text },
    };
    const now = () => ({ before: settled(fixture.deliveries.before.id), uncertain: settled(fixture.deliveries.uncertain.id), held: settled(fixture.deliveries.held!.id) });
    expect(now()).toEqual(expected);

    await migrationTickAndReaper(registry, port);
    await migrationTickAndReaper(registry, port);

    expect(now()).toEqual(expected);
    expect(failedDeliveries(fixture)).toEqual([]);
  });
}

/** Starts a switch to account C that claims, then waits in its account check until `release` is called. */
function switchToCStoppedBeforeItsMigration(fixture: PendingSwitch) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let claimed!: () => void;
  const reachedCheck = new Promise<void>((resolve) => { claimed = resolve; });
  const root = path.dirname(fixture.registryFile);
  const running = applyStructuredReconfigure({ ...fixture.effect, operationId: "reconfigure-to-c", accountId: "account-c", eventSeq: 8 }, {
    registry: fixture.registry,
    validateAccount: async () => { claimed(); await gate; },
    resolveAccount: ((engine: string, accountId: string) => ({ accountId, home: root, engine })) as never,
    releaseHost: async () => true,
    recover: (async () => true) as never,
    migrate: (conversationId, _target, store, ownsOperation, reconfigureOperationId) =>
      advanceConversationMigration(conversationId, store, successorProvider(path.join(root, "successor.jsonl")), { ownsOperation, reconfigureOperationId, deferBoardRepair: true }),
  });
  return { running, reachedCheck, release };
}

for (const restart of [false, true]) {
  test(`a switch to a third account keeps the held delivery through the migration tick${restart ? ", a registry reload" : ""} and the reaper, until the migration it creates adopts it`, async () => {
    const fixture = await pendingSwitch();
    const { id } = fixture;
    const held = delivery(fixture, fixture.deliveries.held!.id);
    const toC = switchToCStoppedBeforeItsMigration(fixture);
    await toC.reachedCheck;
    /* The gap: B's migration is rolled back and C has none yet. */
    expect(fixture.registry.conversation(id)!.migration).toMatchObject({ phase: "rolled-back", targetId: "account-b" });
    expect(fixture.registry.conversation(id)!.reconfigure).toMatchObject({ operationId: "reconfigure-to-c", status: "applying", keepsHeldFrom: held.fencedBy });

    const during = restart ? new AgentRegistry(fixture.registryFile) : fixture.registry;
    /* A withdrawal of C now is too late, and B's retired migration is no revision to cancel C by. */
    const withdrawn = await applyConversationMigration({ conversationId: id, action: "withdraw", operationId: "reconfigure-to-c" }, {
      registry: () => during,
      kick: () => {},
      operationStatus: async () => ({ operationId: "reconfigure-to-c", replayed: false, receipt: { operationId: "reconfigure-to-c", idempotencyKey: "reconfigure-to-c", conversationId: id, kind: "reconfigure", status: "applying", at: "2026-07-21T10:00:40.000Z", revision: 2 } }),
    } as never);
    expect(withdrawn).toMatchObject({ status: 409, body: { code: "SWITCH_CLAIMED", expectedRevision: null } });
    await migrationTickAndReaper(during);
    await migrationTickAndReaper(during);
    expect(delivery({ ...fixture, registry: during }, held.id)).toEqual(held);

    toC.release();
    expect(await toC.running).toBe("pending");
    const after = fixture.registry.conversation(id)!;
    expect(after.migration).toMatchObject({ phase: "waiting-turn", targetId: "account-c" });
    expect(after.reconfigure?.keepsHeldFrom).toBeUndefined();
    const adopted = delivery(fixture, held.id);
    expect({ state: adopted.state, text: adopted.text, operationId: adopted.command.operationId, fencedBy: adopted.fencedBy })
      .toEqual({ state: "held", text: held.text, operationId: held.command.operationId, fencedBy: after.migration!.operationId });
    expect(failedDeliveries(fixture)).toEqual([]);
  });
}

test("a retry that gives the migration a new operation identity keeps the delivery the failed attempt held", async () => {
  const fixture = await pendingSwitch();
  const { registry, id } = fixture;
  const held = delivery(fixture, fixture.deliveries.held!.id);
  const failed = registry.conversation(id)!.migration!;
  /* The attempt failed recoverably, and its intent moved on to a new revision: the retry mints a new operation. */
  (registry as unknown as MutableRegistry).mutate((file) => {
    file.conversations[id]!.migration = { ...failed, phase: "failed-recoverable" };
    file.migrationIntents[failed.intentId]!.revision += 1;
  });
  const retried = registry.retryConversationMigration(id).migration!;
  expect(retried.operationId).not.toBe(failed.operationId);
  expect(delivery(fixture, held.id)).toMatchObject({ state: "held", text: held.text, fencedBy: retried.operationId });
});

test("the coordinator does not advance a cancelled switch", async () => {
  const fixture = await pendingSwitch();
  const { registry, id } = fixture;
  registry.cancelConversationSwitch(id, registry.conversation(id)!.migration!.revision);
  const advanced = await advanceConversationMigration(id, registry, successorProvider(path.join(sandbox, "never.jsonl")), { deferBoardRepair: true }).catch((error: unknown) => error);
  const after = registry.conversation(id)!;
  expect(after.migration?.phase).toBe("rolled-back");
  expect(after.generations.at(-1)?.accountId).toBe("account-a");
  expect(fs.existsSync(path.join(sandbox, "never.jsonl"))).toBe(false);
  void advanced;
});

test("withdrawals are remembered per conversation, bounded, and survive a registry reload", async () => {
  const fixture = await pendingSwitch({ claim: false });
  const { registry, id } = fixture;
  for (let index = 0; index < 25; index += 1) registry.withdrawConversationReconfigure(id, `withdrawn-${index}`);
  const conversation = new AgentRegistry(fixture.registryFile).conversation(id)!;
  expect(conversation.reconfigureWithdrawals?.length).toBe(20);
  expect(conversation.reconfigureWithdrawals?.at(-1)?.operationId).toBe("withdrawn-24");
  const reloaded = new AgentRegistry(fixture.registryFile);
  expect(reloaded.reconfigureCancelled(id, "withdrawn-24")).toBe(true);
  expect(reloaded.reconfigureCancelled(id, "withdrawn-0")).toBe(false);
});
