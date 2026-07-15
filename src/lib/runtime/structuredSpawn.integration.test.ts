import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import type { AccountContext } from "@/lib/accounts/contracts";
import type { ResumeSpec } from "@/lib/agent/cli";
import { AgentRegistry } from "@/lib/agent/registry";
import { spawnResponseForReceipt } from "@/lib/agent/spawnResponse";
import { RuntimeJournal } from "@/runtime-host/journal";

import type { RuntimeHostClient } from "./client";
import type { DeliveryReceipt, HostState, QueueEntry, RuntimeEvent } from "./engineHost";
import { bindStructuredDeliveryQueue, hasStructuredDeliveryHost } from "./structuredDeliveryController";
import { dispatchStructuredControl } from "./structuredControls";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { enqueueStructuredMessage } from "./structuredMessageDelivery";
import { recoverPendingStructuredSpawns, spawnStructuredConversation, structuredClaudePermissionMode, structuredClaudeSpawnPolicyBaseSettingsPath, type SpawnedStructuredHost } from "./structuredSpawn";
import { materializeStructuredTerminal } from "./structuredTerminal";

type UnsequencedEvent = RuntimeEvent extends infer Event
  ? Event extends RuntimeEvent ? Omit<Event, "seq"> : never
  : never;

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-spawn-"));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));
afterEach(async () => { await bindStructuredDeliveryQueue([]); });

test("structured Claude permission mapping distinguishes trusted autonomous spawn paths", () => {
  expect(structuredClaudePermissionMode("bypassPermissions", {
    agentInitiated: true,
    operatorAuthenticated: true,
    roleSpawn: true,
  })).toBe("bypassPermissions");
  expect(structuredClaudePermissionMode("bypassPermissions", {
    agentInitiated: false,
    operatorAuthenticated: false,
    roleSpawn: true,
  })).toBe("bypassPermissions");
  expect(structuredClaudePermissionMode("bypassPermissions", {
    agentInitiated: true,
    operatorAuthenticated: false,
    roleSpawn: true,
  })).toBe("default");
  expect(structuredClaudePermissionMode("bypassPermissions", {
    agentInitiated: false,
    operatorAuthenticated: false,
    roleSpawn: false,
  })).toBe("default");
  expect(structuredClaudePermissionMode("plan", {
    agentInitiated: true,
    operatorAuthenticated: false,
    roleSpawn: true,
  })).toBe("plan");
});

test("structured Claude receipts expose the effective permission mode", () => {
  const store = new AgentRegistry(path.join(sandbox, `permission-receipt-${crypto.randomUUID()}.json`), undefined, undefined, { sqliteMode: "off" });
  const trusted = store.beginSpawnRequest({
    engine: "claude",
    cwd: "/repo",
    transport: "structured",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", permissionMode: "bypassPermissions" }),
  });
  const downgraded = store.beginSpawnRequest({
    engine: "claude",
    cwd: "/repo",
    transport: "structured",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", permissionMode: "default" }),
  });
  if (trusted.kind !== "created" || downgraded.kind !== "created") throw new Error("spawn receipt was unavailable");

  expect(spawnResponseForReceipt(trusted.receipt, null)).toMatchObject({
    state: "starting",
    effectivePermissionMode: "bypassPermissions",
  });
  expect(spawnResponseForReceipt(downgraded.receipt, null)).toMatchObject({
    state: "starting",
    effectivePermissionMode: "default",
  });
});

test("fresh managed Claude structured spawns select the shared settings snapshot", () => {
  const managed = { kind: "managed" } as AccountContext;
  const legacy = { kind: "legacy" } as AccountContext;

  expect(structuredClaudeSpawnPolicyBaseSettingsPath(managed, () => "/shared/claude/settings.json"))
    .toBe("/shared/claude/settings.json");
  expect(structuredClaudeSpawnPolicyBaseSettingsPath(legacy, () => "/shared/claude/settings.json"))
    .toBeNull();
});

function runtimeClient(journal: RuntimeJournal): RuntimeHostClient {
  return {
    snapshot: async () => journal.snapshot(),
    events: async (after) => journal.replay(after),
    waitEvents: async (after) => journal.replay(after),
    append: async (event) => journal.append(event),
    operation: async (event) => journal.append(event),
    command: async (command) => journal.executeOperation(command),
    operationStatus: async (operationId) => journal.operationResult(operationId),
    retryOperation: async (operationId) => journal.retryOperation(operationId),
    producerCursor: async (producerKind, eventKeyPrefix) => journal.producerCursor(producerKind, eventKeyPrefix),
    effectBatch: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (operationId, status, details) => journal.transitionOperation(operationId, status, details),
  } as RuntimeHostClient;
}

class RoundTripHost implements SpawnedStructuredHost {
  readonly sent: QueueEntry[] = [];
  readonly answers: Array<{ id: string; value: unknown }> = [];
  readonly interrupts: string[] = [];
  readonly identity: { threadId: string; path: string } | { sessionId: string };
  private readonly listeners = new Set<(state: HostState) => void>();
  private readonly events: RuntimeEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private cursor = 0;
  private status: HostState["status"] = "idle";
  private activeTurnRef: string | null = null;
  private pendingAttention: string[] = [];
  private released = false;
  releaseCount = 0;

  constructor(readonly engine: "codex" | "claude", readonly artifactPath: string, sessionId: string) {
    this.identity = engine === "codex" ? { threadId: sessionId, path: artifactPath } : { sessionId };
  }

