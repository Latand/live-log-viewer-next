import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { drainHeldDeliveries } from "@/lib/accounts/migration/coordinator";
import { AgentRegistry } from "@/lib/agent/registry";
import { RuntimeJournal } from "@/runtime-host/journal";
import { runStructuredHostStartup } from "@/instrumentation";

import { RuntimeHostUnavailableError, type RuntimeHostClient } from "./client";
import { bindStructuredDeliveryQueue, hasStructuredDeliveryHost } from "./structuredDeliveryController";
import { createFakeDeliveryLedger, FakeEngineHost } from "./fixtures/fakeEngineHost";
import type { StructuredHostAdoptionFilter } from "./registry";
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
    operationStatus: async (operationId) => journal.operationResult(operationId),
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
    ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
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
      turn: "idle",
      provenance: "structured",
      accountId: null,
      parentConversationId: null,
      cwd: directory,
      artifactPath,
      capabilities: { steer: engine === "codex", structuredAttention: true },
      activeTurnId: null,
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

  await adoptStructuredHostsAtStartup({
    registry,
    client,
    adopt: async () => engine === "codex" ? [{ key, host: host as never }] : [],
    adoptClaude: async () => engine === "claude" ? [{ key, host: host as never }] : [],
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
  const sourceId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
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
    sessionId: string;
    status: "live" | "dead";
    turn: "busy" | "terminal";
    activeTurnRef?: string | null;
  },
) {
  const artifactPath = path.join(directory, `${input.sessionId}.jsonl`);
  fs.writeFileSync(artifactPath, "");
  const launchProfile = emptyLaunchProfile({ cwd: directory });
  registry.reconcileConversations([{
    engine: "codex",
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
    key: { engine: "codex", sessionId: input.sessionId },
    artifactPath,
    cwd: directory,
    accountId: null,
    launchProfile,
    status: input.status,
    host: null,
    structuredHost: {
      kind: "codex-app-server",
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

test("startup adoption boots one live unfinished host across terminal history", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-adoption-gate-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const liveSessionId = "11111111-1111-4111-8111-111111111111";
  addStructuredRestartConversation(registry, directory, {
    sessionId: liveSessionId,
    status: "live",
    turn: "busy",
    activeTurnRef: "turn-live",
  });
  for (let index = 2; index <= 8; index += 1) {
    const digit = String(index);
    addStructuredRestartConversation(registry, directory, {
      sessionId: `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`,
      status: "live",
      turn: "terminal",
      activeTurnRef: `stale-turn-${digit}`,
    });
  }

  expect(await startupAdoptionAttempts(registry)).toEqual([`codex:${liveSessionId}`]);

  fs.rmSync(directory, { recursive: true, force: true });
});

test("startup adoption boots a terminal host with a pending delivery", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-pending-delivery-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const sessionId = "99999999-9999-4999-8999-999999999999";
  const { conversation } = addStructuredRestartConversation(registry, directory, {
    sessionId,
    status: "dead",
    turn: "terminal",
  });
  registry.holdDelivery(conversation.id, "deliver after restart", "pending-at-restart");

  expect(await startupAdoptionAttempts(registry)).toEqual([`codex:${sessionId}`]);

  fs.rmSync(directory, { recursive: true, force: true });
});

test.each(["text", "ephemeral-images"] as const)(
  "startup adoption leaves a terminal host dead when its %s delivery has failed",
  async (payloadKind) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), `llv-runtime-startup-failed-${payloadKind}-`));
    const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
    const sessionId = payloadKind === "text"
      ? "dddddddd-1111-4111-8111-dddddddddddd"
      : "eeeeeeee-1111-4111-8111-eeeeeeeeeeee";
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

test("startup adoption boots the terminal host targeted by a queued runtime operation", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-queued-operation-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const sessionId = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
  const { artifactPath, conversation } = addStructuredRestartConversation(registry, directory, {
    sessionId,
    status: "dead",
    turn: "terminal",
  });
  addStructuredRestartConversation(registry, directory, {
    sessionId: "cccccccc-1111-4111-8111-cccccccccccc",
    status: "dead",
    turn: "terminal",
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

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("terminal retained structured metadata stays dead and projects its finished conversation", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-terminal-retained-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  const sessionId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
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
    prompt: "recover after failed adoption",
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
    prompt: "already delivered prompt",
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
