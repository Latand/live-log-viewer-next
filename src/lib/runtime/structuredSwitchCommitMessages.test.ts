import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Database } from "bun:sqlite";
import { afterAll, afterEach, expect, setSystemTime, spyOn, test } from "bun:test";

import { advanceConversationMigration, drainHeldDeliveries, reconcileMigrations, type HeldDeliveryPort } from "@/lib/accounts/migration/coordinator";
import { emptyLaunchProfile, type HeldDelivery, type HeldDeliveryCommandInput, type ProviderReceipt, type SuccessorProviderPort } from "@/lib/accounts/migration/contracts";
import { AgentRegistry, compareDeliveryAdmission, type RegistryConversation, type RegistryFile } from "@/lib/agent/registry";
import type { SessionKey } from "@/lib/agent/sessionKey";
import { boardFor, setBoardFileForTests } from "@/lib/board/store";
import { procBackend } from "@/lib/proc";
import { RuntimeJournal } from "@/runtime-host/journal";

import type { RuntimeHostClient } from "./client";
import type { RuntimeSnapshot } from "./contracts";
import { sendReceiptFor } from "./sendSettlement";
import { structuredContent } from "./structuredContent";
import type { StructuredReconfigureEffect } from "./structuredDeliveryQueue";
import { enqueueStructuredMessage } from "./structuredMessageDelivery";
import { applyStructuredReconfigure } from "./structuredReconfigure";

/*
 * Messages across a SUCCESSFUL account switch (#1695 K6c, #1709), the contract
 * of `evidence/issue-1695/k6c-plan.md`. The first cases were written before the
 * fix and failed on main f1396da9, where a committing switch failed and emptied
 * every pending delivery of the conversation. Isolated registry, board and
 * runtime journal files; no host, runtime socket or account is touched.
 */

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-switch-commit-messages-"));
let caseNumber = 0;

afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));
afterEach(() => setSystemTime());

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


interface Switch {
  registry: AgentRegistry;
  id: RegistryConversation["id"];
  sourcePath: string;
  sourceKey: SessionKey;
  successorPath: string;
  effect: StructuredReconfigureEffect;
  apply: () => Promise<"applied" | "pending">;
}

/** A switch to account B requested while account A's turn runs, before any delivery is admitted. */
async function switchWaitingForTurn(beforeSwitch: (registry: AgentRegistry, id: RegistryConversation["id"], sourceGenerationId: string) => void = () => {}): Promise<Switch> {
  const root = path.join(sandbox, `case-${caseNumber += 1}`);
  fs.mkdirSync(root);
  setBoardFileForTests(path.join(root, "board.json"));
  const registry = new AgentRegistry(path.join(root, "registry.json"));
  const sourcePath = path.join(root, "source.jsonl");
  const successorPath = path.join(root, "successor.jsonl");
  claudeTranscript(sourcePath);
  registry.reconcileConversations([{
    engine: "claude", path: sourcePath, accountId: "account-a",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "busy", source: "assistant", terminalAt: null }, observedAt: "2026-07-21T10:00:10.000Z",
  }]);
  const admitted = registry.conversationForPath(sourcePath)!;
  const source = admitted.generations.at(-1)!;
  const sourceKey: SessionKey = { engine: "claude", sessionId: source.id };
  recordStructuredHost(registry, sourceKey, sourcePath, "account-a", "turn-source");
  beforeSwitch(registry, admitted.id, source.id);
  const effect: StructuredReconfigureEffect = { operationId: "reconfigure-to-b", conversationId: admitted.id, kind: "reconfigure", model: "claude-opus-5", effort: "high", fast: false, accountId: "account-b", eventSeq: 7 };
  const apply = () => applyStructuredReconfigure(effect, {
    registry,
    validateAccount: async () => {},
    resolveAccount: ((engine: string, accountId: string) => ({ accountId, home: root, engine })) as never,
    releaseHost: async () => true,
    recover: (async () => true) as never,
    migrate: (conversationId, _target, store, ownsOperation, reconfigureOperationId) =>
      advanceConversationMigration(conversationId, store, successorProvider(successorPath), { ownsOperation, reconfigureOperationId, deferBoardRepair: true }),
  });
  expect(await apply()).toBe("pending");
  expect(registry.conversation(admitted.id)!.migration?.phase).toBe("waiting-turn");
  return { registry, id: admitted.id, sourcePath, sourceKey, successorPath, effect, apply };
}