  onStateChange(listener: (state: HostState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  attach(afterSeq: number): AsyncIterable<RuntimeEvent> {
    const isReleased = () => this.released;
    const eventAfter = (cursor: number) => this.events.find((candidate) => candidate.seq > cursor);
    const waitForEvent = () => new Promise<void>((resolve) => this.waiters.add(resolve));
    return {
      async *[Symbol.asyncIterator]() {
        let cursor = afterSeq;
        while (!isReleased()) {
          const event = eventAfter(cursor);
          if (event) {
            cursor = event.seq;
            yield event;
            continue;
          }
          await waitForEvent();
        }
      },
    };
  }

  async send(entry: QueueEntry): Promise<DeliveryReceipt> {
    this.sent.push({ ...entry });
    const turnId = `turn-${this.sent.length}`;
    this.status = "active";
    this.activeTurnRef = turnId;
    this.emit({ kind: "turn-started", turnId });
    this.notify();
    return { outcome: "turn-started", turnId };
  }

  finishTurn(): void {
    const turnId = this.activeTurnRef;
    if (!turnId) return;
    this.status = "idle";
    this.activeTurnRef = null;
    this.emit({ kind: "turn-ended", turnId, status: "completed" });
    this.notify();
  }

  ask(attentionId: string): void {
    this.status = "attention";
    this.pendingAttention = [attentionId];
    this.emit({
      kind: "attention",
      id: attentionId,
      method: this.engine === "codex" ? "item/tool/requestUserInput" : "control_request",
      attention: this.engine === "codex"
        ? { turnId: this.activeTurnRef, questions: [{ id: "scope", header: "Scope", question: "Continue?", options: [{ label: "Yes" }] }] }
        : { tool_name: "AskUserQuestion", input: { questions: [{ header: "Scope", question: "Continue?", options: [{ label: "Yes" }] }] } },
    });
    this.notify();
  }

  async answer(attentionRef: string, value: unknown): Promise<void> {
    this.answers.push({ id: attentionRef, value });
    this.pendingAttention = [];
    this.status = this.activeTurnRef ? "active" : "idle";
    this.emit({ kind: "attention-resolved", id: attentionRef, resolution: "answered" });
    this.notify();
  }

  async interrupt(turnRef: string): Promise<void> {
    this.interrupts.push(turnRef);
    this.activeTurnRef = null;
    this.status = "idle";
    this.emit({ kind: "turn-ended", turnId: turnRef, status: "interrupted" });
    this.notify();
  }

  async health(): Promise<HostState> {
    return {
      status: this.status,
      sessionKey: this.engine === "codex" ? (this.identity as { threadId: string }).threadId : (this.identity as { sessionId: string }).sessionId,
      endpoint: "fake:stdio",
      pid: process.pid,
      processStartIdentity: "test-process",
      eventCursor: this.cursor,
      protocolVersion: "fake-v1",
      activeTurnRef: this.activeTurnRef,
      pendingAttention: [...this.pendingAttention],
      activeFlags: [],
      account: { type: this.engine === "codex" ? "chatgpt" : "claude.ai", planType: "subscription" },
    };
  }

  async release(): Promise<void> {
    this.releaseCount += 1;
    this.released = true;
    this.status = "unhosted";
    this.activeTurnRef = null;
    this.pendingAttention = [];
    this.emit({ kind: "session-status", status: "unhosted" });
    const state = await this.health();
    for (const listener of this.listeners) listener(state);
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  private emit(event: UnsequencedEvent): void {
    this.cursor += 1;
    this.events.push({ ...event, seq: this.cursor } as RuntimeEvent);
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  private notify(): void {
    void this.health().then((state) => {
      for (const listener of this.listeners) listener(state);
    });
  }
}

async function waitFor(assertion: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (assertion()) return;
    await Bun.sleep(5);
  }
  throw new Error("round-trip condition did not settle");
}

async function completesWithin<T>(operation: T | PromiseLike<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 1_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

test("a concurrent structured spawn replay stays pending until durable host setup finishes", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `pending-replay-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const artifactPath = path.join(cwd, `${id}.jsonl`);
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  await bindStructuredDeliveryQueue([], { registry, client });
  const parent = registry.ensureConversation("codex", path.join(cwd, "parent.jsonl"), "codex-subscription");
  const child = registry.ensureConversation("codex", artifactPath, "codex-subscription");
  const request = {
    engine: "codex" as const,
    cwd,
    accountId: "codex-subscription",
    parentConversationId: parent.id,
    conversationId: child.id,
    purpose: "resume-successor" as const,
    launchProfile: emptyLaunchProfile({ cwd, model: "gpt-5.6-luna", parentConversationId: parent.id }),
    clientAttemptId: `attempt_${id}`,
    requestDigest: id.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
  };
  const begun = registry.beginSpawnRequest(request);
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  const host = new RoundTripHost("codex", artifactPath, id);
  const bindReached = deferred();
  const allowBind = deferred();
  const spawning = spawnStructuredConversation({
    engine: "codex",
    receipt: begun.receipt,
    spec: { command: "codex", cwd, windowName: "pending", engine: "codex", transcript: artifactPath, launchProfile: request.launchProfile },
    account: { engine: "codex", accountId: request.accountId, kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } },
    prompt: "initial prompt",
    registry,
    client,
  }, {
    startHost: async () => host,
    bindHost: async (targetRegistry, key, runningHost, claimOwner, claimEpoch) => {
      bindReached.resolve();
      await allowBind.promise;
      const state = await runningHost.health();
      targetRegistry.setStructuredHostClaimed(key, {
        kind: "codex-app-server",
        endpoint: state.endpoint,
        process: { pid: process.pid, startIdentity: "test-process" },
        eventCursor: state.eventCursor,
        protocolVersion: state.protocolVersion,
        writerClaimEpoch: claimEpoch,
        activeTurnRef: state.activeTurnRef,
        pendingAttention: state.pendingAttention,
        activeFlags: state.activeFlags,
      }, "idle", claimOwner, claimEpoch);
      return () => {};
    },
    processIdentity: () => ({ pid: process.pid, startIdentity: "test-process" }),
  });

  await bindReached.promise;
  const replay = registry.beginSpawnRequest(request);
  if (replay.kind !== "replay") throw new Error("concurrent request did not replay");
  const response = spawnResponseForReceipt(replay.receipt, replay.receipt.artifactPath, { structured: true });
  expect(response).toMatchObject({ launched: false, state: "path-pending", path: artifactPath });

  allowBind.resolve();
  await expect(spawning).resolves.toMatchObject({ launched: true, state: "settled", path: artifactPath });
  expect(journal.snapshot().sessions.find((session) => session.conversationId === begun.receipt.conversationId))
    .toMatchObject({ parentConversationId: parent.id });
  expect(journal.snapshot().edges.filter((edge) => edge.childConversationId === begun.receipt.conversationId))
    .toEqual([expect.objectContaining({ parentConversationId: parent.id })]);
});

describe.each(["bind", "publish", "first-message"] as const)("structured spawn %s failure", (barrier) => {
  test("a concurrent replay never observes success", async () => {
    const id = crypto.randomUUID();
    const cwd = path.join(sandbox, `${barrier}-failure-${id}`);
    fs.mkdirSync(cwd, { recursive: true });
    const artifactPath = path.join(cwd, `${id}.jsonl`);
    const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
    const client = runtimeClient(journal);
    await bindStructuredDeliveryQueue([], { registry, client });
    const parent = registry.ensureConversation("codex", path.join(cwd, "reviewed.jsonl"), "codex-subscription");
    const child = registry.ensureConversation("codex", artifactPath, "codex-subscription");
    const request = {
      engine: "codex" as const,
      cwd,
      accountId: "codex-subscription",
      parentConversationId: parent.id,
      conversationId: child.id,
      purpose: "resume-successor" as const,
      launchProfile: emptyLaunchProfile({ cwd, model: "gpt-5.6-luna", parentConversationId: parent.id }),
      clientAttemptId: `attempt_${id}`,
      requestDigest: id.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
    };
    const begun = registry.beginSpawnRequest(request);
    if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
    const host = new RoundTripHost("codex", artifactPath, id);
    const reached = deferred();
    const release = deferred();
    const failAtBarrier = async (candidate: typeof barrier): Promise<void> => {
      if (candidate !== barrier) return;
      reached.resolve();
      await release.promise;
      throw new Error(`${barrier} failed`);
    };
    const spawning = spawnStructuredConversation({
      engine: "codex",
      receipt: begun.receipt,
      spec: { command: "codex", cwd, windowName: "failure", engine: "codex", transcript: artifactPath, launchProfile: request.launchProfile },
      account: { engine: "codex", accountId: request.accountId, kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } },
      prompt: "initial prompt",
      registry,
      client,
    }, {
      startHost: async () => host,
      bindHost: async (targetRegistry, key, runningHost, claimOwner, claimEpoch) => {
        await failAtBarrier("bind");
        const state = await runningHost.health();
        targetRegistry.setStructuredHostClaimed(key, {
          kind: "codex-app-server",
          endpoint: state.endpoint,
          process: { pid: process.pid, startIdentity: "test-process" },
          eventCursor: state.eventCursor,
          protocolVersion: state.protocolVersion,
          writerClaimEpoch: claimEpoch,
          activeTurnRef: state.activeTurnRef,
          pendingAttention: state.pendingAttention,
          activeFlags: state.activeFlags,
        }, "idle", claimOwner, claimEpoch);
        return () => {};
      },
      publishHost: async () => {
        await failAtBarrier("publish");
        return async () => {};
      },
      deliverFirst: async () => { await failAtBarrier("first-message"); },
      processIdentity: () => ({ pid: process.pid, startIdentity: "test-process" }),
    });

    await reached.promise;
    const replay = registry.beginSpawnRequest(request);
    if (replay.kind !== "replay") throw new Error("concurrent request did not replay");
    expect(spawnResponseForReceipt(replay.receipt, replay.receipt.artifactPath, { structured: true })).toMatchObject({
      launched: false,
      state: "path-pending",
      path: artifactPath,
    });

    release.resolve();
    await expect(spawning).rejects.toThrow(`${barrier} failed`);
    expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({ state: "failed", error: `${barrier} failed` });
    expect(Object.values(registry.snapshot().entries).find((entry) => entry.artifactPath === artifactPath)).toMatchObject({
      status: "dead",
      structuredHost: null,
      pendingAction: null,
    });
    expect(journal.snapshot().sessions.find((session) => session.conversationId === begun.receipt.conversationId)).toMatchObject({
      host: "dead",
      artifactPath,
      parentConversationId: parent.id,
    });
    expect(journal.snapshot().edges.filter((edge) => edge.childConversationId === begun.receipt.conversationId))
      .toEqual([expect.objectContaining({ parentConversationId: parent.id })]);
  });
});

test("startup recovery finalizes a staged spawn without duplicating its admitted first message", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `recovery-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const artifactPath = path.join(cwd, `${id}.jsonl`);
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const launchProfile = emptyLaunchProfile({ cwd, model: "gpt-5.6-luna" });
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd, accountId: "codex-subscription", launchProfile });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  await client.command({
    kind: "spawn",
    operationId: begun.receipt.launchId,
    idempotencyKey: begun.receipt.launchId,
    conversationId: begun.receipt.conversationId,
    engine: "codex",
    cwd,
    prompt: "recover this first prompt",
    accountId: "codex-subscription",
    parentConversationId: null,
  });
  const key = { engine: "codex" as const, sessionId: id };
  const staged = registry.stageStructuredSpawn(begun.receipt.launchId, {
    key,
    artifactPath,
    cwd,
    accountId: "codex-subscription",
    launchProfile,
    status: "unhosted",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:pending",
      process: null,
      eventCursor: 0,
      protocolVersion: null,
      writerClaimEpoch: 0,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: "spawn",
  });
  if (staged.kind !== "settled") throw new Error("spawn identity was unavailable");
  const claimed = registry.claimStructuredHost(key, { pid: process.pid, startIdentity: "test-process" }, { allowUnhosted: true });
  if (!claimed?.claimOwner) throw new Error("structured claim was unavailable");
  registry.setStructuredHostClaimed(key, {
    kind: "codex-app-server",
    endpoint: "fake:stdio",
    process: { pid: process.pid, startIdentity: "test-process" },
    eventCursor: 0,
    protocolVersion: "fake-v1",
    writerClaimEpoch: claimed.claimEpoch,
    activeTurnRef: null,
    pendingAttention: [],
    activeFlags: [],
  }, "idle", claimed.claimOwner, claimed.claimEpoch);
  const host = new RoundTripHost("codex", artifactPath, id);
  await bindStructuredDeliveryQueue([{ key, host }], { registry, client });
  await enqueueStructuredMessage({
    path: artifactPath,
    conversationId: begun.receipt.conversationId,
    clientMessageId: `spawn_${begun.receipt.launchId}`,
    operationId: `spawn_message_${begun.receipt.launchId}`,
    text: "recover this first prompt",
    hasImages: false,
  }, { client: () => client, registry: () => registry, enabled: () => true });
  await waitFor(() => host.sent.length === 1);

  await recoverPendingStructuredSpawns(registry, client);

  expect(host.sent.map((entry) => entry.text)).toEqual(["recover this first prompt"]);
  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({ state: "completed", artifactPath });
  expect((await client.operationStatus(begun.receipt.launchId))?.receipt.status).toBe("delivered");
});

test("startup recovery terminalizes an admitted spawn interrupted before identity staging", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `unstaged-recovery-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd, transport: "structured", accountId: "codex-subscription" });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  await client.command({
    kind: "spawn", operationId: begun.receipt.launchId, idempotencyKey: begun.receipt.launchId,
    conversationId: begun.receipt.conversationId, engine: "codex", cwd, prompt: "durably admitted", accountId: "codex-subscription", parentConversationId: null,
  });

  await recoverPendingStructuredSpawns(registry, client);
  await recoverPendingStructuredSpawns(registry, client);

  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({ state: "failed", key: null });
  expect((await client.operationStatus(begun.receipt.launchId))?.receipt).toMatchObject({ status: "failed" });
  expect((await client.effectBatch(["runtime.spawn"], 0)).filter((effect) => effect.payload.operationId === begun.receipt.launchId)).toEqual([]);
  expect(registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "codex-subscription",
    clientAttemptId: `fresh-${id}`,
  }).kind).toBe("created");
});

test("startup recovery settles a structured receipt after a crash before runtime admission", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `pre-admission-recovery-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const structured = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "codex-subscription",
  });
  const tmux = registry.beginSpawnRequest({
    engine: "claude",
    cwd,
    transport: "tmux",
    accountId: "claude-subscription",
  });
  if (structured.kind !== "created" || tmux.kind !== "created") throw new Error("spawn receipt was unavailable");

  await recoverPendingStructuredSpawns(registry, client);
  await recoverPendingStructuredSpawns(registry, client);

  expect(registry.snapshot().receipts[structured.receipt.launchId]).toMatchObject({
    state: "failed",
    key: null,
    error: `structured spawn interrupted before runtime admission: ${structured.receipt.launchId}`,
  });
  expect(registry.snapshot().receipts[tmux.receipt.launchId]).toMatchObject({ state: "starting", key: null });
  expect(await client.effectBatch(["runtime.spawn"], 0)).toEqual([]);
  expect(registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "codex-subscription",
    clientAttemptId: `fresh-${id}`,
  }).kind).toBe("created");
});

