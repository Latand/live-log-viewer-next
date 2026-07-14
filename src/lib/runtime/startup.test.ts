import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";
import { RuntimeJournal } from "@/runtime-host/journal";

import type { RuntimeHostClient } from "./client";
import { bindStructuredDeliveryQueue } from "./structuredDeliveryController";
import { enqueueStructuredMessage } from "./structuredMessageDelivery";
import { adoptStructuredHostsAtStartup, type StructuredStartupDependencies } from "./startup";

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
  const client = {
    snapshot: async () => journal.snapshot(),
    append: async (event: Parameters<RuntimeHostClient["append"]>[0]) => journal.append(event),
    command: async (command: Parameters<RuntimeHostClient["command"]>[0]) => journal.executeOperation(command),
    operationStatus: async (operationId: string) => journal.operationResult(operationId),
    effectBatch: async (kinds?: readonly string[], afterEventSeq?: number) => journal.effectBatch(100, kinds, afterEventSeq),
    transitionOperation: async (...args: Parameters<RuntimeHostClient["transitionOperation"]>) => journal.transitionOperation(...args),
  } as RuntimeHostClient;

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

test("startup reconciles a failed spawn after host adoption fails", async () => {
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
    adopt: async (received) => {
      const entry = received.snapshot().entries[`codex:${sessionId}`];
      if (entry?.structuredHost) {
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

  expect(failedAdoptions).toBe(1);
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