/** The source's turn ends; the queue runs the switch again, and it commits on account B. */
async function turnEndsAndSwitchCommits(fixture: Switch): Promise<RegistryConversation> {
  recordStructuredHost(fixture.registry, fixture.sourceKey, fixture.sourcePath, "account-a", null);
  fixture.registry.reconcileConversations([{
    engine: "claude", path: fixture.sourcePath, accountId: "account-a",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "assistant", terminalAt: "2026-07-21T10:00:26.000Z" }, observedAt: "2026-07-21T10:00:30.000Z",
  }] as never);
  expect(await fixture.apply()).toBe("applied");
  const committed = fixture.registry.conversation(fixture.id)!;
  expect(committed.migration?.phase).toBe("committed");
  expect(committed.generations.at(-1)).toMatchObject({ accountId: "account-b", path: fixture.successorPath });
  return committed;
}

/** A delivery port that records what it is handed and confirms each delivery. */
function recordingPort() {
  const handed: Array<{ id: string; text: string; path: string; operationId: string }> = [];
  const port: HeldDeliveryPort = {
    deliver: async ({ delivery, path: target }) => {
      handed.push({ id: delivery.id, text: delivery.text, path: target, operationId: delivery.command.operationId });
      return "delivered";
    },
  };
  return { port, handed };
}

const snapshotOf = (fixture: Switch, id: string) => structuredClone(fixture.registry.snapshot().heldDeliveries[id]!);


type MutableRegistry = { mutate<T>(fn: (file: RegistryFile) => T): T };
const mutate = <T>(registry: AgentRegistry, fn: (file: RegistryFile) => T): T => (registry as unknown as MutableRegistry).mutate(fn);

/** The migration tick: one ordinary `reconcileMigrations` pass. */
async function migrationTick(fixture: Switch, port: HeldDeliveryPort): Promise<void> {
  await reconcileMigrations(successorProvider(path.join(sandbox, "tick-never.jsonl")), port, fixture.registry, {
    remapBoardPaths: (project) => boardFor(project),
    transferBoardPathPlacements: () => {},
  });
}

const send = (registry: AgentRegistry, id: RegistryConversation["id"], text: string, key: string, command: HeldDeliveryCommandInput = {}, payloadKind: HeldDelivery["payloadKind"] = "text") =>
  registry.holdDelivery(id, text, key, payloadKind, [], structuredContent(text, []).contentDigest, command);

/** What a carried delivery must keep: everything but where and when it is assigned. */
const carriedPart = (delivery: HeldDelivery) => ({
  text: delivery.text,
  clientMessageId: delivery.clientMessageId,
  command: delivery.command,
  requestDigest: delivery.requestDigest,
  contentDigest: delivery.contentDigest,
  payloadKind: delivery.payloadKind,
  runtimeImages: delivery.runtimeImages,
  attempts: delivery.attempts,
  admissionSeq: delivery.admissionSeq,
  createdAt: delivery.createdAt,
});

test("never-attempted messages sent before and while the switch waited reach the successor once, in the order they were sent, through the ordinary migration tick", async () => {
  let before: HeldDelivery | null = null;
  const fixture = await switchWaitingForTurn((registry, id) => {
    before = send(registry, id, "sent before the switch", "before-switch");
  });
  const held = send(fixture.registry, fixture.id, "sent while the switch waits", "during-switch");
  const heldToo = send(fixture.registry, fixture.id, "and another one", "during-switch-2");
  expect([before!.state, held.state, heldToo.state]).toEqual(["assigned", "held", "held"]);
  const admitted = [before!, held, heldToo].map((delivery) => snapshotOf(fixture, delivery.id));
  expect(admitted.map((delivery) => delivery.admissionSeq)).toEqual([1, 2, 3]);

  const committed = await turnEndsAndSwitchCommits(fixture);
  const successorId = committed.generations.at(-1)!.id;
  for (const original of admitted) {
    const carried = snapshotOf(fixture, original.id);
    expect({ state: carried.state, generationId: carried.generationId, fencedBy: carried.fencedBy ?? null, ...carriedPart(carried) })
      .toEqual({ state: "assigned", generationId: successorId, fencedBy: null, ...carriedPart(original) });
    expect(fixture.registry.snapshot().deliveryOperationOwners[original.command.operationId]).toMatchObject({ terminalState: null, terminalDisposition: null });
  }

  const { port, handed } = recordingPort();
  await migrationTick(fixture, port);
  const settledAt = admitted.map((delivery) => fixture.registry.snapshot().deliveryOperationOwners[delivery.command.operationId]!.settledAt);
  await migrationTick(fixture, port);
  expect(handed).toEqual(admitted.map((delivery) => ({ id: delivery.id, text: delivery.text, path: fixture.successorPath, operationId: delivery.command.operationId })));
  for (const [index, delivery] of admitted.entries()) {
    expect(snapshotOf(fixture, delivery.id).state).toBe("delivered");
    const owner = fixture.registry.snapshot().deliveryOperationOwners[delivery.command.operationId]!;
    expect({ terminalState: owner.terminalState, terminalDisposition: owner.terminalDisposition, settledAt: owner.settledAt })
      .toEqual({ terminalState: "delivered", terminalDisposition: "delivered", settledAt: settledAt[index] });
  }
});

