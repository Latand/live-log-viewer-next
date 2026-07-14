import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import { RuntimeJournal } from "@/runtime-host/journal";

import type { RuntimeHostClient } from "./client";
import { bindStructuredDeliveryQueue } from "./structuredDeliveryController";
import { createFakeDeliveryLedger, FakeEngineHost } from "./fixtures/fakeEngineHost";
import { enqueueStructuredMessage } from "./structuredMessageDelivery";
import { adoptStructuredHostsAtStartup, type StructuredStartupDependencies } from "./startup";

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

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("startup delivery did not settle");
}

test.each(["codex", "claude"] as const)("failed %s restart adoption projects dead structured ownership and fences legacy delivery", async (engine) => {
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
  const delivery = await enqueueStructuredMessage({
    path: artifactPath,
    text: "must stay structured",
    clientMessageId: `failed-${engine}-restart-message`,
    hasImages: false,
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
  });
  if (delivery === null) legacyCalls += 1;
  expect(delivery).toMatchObject({
    ok: false,
    structured: true,
    outcome: "failed",
    error: "dead-host",
    status: 409,
    receipt: { status: "rejected", reason: "dead-host" },
  });
  expect(legacyCalls).toBe(0);

  await bindStructuredDeliveryQueue([], { registry, client: null });
  journal.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

test("failed restart adoption replaces a stale hosted projection before delivery", async () => {
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
    text: "reject stale hosted delivery",
    clientMessageId: "failed-stale-restart-message",
    hasImages: false,
  }, {
    enabled: () => true,
    client: () => client,
    registry: () => registry,
  });
  expect(delivery).toMatchObject({
    ok: false,
    structured: true,
    error: "dead-host",
    receipt: { status: "rejected", reason: "dead-host" },
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