test.each(["failed", "delivered"] as const)("startup recovery settles a keyless receipt after the runtime operation is %s", async (terminalStatus) => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `pre-identity-${terminalStatus}-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const begun = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "codex-subscription",
  });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  await client.command({
    kind: "spawn",
    operationId: begun.receipt.launchId,
    idempotencyKey: begun.receipt.launchId,
    conversationId: begun.receipt.conversationId,
    engine: "codex",
    cwd,
    prompt: "durable pre-identity prompt",
    accountId: "codex-subscription",
    parentConversationId: null,
  });
  await client.transitionOperation(begun.receipt.launchId, terminalStatus, {
    ...(terminalStatus === "failed" ? { reason: "runtime spawn failed before identity" } : {}),
  });

  await recoverPendingStructuredSpawns(registry, client);
  await recoverPendingStructuredSpawns(registry, client);

  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
    state: "failed",
    key: null,
  });
  expect((await client.operationStatus(begun.receipt.launchId))?.receipt.status).toBe(terminalStatus);
  expect((await client.effectBatch(["runtime.spawn"], 0)).filter((effect) => effect.payload.operationId === begun.receipt.launchId)).toEqual([]);
  expect(registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    accountId: "codex-subscription",
    clientAttemptId: `fresh-${id}`,
  }).kind).toBe("created");
});

test("startup recovery cleans a staged host whose spawn operation already failed", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `failed-recovery-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const artifactPath = path.join(cwd, `${id}.jsonl`);
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const launchProfile = emptyLaunchProfile({ cwd, model: "gpt-5.6-luna" });
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd, accountId: "codex-subscription", launchProfile });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  await client.command({
    kind: "spawn",
    operationId: begun.receipt.launchId,
    idempotencyKey: begun.receipt.launchId,
    conversationId: begun.receipt.conversationId,
    engine: "codex",
    cwd,
    prompt: "crash-window prompt",
    accountId: "codex-subscription",
    parentConversationId: null,
  });
  const key = { engine: "codex" as const, sessionId: id };
  const staged = registry.stageStructuredSpawn(begun.receipt.launchId, {
    key,
    artifactPath,
    cwd,
    accountId: "codex-subscription",
    launchProfile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fake:stdio",
      process: { pid: process.pid, startIdentity: "test-process" },
      eventCursor: 0,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: "structured-host:test",
    pendingAction: "spawn",
  });
  if (staged.kind !== "settled") throw new Error("spawn identity was unavailable");
  const host = new RoundTripHost("codex", artifactPath, id);
  await bindStructuredDeliveryQueue([{ key, host }], { registry, client });
  await client.transitionOperation(begun.receipt.launchId, "failed", { reason: "engine child failed" });

  await recoverPendingStructuredSpawns(registry, client);
  await recoverPendingStructuredSpawns(registry, client);

  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
    state: "failed",
    error: "engine child failed",
  });
  expect(registry.snapshot().entries[`codex:${id}`]).toMatchObject({
    status: "dead",
    structuredHost: null,
    claimOwner: null,
    pendingAction: null,
  });
  expect(hasStructuredDeliveryHost(key)).toBeFalse();
  expect(host.releaseCount).toBe(1);
  expect((await client.operationStatus(begun.receipt.launchId))?.receipt).toMatchObject({
    status: "failed",
    reason: "engine child failed",
  });
  expect(journal.snapshot().sessions.find((session) => session.conversationId === begun.receipt.conversationId)).toMatchObject({
    host: "dead",
  });
});

