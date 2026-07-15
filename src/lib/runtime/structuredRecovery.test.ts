import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import type { AccountContext } from "@/lib/accounts/contracts";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry } from "@/lib/agent/registry";

import type { RuntimeHostClient } from "./client";
import { recoverDeadStructuredConversation } from "./structuredRecovery";
import { structuredResumeSessionId } from "./structuredSpawn";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-recovery-"));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

test("dead structured recovery retains ownership and starts a pane-less resume host", async () => {
  const sessionId = crypto.randomUUID();
  const cwd = path.join(sandbox, sessionId);
  const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const profile = emptyLaunchProfile({
    cwd,
    model: "gpt-5.6-luna",
    effort: "high",
    readOnly: true,
    permissionMode: "never",
    allowSubagents: true,
  });
  const conversation = registry.ensureConversation("codex", artifactPath, "retained-account");
  registry.upsert({
    key: { engine: "codex", sessionId },
    artifactPath,
    cwd,
    accountId: "retained-account",
    launchProfile: profile,
    status: "dead",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:released",
      process: null,
      eventCursor: 4,
      protocolVersion: "v2",
      writerClaimEpoch: 3,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 3,
    claimOwner: null,
    pendingAction: null,
  });
  const account: AccountContext = {
    engine: "codex",
    accountId: "retained-account",
    kind: "managed",
    home: path.join(cwd, "account"),
    transcriptRoot: cwd,
    env: { NODE_ENV: "test" },
  };
  const spawnCalls: unknown[] = [];

  const result = await recoverDeadStructuredConversation({
    path: artifactPath,
    conversationId: conversation.id,
  }, {
    registry,
    client: {} as RuntimeHostClient,
    transport: () => "structured",
    resolveAccount: (engine, accountId) => {
      expect(engine).toBe("codex");
      expect(accountId).toBe("retained-account");
      return account;
    },
    spawn: async (input) => {
      spawnCalls.push(input);
      expect(input.prompt).toBe("");
      expect(structuredResumeSessionId(input)).toBe(sessionId);
      expect(input.receipt).toMatchObject({
        conversationId: conversation.id,
        purpose: "resume-successor",
        transport: "structured",
        accountId: "retained-account",
      });
      expect(input.spec).toMatchObject({
        cwd,
        engine: "codex",
        transcript: artifactPath,
        launchProfile: profile,
      });
      return {
        ok: true,
        target: null,
        path: artifactPath,
        launchId: input.receipt.launchId,
        conversationId: conversation.id,
        launched: true,
        retrySafe: false,
        state: "settled",
      };
    },
  });

  expect(spawnCalls).toHaveLength(1);
  expect(result).toMatchObject({
    target: null,
    path: artifactPath,
    conversationId: conversation.id,
    spawned: true,
  });
});

test("live structured ownership prevents a duplicate recovery host", async () => {
  const sessionId = crypto.randomUUID();
  const cwd = path.join(sandbox, `live-${sessionId}`);
  const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const conversation = registry.ensureConversation("codex", artifactPath, "retained-account");
  registry.upsert({
    key: { engine: "codex", sessionId },
    artifactPath,
    cwd,
    accountId: "retained-account",
    launchProfile: emptyLaunchProfile({ cwd }),
    status: "idle",
    host: null,
    structuredHost: {
      kind: "codex-app-server",
      endpoint: "stdio:live",
      process: { pid: process.pid, startIdentity: "live-process" },
      eventCursor: 7,
      protocolVersion: "v2",
      writerClaimEpoch: 4,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 4,
    claimOwner: "structured-host:live",
    pendingAction: null,
  });
  let spawnCalls = 0;

  const result = await recoverDeadStructuredConversation({
    path: artifactPath,
    conversationId: conversation.id,
  }, {
    registry,
    transport: () => "structured",
    spawn: async () => {
      spawnCalls += 1;
      throw new Error("duplicate structured host");
    },
  });

  expect(result).toMatchObject({ target: null, conversationId: conversation.id, spawned: false });
  expect(spawnCalls).toBe(0);
});

test("legacy tmux history remains on the legacy resume path after cutover", async () => {
  const sessionId = crypto.randomUUID();
  const cwd = path.join(sandbox, `legacy-${sessionId}`);
  const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const conversation = registry.ensureConversation("codex", artifactPath, "legacy-account");
  registry.upsert({
    key: { engine: "codex", sessionId },
    artifactPath,
    cwd,
    accountId: "legacy-account",
    launchProfile: emptyLaunchProfile({ cwd }),
    status: "dead",
    host: null,
    structuredHost: null,
    claimEpoch: 1,
    claimOwner: null,
    pendingAction: null,
  });
  registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "tmux",
    conversationId: conversation.id,
    expectedArtifactPath: artifactPath,
    launchProfile: emptyLaunchProfile({ cwd }),
  });
  const failedStructuredAttempt = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    transport: "structured",
    conversationId: conversation.id,
    expectedArtifactPath: artifactPath,
    launchProfile: emptyLaunchProfile({ cwd }),
  });
  registry.failSpawn(failedStructuredAttempt.receipt.launchId, "structured launch failed before ownership");
  let spawnCalls = 0;

  const result = await recoverDeadStructuredConversation({
    path: artifactPath,
    conversationId: conversation.id,
  }, {
    registry,
    transport: () => "structured",
    spawn: async () => {
      spawnCalls += 1;
      throw new Error("legacy conversation entered structured recovery");
    },
  });

  expect(result).toBeNull();
  expect(spawnCalls).toBe(0);
});