test("messages the switch owns but does not carry end failed with their payload kept, and their receipts say whether sending again is safe", async () => {
  const rows: Record<string, HeldDelivery> = {};
  const fixture = await switchWaitingForTurn((registry, id) => {
    rows.turn = send(registry, id, "answer inside the source turn", "turn-bound", { turnId: "turn-source", policy: "queue" });
    rows.interrupt = send(registry, id, "interrupt that turn, then answer", "interrupt-bound", { turnId: "turn-source", policy: "interrupt-active" });
    rows.inject = send(registry, id, "context for the source thread", "injected", { kind: "inject" });
    rows.requestLocal = registry.holdDelivery(id, "", "request-local", "ephemeral-images");
  });
  rows.attempted = send(fixture.registry, fixture.id, "held again after an attempt", "attempted-then-held");
  /* The record of an earlier attempt, as a retry placement leaves it: held again with attempts > 0. */
  mutate(fixture.registry, (file) => { file.heldDeliveries[rows.attempted!.id]!.attempts = 1; });
  const before = Object.fromEntries(Object.entries(rows).map(([name, delivery]) => [name, snapshotOf(fixture, delivery.id)]));

  await turnEndsAndSwitchCommits(fixture);
  const file = fixture.registry.snapshot();
  const outcome = (name: string) => {
    const delivery = file.heldDeliveries[before[name]!.id]!;
    const receipt = sendReceiptFor(file, delivery.command.operationId)!;
    return { state: delivery.state, text: delivery.text, error: delivery.error, resend: receipt.resend, duplicateRisk: receipt.duplicateRisk };
  };
  expect(outcome("attempted")).toMatchObject({ state: "failed", text: "held again after an attempt", error: expect.stringContaining("may have reached the previous account"), resend: "verify-first", duplicateRisk: true });
  expect(outcome("turn")).toMatchObject({ state: "failed", text: "answer inside the source turn", error: expect.stringContaining("bound to the previous account's turn"), resend: "safe", duplicateRisk: false });
  expect(outcome("inject")).toMatchObject({ state: "failed", text: "context for the source thread", error: expect.stringContaining("injected context"), resend: "safe", duplicateRisk: false });
  expect(outcome("requestLocal")).toMatchObject({ state: "failed", error: expect.stringContaining("held only by the client that sent it"), resend: "safe", duplicateRisk: false });
  for (const name of ["attempted", "turn", "inject", "requestLocal"]) {
    const kept = file.heldDeliveries[before[name]!.id]!;
    expect(carriedPart(kept)).toEqual(carriedPart(before[name]!));
  }
  /* A turn id under interrupt-active only names what to interrupt; the message itself is carried. */
  expect(file.heldDeliveries[before.interrupt!.id]).toMatchObject({ state: "assigned", command: { turnId: "turn-source", policy: "interrupt-active" } });

  const { port, handed } = recordingPort();
  await migrationTick(fixture, port);
  await migrationTick(fixture, port);
  expect(handed.map((item) => item.id)).toEqual([before.interrupt!.id]);
  for (const name of ["attempted", "turn", "inject", "requestLocal"]) expect(snapshotOf(fixture, before[name]!.id).state).toBe("failed");
});