test("startup recovery completes an intentionally empty spawn prompt without a host send", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `empty-prompt-recovery-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const artifactPath = path.join(cwd, `${id}.jsonl`);
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const launchProfile = emptyLaunchProfile({ cwd, model: "gpt-5.6-luna" });
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd, accountId: "codex-subscription", launchProfile });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  await client.command({
    kind: "spawn",
    operationId: begun.receipt.launchId,
    idempotencyKey: begun.receipt.launchId,
    conversationId: begun.receipt.conversationId,
    engine: "codex",
    cwd,
    prompt: "",
    accountId: "codex-subscription",
    parentConversationId: null,
  });
  const key = { engine: "codex" as const, sessionId: id };
  const staged = registry.stageStructuredSpawn(begun.receipt.launchId, {
    key,
    artifactPath,
    cwd,
    accountId: "codex-subscription",
    launchProfile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fake:stdio",
      process: { pid: process.pid, startIdentity: "test-process" },
      eventCursor: 0,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: "structured-host:test",
    pendingAction: "spawn",
  });
  if (staged.kind !== "settled") throw new Error("spawn identity was unavailable");
  const host = new RoundTripHost("codex", artifactPath, id);
  await bindStructuredDeliveryQueue([{ key, host }], { registry, client });

  await recoverPendingStructuredSpawns(registry, client);

  expect(host.sent).toEqual([]);
  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({ state: "completed", artifactPath });
  expect((await client.operationStatus(begun.receipt.launchId))?.receipt.status).toBe("delivered");
});

test("a queued kill terminalizes after restart when its generation is confirmed dead", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `dead-kill-recovery-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const artifactPath = path.join(cwd, `${id}.jsonl`);
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const conversation = registry.ensureConversation("codex", artifactPath, "codex-subscription");
  const generation = conversation.generations.at(-1);
  if (!generation) throw new Error("structured generation was unavailable");
  const key = { engine: "codex" as const, sessionId: generation.id };
  registry.upsert({
    key,
    artifactPath,
    cwd,
    accountId: "codex-subscription",
    status: "dead",
    host: null,
    structuredHost: null,
    claimEpoch: 1,
    claimOwner: null,
    pendingAction: null,
  });
  await client.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey: key,
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      accountId: "codex-subscription",
      parentConversationId: null,
      cwd,
      artifactPath,
      capabilities: { steer: true, structuredAttention: true },
      activeTurnId: null,
    },
  });
  expect(journal.snapshot().sessions.find((session) => session.conversationId === conversation.id)?.host).toBe("hosted");
  const operationId = `kill_${id}`;
  await client.command({
    kind: "kill",
    operationId,
    idempotencyKey: operationId,
    conversationId: conversation.id,
    sessionKey: key,
  });

  await bindStructuredDeliveryQueue([], { registry, client });

  expect((await client.operationStatus(operationId))?.receipt).toMatchObject({
    kind: "kill",
    status: "delivered",
  });
  expect(registry.snapshot().entries[`codex:${generation.id}`]).toMatchObject({
    status: "dead",
    host: null,
    structuredHost: null,
    claimOwner: null,
    pendingAction: null,
  });
  expect(await client.effectBatch(["runtime.kill"], 0)).toEqual([]);
  expect(journal.snapshot().sessions.find((session) => session.conversationId === conversation.id)).toMatchObject({
    host: "dead",
    activeTurnId: null,
  });
  const sendOperationId = `send_after_${id}`;
  const sent = await client.command({
    kind: "send",
    operationId: sendOperationId,
    idempotencyKey: sendOperationId,
    conversationId: conversation.id,
    text: "must reject after kill",
    policy: "queue",
  });
  expect(sent.receipt).toMatchObject({ status: "rejected", reason: "dead-host" });
});

