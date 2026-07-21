import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, spyOn, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { drainHeldDeliveries } from "@/lib/accounts/migration/coordinator";
import { AgentRegistry } from "@/lib/agent/registry";
import { turnStateFromRecords } from "@/lib/scanner/activity";
import { RuntimeJournal } from "@/runtime-host/journal";
import { runStructuredHostStartup } from "@/lib/viewerInstrumentation";

import { RuntimeHostUnavailableError, type RuntimeHostClient } from "./client";
import { bindStructuredDeliveryQueue, hasStructuredDeliveryHost, publishStructuredDeliveryHost } from "./structuredDeliveryController";
import { createFakeDeliveryLedger, FakeEngineHost } from "./fixtures/fakeEngineHost";
import { demoteSkippedStructuredRegistryHosts, type StructuredHostAdoptionFilter } from "./registry";
import { deliverHeldStructuredMessage, enqueueStructuredMessage } from "./structuredMessageDelivery";
import { didStructuredHostStartupFail } from "./startupStatus";
import { adoptStructuredHostsAtStartup, structuredStartupHosts, type StructuredStartupDependencies } from "./startup";

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
    effectBatch: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (operationId, status, details) => journal.transitionOperation(operationId, status, details),
  } as RuntimeHostClient;
}

test("startup publishes the structured controller before transcript refresh settles", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-early-controller-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  let refreshStarted!: () => void;
  const refreshStartedPromise = new Promise<void>((resolve) => { refreshStarted = resolve; });
  let releaseRefresh!: () => void;
  const refreshRelease = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const startup = adoptStructuredHostsAtStartup({
    registry,
    client,
    refreshTranscriptState: async () => {
      refreshStarted();
      await refreshRelease;
    },
    adopt: async () => [],
    adoptClaude: async () => [],
  });
  await refreshStartedPromise;

  const sessionId = "early-controller-session";
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  fs.writeFileSync(artifactPath, "");
  registry.upsert({
    key: { engine: "codex", sessionId },
    artifactPath,
    cwd: directory,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: directory }),
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "fake:early-controller",
      process: null,
      eventCursor: 0,
      protocolVersion: "test",
      writerClaimEpoch: 0,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: "spawn",
  });
  const key = { engine: "codex" as const, sessionId };
  const host = Object.assign(new FakeEngineHost(createFakeDeliveryLedger()), { onStateChange: () => () => {} });
  const unregister = await publishStructuredDeliveryHost({ key, host });
  expect(hasStructuredDeliveryHost(key)).toBe(true);

  await unregister();
  releaseRefresh();
  await startup;
  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
});

test("startup retry preserves a host registered after the first attempt fails", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-controller-retry-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  let refreshAttempts = 0;
  const dependencies = {
    registry,
    client,
    refreshTranscriptState: async () => {
      refreshAttempts += 1;
      if (refreshAttempts === 1) throw new RuntimeHostUnavailableError("runtime host is unavailable");
    },
    adopt: async () => [],
    adoptClaude: async () => [],
  } satisfies StructuredStartupDependencies;

  await expect(adoptStructuredHostsAtStartup(dependencies)).rejects.toThrow("runtime host is unavailable");

  const key = { engine: "claude" as const, sessionId: "hosted-between-startup-attempts" };
  const host = Object.assign(new FakeEngineHost(createFakeDeliveryLedger()), { onStateChange: () => () => {} });
  const unregister = await publishStructuredDeliveryHost({ key, host });
  expect(hasStructuredDeliveryHost(key)).toBe(true);

  await adoptStructuredHostsAtStartup(dependencies);
  expect(hasStructuredDeliveryHost(key)).toBe(true);

  await unregister();
  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("server startup delegates managed rows with file credentials and their launch profile", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const artifactPath = "/managed/sessions/startup-thread.jsonl";
  const conversation = registry.ensureConversation("codex", artifactPath, "managed");
  registry.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    conversationId: conversation.id,
    spawnCapabilityDigest: "a".repeat(64),
  });
  registry.upsert({
    key: { engine: "codex", sessionId: "startup-thread" },
    artifactPath,
    cwd: "/repo",
    accountId: "managed",
    launchProfile: {
      cwd: "/repo",
      model: "gpt-5.4-mini",
      effort: "high",
      fast: null,
      permissionMode: null,
      readOnly: true,
      allowSubagents: true,
      title: null,
      project: null,
      parentConversationId: null,
      role: "worker",
      goal: null,
      plan: null,
    },
    status: "dead",
    host: null,
    claimEpoch: 1,
    claimOwner: null,
    pendingAction: null,
  });
  let codexOptions: unknown;
  let claudeOptions: unknown;
  await adoptStructuredHostsAtStartup({
    registry,
    resolveCodexOwner: () => ({ home: "/managed", kind: "managed" }),
    resolveClaudeOwner: () => ({
      home: "/managed-claude",
      kind: "managed",
      transcriptRoot: "/managed-claude/projects",
      env: { NODE_ENV: "test", CLAUDE_CONFIG_DIR: "/managed-claude" },
    }),
    adopt: async (received, optionsFor) => {
      expect(received).toBe(registry);
      codexOptions = optionsFor(registry.snapshot().entries["codex:startup-thread"]!);
      return [];
    },
    adoptClaude: async (received, optionsFor) => {
      expect(received).toBe(registry);
      claudeOptions = optionsFor(registry.snapshot().entries["codex:startup-thread"]!);
      return [];
    },
  });
  expect(codexOptions).toMatchObject({
    cwd: "/repo",
    codexHome: "/managed",
    fileAuthCredentials: true,
    model: "gpt-5.4-mini",
    effort: "high",
    env: { LLV_SPAWN_CAPABILITY: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) },
  });
  expect(claudeOptions).toMatchObject({
    cwd: "/repo",
    claudeConfigDir: "/managed-claude",
    claudeProjectsDir: "/managed-claude/projects",
    env: { CLAUDE_CONFIG_DIR: "/managed-claude" },
    model: "gpt-5.4-mini",
    effort: "high",
    allowSubagents: true,
  });
  expect(claudeOptions).toMatchObject({
    env: { LLV_SPAWN_CAPABILITY: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) },
  });
});

function runtimeJournalClient(journal: RuntimeJournal): RuntimeHostClient {
  return {
    snapshot: async () => journal.snapshot(),
    append: async (event) => journal.append(event),
    command: async (command) => journal.executeOperation(command),
    operationStatus: async (operationId, options) => options?.currentRetryLeaf
      ? journal.currentRetryResult(operationId)
      : journal.operationResult(operationId),
    retryOperation: async (operationId, nextIdempotencyKey, options) =>
      journal.retryOperation(operationId, nextIdempotencyKey, options),
    effectBatch: async (kinds, afterEventSeq) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (operationId, status, details) => journal.transitionOperation(operationId, status, details),
  } as RuntimeHostClient;
}

function structuredRestartFixture(
  directory: string,
  engine: "codex" | "claude",
  status: "dead" | "unhosted" = "dead",
  structured = true,
) {
  const sessionId = engine === "codex"
    ? "aaaaaaaa-aaaa-0aaa-0aaa-aaaaaaaaaaaa"
    : "bbbbbbbb-bbbb-0bbb-0bbb-bbbbbbbbbbbb";
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const conversation = registry.ensureConversation(engine, artifactPath, null);
  registry.upsert({
    key: { engine, sessionId },
    artifactPath,
    cwd: directory,
    accountId: null,
    launchProfile: emptyLaunchProfile({ cwd: directory }),
    status,
    host: null,
    structuredHost: structured ? {
      kind: engine === "codex" ? "codex-app-server" : "claude-broker",
      endpoint: "stdio:released",
      process: null,
      eventCursor: 4,
      protocolVersion: "test",
      writerClaimEpoch: 2,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    } : null,
    claimEpoch: 2,
    claimOwner: null,
    pendingAction: null,
  });
  return { artifactPath, conversation, registry, sessionId };
}

function projectHostedRestart(
  journal: RuntimeJournal,
  engine: "codex" | "claude",
  conversationId: string,
  sessionId: string,
  directory: string,
  artifactPath: string,
  turn: "idle" | "running" = "idle",
): void {
  journal.append({
    scope: { type: "session", id: conversationId },
    kind: "session-status",
    producer: {
      kind: engine === "codex" ? "codex-app-server" : "claude-broker",
      eventKey: `recovered-${engine}-restart`,
    },
    payload: {
      conversationId,
      sessionKey: { engine, sessionId },
      hostKind: engine === "codex" ? "codex-app-server" : "claude-broker",
      host: "hosted",
      turn,
      provenance: "structured",
      accountId: null,
      parentConversationId: null,
      cwd: directory,
      artifactPath,
      capabilities: { steer: engine === "codex", structuredAttention: true },
      activeTurnId: turn === "running" ? "runtime-running-turn" : null,
    },
  });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("startup delivery did not settle");
}