test("deliveries the committing switch cannot prove it owns stay exactly as they are", async () => {
  const rows: Record<string, HeldDelivery> = {};
  const fixture = await switchWaitingForTurn((registry, id) => {
    rows.olderGeneration = send(registry, id, "assigned to an older generation", "older-generation");
    rows.settledOwner = send(registry, id, "its operation already has an answer", "settled-owner");
  });
  rows.foreign = send(fixture.registry, fixture.id, "fenced by another switch", "foreign-fence");
  rows.legacy = send(fixture.registry, fixture.id, "held before fences existed", "legacy-hold");
  const intentId = fixture.registry.conversation(fixture.id)!.migration!.intentId;
  mutate(fixture.registry, (file) => {
    file.heldDeliveries[rows.olderGeneration!.id]!.generationId = "older-generation";
    file.heldDeliveries[rows.foreign!.id]!.fencedBy = "another-switch";
    const legacy = file.heldDeliveries[rows.legacy!.id]!;
    delete legacy.fencedBy;
    legacy.createdAt = new Date(Date.parse(file.migrationIntents[intentId]!.createdAt) - 1000).toISOString();
    const owner = file.deliveryOperationOwners[rows.settledOwner!.command.operationId]!;
    Object.assign(owner, { terminalState: "failed", terminalDisposition: "lost", terminalReason: "settled elsewhere", settledAt: "2026-07-21T10:00:20.000Z" });
  });
  const before = Object.fromEntries(Object.entries(rows).map(([name, delivery]) => [name, snapshotOf(fixture, delivery.id)]));

  await turnEndsAndSwitchCommits(fixture);
  const { port, handed } = recordingPort();
  await migrationTick(fixture, port);
  for (const name of Object.keys(rows)) expect(snapshotOf(fixture, before[name]!.id)).toEqual(before[name]!);
  expect(handed).toEqual([]);
});

test("explicit recovery of a message that was not carried follows its receipt: a never-attempted one is re-armed under its own key, a possibly delivered one is not, and a new key is a new send", async () => {
  let turnBound: HeldDelivery | null = null;
  const fixture = await switchWaitingForTurn((registry, id) => {
    turnBound = send(registry, id, "answer inside the source turn", "turn-bound", { turnId: "turn-source", policy: "queue" });
  });
  const attempted = send(fixture.registry, fixture.id, "held again after an attempt", "attempted-then-held");
  mutate(fixture.registry, (file) => { file.heldDeliveries[attempted.id]!.attempts = 1; });
  await turnEndsAndSwitchCommits(fixture);
  const successorId = fixture.registry.conversation(fixture.id)!.generations.at(-1)!.id;

  /* Never attempted (`lost`, resend "safe"): the same key and payload again re-arm the same record and operation. */
  const again = send(fixture.registry, fixture.id, "answer inside the source turn", "turn-bound", { turnId: "turn-source", policy: "queue" });
  expect({ id: again.id, state: again.state, generationId: again.generationId, operationId: again.command.operationId, error: again.error })
    .toEqual({ id: turnBound!.id, state: "assigned", generationId: successorId, operationId: turnBound!.command.operationId, error: null });

  /* Possibly delivered (`unverified`, resend "verify-first"): the same key and payload change nothing. */
  const replay = send(fixture.registry, fixture.id, "held again after an attempt", "attempted-then-held");
  expect({ id: replay.id, state: replay.state }).toEqual({ id: attempted.id, state: "failed" });
  expect(sendReceiptFor(fixture.registry.snapshot(), attempted.command.operationId)).toMatchObject({ state: "failed", resend: "verify-first" });

  /* A new key is a new message, admitted after everything before it. */
  const fresh = send(fixture.registry, fixture.id, "held again after an attempt", "fresh-key");
  expect(fresh.id).not.toBe(attempted.id);
  expect(fresh).toMatchObject({ state: "assigned", attempts: 0 });
  expect(compareDeliveryAdmission(snapshotOf(fixture, again.id), snapshotOf(fixture, fresh.id))).toBeLessThan(0);
});