test("a dead predecessor kill terminalizes without touching its live successor", async () => {
  const predecessorId = crypto.randomUUID();
  const successorId = crypto.randomUUID();
  const cwd = path.join(sandbox, `successor-kill-${predecessorId}`);
  fs.mkdirSync(cwd, { recursive: true });
  const predecessorPath = path.join(cwd, `${predecessorId}.jsonl`);
  const successorPath = path.join(cwd, `${successorId}.jsonl`);
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const conversation = registry.ensureConversation("codex", predecessorPath, "codex-subscription");
  const predecessorKey = { engine: "codex" as const, sessionId: predecessorId };
  registry.upsert({
    key: predecessorKey,
    artifactPath: predecessorPath,
    cwd,
    accountId: "codex-subscription",
    status: "dead",
    host: null,
    structuredHost: null,
    claimEpoch: 1,
    claimOwner: null,
    pendingAction: null,
  });
  const resumed = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    accountId: "codex-subscription",
    conversationId: conversation.id,
    purpose: "resume-successor",
  });
  if (resumed.kind !== "created") throw new Error("successor receipt was unavailable");
  const successorKey = { engine: "codex" as const, sessionId: successorId };
  const settled = registry.settleSpawn(resumed.receipt.launchId, {
    key: successorKey,
    artifactPath: successorPath,
    cwd,
    accountId: "codex-subscription",
    status: "live",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fake:successor",
      process: { pid: process.pid, startIdentity: "successor-process" },
      eventCursor: 1,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 2,
      activeTurnRef: "successor-turn",
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 2,
    claimOwner: "structured-host:successor",
    pendingAction: null,
  });
  if (settled.kind !== "settled") throw new Error("successor settlement failed");
  const successorBefore = registry.snapshot().entries[`codex:${successorId}`];
  const operationId = `kill_${predecessorId}`;
  await client.command({
    kind: "kill",
    operationId,
    idempotencyKey: operationId,
    conversationId: conversation.id,
    sessionKey: predecessorKey,
  });
  const successorHost = new RoundTripHost("codex", successorPath, successorId);

  await bindStructuredDeliveryQueue([{ key: successorKey, host: successorHost }], { registry, client });

  expect((await client.operationStatus(operationId))?.receipt.status).toBe("delivered");
  expect(registry.snapshot().entries[`codex:${successorId}`]).toEqual(successorBefore);
  expect(successorHost.releaseCount).toBe(0);
  expect(hasStructuredDeliveryHost(successorKey)).toBeTrue();
  expect(journal.snapshot().sessions.find((session) => session.conversationId === conversation.id)).toMatchObject({
    sessionKey: successorKey,
    host: "hosted",
    hostKind: "codex-app-server",
  });
  expect(await client.effectBatch(["runtime.kill"], 0)).toEqual([]);
});