test.each(["codex", "claude"] as const)("failed %s restart adoption recovers structured ownership before delivery", async (engine) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `llv-runtime-startup-dead-${engine}-`));
  const { artifactPath, conversation, registry, sessionId } = structuredRestartFixture(directory, engine);
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeJournalClient(journal);

  await adoptStructuredHostsAtStartup({
    registry,
    client,
    adopt: async () => [],
    adoptClaude: async () => [],
  });

  expect(journal.snapshot().sessions).toMatchObject([{
    conversationId: conversation.id,
    sessionKey: { engine, sessionId },
    hostKind: engine === "codex" ? "codex-app-server" : "claude-broker",
    host: "dead",
    artifactPath,
  }]);
  let legacyCalls = 0;
  let recoveryCalls = 0;
  const delivery = await enqueueStructuredMessage({
    path: artifactPath,
    text: "must stay structured",
    clientMessageId: `failed-${engine}-restart-message`,
    hasImages: false,
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    recover: async () => {
      recoveryCalls += 1;
      projectHostedRestart(journal, engine, conversation.id, sessionId, directory, artifactPath);
      return { target: null, path: artifactPath, conversationId: conversation.id, spawned: true };
    },
  });
  if (delivery === null) legacyCalls += 1;
  expect(delivery).toMatchObject({
    ok: true,
    structured: true,
    target: null,
    spawned: true,
    outcome: "queued",
    receipt: { status: "queued" },
  });
  expect(recoveryCalls).toBe(1);
  expect(legacyCalls).toBe(0);

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("failed restart adoption replaces a stale projection and recovers before delivery", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-stale-hosted-"));
  const { artifactPath, conversation, registry, sessionId } = structuredRestartFixture(directory, "codex");
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeJournalClient(journal);
  journal.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey: { engine: "codex", sessionId },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      artifactPath,
      capabilities: { steer: true, structuredAttention: true },
    },
  });

  await adoptStructuredHostsAtStartup({
    registry,
    client,
    adopt: async () => [],
    adoptClaude: async () => [],
  });

  expect(journal.snapshot().sessions).toMatchObject([{
    conversationId: conversation.id,
    hostKind: "codex-app-server",
    host: "dead",
  }]);
  const delivery = await enqueueStructuredMessage({
    path: artifactPath,
    text: "recover stale hosted delivery",
    clientMessageId: "failed-stale-restart-message",
    hasImages: false,
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
    recover: async () => {
      projectHostedRestart(journal, "codex", conversation.id, sessionId, directory, artifactPath);
      return { target: null, path: artifactPath, conversationId: conversation.id, spawned: true };
    },
  });
  expect(delivery).toMatchObject({
    ok: true,
    structured: true,
    target: null,
    spawned: true,
    outcome: "queued",
    receipt: { status: "queued" },
  });

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test.each(["codex", "claude"] as const)("successful %s restart adoption publishes hosted ownership and delivers through EngineHost", async (engine) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `llv-runtime-startup-hosted-${engine}-`));
  const { artifactPath, conversation, registry, sessionId } = structuredRestartFixture(directory, engine, "unhosted");
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeJournalClient(journal);
  const ledger = createFakeDeliveryLedger();
  const host = Object.assign(new FakeEngineHost(ledger), { onStateChange: () => () => {} });
  const key = { engine, sessionId } as const;
  const adoptHost = (received: AgentRegistry) => {
    const processIdentity = { pid: process.pid, startIdentity: `hosted-${engine}-process` };
    const claimed = received.claimStructuredHost(key, processIdentity, { allowUnhosted: true });
    if (!claimed?.structuredHost || !claimed.claimOwner) throw new Error("hosted restart claim was unavailable");
    const persisted = received.setStructuredHostClaimed(key, {
      ...claimed.structuredHost,
      endpoint: `fake:hosted-${engine}`,
      process: processIdentity,
    }, "live", claimed.claimOwner, claimed.claimEpoch);
    if (!persisted) throw new Error("hosted restart claim was lost");
    return [{ key, host: host as never }];
  };

  await adoptStructuredHostsAtStartup({
    registry,
    client,
    adopt: async (received) => engine === "codex" ? adoptHost(received) as never : [],
    adoptClaude: async (received) => engine === "claude" ? adoptHost(received) as never : [],
  });

  expect(journal.snapshot().sessions).toMatchObject([{
    conversationId: conversation.id,
    sessionKey: key,
    hostKind: engine === "codex" ? "codex-app-server" : "claude-broker",
    host: "hosted",
    artifactPath,
  }]);
  let legacyCalls = 0;
  const delivery = await enqueueStructuredMessage({
    path: artifactPath,
    text: `deliver through ${engine}`,
    clientMessageId: `hosted-${engine}-restart-message`,
    hasImages: false,
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
  });
  if (delivery === null) legacyCalls += 1;
  expect(delivery).toMatchObject({ ok: true, structured: true, outcome: "queued" });
  await waitFor(() => ledger.writes.length === 1);
  expect(ledger.writes).toEqual([expect.objectContaining({ text: `deliver through ${engine}` })]);
  expect(legacyCalls).toBe(0);

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("startup socket recovery retains a partially adopted host and drains its held send once", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-partial-adoption-"));
  const { conversation, registry, sessionId } = structuredRestartFixture(directory, "codex", "unhosted");
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeJournalClient(journal);
  const key = { engine: "codex" as const, sessionId };
  const operationId = "operation-partial-adoption-held-send";
  const held = registry.holdDelivery(
    conversation.id,
    "deliver after partial startup adoption",
    "partial-adoption-held-send",
    "text",
    [],
    null,
    { operationId, kind: "send", policy: "queue", turnId: null },
  );
  const ledger = createFakeDeliveryLedger();
  const listeners = new Set<() => void>();
  const host = Object.assign(new FakeEngineHost(ledger), {
    onStateChange: () => {
      const listener = () => {};
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  });
  const scheduled: Array<() => void> = [];
  let adoptedProcesses = 0;
  let effectCalls = 0;
  const startupClient = {
    ...client,
    producerCursor: async (producerKind: string, eventKeyPrefix: string) =>
      journal.producerCursor(producerKind, eventKeyPrefix),
    effectBatch: async (kinds?: readonly string[], afterEventSeq?: number) => {
      effectCalls += 1;
      if (effectCalls === 2) {
        throw new RuntimeHostUnavailableError("runtime socket failed after host adoption");
      }
      return journal.effectBatch(100, kinds, afterEventSeq);
    },
  } as RuntimeHostClient;
  const dependencies: StructuredStartupDependencies = {
    registry,
    client: startupClient,
    adopt: async (received, _optionsFor, _env, shouldAdopt = () => true) => {
      const entry = received.snapshot().entries[`codex:${sessionId}`];
      if (!entry || !shouldAdopt(entry) || adoptedProcesses > 0) return [];
      const processIdentity = { pid: process.pid, startIdentity: "partial-adoption-process" };
      const claimed = received.claimStructuredHost(key, processIdentity, { allowUnhosted: true });
      if (!claimed?.structuredHost || !claimed.claimOwner) throw new Error("partial adoption claim was unavailable");
      const persisted = received.setStructuredHostClaimed(key, {
        ...claimed.structuredHost,
        endpoint: "fake:partial-adoption",
        process: processIdentity,
      }, "idle", claimed.claimOwner, claimed.claimEpoch);
      if (!persisted) throw new Error("partial adoption writer claim was lost");
      adoptedProcesses += 1;
      return [{ key, host: host as never }];
    },
    adoptClaude: async () => [],
  };

  try {
    await runStructuredHostStartup(
      () => adoptStructuredHostsAtStartup(dependencies),
      () => {},
      {
        schedule: (callback) => {
          scheduled.push(callback);
          return { unref() {} };
        },
      },
    );

    expect(adoptedProcesses).toBe(1);
    expect(scheduled).toHaveLength(1);
    scheduled.shift()!();
    await waitFor(() => !didStructuredHostStartupFail());
    expect(hasStructuredDeliveryHost(key)).toBe(true);

    await drainHeldDeliveries(conversation.id, {
      deliver: async ({ delivery, path: deliveryPath, clientMessageId }) =>
        await deliverHeldStructuredMessage({
          conversationId: conversation.id,
          path: deliveryPath,
          deliveryId: delivery.id,
          clientMessageId,
          text: delivery.text,
          command: delivery.command,
        }, {
          enabled: () => true,
          client: () => startupClient,
          registry: () => registry,
        }) ?? "delivery-uncertain",
    }, registry);
    await drainHeldDeliveries(conversation.id, {
      deliver: async () => { throw new Error("delivered hold must not drain twice"); },
    }, registry);

    expect(structuredStartupHosts()).toMatchObject([{ key, host }]);
    expect(ledger.writes).toEqual([expect.objectContaining({
      id: operationId,
      text: "deliver after partial startup adoption",
      expectedTurnId: null,
    })]);
    expect(registry.snapshot().heldDeliveries[held.id]).toMatchObject({ state: "delivered", text: "" });
    expect(listeners.size).toBe(1);
    expect(adoptedProcesses).toBe(1);
    expect(registry.snapshot().entries[`codex:${sessionId}`]).toMatchObject({
      claimOwner: expect.any(String),
      structuredHost: {
        process: { pid: process.pid, startIdentity: "partial-adoption-process" },
        writerClaimEpoch: expect.any(Number),
      },
    });
  } finally {
    await bindStructuredDeliveryQueue([], { registry, client: null });
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("scheduled startup retry continues through the retained Codex host", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-retained-continuation-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const sessionId = "00000000-0000-0000-0000-000000000000";
  const { artifactPath, conversation } = addStructuredRestartConversation(registry, directory, {
    sessionId,
    status: "live",
    turn: "busy",
    activeTurnRef: "turn-interrupted-before-continuation-admission",
    transcriptRecords: [{ timestamp: "2026-07-20T11:47:00.000Z", payload: { type: "task_started" } }],
  });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  projectHostedRestart(journal, "codex", conversation.id, sessionId, directory, artifactPath);
  journal.executeOperation({
    kind: "send",
    operationId: "queued-draft-before-retained-retry",
    idempotencyKey: "queued-draft-before-retained-retry",
    conversationId: conversation.id,
    text: "keep this draft ahead of continuation",
    policy: "queue",
    turnId: null,
  });
  const baseClient = runtimeJournalClient(journal);
  let continuationAdmissions = 0;
  const client = {
    ...baseClient,
    command: async (command: Parameters<RuntimeHostClient["command"]>[0]) => {
      if (command.kind === "send" && command.text === "Continue the interrupted turn from the transcript.") {
        continuationAdmissions += 1;
        if (continuationAdmissions === 1) {
          throw new RuntimeHostUnavailableError("runtime socket failed before continuation admission");
        }
      }
      return journal.executeOperation(command);
    },
  } as RuntimeHostClient;
  const ledger = createFakeDeliveryLedger();
  const host = Object.assign(new FakeEngineHost(ledger), { onStateChange: () => () => {} });
  const key = { engine: "codex" as const, sessionId };
  const scheduled: Array<() => void> = [];
  let adoptedProcesses = 0;
  const dependencies: StructuredStartupDependencies = {
    registry,
    client,
    adopt: async (received) => {
      const entry = received.snapshot().entries[`codex:${sessionId}`];
      if (!entry || adoptedProcesses > 0) return [];
      const processIdentity = { pid: process.pid, startIdentity: "retained-continuation-process" };
      const claimed = received.claimStructuredHost(key, processIdentity, { allowUnhosted: true });
      if (!claimed?.structuredHost || !claimed.claimOwner) throw new Error("continuation adoption claim was unavailable");
      const persisted = received.setStructuredHostClaimed(key, {
        ...claimed.structuredHost,
        endpoint: "fake:retained-continuation",
        process: processIdentity,
      }, "idle", claimed.claimOwner, claimed.claimEpoch);
      if (!persisted) throw new Error("continuation adoption writer claim was lost");
      adoptedProcesses += 1;
      return [{ key, host: host as never }];
    },
    adoptClaude: async () => [],
  };

  try {
    await runStructuredHostStartup(
      () => adoptStructuredHostsAtStartup(dependencies),
      () => {},
      {
        schedule: (callback) => {
          scheduled.push(callback);
          return { unref() {} };
        },
      },
    );

    const retainedEpoch = registry.snapshot().entries[`codex:${sessionId}`]!.claimEpoch;
    expect(didStructuredHostStartupFail()).toBe(true);
    expect(scheduled).toHaveLength(1);
    expect(ledger.writes.map(({ text }) => text)).toEqual(["keep this draft ahead of continuation"]);

    scheduled.shift()!();
    await waitFor(() => !didStructuredHostStartupFail() && ledger.writes.length === 2);

    const continuationOperationId = `recovery-continuation-${sessionId}-${retainedEpoch}`;
    expect(structuredStartupHosts()).toMatchObject([{ key, host }]);
    expect(adoptedProcesses).toBe(1);
    expect(continuationAdmissions).toBe(2);
    expect(registry.snapshot().entries[`codex:${sessionId}`]!.claimEpoch).toBe(retainedEpoch);
    expect(ledger.writes.map(({ id, text }) => ({ id, text }))).toEqual([
      { id: "queued-draft-before-retained-retry", text: "keep this draft ahead of continuation" },
      { id: continuationOperationId, text: "Continue the interrupted turn from the transcript." },
    ]);
    expect(journal.operationResult("queued-draft-before-retained-retry")?.receipt.status).toBe("delivered");
    expect(journal.operationResult(continuationOperationId)?.receipt).toMatchObject({
      idempotencyKey: continuationOperationId,
      status: "delivered",
    });
    expect(journal.snapshot().recentOperations
      .filter((receipt) => receipt.operationId === continuationOperationId)).toHaveLength(1);
  } finally {
    await bindStructuredDeliveryQueue([], { registry, client: null });
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test.each(["terminal", "demoted-superseded", "new-generation", "superseded-during-signals"] as const)(
  "scheduled startup retry releases a %s retained host",
  async (condition) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-discarded-retained-host-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const sessionId = "00000000-0000-0000-0000-000000000000";
  const { artifactPath, conversation } = addStructuredRestartConversation(registry, directory, {
    sessionId,
    status: "live",
    turn: "busy",
    activeTurnRef: "turn-interrupted-before-supersedence",
    transcriptRecords: [{
      timestamp: "2026-07-20T11:47:00.000Z",
      payload: { type: "task_started", turn_id: "turn-interrupted-before-supersedence" },
    }],
  });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const baseClient = runtimeJournalClient(journal);
  let continuationAdmissions = 0;
  let failStartupSignalsAfterDiscard = false;
  let supersedeDuringEffectBatch = false;
  let supersedenceDuringSignals = 0;
  const client = {
    ...baseClient,
    snapshot: async () => {
      if (failStartupSignalsAfterDiscard) {
        failStartupSignalsAfterDiscard = false;
        throw new RuntimeHostUnavailableError("runtime socket failed after retained host discard");
      }
      return baseClient.snapshot();
    },
    effectBatch: async (...args: Parameters<RuntimeHostClient["effectBatch"]>) => {
      const batch = await baseClient.effectBatch(...args);
      if (supersedeDuringEffectBatch) {
        supersedeDuringEffectBatch = false;
        supersedenceDuringSignals += 1;
        const staleEntry = registry.snapshot().entries[`codex:${sessionId}`]!;
        await demoteSkippedStructuredRegistryHosts(registry, () => false);
        const successor = registry.ensureConversation("codex", path.join(directory, "signal-successor.jsonl"), null);
        registry.recordSupersedence(conversation.id, successor.id, "recovery-spawn");
        registry.upsert({ ...staleEntry, status: "live" });
      }
      return batch;
    },
    command: async (command: Parameters<RuntimeHostClient["command"]>[0]) => {
      if (command.kind === "send" && command.text === "Continue the interrupted turn from the transcript.") {
        continuationAdmissions += 1;
        if (continuationAdmissions === 1) {
          throw new RuntimeHostUnavailableError("runtime socket failed after retained host publication");
        }
      }
      return journal.executeOperation(command);
    },
  } as RuntimeHostClient;
  const ledger = createFakeDeliveryLedger();
  let releaseCalls = 0;
  const host = Object.assign(new FakeEngineHost(ledger), {
    onStateChange: () => () => {},
    release: async () => { releaseCalls += 1; },
  });
  const key = { engine: "codex" as const, sessionId };
  const scheduled: Array<() => void> = [];
  let adoptedProcesses = 0;
  const dependencies: StructuredStartupDependencies = {
    registry,
    client,
    adopt: async (received) => {
      const entry = received.snapshot().entries[`codex:${sessionId}`];
      if (!entry || adoptedProcesses > 0) return [];
      const processIdentity = { pid: process.pid, startIdentity: "discarded-retained-process" };
      const claimed = received.claimStructuredHost(key, processIdentity, { allowUnhosted: true });
      if (!claimed?.structuredHost || !claimed.claimOwner) throw new Error("discarded host claim was unavailable");
      const persisted = received.setStructuredHostClaimed(key, {
        ...claimed.structuredHost,
        endpoint: "fake:discarded-retained",
        process: processIdentity,
      }, "live", claimed.claimOwner, claimed.claimEpoch);
      if (!persisted) throw new Error("discarded host writer claim was lost");
      adoptedProcesses += 1;
      return [{ key, host: host as never }];
    },
    adoptClaude: async () => [],
  };

  try {
    await runStructuredHostStartup(
      () => adoptStructuredHostsAtStartup(dependencies),
      () => {},
      {
        schedule: (callback) => {
          scheduled.push(callback);
          return { unref() {} };
        },
      },
    );

    expect(didStructuredHostStartupFail()).toBe(true);
    expect(scheduled).toHaveLength(1);
    expect(ledger.writes).toEqual([]);

    if (condition === "terminal") {
      fs.appendFileSync(artifactPath, `\n${JSON.stringify({
        timestamp: "2026-07-20T11:48:00.000Z",
        payload: { type: "task_complete", turn_id: "turn-interrupted-before-supersedence" },
      })}\n`);
    } else if (condition === "demoted-superseded") {
      await demoteSkippedStructuredRegistryHosts(registry, () => false);
      const successor = registry.ensureConversation("codex", path.join(directory, "successor.jsonl"), null);
      registry.recordSupersedence(conversation.id, successor.id, "recovery-spawn");
      failStartupSignalsAfterDiscard = true;
    } else if (condition === "new-generation") {
      const successorId = "synthetic-current-generation";
      const successorPath = path.join(directory, "current-generation.jsonl");
      fs.writeFileSync(successorPath, "");
      const operationId = "advance-current-generation";
      const receipt = {
        operationId,
        nativeId: successorId,
        path: successorPath,
        continuityPaths: [successorPath],
        historyHash: "synthetic-current-generation-history",
        host: {
          kind: "codex-app-server" as const,
          identity: successorId,
          epoch: 1,
          verifiedAt: "2026-07-20T11:48:00.000Z",
        },
      };
      registry.setConversationMigration(conversation.id, {
        intentId: "advance-current-generation-intent",
        phase: "verifying",
        targetId: "successor-account",
        revision: 1,
        operationId,
        providerReceipt: receipt,
        error: null,
        updatedAt: "2026-07-20T11:48:00.000Z",
      });
      registry.commitSuccessor(conversation.id, {
        id: successorId,
        path: successorPath,
        accountId: "successor-account",
      }, 1, operationId, receipt);
    } else {
      supersedeDuringEffectBatch = true;
    }

    scheduled.shift()!();
    if (condition === "demoted-superseded") {
      await waitFor(() => didStructuredHostStartupFail() && scheduled.length === 1);
      expect(releaseCalls).toBe(1);
      scheduled.shift()!();
    }
    await waitFor(() => !didStructuredHostStartupFail());

    expect(structuredStartupHosts()).toEqual([]);
    expect(adoptedProcesses).toBe(1);
    expect(continuationAdmissions).toBe(1);
    expect(ledger.writes).toEqual([]);
    expect(releaseCalls).toBe(1);
    expect(journal.snapshot().recentOperations.filter((receipt) =>
      receipt.operationId.startsWith(`recovery-continuation-${sessionId}-`))).toEqual([]);

    if (condition === "superseded-during-signals") {
      expect(supersedenceDuringSignals).toBe(1);
      await adoptStructuredHostsAtStartup(dependencies);
      expect(structuredStartupHosts()).toEqual([]);
      expect(ledger.writes).toEqual([]);
      expect(releaseCalls).toBe(1);
      expect(journal.snapshot().recentOperations.filter((receipt) =>
        receipt.operationId.startsWith(`recovery-continuation-${sessionId}-`))).toEqual([]);
    }
  } finally {
    await bindStructuredDeliveryQueue([], { registry, client: null });
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
  },
);

test("terminal structured row with a cleared ownership marker stays outside startup adoption", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-terminal-"));
  const { registry } = structuredRestartFixture(directory, "codex", "dead", false);
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeJournalClient(journal);

  await adoptStructuredHostsAtStartup({
    registry,
    client,
    adopt: async () => [],
    adoptClaude: async () => [],
  });

  expect(journal.snapshot().sessions).toEqual([]);

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("fresh-journal startup projects a live tmux registry row for composer fallback", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-legacy-"));
  const sourceId = "dddddddd-dddd-0ddd-0ddd-dddddddddddd";
  const sourcePath = path.join(directory, `${sourceId}.jsonl`);
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const profile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{
    engine: "codex",
    path: sourcePath,
    accountId: "legacy",
    launchProfile: profile,
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-14T14:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath(sourcePath)!;
  registry.upsert({
    key: { engine: "codex", sessionId: sourceId },
    artifactPath: sourcePath,
    cwd: directory,
    accountId: "legacy",
    launchProfile: profile,
    status: "idle",
    host: {
      kind: "tmux",
      endpoint: "tmux:fresh-journal",
      server: { pid: 201, startIdentity: "server:201" },
      paneId: "%201",
      panePid: { pid: 202, startIdentity: "pane:202" },
      windowName: "fresh-journal",
      agent: { pid: 203, startIdentity: "agent:203" },
      argv: ["codex", "resume", sourceId],
    },
    structuredHost: null,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeJournalClient(journal);

  await adoptStructuredHostsAtStartup({
    registry,
    client,
    adopt: async () => [],
    adoptClaude: async () => [],
  } as StructuredStartupDependencies);

  expect(journal.snapshot().sessions).toMatchObject([{
    conversationId: conversation.id,
    sessionKey: { engine: "codex", sessionId: sourceId },
    hostKind: "tmux-legacy",
    host: "hosted",
    artifactPath: sourcePath,
  }]);
  const delivery = await enqueueStructuredMessage({
    path: sourcePath,
    text: "continue through tmux",
    clientMessageId: "fresh-journal-legacy-message",
    hasImages: false,
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
  });
  expect(delivery).toBeNull();

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

function addStructuredRestartConversation(
  registry: AgentRegistry,
  directory: string,
  input: {
    engine?: "codex" | "claude";
    sessionId: string;
    status: "live" | "dead";
    turn: "busy" | "terminal" | "unknown";
    activeTurnRef?: string | null;
    transcriptRecords?: Record<string, unknown>[];
    transcriptSuffix?: string;
    alignFirstRecordToTailBoundary?: boolean;
  },
) {
  const engine = input.engine ?? "codex";
  const artifactPath = path.join(directory, `${input.sessionId}.jsonl`);
  const transcript = (input.transcriptRecords ?? []).map((record) => JSON.stringify(record)).join("\n") + (input.transcriptSuffix ?? "");
  fs.writeFileSync(artifactPath, input.alignFirstRecordToTailBoundary
    ? `${JSON.stringify({ padding: "before-window" })}\n${transcript}${" ".repeat(128 * 1024 - Buffer.byteLength(transcript))}`
    : transcript);
  const launchProfile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{
    engine,
    path: artifactPath,
    accountId: null,
    launchProfile,
    turn: {
      state: input.turn,
      source: "lifecycle",
      terminalAt: input.turn === "terminal" ? "2026-07-15T06:00:00.000Z" : null,
    },
    observedAt: "2026-07-15T06:00:00.000Z",
  }]);
  const conversation = registry.conversationForPath(artifactPath)!;
  registry.upsert({
    key: { engine, sessionId: input.sessionId },
    artifactPath,
    cwd: directory,
    accountId: null,
    launchProfile,
    status: input.status,
    host: null,
    structuredHost: {
      kind: engine === "codex" ? "codex-app-server" : "claude-broker",
      endpoint: "stdio:retained",
      process: null,
      eventCursor: 8,
      protocolVersion: "test",
      writerClaimEpoch: 3,
      activeTurnRef: input.activeTurnRef ?? null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 3,
    claimOwner: null,
    pendingAction: null,
  });
  return { artifactPath, conversation };
}

async function startupAdoptionAttempts(
  registry: AgentRegistry,
  client: RuntimeHostClient | null = null,
): Promise<string[]> {
  const attempts: string[] = [];
  const select = (
    engine: "codex" | "claude",
    received: AgentRegistry,
    shouldAdopt: StructuredHostAdoptionFilter,
  ) => {
    for (const entry of Object.values(received.snapshot().entries)) {
      if (entry.key.engine === engine && shouldAdopt(entry)) attempts.push(`${entry.key.engine}:${entry.key.sessionId}`);
    }
  };
  await adoptStructuredHostsAtStartup({
    registry,
    client,
    adopt: async (received, _optionsFor, _env, shouldAdopt = () => true) => {
      select("codex", received, shouldAdopt);
      return [];
    },
    adoptClaude: async (received, _optionsFor, _env, shouldAdopt = () => true) => {
      select("claude", received, shouldAdopt);
      return [];
    },
  });
  return attempts;
}

function claudeTerminalRecord() {
  return {
    type: "assistant",
    timestamp: "2026-07-15T10:00:00.000Z",
    message: { role: "assistant", content: [], stop_reason: "end_turn" },
  };
}

test("startup adoption boots one live unfinished host across terminal history", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-adoption-gate-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const liveSessionId = "11111111-1111-0111-0111-111111111111";
  addStructuredRestartConversation(registry, directory, {
    sessionId: liveSessionId,
    status: "live",
    turn: "busy",
    activeTurnRef: "turn-live",
  });
  for (let index = 2; index <= 8; index += 1) {
    const digit = String(index);
    addStructuredRestartConversation(registry, directory, {
      sessionId: `${digit.repeat(8)}-${digit.repeat(4)}-0${digit.repeat(3)}-0${digit.repeat(3)}-${digit.repeat(12)}`,
      status: "live",
      turn: "terminal",
      activeTurnRef: `stale-turn-${digit}`,
    });
  }

  expect(await startupAdoptionAttempts(registry)).toEqual([`codex:${liveSessionId}`]);

  fs.rmSync(directory, { recursive: true, force: true });
});

test("unknown Codex durable state continues when the structured host retains an active turn", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-codex-unknown-active-turn-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const sessionId = "00000000-0000-0000-0000-000000000000";
  const { conversation } = addStructuredRestartConversation(registry, directory, {
    sessionId,
    status: "live",
    turn: "unknown",
    activeTurnRef: "turn-retained-through-unknown-state",
  });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeJournalClient(journal);
  const ledger = createFakeDeliveryLedger();
  const host = Object.assign(new FakeEngineHost(ledger), { onStateChange: () => () => {} });

  await adoptStructuredHostsAtStartup({
    registry,
    client,
    adopt: async () => [{ key: { engine: "codex", sessionId }, host: host as never }],
    adoptClaude: async () => [],
  });

  expect(registry.conversation(conversation.id)?.turn.state).toBe("unknown");
  expect(ledger.writes).toEqual([expect.objectContaining({
    id: `recovery-continuation-${sessionId}-3`,
    text: "Continue the interrupted turn from the transcript.",
  })]);

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("unknown Codex durable state continues from runtime-running evidence", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-codex-unknown-running-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const sessionId = "00000000-0000-0000-0000-000000000000";
  const { artifactPath, conversation } = addStructuredRestartConversation(registry, directory, {
    sessionId,
    status: "live",
    turn: "unknown",
    activeTurnRef: null,
  });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  projectHostedRestart(journal, "codex", conversation.id, sessionId, directory, artifactPath, "running");
  const client = runtimeJournalClient(journal);
  const ledger = createFakeDeliveryLedger();
  const host = Object.assign(new FakeEngineHost(ledger), { onStateChange: () => () => {} });

  await adoptStructuredHostsAtStartup({
    registry,
    client,
    adopt: async () => [{ key: { engine: "codex", sessionId }, host: host as never }],
    adoptClaude: async () => [],
  });

  expect(ledger.writes).toEqual([expect.objectContaining({
    id: `recovery-continuation-${sessionId}-3`,
  })]);

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test.each(["terminal", "superseded"] as const)(
  "%s Codex conversation stays outside startup continuation",
  async (condition) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `llv-runtime-startup-codex-${condition}-continuation-`));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const sessionId = "00000000-0000-0000-0000-000000000000";
    const { conversation } = addStructuredRestartConversation(registry, directory, {
      sessionId,
      status: condition === "superseded" ? "dead" : "live",
      turn: condition === "terminal" ? "terminal" : "unknown",
      activeTurnRef: "stale-predecessor-turn",
    });
    if (condition === "superseded") {
      const successor = registry.ensureConversation("codex", path.join(directory, "successor.jsonl"), null);
      registry.recordSupersedence(conversation.id, successor.id, "recovery-spawn");
      const entry = registry.snapshot().entries[`codex:${sessionId}`]!;
      registry.upsert({ ...entry, status: "live" });
    }
    const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
    const client = runtimeJournalClient(journal);
    const ledger = createFakeDeliveryLedger();
    const host = Object.assign(new FakeEngineHost(ledger), { onStateChange: () => () => {} });

    await adoptStructuredHostsAtStartup({
      registry,
      client,
      adopt: async () => [{ key: { engine: "codex", sessionId }, host: host as never }],
      adoptClaude: async () => [],
    });

    expect(ledger.writes).toEqual([]);

    await bindStructuredDeliveryQueue([], { registry, client: null });
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  },
);

test("a busy Codex turn advances after container replacement without operator messaging", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-codex-continuation-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const sessionId = "11111111-2222-0222-0222-111111111111";
  const { artifactPath, conversation } = addStructuredRestartConversation(registry, directory, {
    sessionId,
    status: "live",
    turn: "busy",
    activeTurnRef: "turn-interrupted-by-promotion",
    transcriptRecords: [{ timestamp: "2026-07-20T11:47:00.000Z", payload: { type: "task_started" } }],
  });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeJournalClient(journal);
  const ledger = createFakeDeliveryLedger();
  const baseHost = new FakeEngineHost(ledger);
  let host = Object.assign(baseHost, {
    onStateChange: () => () => {},
    send: async (entry: Parameters<FakeEngineHost["send"]>[0]) => {
      const receipt = await FakeEngineHost.prototype.send.call(baseHost, entry);
      fs.appendFileSync(artifactPath, `${JSON.stringify({
        timestamp: "2026-07-20T11:50:00.000Z",
        payload: { type: "user_message", text: entry.text },
      })}\n`);
      return receipt;
    },
  });
  const before = fs.statSync(artifactPath).size;

  const startup = () => adoptStructuredHostsAtStartup({
    registry,
    client,
    adopt: async (received, _optionsFor, _env, shouldAdopt = () => true) => {
      const entry = received.snapshot().entries[`codex:${sessionId}`];
      return entry?.structuredHost && shouldAdopt(entry)
        ? [{ key: { engine: "codex", sessionId }, host: host as never }]
        : [];
    },
    adoptClaude: async () => [],
  });
  await startup();

  await waitFor(() => ledger.writes.length === 1);
  expect(ledger.writes).toEqual([expect.objectContaining({
    text: "Continue the interrupted turn from the transcript.",
  })]);
  expect(fs.statSync(artifactPath).size).toBeGreaterThan(before);
  expect(registry.conversation(conversation.id)?.id).toBe(conversation.id);
  const advanced = fs.statSync(artifactPath).size;

  await startup();
  expect(ledger.writes).toHaveLength(1);
  expect(fs.statSync(artifactPath).size).toBe(advanced);

  const nextLedger = createFakeDeliveryLedger();
  const nextBaseHost = new FakeEngineHost(nextLedger);
  host = Object.assign(nextBaseHost, {
    onStateChange: () => () => {},
    send: async (entry: Parameters<FakeEngineHost["send"]>[0]) => {
      const receipt = await FakeEngineHost.prototype.send.call(nextBaseHost, entry);
      fs.appendFileSync(artifactPath, `${JSON.stringify({
        timestamp: "2026-07-20T11:55:00.000Z",
        payload: { type: "user_message", text: entry.text },
      })}\n`);
      return receipt;
    },
  });
  const entry = registry.snapshot().entries[`codex:${sessionId}`]!;
  registry.upsert({
    ...entry,
    claimEpoch: 4,
    structuredHost: { ...entry.structuredHost!, writerClaimEpoch: 4 },
  });

  await startup();
  await waitFor(() => nextLedger.writes.length === 1);
  expect(nextLedger.writes).toEqual([expect.objectContaining({
    id: `recovery-continuation-${sessionId}-4`,
  })]);
  expect(fs.statSync(artifactPath).size).toBeGreaterThan(advanced);

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("a repeated promotion reuses one pending Codex continuation", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-codex-pending-continuation-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const sessionId = "11111111-3333-0333-0333-111111111111";
  const { artifactPath, conversation } = addStructuredRestartConversation(registry, directory, {
    sessionId,
    status: "live",
    turn: "busy",
    activeTurnRef: "turn-interrupted-before-retry",
    transcriptRecords: [{ timestamp: "2026-07-20T11:47:00.000Z", payload: { type: "task_started" } }],
  });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeJournalClient(journal);
  projectHostedRestart(journal, "codex", conversation.id, sessionId, directory, artifactPath);
  const pendingOperationId = `recovery-continuation-${sessionId}-3`;
  journal.executeOperation({
    kind: "send",
    operationId: pendingOperationId,
    idempotencyKey: pendingOperationId,
    conversationId: conversation.id,
    text: "Continue the interrupted turn from the transcript.",
    policy: "queue",
    turnId: null,
  });
  const entry = registry.snapshot().entries[`codex:${sessionId}`]!;
  registry.upsert({
    ...entry,
    claimEpoch: 5,
    structuredHost: { ...entry.structuredHost!, writerClaimEpoch: 5 },
  });
  const ledger = createFakeDeliveryLedger();
  const host = Object.assign(new FakeEngineHost(ledger), { onStateChange: () => () => {} });

  await adoptStructuredHostsAtStartup({
    registry,
    client,
    adopt: async () => [{ key: { engine: "codex", sessionId }, host: host as never }],
    adoptClaude: async () => [],
  });

  expect(ledger.writes).toEqual([expect.objectContaining({ id: pendingOperationId })]);
  expect(journal.operationResult(`recovery-continuation-${sessionId}-5`)).toBeNull();

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("startup retries a failed Codex continuation once through the published successor", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-codex-continuation-retry-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const sessionId = "11111111-4444-0444-0444-111111111111";
  const { artifactPath, conversation } = addStructuredRestartConversation(registry, directory, {
    sessionId,
    status: "live",
    turn: "busy",
    activeTurnRef: "turn-interrupted-before-failed-continuation",
    transcriptRecords: [{ timestamp: "2026-07-20T11:47:00.000Z", payload: { type: "task_started" } }],
  });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeJournalClient(journal);
  projectHostedRestart(journal, "codex", conversation.id, sessionId, directory, artifactPath);
  const failedOperationId = `recovery-continuation-${sessionId}-3`;
  journal.executeOperation({
    kind: "send",
    operationId: failedOperationId,
    idempotencyKey: failedOperationId,
    conversationId: conversation.id,
    text: "Continue the interrupted turn from the transcript.",
    policy: "queue",
    turnId: null,
  });
  journal.transitionOperation(failedOperationId, "delivering");
  journal.transitionOperation(failedOperationId, "failed", { reason: "successor socket closed" });
  const entry = registry.snapshot().entries[`codex:${sessionId}`]!;
  registry.upsert({
    ...entry,
    claimEpoch: 4,
    structuredHost: { ...entry.structuredHost!, writerClaimEpoch: 4 },
  });
  const ledger = createFakeDeliveryLedger();
  const host = Object.assign(new FakeEngineHost(ledger), { onStateChange: () => () => {} });
  const startup = () => adoptStructuredHostsAtStartup({
    registry,
    client,
    adopt: async () => [{ key: { engine: "codex", sessionId }, host: host as never }],
    adoptClaude: async () => [],
  });

  await startup();

  expect(journal.currentRetryResult(failedOperationId)?.receipt).toMatchObject({
    retryOfOperationId: failedOperationId,
    status: "delivered",
  });
  expect(journal.operationResult(`recovery-continuation-${sessionId}-4`)).toBeNull();
  expect(ledger.writes).toHaveLength(1);

  await startup();
  expect(ledger.writes).toHaveLength(1);

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("startup retries one failed same-epoch Codex continuation after a lost admission response", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-codex-same-epoch-retry-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const sessionId = "00000000-0000-0000-0000-000000000000";
  const { artifactPath, conversation } = addStructuredRestartConversation(registry, directory, {
    sessionId,
    status: "live",
    turn: "busy",
    activeTurnRef: "turn-interrupted-after-admission",
    transcriptRecords: [{ timestamp: "2026-07-20T11:47:00.000Z", payload: { type: "task_started" } }],
  });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeJournalClient(journal);
  projectHostedRestart(journal, "codex", conversation.id, sessionId, directory, artifactPath);
  const failedOperationId = `recovery-continuation-${sessionId}-3`;
  journal.executeOperation({
    kind: "send",
    operationId: failedOperationId,
    idempotencyKey: failedOperationId,
    conversationId: conversation.id,
    text: "Continue the interrupted turn from the transcript.",
    policy: "queue",
    turnId: null,
  });
  journal.transitionOperation(failedOperationId, "delivering");
  journal.transitionOperation(failedOperationId, "failed", { reason: "response lost after durable admission" });
  const ledger = createFakeDeliveryLedger();
  const host = Object.assign(new FakeEngineHost(ledger), { onStateChange: () => () => {} });
  const startup = () => adoptStructuredHostsAtStartup({
    registry,
    client,
    adopt: async () => [{ key: { engine: "codex", sessionId }, host: host as never }],
    adoptClaude: async () => [],
  });

  await startup();

  expect(journal.currentRetryResult(failedOperationId)?.receipt).toMatchObject({
    retryOfOperationId: failedOperationId,
    idempotencyKey: `${failedOperationId}-retry-1`,
    status: "delivered",
  });
  expect(ledger.writes).toHaveLength(1);
  expect(registry.snapshot().entries[`codex:${sessionId}`]!.claimEpoch).toBe(3);

  await startup();
  expect(ledger.writes).toHaveLength(1);
  expect(journal.snapshot().recentOperations.filter((receipt) =>
    receipt.retryOfOperationId === failedOperationId)).toHaveLength(1);

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("startup preserves a queued user draft before the Codex continuation", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-codex-draft-order-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const sessionId = "11111111-5555-0555-0555-111111111111";
  const { artifactPath, conversation } = addStructuredRestartConversation(registry, directory, {
    sessionId,
    status: "live",
    turn: "busy",
    activeTurnRef: "turn-interrupted-with-queued-draft",
    transcriptRecords: [{ timestamp: "2026-07-20T11:47:00.000Z", payload: { type: "task_started" } }],
  });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeJournalClient(journal);
  projectHostedRestart(journal, "codex", conversation.id, sessionId, directory, artifactPath);
  journal.executeOperation({
    kind: "send",
    operationId: "queued-user-draft-before-promotion",
    idempotencyKey: "queued-user-draft-before-promotion",
    conversationId: conversation.id,
    text: "keep this queued draft lossless",
    policy: "queue",
    turnId: null,
  });
  const ledger = createFakeDeliveryLedger();
  const host = Object.assign(new FakeEngineHost(ledger), { onStateChange: () => () => {} });

  await adoptStructuredHostsAtStartup({
    registry,
    client,
    adopt: async () => [{ key: { engine: "codex", sessionId }, host: host as never }],
    adoptClaude: async () => [],
  });

  expect(ledger.writes.map(({ id, text }) => ({ id, text }))).toEqual([
    { id: "queued-user-draft-before-promotion", text: "keep this queued draft lossless" },
    {
      id: `recovery-continuation-${sessionId}-3`,
      text: "Continue the interrupted turn from the transcript.",
    },
  ]);
  expect(journal.operationResult("queued-user-draft-before-promotion")?.receipt).toMatchObject({
    status: "delivered",
    text: "keep this queued draft lossless",
  });

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("startup adoption reads terminal transcripts before booting production-shaped stale registry rows", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-transcript-gate-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const activeSessionId = "11111111-aaaa-0111-0111-111111111111";
  addStructuredRestartConversation(registry, directory, {
    sessionId: activeSessionId,
    status: "live",
    turn: "busy",
    activeTurnRef: "turn-active",
    transcriptRecords: [{ timestamp: "2026-07-15T10:00:00.000Z", payload: { type: "task_started" } }],
  });
  for (const engine of ["codex", "claude"] as const) {
    for (let index = 0; index < 10; index += 1) {
      const sessionId = `${engine === "codex" ? "2" : "3"}0000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      addStructuredRestartConversation(registry, directory, {
        engine,
        sessionId,
        status: "live",
        turn: "busy",
        activeTurnRef: `stale-${engine}-${index}`,
        transcriptRecords: engine === "codex"
          ? [{ timestamp: "2026-07-15T10:00:00.000Z", payload: { type: "task_complete" } }]
          : [claudeTerminalRecord()],
      });
    }
  }

  const startedAt = performance.now();
  expect(await startupAdoptionAttempts(registry)).toEqual([`codex:${activeSessionId}`]);
  expect(performance.now() - startedAt).toBeLessThan(1_000);

  fs.rmSync(directory, { recursive: true, force: true });
});

test.each(["codex", "claude"] as const)(
  "startup adopts a persisted terminal %s conversation whose transcript starts a new turn before restart",
  async (engine) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `llv-runtime-startup-reopened-${engine}-`));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const sessionId = `${engine === "codex" ? "2" : "3"}1000000-0000-0000-0000-000000000001`;
    const { conversation } = addStructuredRestartConversation(registry, directory, {
      engine,
      sessionId,
      status: "live",
      turn: "terminal",
      activeTurnRef: `fresh-${engine}-turn`,
      transcriptRecords: engine === "codex"
        ? [{ timestamp: "2026-07-15T10:01:00.000Z", payload: { type: "task_started" } }]
        : [{ type: "user", timestamp: "2026-07-15T10:01:00.000Z", message: { role: "user", content: [] } }],
    });

    expect(await startupAdoptionAttempts(registry)).toEqual([`${engine}:${sessionId}`]);
    expect(registry.conversation(conversation.id)?.turn.state).toBe("busy");

    fs.rmSync(directory, { recursive: true, force: true });
  },
);

test("startup keeps a Codex host eligible when the bounded tail cuts off an unmatched tool call", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-cutoff-tool-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const sessionId = "41000000-0000-0000-0000-000000000001";
  const transcriptRecords = [
    { timestamp: "2026-07-15T10:00:00.000Z", payload: { type: "task_started", turn_id: "turn-1" } },
    {
      timestamp: "2026-07-15T10:00:01.000Z",
      payload: { type: "function_call", call_id: "tool-before-cutoff", arguments: "x".repeat(128 * 1024) },
    },
    { timestamp: "2026-07-15T10:00:02.000Z", payload: { type: "task_complete", turn_id: "turn-1" } },
  ];
  expect(turnStateFromRecords(transcriptRecords, true)).toBe("busy");
  addStructuredRestartConversation(registry, directory, {
    sessionId,
    status: "live",
    turn: "busy",
    activeTurnRef: "turn-1",
    transcriptRecords,
  });

  expect(await startupAdoptionAttempts(registry)).toEqual([`codex:${sessionId}`]);

  fs.rmSync(directory, { recursive: true, force: true });
});

test.each(["codex", "claude"] as const)(
  "a clean terminal %s transcript stays retired across repeated startup",
  async (engine) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `llv-runtime-startup-repeat-terminal-${engine}-`));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const sessionId = `${engine === "codex" ? "f" : "1"}0000000-0000-0000-0000-000000000001`;
    const { conversation } = addStructuredRestartConversation(registry, directory, {
      engine,
      sessionId,
      status: "live",
      turn: "busy",
      activeTurnRef: `stale-${engine}`,
      transcriptRecords: engine === "codex"
        ? [
            { timestamp: "2026-07-15T10:00:00.000Z", payload: { type: "task_started", turn_id: "turn-1" } },
            { timestamp: "2026-07-15T10:00:01.000Z", payload: { type: "function_call", call_id: "tool-1" } },
            { timestamp: "2026-07-15T10:00:02.000Z", payload: { type: "function_call_output", call_id: "tool-1" } },
            { timestamp: "2026-07-15T10:00:03.000Z", payload: { type: "task_complete", turn_id: "turn-1" } },
          ]
        : [claudeTerminalRecord()],
    });

    expect(await startupAdoptionAttempts(registry)).toEqual([]);
    expect(registry.conversation(conversation.id)?.turn.state).toBe("terminal");
    expect(await startupAdoptionAttempts(registry)).toEqual([]);
    expect(registry.conversation(conversation.id)?.turn.state).toBe("terminal");

    fs.rmSync(directory, { recursive: true, force: true });
  },
);

test("a production-shaped Claude broker transcript ending in end_turn stays retired across repeated startup", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-repeat-broker-terminal-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const sessionId = "10000000-0000-0000-0000-000000000002";
  const { conversation } = addStructuredRestartConversation(registry, directory, {
    engine: "claude",
    sessionId,
    status: "live",
    turn: "busy",
    activeTurnRef: "stale-claude-broker-turn",
    transcriptRecords: [
      {
        type: "user",
        uuid: "20000000-0000-0000-0000-000000000001",
        parentUuid: null,
        sessionId,
        timestamp: "2026-07-15T10:00:00.000Z",
        message: { role: "user", content: [] },
      },
      {
        type: "assistant",
        uuid: "20000000-0000-0000-0000-000000000002",
        parentUuid: "20000000-0000-0000-0000-000000000001",
        sessionId,
        timestamp: "2026-07-15T10:00:01.000Z",
        message: { role: "assistant", content: [], stop_reason: "end_turn" },
      },
    ],
  });

  expect(await startupAdoptionAttempts(registry)).toEqual([]);
  expect(registry.conversation(conversation.id)?.turn.state).toBe("terminal");
  expect(await startupAdoptionAttempts(registry)).toEqual([]);
  expect(registry.conversation(conversation.id)?.turn.state).toBe("terminal");

  fs.rmSync(directory, { recursive: true, force: true });
});

test.each(["codex", "claude"] as const)(
  "a 128 KiB-aligned terminal %s transcript stays retired across repeated startup",
  async (engine) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `llv-runtime-startup-repeat-aligned-terminal-${engine}-`));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const sessionId = `${engine === "codex" ? "4" : "5"}0000000-0000-4000-8000-000000000001`;
    const { conversation } = addStructuredRestartConversation(registry, directory, {
      engine,
      sessionId,
      status: "live",
      turn: "busy",
      activeTurnRef: `stale-${engine}`,
      transcriptRecords: engine === "codex"
        ? [
            { timestamp: "2026-07-15T10:00:00.000Z", payload: { type: "task_started", turn_id: "turn-1" } },
            { timestamp: "2026-07-15T10:00:01.000Z", payload: { type: "function_call", call_id: "tool-1" } },
            { timestamp: "2026-07-15T10:00:02.000Z", payload: { type: "function_call_output", call_id: "tool-1" } },
            { timestamp: "2026-07-15T10:00:03.000Z", payload: { type: "task_complete", turn_id: "turn-1" } },
          ]
        : [claudeTerminalRecord()],
      alignFirstRecordToTailBoundary: true,
    });

    expect(await startupAdoptionAttempts(registry)).toEqual([]);
    expect(registry.conversation(conversation.id)?.turn.state).toBe("terminal");
    expect(await startupAdoptionAttempts(registry)).toEqual([]);
    expect(registry.conversation(conversation.id)?.turn.state).toBe("terminal");

    fs.rmSync(directory, { recursive: true, force: true });
  },
);

test.each(["codex", "claude"] as const)(
  "startup keeps a %s host adoption-eligible when malformed JSON follows a terminal marker",
  async (engine) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `llv-runtime-startup-corrupt-tail-${engine}-`));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const sessionId = `${engine === "codex" ? "7" : "8"}0000000-0000-4000-8000-000000000000`;
    addStructuredRestartConversation(registry, directory, {
      engine,
      sessionId,
      status: "live",
      turn: "busy",
      activeTurnRef: `active-${engine}`,
      transcriptRecords: engine === "codex"
        ? [{ timestamp: "2026-07-15T10:00:00.000Z", payload: { type: "task_complete" } }]
        : [claudeTerminalRecord()],
      transcriptSuffix: "\n{corrupt",
    });

    expect(await startupAdoptionAttempts(registry)).toEqual([`${engine}:${sessionId}`]);

    fs.rmSync(directory, { recursive: true, force: true });
  },
);

test.each(["codex", "claude"] as const)(
  "startup keeps a %s host adoption-eligible when a truncated record follows a terminal marker",
  async (engine) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `llv-runtime-startup-truncated-tail-${engine}-`));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const sessionId = `${engine === "codex" ? "9" : "a"}0000000-0000-4000-8000-000000000000`;
    addStructuredRestartConversation(registry, directory, {
      engine,
      sessionId,
      status: "live",
      turn: "busy",
      activeTurnRef: `active-${engine}`,
      transcriptRecords: engine === "codex"
        ? [{ timestamp: "2026-07-15T10:00:00.000Z", payload: { type: "task_complete" } }]
        : [claudeTerminalRecord()],
      transcriptSuffix: '\n{"next_turn":',
    });

    expect(await startupAdoptionAttempts(registry)).toEqual([`${engine}:${sessionId}`]);

    fs.rmSync(directory, { recursive: true, force: true });
  },
);

test.each(["codex", "claude"] as const)(
  "startup keeps a %s host adoption-eligible while its transcript grows during the tail read",
  async (engine) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `llv-runtime-startup-growing-tail-${engine}-`));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const sessionId = `${engine === "codex" ? "b" : "c"}0000000-0000-4000-8000-000000000000`;
    const { artifactPath } = addStructuredRestartConversation(registry, directory, {
      engine,
      sessionId,
      status: "live",
      turn: "busy",
      activeTurnRef: `active-${engine}`,
      transcriptRecords: engine === "codex"
        ? [{ timestamp: "2026-07-15T10:00:00.000Z", payload: { type: "task_complete" } }]
        : [claudeTerminalRecord()],
    });
    const realOpen = fs.promises.open.bind(fs.promises);
    const open = spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (String(args[0]) !== artifactPath) return handle;
      const realRead = handle.read.bind(handle);
      let appended = false;
      handle.read = (async (...readArgs: Parameters<typeof handle.read>) => {
        const result = await realRead(...readArgs);
        if (!appended) {
          appended = true;
          fs.appendFileSync(artifactPath, '\n{"type":"user"}');
        }
        return result;
      }) as typeof handle.read;
      return handle;
    });

    try {
      expect(await startupAdoptionAttempts(registry)).toEqual([`${engine}:${sessionId}`]);
    } finally {
      open.mockRestore();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);

test.each([
  ["codex", "missing"],
  ["codex", "unreadable"],
  ["claude", "missing"],
  ["claude", "unreadable"],
] as const)(
  "startup keeps a %s host adoption-eligible when its transcript path is %s",
  async (engine, condition) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `llv-runtime-startup-${condition}-${engine}-`));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const sessionId = `${engine === "codex" ? "d" : "e"}0000000-0000-4000-8000-000000000000`;
    const { artifactPath } = addStructuredRestartConversation(registry, directory, {
      engine,
      sessionId,
      status: "live",
      turn: "busy",
      activeTurnRef: `active-${engine}`,
      transcriptRecords: engine === "codex"
        ? [{ timestamp: "2026-07-15T10:00:00.000Z", payload: { type: "task_complete" } }]
        : [claudeTerminalRecord()],
    });
    if (condition === "missing") fs.rmSync(artifactPath);
    else fs.chmodSync(artifactPath, 0o000);

    expect(await startupAdoptionAttempts(registry)).toEqual([`${engine}:${sessionId}`]);

    if (condition === "unreadable") fs.chmodSync(artifactPath, 0o600);
    fs.rmSync(directory, { recursive: true, force: true });
  },
);

test("an explicit terminal transcript outranks a stale running runtime projection", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-terminal-runtime-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const sessionId = "60000000-0000-0000-0000-000000000000";
  const { artifactPath, conversation } = addStructuredRestartConversation(registry, directory, {
    sessionId,
    status: "live",
    turn: "busy",
    activeTurnRef: "stale-running-turn",
    transcriptRecords: [{ timestamp: "2026-07-15T10:00:00.000Z", payload: { type: "task_complete" } }],
  });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey: { engine: "codex", sessionId },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "running",
      activeTurnId: "stale-running-turn",
      provenance: "structured",
      artifactPath,
      capabilities: { steer: true, structuredAttention: true },
    },
  });

  expect(await startupAdoptionAttempts(registry, runtimeJournalClient(journal))).toEqual([]);

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("startup adoption boots a terminal host with a pending delivery", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-pending-delivery-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const sessionId = "99999999-9999-0999-0999-999999999999";
  const { conversation } = addStructuredRestartConversation(registry, directory, {
    sessionId,
    status: "dead",
    turn: "terminal",
  });
  registry.holdDelivery(conversation.id, "deliver after restart", "pending-at-restart");

  expect(await startupAdoptionAttempts(registry)).toEqual([`codex:${sessionId}`]);

  fs.rmSync(directory, { recursive: true, force: true });
});

test("startup adoption never revives a superseded round, even with pending work (#383)", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-superseded-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const sessionId = "38338383-8383-0383-0383-838383838383";
  const { conversation } = addStructuredRestartConversation(registry, directory, {
    sessionId,
    status: "dead",
    turn: "terminal",
  });
  /* Pending work alone would adopt this host (test above) — the terminal
     supersedence edge must outrank it: the successor owns the work now. */
  registry.holdDelivery(conversation.id, "deliver after restart", "pending-superseded");
  const successor = registry.ensureConversation("codex", path.join(directory, "successor.jsonl"), null);
  registry.recordSupersedence(conversation.id, successor.id, "recovery-spawn");

  expect(await startupAdoptionAttempts(registry)).toEqual([]);

  fs.rmSync(directory, { recursive: true, force: true });
});

test.each(["text", "ephemeral-images"] as const)(
  "startup adoption leaves a terminal host dead when its %s delivery has failed",
  async (payloadKind) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `llv-runtime-startup-failed-${payloadKind}-`));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const sessionId = payloadKind === "text"
      ? "dddddddd-1111-0111-0111-dddddddddddd"
      : "eeeeeeee-1111-0111-0111-eeeeeeeeeeee";
    const { conversation } = addStructuredRestartConversation(registry, directory, {
      sessionId,
      status: "dead",
      turn: "terminal",
    });
    const delivery = registry.holdDelivery(
      conversation.id,
      payloadKind === "text" ? "failed before restart" : "",
      `failed-${payloadKind}`,
      payloadKind,
    );
    registry.recordDeliveryOutcome(delivery.id, "failed", "delivery failed before restart");

    expect(await startupAdoptionAttempts(registry)).toEqual([]);
    expect(registry.snapshot().entries[`codex:${sessionId}`]).toMatchObject({
      status: "dead",
      claimOwner: null,
      structuredHost: {
        endpoint: "stdio:released",
        process: null,
        activeTurnRef: null,
      },
    });

    fs.rmSync(directory, { recursive: true, force: true });
  },
);

test("startup adoption keeps the PID-only claim targeted by a queued runtime send", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-queued-operation-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const sessionId = "bbbbbbbb-1111-0111-0111-bbbbbbbbbbbb";
  const { artifactPath, conversation } = addStructuredRestartConversation(registry, directory, {
    sessionId,
    status: "dead",
    turn: "terminal",
  });
  addStructuredRestartConversation(registry, directory, {
    sessionId: "cccccccc-1111-0111-0111-cccccccccccc",
    status: "dead",
    turn: "terminal",
  });
  const key = { engine: "codex" as const, sessionId };
  const entry = registry.snapshot().entries[`codex:${sessionId}`]!;
  const claimOwner = `structured-host:${JSON.stringify({ pid: process.pid, startIdentity: null })}`;
  registry.upsert({
    ...entry,
    claimEpoch: entry.claimEpoch + 1,
    claimOwner,
    structuredHost: {
      ...entry.structuredHost!,
      writerClaimEpoch: entry.claimEpoch + 1,
    },
  });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: conversation.id },
    kind: "session-status",
    payload: {
      conversationId: conversation.id,
      sessionKey: { engine: "codex", sessionId },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      artifactPath,
      capabilities: { steer: true, structuredAttention: true },
    },
  });
  const queued = journal.executeOperation({
    kind: "send",
    operationId: "queued-at-restart",
    idempotencyKey: "queued-at-restart",
    conversationId: conversation.id,
    text: "continue queued work",
    policy: "queue",
  });
  expect(queued.receipt.status).toBe("queued");

  expect(await startupAdoptionAttempts(registry, runtimeJournalClient(journal)))
    .toEqual([`codex:${sessionId}`]);
  expect(registry.snapshot().entries[`codex:${sessionId}`]).toMatchObject({
    key,
    status: "dead",
    claimOwner,
    structuredHost: { process: null },
  });

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test.each(["codex", "claude"] as const)(
  "startup drains a queued %s terminal kill without adopting its host across repeated restarts",
  async (engine) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `llv-runtime-startup-terminal-kill-${engine}-`));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const sessionId = `${engine === "codex" ? "4" : "5"}0000000-0000-4000-8000-000000000000`;
    const { artifactPath, conversation } = addStructuredRestartConversation(registry, directory, {
      engine,
      sessionId,
      status: "live",
      turn: "busy",
      activeTurnRef: "stale-terminal-turn",
      transcriptRecords: engine === "codex"
        ? [{ timestamp: "2026-07-15T10:00:00.000Z", payload: { type: "task_complete" } }]
        : [claudeTerminalRecord()],
    });
    const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
    journal.append({
      scope: { type: "session", id: conversation.id },
      kind: "session-status",
      payload: {
        conversationId: conversation.id,
        sessionKey: { engine, sessionId },
        hostKind: engine === "codex" ? "codex-app-server" : "claude-broker",
        host: "hosted",
        turn: "idle",
        provenance: "structured",
        artifactPath,
        capabilities: { steer: engine === "codex", structuredAttention: true },
      },
    });
    journal.executeOperation({
      kind: "kill",
      operationId: `terminal-kill-${engine}`,
      idempotencyKey: `terminal-kill-${engine}`,
      conversationId: conversation.id,
      sessionKey: { engine, sessionId },
    });
    const client = runtimeJournalClient(journal);

    expect(await startupAdoptionAttempts(registry, client)).toEqual([]);
    expect(journal.operationResult(`terminal-kill-${engine}`)?.receipt.status).toBe("delivered");
    expect(registry.snapshot().entries[`${engine}:${sessionId}`]).toMatchObject({
      status: "dead",
      structuredHost: null,
      claimOwner: null,
    });
    expect(await startupAdoptionAttempts(registry, client)).toEqual([]);

    await bindStructuredDeliveryQueue([], { registry, client: null });
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  },
);

test("terminal retained structured metadata stays dead and projects its finished conversation", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-terminal-retained-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const sessionId = "aaaaaaaa-1111-0111-0111-aaaaaaaaaaaa";
  const { artifactPath, conversation } = addStructuredRestartConversation(registry, directory, {
    sessionId,
    status: "dead",
    turn: "terminal",
  });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });

  expect(await startupAdoptionAttempts(registry, runtimeJournalClient(journal))).toEqual([]);
  expect(registry.conversation(conversation.id)?.turn).toMatchObject({ state: "terminal" });
  expect(registry.snapshot().entries[`codex:${sessionId}`]).toMatchObject({
    status: "dead",
    claimOwner: null,
    structuredHost: {
      endpoint: "stdio:released",
      process: null,
      activeTurnRef: null,
    },
  });
  expect(journal.snapshot().sessions).toMatchObject([{
    conversationId: conversation.id,
    sessionKey: { engine: "codex", sessionId },
    hostKind: "codex-app-server",
    host: "dead",
    turn: "unknown",
    artifactPath,
    activeTurnId: null,
  }]);

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("startup keeps a failed spawn host dead while reconciling its receipt", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-failed-spawn-"));
  const sessionId = crypto.randomUUID();
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const profile = emptyLaunchProfile({ cwd: directory });
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd: directory, accountId: "managed", launchProfile: profile });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  await client.command({
    kind: "spawn",
    operationId: begun.receipt.launchId,
    idempotencyKey: begun.receipt.launchId,
    conversationId: begun.receipt.conversationId,
    engine: "codex",
    cwd: directory,
    ["prompt"]: "recover after failed adoption",
    accountId: "managed",
    parentConversationId: null,
  });
  const key = { engine: "codex" as const, sessionId };
  const staged = registry.stageStructuredSpawn(begun.receipt.launchId, {
    key,
    artifactPath,
    cwd: directory,
    accountId: "managed",
    launchProfile: profile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:staged",
      process: null,
      eventCursor: 0,
      protocolVersion: "test-v1",
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
  await client.transitionOperation(begun.receipt.launchId, "failed", { reason: "engine process could not resume" });

  let failedAdoptions = 0;
  const dependencies: StructuredStartupDependencies = {
    registry,
    client,
    adopt: async (received, _optionsFor, _env, shouldAdopt = () => true) => {
      const entry = received.snapshot().entries[`codex:${sessionId}`];
      if (entry?.structuredHost && shouldAdopt(entry)) {
        failedAdoptions += 1;
        received.setStructuredHost(key, {
          ...entry.structuredHost,
          endpoint: "stdio:released",
          process: null,
          activeTurnRef: null,
          pendingAttention: [],
          activeFlags: [],
        }, "dead");
      }
      return [];
    },
    adoptClaude: async () => [],
  };

  expect(await adoptStructuredHostsAtStartup(dependencies)).toEqual([]);
  expect(await adoptStructuredHostsAtStartup(dependencies)).toEqual([]);

  expect(failedAdoptions).toBe(0);
  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
    state: "failed",
    error: "engine process could not resume",
  });
  expect(registry.snapshot().entries[`codex:${sessionId}`]).toMatchObject({
    status: "dead",
    structuredHost: null,
    claimOwner: null,
    pendingAction: null,
  });
  expect((await client.operationStatus(begun.receipt.launchId))?.receipt).toMatchObject({
    status: "failed",
    reason: "engine process could not resume",
  });
  expect(journal.snapshot().sessions.find((session) => session.conversationId === begun.receipt.conversationId)).toMatchObject({
    host: "dead",
    activeTurnId: null,
  });
  expect((await client.events(0)).events).toContainEqual(expect.objectContaining({
    kind: "session-status",
    payload: expect.objectContaining({
      conversationId: begun.receipt.conversationId,
      host: "dead",
      artifactPath,
    }),
  }));

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("startup keeps a delivered spawn host dead while settling its receipt", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-delivered-spawn-"));
  const sessionId = crypto.randomUUID();
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const profile = emptyLaunchProfile({ cwd: directory });
  const begun = registry.beginSpawnRequest({ engine: "codex", cwd: directory, accountId: "managed", launchProfile: profile });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  await client.command({
    kind: "spawn",
    operationId: begun.receipt.launchId,
    idempotencyKey: begun.receipt.launchId,
    conversationId: begun.receipt.conversationId,
    engine: "codex",
    cwd: directory,
    ["prompt"]: "already delivered prompt",
    accountId: "managed",
    parentConversationId: null,
  });
  const key = { engine: "codex" as const, sessionId };
  const staged = registry.stageStructuredSpawn(begun.receipt.launchId, {
    key,
    artifactPath,
    cwd: directory,
    accountId: "managed",
    launchProfile: profile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:staged",
      process: null,
      eventCursor: 0,
      protocolVersion: "test-v1",
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
  await client.transitionOperation(begun.receipt.launchId, "delivered");

  let failedAdoptions = 0;
  let recoverySendCommands = 0;
  const startupClient = {
    ...client,
    command: async (command: Parameters<RuntimeHostClient["command"]>[0]) => {
      if (command.kind === "send" || command.kind === "steer") recoverySendCommands += 1;
      return client.command(command);
    },
  } as RuntimeHostClient;
  const dependencies: StructuredStartupDependencies = {
    registry,
    client: startupClient,
    adopt: async (received, _optionsFor, _env, shouldAdopt = () => true) => {
      const entry = received.snapshot().entries[`codex:${sessionId}`];
      if (entry?.structuredHost && shouldAdopt(entry)) {
        failedAdoptions += 1;
        received.setStructuredHost(key, {
          ...entry.structuredHost,
          endpoint: "stdio:released",
          process: null,
          activeTurnRef: null,
          pendingAttention: [],
          activeFlags: [],
        }, "dead");
      }
      return [];
    },
    adoptClaude: async () => [],
  };

  expect(await adoptStructuredHostsAtStartup(dependencies)).toEqual([]);
  expect(await adoptStructuredHostsAtStartup(dependencies)).toEqual([]);

  expect(failedAdoptions).toBe(0);
  expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
    state: "completed",
    artifactPath,
    completionMode: "route-recovered",
  });
  expect(registry.snapshot().entries[`codex:${sessionId}`]).toMatchObject({
    status: "dead",
    structuredHost: null,
    claimOwner: null,
    pendingAction: null,
  });
  expect((await client.operationStatus(begun.receipt.launchId))?.receipt).toMatchObject({
    status: "delivered",
    reason: null,
  });
  await expect(client.retryOperation(begun.receipt.launchId)).rejects.toThrow("only failed runtime operations can retry");
  expect(journal.snapshot().sessions.find((session) => session.conversationId === begun.receipt.conversationId)).toMatchObject({
    host: "dead",
    activeTurnId: null,
  });
  expect(recoverySendCommands).toBe(0);
  expect(await client.effectBatch(["runtime.send", "runtime.steer"])).toEqual([]);

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("startup terminalizes a delivered Claude spawn whose unverifiable host claim survived reboot", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-delivered-claude-reboot-"));
  const sessionId = crypto.randomUUID();
  const artifactPath = path.join(directory, `${sessionId}.jsonl`);
  const transcript = `${JSON.stringify(claudeTerminalRecord())}\n`;
  fs.writeFileSync(artifactPath, transcript);
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const profile = emptyLaunchProfile({ cwd: directory, model: "claude-opus-4-8" });
  const begun = registry.beginSpawnRequest({
    engine: "claude",
    cwd: directory,
    transport: "structured",
    accountId: "managed",
    launchProfile: profile,
  });
  if (begun.kind !== "created") throw new Error("spawn receipt was unavailable");
  await client.command({
    kind: "spawn",
    operationId: begun.receipt.launchId,
    idempotencyKey: begun.receipt.launchId,
    conversationId: begun.receipt.conversationId,
    engine: "claude",
    cwd: directory,
    ["prompt"]: "already delivered Claude prompt",
    accountId: "managed",
    parentConversationId: null,
  });
  const key = { engine: "claude" as const, sessionId };
  const staged = registry.stageStructuredSpawn(begun.receipt.launchId, {
    key,
    artifactPath,
    cwd: directory,
    accountId: "managed",
    launchProfile: profile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "claude-broker",
      endpoint: "stdio:released",
      process: null,
      eventCursor: 128,
      protocolVersion: null,
      writerClaimEpoch: 3,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 3,
    claimOwner: `structured-host:${JSON.stringify({ pid: process.pid, startIdentity: null })}`,
    pendingAction: "spawn",
  });
  if (staged.kind !== "settled") throw new Error("spawn identity was unavailable");
  await client.transitionOperation(begun.receipt.launchId, "delivered");
  const receiptIds = Object.keys(registry.snapshot().receipts);

  const dependencies: StructuredStartupDependencies = {
    registry,
    client,
    adopt: async () => [],
    adoptClaude: async () => [],
  };
  expect(await adoptStructuredHostsAtStartup(dependencies)).toEqual([]);
  expect(await adoptStructuredHostsAtStartup(dependencies)).toEqual([]);

  const snapshot = registry.snapshot();
  expect(Object.keys(snapshot.receipts)).toEqual(receiptIds);
  expect(snapshot.receipts[begun.receipt.launchId]).toMatchObject({
    state: "completed",
    artifactPath,
    completionMode: "route-recovered",
    error: null,
  });
  expect(snapshot.entries[`claude:${sessionId}`]).toMatchObject({
    artifactPath,
    status: "dead",
    host: null,
    structuredHost: null,
    claimOwner: null,
    pendingAction: null,
  });
  expect((await client.operationStatus(begun.receipt.launchId))?.receipt).toMatchObject({
    status: "delivered",
    reason: null,
  });
  expect(fs.readFileSync(artifactPath, "utf8")).toBe(transcript);
  expect(journal.snapshot().sessions).toMatchObject([{
    conversationId: begun.receipt.conversationId,
    sessionKey: key,
    host: "dead",
    artifactPath,
  }]);

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("startup settles a delivered pipeline retry and collapses its rebooted predecessor exactly once", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-delivered-pipeline-reboot-"));
  const predecessorSessionId = crypto.randomUUID();
  const successorSessionId = crypto.randomUUID();
  const predecessorPath = path.join(directory, `${predecessorSessionId}.jsonl`);
  const successorPath = path.join(directory, `${successorSessionId}.jsonl`);
  const predecessorTranscript = `${JSON.stringify({
    timestamp: "2026-07-20T11:47:00.000Z",
    payload: { type: "task_complete", turn_id: "pipeline-round-1" },
  })}\n`;
  const successorTranscript = `${JSON.stringify({
    timestamp: "2026-07-20T11:52:00.000Z",
    payload: { type: "task_complete", turn_id: "pipeline-round-2" },
  })}\n`;
  fs.writeFileSync(predecessorPath, predecessorTranscript);
  fs.writeFileSync(successorPath, successorTranscript);
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"), undefined, undefined, { sqliteMode: "off" });
  const journal = new RuntimeJournal(path.join(directory, "runtime.sqlite"), { structuredHosts: true });
  const client = runtimeClient(journal);
  const profile = emptyLaunchProfile({ cwd: directory, model: "gpt-5.6-sol" });
  const staleClaimOwner = `structured-host:${JSON.stringify({ pid: process.pid, startIdentity: null })}`;
  const predecessor = registry.beginSpawnRequest({
    engine: "codex",
    cwd: directory,
    transport: "structured",
    accountId: "managed",
    launchProfile: profile,
    memberships: [{
      kind: "pipeline",
      containerId: "pipeline_reboot",
      role: "builder",
      slot: "build:1",
      stageId: "build",
      stageOrder: 0,
      round: 1,
      parentConversationId: null,
    }],
  });
  if (predecessor.kind !== "created") throw new Error("predecessor receipt was unavailable");
  const predecessorKey = { engine: "codex" as const, sessionId: predecessorSessionId };
  const predecessorSettlement = registry.settleSpawn(predecessor.receipt.launchId, {
    key: predecessorKey,
    artifactPath: predecessorPath,
    cwd: directory,
    accountId: "managed",
    launchProfile: profile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:released",
      process: null,
      eventCursor: 64,
      protocolVersion: null,
      writerClaimEpoch: 2,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 2,
    claimOwner: staleClaimOwner,
    pendingAction: null,
  });
  if (predecessorSettlement.kind !== "settled") throw new Error("predecessor settlement was unavailable");

  const successor = registry.beginSpawnRequest({
    engine: "codex",
    cwd: directory,
    transport: "structured",
    accountId: "managed",
    launchProfile: profile,
    supersedes: predecessor.receipt.conversationId,
    supersedesReason: "stage-retry",
    memberships: [{
      kind: "pipeline",
      containerId: "pipeline_reboot",
      role: "builder",
      slot: "build:2",
      stageId: "build",
      stageOrder: 0,
      round: 2,
      parentConversationId: null,
    }],
  });
  if (successor.kind !== "created") throw new Error("successor receipt was unavailable");
  await client.command({
    kind: "spawn",
    operationId: successor.receipt.launchId,
    idempotencyKey: successor.receipt.launchId,
    conversationId: successor.receipt.conversationId,
    engine: "codex",
    cwd: directory,
    ["prompt"]: "already delivered pipeline retry",
    accountId: "managed",
    parentConversationId: null,
  });
  const successorKey = { engine: "codex" as const, sessionId: successorSessionId };
  const staged = registry.stageStructuredSpawn(successor.receipt.launchId, {
    key: successorKey,
    artifactPath: successorPath,
    cwd: directory,
    accountId: "managed",
    launchProfile: profile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:released",
      process: null,
      eventCursor: 96,
      protocolVersion: null,
      writerClaimEpoch: 3,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 3,
    claimOwner: staleClaimOwner,
    pendingAction: "spawn",
  });
  if (staged.kind !== "settled") throw new Error("successor identity was unavailable");
  await client.transitionOperation(successor.receipt.launchId, "delivered");
  const before = registry.snapshot();
  const receiptIds = Object.keys(before.receipts).sort();
  const conversationIds = Object.keys(before.conversations).sort();
  expect(before.conversations[predecessor.receipt.conversationId]?.supersededBy).toBeNull();

  const dependencies: StructuredStartupDependencies = {
    registry,
    client,
    adopt: async () => [],
    adoptClaude: async () => [],
  };
  expect(await adoptStructuredHostsAtStartup(dependencies)).toEqual([]);
  expect(await adoptStructuredHostsAtStartup(dependencies)).toEqual([]);

  const snapshot = registry.snapshot();
  expect(Object.keys(snapshot.receipts).sort()).toEqual(receiptIds);
  expect(Object.keys(snapshot.conversations).sort()).toEqual(conversationIds);
  expect(snapshot.receipts[predecessor.receipt.launchId]).toMatchObject({
    state: "completed",
    conversationId: predecessor.receipt.conversationId,
    artifactPath: predecessorPath,
    error: null,
  });
  expect(snapshot.receipts[successor.receipt.launchId]).toMatchObject({
    state: "completed",
    conversationId: successor.receipt.conversationId,
    artifactPath: successorPath,
    completionMode: "route-recovered",
    error: null,
  });
  expect(snapshot.conversations[predecessor.receipt.conversationId]?.supersededBy).toMatchObject({
    conversationId: successor.receipt.conversationId,
    reason: "stage-retry",
  });
  expect(snapshot.conversations[successor.receipt.conversationId]?.supersededBy).toBeNull();
  expect(Object.values(snapshot.conversations)
    .filter((conversation) => conversation.supersededBy?.conversationId === successor.receipt.conversationId))
    .toHaveLength(1);
  expect(snapshot.pendingSupersedence).toEqual({});
  expect(snapshot.memberships[predecessor.receipt.conversationId]).toMatchObject([{ round: 1, slot: "build:1" }]);
  expect(snapshot.memberships[successor.receipt.conversationId]).toMatchObject([{ round: 2, slot: "build:2" }]);
  expect(snapshot.entries[`codex:${predecessorSessionId}`]).toMatchObject({
    status: "dead",
    structuredHost: {
      endpoint: "stdio:released",
      process: null,
      eventCursor: 64,
    },
    claimOwner: null,
  });
  expect(snapshot.entries[`codex:${successorSessionId}`]).toMatchObject({
    status: "dead",
    structuredHost: null,
    claimOwner: null,
  });
  expect(fs.readFileSync(predecessorPath, "utf8")).toBe(predecessorTranscript);
  expect(fs.readFileSync(successorPath, "utf8")).toBe(successorTranscript);

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});