test("admissions in the same millisecond keep their order, and records without a sequence order first, by time", async () => {
  const fixture = await switchWaitingForTurn();
  setSystemTime(new Date("2026-07-21T10:00:15.000Z"));
  /* Descending ids, so an order by id alone would reverse them. Assembled from parts: no identifier literal. */
  const ids = ["3", "2", "1"].map((last) => ["ffffffff", "ffff", "4fff", "8fff", `fffffffffff${last}`].join("-"));
  const uuid = spyOn(crypto, "randomUUID").mockImplementation(() => ids.shift() as `${string}-${string}-${string}-${string}-${string}`);
  let admitted: HeldDelivery[];
  try {
    admitted = ["first", "second", "third"].map((text) => send(fixture.registry, fixture.id, text, `same-ms-${text}`));
  } finally {
    uuid.mockRestore();
  }
  expect(new Set(admitted.map((delivery) => snapshotOf(fixture, delivery.id).createdAt)).size).toBe(1);
  expect(fixture.registry.pendingDeliveries(fixture.id).map((delivery) => delivery.text)).toEqual(["first", "second", "third"]);

  /* Two records written before the sequence existed, the later one first in time order. */
  const legacyLate = send(fixture.registry, fixture.id, "legacy, admitted second", "legacy-late");
  const legacyEarly = send(fixture.registry, fixture.id, "legacy, admitted first", "legacy-early");
  mutate(fixture.registry, (file) => {
    for (const [id, at] of [[legacyLate.id, "2026-07-21T10:00:12.000Z"], [legacyEarly.id, "2026-07-21T10:00:11.000Z"]] as const) {
      delete file.heldDeliveries[id]!.admissionSeq;
      file.heldDeliveries[id]!.createdAt = at;
    }
  });
  expect(fixture.registry.pendingDeliveries(fixture.id).map((delivery) => delivery.text))
    .toEqual(["legacy, admitted first", "legacy, admitted second", "first", "second", "third"]);
});

test("an attempt is refused while an earlier admission waits in the same generation, and nothing else gates it", async () => {
  const fixture = await switchWaitingForTurn();
  await turnEndsAndSwitchCommits(fixture);
  const generationId = fixture.registry.conversation(fixture.id)!.generations.at(-1)!.id;
  const earlier = send(fixture.registry, fixture.id, "admitted first", "gate-earlier");
  const later = send(fixture.registry, fixture.id, "admitted second", "gate-later");
  const otherGeneration = send(fixture.registry, fixture.id, "assigned to an older generation", "gate-older");
  const legacyHeld = send(fixture.registry, fixture.id, "held with an unproven owner", "gate-held");
  mutate(fixture.registry, (file) => {
    Object.assign(file.heldDeliveries[otherGeneration.id]!, { generationId: "older-generation" });
    Object.assign(file.heldDeliveries[legacyHeld.id]!, { state: "held", generationId: null, assignedAt: null });
    /* Without a sequence both order before `later`, so only their state and generation keep them from gating it. */
    delete file.heldDeliveries[otherGeneration.id]!.admissionSeq;
    delete file.heldDeliveries[legacyHeld.id]!.admissionSeq;
  });
  expect(fixture.registry.beginDeliveryAttempt(later.id, generationId)).toBeNull();
  expect(snapshotOf(fixture, later.id)).toMatchObject({ state: "assigned", attempts: 0 });
  expect(fixture.registry.beginDeliveryAttempt(earlier.id, generationId)).toMatchObject({ state: "delivery-uncertain", attempts: 1 });
  /* An earlier admission that has begun its attempt no longer gates the claim; the actuation section orders their commands. */
  expect(fixture.registry.beginDeliveryAttempt(later.id, generationId)).toMatchObject({ state: "delivery-uncertain", attempts: 1 });
});

const CONVERSATION_SESSION = "native-successor";

function journalFor(fixture: Switch): { journal: RuntimeJournal; file: string; order: () => string[] } {
  const file = path.join(path.dirname(fixture.sourcePath), "runtime-journal.sqlite");
  const journal = new RuntimeJournal(file, { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: fixture.id },
    kind: "session-status",
    payload: {
      conversationId: fixture.id,
      sessionKey: { engine: "claude", sessionId: CONVERSATION_SESSION },
      hostKind: "claude-broker",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      artifactPath: fixture.successorPath,
      capabilities: { steer: false, structuredAttention: true },
      activeTurnId: null,
    },
  });
  const order = () => new Database(file, { readonly: true })
    .query<{ operation_id: string }, [string]>("SELECT operation_id FROM operations WHERE conversation_id = ?1 ORDER BY event_seq")
    .all(fixture.id).map((row) => row.operation_id);
  return { journal, file, order };
}

/** A delivery port that admits each delivery to the runtime journal, after `before` resolves. */
function journalPort(journal: RuntimeJournal, before: (delivery: HeldDelivery) => Promise<void> = async () => {}): HeldDeliveryPort {
  return {
    deliver: async ({ delivery, clientMessageId }) => {
      await before(delivery);
      journal.executeOperation({
        kind: "send",
        operationId: delivery.command.operationId,
        idempotencyKey: clientMessageId,
        conversationId: delivery.runtimeConversationId,
        text: delivery.text,
        contentDigest: delivery.contentDigest!,
        policy: delivery.command.policy,
      });
      return "delivered";
    },
  };
}