test("a queued kill waits when an unadopted structured process may still be live", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `live-kill-recovery-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const artifactPath = path.join(cwd, `${id}.jsonl`);
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const conversation = registry.ensureConversation("codex", artifactPath, "codex-subscription");
  const key = { engine: "codex" as const, sessionId: id };
  registry.upsert({
    key,
    artifactPath,
    cwd,
    accountId: "codex-subscription",
    status: "live",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fake:unadopted",
      process: { pid: process.pid, startIdentity: "potentially-live" },
      eventCursor: 1,
      protocolVersion: "fake-v1",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: "structured-host:unadopted",
    pendingAction: null,
  });
  const entryBefore = registry.snapshot().entries[`codex:${id}`];
  const operationId = `kill_${id}`;
  await client.command({
    kind: "kill",
    operationId,
    idempotencyKey: operationId,
    conversationId: conversation.id,
    sessionKey: key,
  });

  await bindStructuredDeliveryQueue([], { registry, client });

  expect((await client.operationStatus(operationId))?.receipt.status).toBe("queued");
  expect(registry.snapshot().entries[`codex:${id}`]).toEqual(entryBefore);
  expect(await client.effectBatch(["runtime.kill"], 0)).toHaveLength(1);
});

test("a queued kill waits through a processless structured adoption claim", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `claimed-kill-recovery-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const artifactPath = path.join(cwd, `${id}.jsonl`);
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const conversation = registry.ensureConversation("codex", artifactPath, "codex-subscription");
  const key = { engine: "codex" as const, sessionId: id };
  registry.upsert({
    key,
    artifactPath,
    cwd,
    accountId: "codex-subscription",
    status: "unhosted",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:pending",
      process: null,
      eventCursor: 0,
      protocolVersion: null,
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: "structured-host:adopting",
    pendingAction: null,
  });
  const entryBefore = registry.snapshot().entries[`codex:${id}`];
  const operationId = `kill_${id}`;
  await client.command({
    kind: "kill",
    operationId,
    idempotencyKey: operationId,
    conversationId: conversation.id,
    sessionKey: key,
  });

  await bindStructuredDeliveryQueue([], { registry, client });

  expect((await client.operationStatus(operationId))?.receipt.status).toBe("queued");
  expect(registry.snapshot().entries[`codex:${id}`]).toEqual(entryBefore);
  expect(await client.effectBatch(["runtime.kill"], 0)).toHaveLength(1);
});

