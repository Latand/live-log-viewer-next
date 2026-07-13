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

test("server startup delegates managed rows with file credentials and their launch profile", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-runtime-startup-"));
  const registry = new AgentRegistry(path.join(directory, "agent-registry.json"));
  registry.upsert({
    key: { engine: "codex", sessionId: "startup-thread" },
    artifactPath: "/managed/sessions/startup-thread.jsonl",
    cwd: "/repo",
    accountId: "managed",
    launchProfile: {
      cwd: "/repo",
      model: "gpt-5.4-mini",
      effort: "high",
      fast: null,
      permissionMode: null,
      readOnly: true,
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
  });
  expect(claudeOptions).toMatchObject({
    cwd: "/repo",
    claudeConfigDir: "/managed-claude",
    claudeProjectsDir: "/managed-claude/projects",
    env: { CLAUDE_CONFIG_DIR: "/managed-claude" },
    model: "gpt-5.4-mini",
    effort: "high",
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