/** The runtime host client a structured send talks to: the successor hosted and idle, commands admitted to the journal. */
function journalClient(fixture: Switch, journal: RuntimeJournal): RuntimeHostClient {
  const snapshot = (): RuntimeSnapshot => ({
    schemaVersion: 1, snapshotSeq: 1, retentionFloorSeq: 0, serverTime: "2026-07-21T10:01:00.000Z",
    runtime: { hostEpoch: 1, health: "ready" }, filesRevision: 0,
    sessions: [{
      conversationId: fixture.id, sessionKey: { engine: "claude", sessionId: CONVERSATION_SESSION }, hostKind: "claude-broker", host: "hosted", turn: "idle",
      provenance: "structured", revision: 1, attentionIds: [], recentReceipts: [], accountId: "account-b", parentConversationId: null, flowId: null, workflowId: null,
      cwd: "/repo", artifactPath: fixture.successorPath, capabilities: { steer: false, structuredAttention: true }, activeTurnId: null,
    }],
    attentions: [], recentOperations: [], edges: [], flows: [], workflows: [], tasks: [], deployments: [],
  }) as unknown as RuntimeSnapshot;
  return {
    snapshot: async () => snapshot(),
    command: async (command: Parameters<RuntimeJournal["executeOperation"]>[0]) => journal.executeOperation(command),
    operationStatus: async (operationId: string) => journal.operationResult(operationId),
  } as unknown as RuntimeHostClient;
}

const structuredSend = (fixture: Switch, client: RuntimeHostClient, text: string, key: string) => enqueueStructuredMessage({
  path: fixture.successorPath,
  conversationId: fixture.id,
  clientMessageId: key,
  text,
}, {
  enabled: () => true,
  client: () => client,
  registry: () => fixture.registry,
  requestMigrationTick: () => {},
  kick: () => {},
  republish: async () => false,
});

test("a send made after the switch commits, while the carried message still waits, is held behind it and reaches the journal after it", async () => {
  const fixture = await switchWaitingForTurn();
  const carried = send(fixture.registry, fixture.id, "sent while the switch waits", "during-switch");
  await turnEndsAndSwitchCommits(fixture);
  const { journal, order } = journalFor(fixture);

  const later = await structuredSend(fixture, journalClient(fixture, journal), "sent after the switch", "after-switch");
  expect(later).toMatchObject({ ok: true, outcome: "held" });
  expect(order()).toEqual([]);

  await migrationTick(fixture, journalPort(journal));
  const laterRow = fixture.registry.pendingDeliveries(fixture.id).find((delivery) => delivery.clientMessageId === "after-switch")
    ?? Object.values(fixture.registry.snapshot().heldDeliveries).find((delivery) => delivery.clientMessageId === "after-switch")!;
  expect(order()).toEqual([carried.command.operationId, laterRow.command.operationId]);
});

test("an actuator paused between its claim and its journal admission keeps a later send out of the journal until it is admitted", async () => {
  const fixture = await switchWaitingForTurn();
  const carried = send(fixture.registry, fixture.id, "sent while the switch waits", "during-switch");
  await turnEndsAndSwitchCommits(fixture);
  const { journal, order } = journalFor(fixture);

  let resume!: () => void;
  const paused = new Promise<void>((resolve) => { resume = resolve; });
  let claimed!: () => void;
  const reachedPause = new Promise<void>((resolve) => { claimed = resolve; });
  const draining = migrationTick(fixture, journalPort(journal, async () => { claimed(); await paused; }));
  await reachedPause;
  /* The carried message is claimed (uncertain) and not yet in the journal. */
  expect(snapshotOf(fixture, carried.id)).toMatchObject({ state: "delivery-uncertain", attempts: 1 });

  const later = structuredSend(fixture, journalClient(fixture, journal), "sent after the switch", "after-switch");
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(order()).toEqual([]);

  resume();
  await draining;
  expect(await later).toMatchObject({ ok: true });
  const laterRow = Object.values(fixture.registry.snapshot().heldDeliveries).find((delivery) => delivery.clientMessageId === "after-switch")!;
  expect(order()).toEqual([carried.command.operationId, laterRow.command.operationId]);
});