describe.each(["codex", "claude"] as const)("%s structured spawn round trip", (engine) => {
  test("spawn, send, question, answer, interrupt, resume, and kill use one pane-less host", async () => {
    const id = crypto.randomUUID();
    const cwd = path.join(sandbox, `${engine}-${id}`);
    fs.mkdirSync(cwd, { recursive: true });
    const artifactPath = path.join(cwd, `${id}.jsonl`);
    const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
    const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
    const client = runtimeClient(journal);
    await bindStructuredDeliveryQueue([], { registry, client });
    const model = engine === "codex" ? "gpt-5.6-luna" : "claude-sonnet-4-6";
    const launchProfile = emptyLaunchProfile({ cwd, model });
    const begun = registry.beginSpawnRequest({
      engine,
      cwd,
      accountId: `${engine}-subscription`,
      launchProfile,
      clientAttemptId: `attempt_${id}`,
      requestDigest: id.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
    });
    if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
    const spec: ResumeSpec = { command: engine, cwd, windowName: `test-${engine}`, engine, transcript: artifactPath, launchProfile };
    const account: AccountContext = {
      engine,
      accountId: `${engine}-subscription`,
      kind: "managed",
      home: path.join(cwd, "account"),
      transcriptRoot: cwd,
      env: { NODE_ENV: "test" },
    };
    const host = new RoundTripHost(engine, artifactPath, id);

    const response = await spawnStructuredConversation({
      engine,
      receipt: begun.receipt,
      spec,
      account,
      prompt: "initial prompt",
      registry,
      client,
    }, {
      startHost: async (input) => {
        expect(input.spec.launchProfile?.model).toBe(model);
        return host;
      },
      bindHost: async (targetRegistry, key, runningHost, claimOwner, claimEpoch) => {
        const state = await runningHost.health();
        targetRegistry.setStructuredHostClaimed(key, {
          kind: engine === "codex" ? "codex-app-server" : "claude-broker",
          endpoint: state.endpoint,
          process: state.pid ? { pid: state.pid, startIdentity: state.processStartIdentity } : null,
          eventCursor: state.eventCursor,
          protocolVersion: state.protocolVersion,
          writerClaimEpoch: claimEpoch,
          activeTurnRef: state.activeTurnRef,
          pendingAttention: state.pendingAttention,
          activeFlags: state.activeFlags,
        }, "idle", claimOwner, claimEpoch);
        return () => {};
      },
      processIdentity: () => ({ pid: process.pid, startIdentity: "test-process" }),
    });

    expect(response).toMatchObject({ launched: true, target: null, path: artifactPath, state: "settled" });
    if (engine === "claude") expect(response).toMatchObject({ effectivePermissionMode: "default" });
    expect(registry.snapshot().receipts[begun.receipt.launchId]?.pane).toBeNull();
    const registryBeforeAttach = registry.snapshot();
    let terminalCommand = "";
    const attached = await materializeStructuredTerminal(artifactPath, {
      registry,
      spawn: async (command) => {
        terminalCommand = command.command;
        return {
          paneId: "%77",
          panePid: 7700,
          display: "agents:view.0",
          host: undefined,
          ...command,
        };
      },
    });
    expect(attached).toEqual({ target: "%77", display: "agents:view.0" });
    expect(terminalCommand).toContain("tail -n 200 -F");
    expect(terminalCommand.includes("codex resume") || terminalCommand.includes("claude --resume")).toBeFalse();
    expect(registry.snapshot().entries).toEqual(registryBeforeAttach.entries);
    await waitFor(() => host.sent.length === 1);
    host.finishTurn();

    const sent = await enqueueStructuredMessage({
      path: artifactPath,
      conversationId: response.conversationId,
      clientMessageId: `message_${id}`,
      text: "viewer send",
      hasImages: false,
    }, { client: () => client, registry: () => registry, enabled: () => true });
    expect(sent?.ok).toBeTrue();
    await waitFor(() => host.sent.some((entry) => entry.text === "viewer send"));

    host.ask("question-one");
    await waitFor(() => journal.snapshot().attentions.some((attention) => attention.id === "question-one"));
    const resolution = engine === "codex"
      ? { answers: { scope: { answers: ["Yes"] } } }
      : { behavior: "allow", updatedInput: { questions: [{ header: "Scope", question: "Continue?", options: [{ label: "Yes" }] }], answers: { "Continue?": "Yes" } } };
    await client.command({
      kind: "answer",
      operationId: `answer_${id}`,
      idempotencyKey: `answer_${id}`,
      conversationId: response.conversationId,
      attentionId: "question-one",
      resolution,
    });
    await kickStructuredDeliveryQueue();
    await waitFor(() => host.answers.length === 1);
    expect(host.answers[0]).toEqual({ id: "question-one", value: resolution });

    host.finishTurn();
    await enqueueStructuredMessage({
      path: artifactPath,
      conversationId: response.conversationId,
      clientMessageId: `slow_${id}`,
      text: "deliberately slow fake-host turn",
      hasImages: false,
    }, { client: () => client, registry: () => registry, enabled: () => true });
    await waitFor(() => host.sent.some((entry) => entry.text === "deliberately slow fake-host turn"));
    const slowTurn = (await host.health()).activeTurnRef!;
    await client.command({
      kind: "interrupt",
      operationId: `interrupt_${id}`,
      idempotencyKey: `interrupt_${id}`,
      conversationId: response.conversationId,
      turnId: slowTurn,
    });
    await kickStructuredDeliveryQueue();
    await waitFor(() => host.interrupts.includes(slowTurn));

    await enqueueStructuredMessage({
      path: artifactPath,
      conversationId: response.conversationId,
      clientMessageId: `resume_${id}`,
      text: "resume after interrupt",
      hasImages: false,
    }, { client: () => client, registry: () => registry, enabled: () => true });
    await waitFor(() => host.sent.some((entry) => entry.text === "resume after interrupt"));
    expect(host.sent.map((entry) => entry.text)).toEqual([
      "initial prompt",
      "viewer send",
      "deliberately slow fake-host turn",
      "resume after interrupt",
    ]);

    const pendingAfterKillId = `pending_after_kill_${id}`;
    await enqueueStructuredMessage({
      path: artifactPath,
      conversationId: response.conversationId,
      clientMessageId: pendingAfterKillId,
      text: "must stay queued after kill",
      hasImages: false,
      policy: "queue",
    }, { client: () => client, registry: () => registry, enabled: () => true });
    expect(host.sent.some((entry) => entry.text === "must stay queued after kill")).toBeFalse();

    const killOperationId = `kill_${id}`;
    const secondKillOperationId = `kill_again_${id}`;
    const kill = await dispatchStructuredControl({ path: artifactPath, conversationId: response.conversationId, action: "kill" }, {
      registry,
      client,
      operationId: () => killOperationId,
      kick: () => {},
      enabled: () => true,
    });
    expect(kill).toMatchObject({ status: 202, body: { ok: true, structured: true, operationId: killOperationId } });
    const secondKill = await dispatchStructuredControl({ path: artifactPath, conversationId: response.conversationId, action: "kill" }, {
      registry,
      client,
      operationId: () => secondKillOperationId,
      kick: () => {},
      enabled: () => true,
    });
    expect(secondKill).toMatchObject({ status: 202, body: { ok: true, structured: true, operationId: secondKillOperationId } });
    await completesWithin(kickStructuredDeliveryQueue(), "structured kill did not complete");
    await waitFor(() => host.releaseCount === 1);

    expect(hasStructuredDeliveryHost({ engine, sessionId: id })).toBeFalse();
    expect(registry.snapshot().entries[`${engine}:${id}`]).toMatchObject({
      status: "dead",
      host: null,
      structuredHost: null,
      claimOwner: null,
      pendingAction: null,
    });
    expect((await client.operationStatus(killOperationId))?.receipt).toMatchObject({
      kind: "kill",
      status: "delivered",
    });
    expect((await client.operationStatus(secondKillOperationId))?.receipt).toMatchObject({
      kind: "kill",
      status: "delivered",
    });
    expect(await client.effectBatch(["runtime.kill"], 0)).toEqual([]);
    expect(journal.snapshot().sessions.find((session) => session.conversationId === response.conversationId)).toMatchObject({
      host: "dead",
    });
    await completesWithin(kickStructuredDeliveryQueue(), "structured delivery queue stayed wedged after kill");
    expect(host.sent.some((entry) => entry.text === "must stay queued after kill")).toBeFalse();
  });
});

test("structured spawn fails loudly when Codex omits the transcript-path capability", async () => {
  const id = crypto.randomUUID();
  const cwd = path.join(sandbox, `codex-gap-${id}`);
  fs.mkdirSync(cwd, { recursive: true });
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(cwd, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const launchProfile = emptyLaunchProfile({ cwd, model: "gpt-5.6-luna" });
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd, accountId: "codex-subscription", launchProfile });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  const host = new RoundTripHost("codex", path.join(cwd, `${id}.jsonl`), id);
  Object.defineProperty(host, "identity", { value: { threadId: id, path: null } });

  await expect(spawnStructuredConversation({
    engine: "codex",
    receipt: begun.receipt,
    spec: { command: "codex", cwd, windowName: "gap", engine: "codex", launchProfile },
    account: { engine: "codex", accountId: "codex-subscription", kind: "managed", home: cwd, transcriptRoot: cwd, env: { NODE_ENV: "test" } },
    prompt: "prompt",
    registry,
    client,
  }, { startHost: async () => host })).rejects.toThrow("app-server returned no transcript path");

  expect(registry.snapshot().receipts[begun.receipt.launchId]?.state).toBe("failed");
  expect(journal.operationResult(begun.receipt.launchId)?.receipt).toMatchObject({ status: "failed", reason: expect.stringContaining("transcript path") });
});
