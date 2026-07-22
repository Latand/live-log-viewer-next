import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import type { AccountContext } from "@/lib/accounts/contracts";
import { emptyLaunchProfile } from "@/lib/accounts/migration/contracts";
import { AgentRegistry, type TmuxHostEvidence } from "@/lib/agent/registry";
import { RuntimeJournal } from "@/runtime-host/journal";

import type { RuntimeHostClient } from "./client";
import { recoverDeadStructuredConversation } from "./structuredRecovery";
import { structuredResumeSessionId } from "./structuredSpawn";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-structured-recovery-"));
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

test("the recovery reservation converges repeated calls onto one successor spawn", async () => {
  const sessionId = crypto.randomUUID();
  const conversationId = `conversation_${crypto.randomUUID()}` as const;
  const parentConversationId = `conversation_${crypto.randomUUID()}` as const;
  const directory = path.join(sandbox, `legacy-claude-reboot-${sessionId}`);
  const cwd = path.join(directory, "fixture-workspace");
  const artifactPath = path.join(directory, "claude-projects", "fixture-workspace", `${sessionId}.jsonl`);
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, `${JSON.stringify({
    type: "assistant",
    cwd,
    sessionId,
    message: { role: "assistant", content: [{ type: "text", text: "privacy-safe recovery fixture" }] },
  })}\n`);
  const registryFilename = path.join(directory, "registry.json");
  const runtimeFilename = path.join(directory, "runtime.sqlite");
  const transcriptDigest = () => crypto.createHash("sha256").update(fs.readFileSync(artifactPath)).digest("hex");
  const beforeTranscript = transcriptDigest();
  const profile = emptyLaunchProfile({
    cwd,
    model: "claude-fable-5",
    effort: "high",
    permissionMode: "bypassPermissions",
    readOnly: false,
    parentConversationId,
  });
  let registry = new AgentRegistry(registryFilename, undefined, undefined, { sqliteMode: "off" });
  const original = registry.beginSpawnRequest({
    engine: "claude",
    cwd,
    transport: "structured",
    accountId: "default",
    conversationId,
    parentConversationId: profile.parentConversationId,
    expectedArtifactPath: artifactPath,
    launchProfile: profile,
  });
  if (original.kind !== "created") throw new Error("legacy launch receipt was unavailable");
  const key = { engine: "claude" as const, sessionId };
  const originalSettlement = registry.settleSpawn(original.receipt.launchId, {
    key,
    artifactPath,
    cwd,
    accountId: "default",
    launchProfile: profile,
    status: "dead",
    host: null,
    structuredHost: {
      kind: "claude-broker",
      endpoint: "stdio:released",
      process: null,
      eventCursor: 2_260,
      protocolVersion: "2.1.214",
      writerClaimEpoch: 4,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 4,
    claimOwner: null,
    pendingAction: null,
  });
  if (originalSettlement.kind !== "settled") throw new Error("legacy launch did not settle");

  let journal = new RuntimeJournal(runtimeFilename, { structuredHosts: true });
  journal.append({
    scope: { type: "session", id: conversationId },
    kind: "session-status",
    payload: {
      conversationId,
      sessionKey: key,
      hostKind: "claude-broker",
      host: "hosted",
      turn: "running",
      provenance: "structured",
      accountId: null,
      cwd,
      artifactPath,
      capabilities: { steer: false, structuredAttention: true },
      activeTurnId: "turn-before-reboot",
    },
  });
  journal.append({
    scope: { type: "session", id: conversationId },
    kind: "turn.interrupted",
    payload: { conversationId, turnId: "turn-before-reboot" },
  });
  journal.append({
    scope: { type: "session", id: conversationId },
    kind: "host.degraded",
    payload: { conversationId },
  });
  journal.append({
    scope: { type: "session", id: conversationId },
    kind: "turn.started",
    payload: { conversationId, turnId: "turn-after-reboot" },
  });
  journal.append({
    scope: { type: "session", id: conversationId },
    kind: "session-status",
    payload: { conversationId, host: "dead" },
  });
  journal.close();

  registry = new AgentRegistry(registryFilename, undefined, undefined, { sqliteMode: "off" });
  journal = new RuntimeJournal(runtimeFilename, { structuredHosts: true });
  const rebootEvents = journal.replay(0).events.slice(-4);
  expect(rebootEvents.map((event) => event.kind)).toEqual([
    "turn-ended",
    "session-status",
    "turn-started",
    "session-status",
  ]);
  expect(rebootEvents.map((event) => ({
    outcome: event.payload.outcome ?? null,
    host: event.payload.host ?? null,
  }))).toEqual([
    { outcome: "interrupted", host: null },
    { outcome: null, host: "unhosted" },
    { outcome: null, host: null },
    { outcome: null, host: "dead" },
  ]);
  expect(journal.snapshot().sessions).toMatchObject([{
    conversationId,
    sessionKey: key,
    hostKind: "claude-broker",
    host: "dead",
    turn: "running",
    accountId: null,
    cwd,
    artifactPath,
  }]);

  let spawnCalls = 0;
  const recover = () => recoverDeadStructuredConversation({ path: artifactPath, conversationId }, {
    registry,
    client: {} as RuntimeHostClient,
    transport: () => "structured",
    resolveAccount: (engine, accountId) => {
      expect({ engine, accountId }).toEqual({ engine: "claude", accountId: "default" });
      return {
        engine: "claude",
        accountId: "default",
        kind: "managed",
        home: path.join(directory, "account"),
        transcriptRoot: path.dirname(path.dirname(artifactPath)),
        env: { NODE_ENV: "test" },
      };
    },
    spawn: async (input) => {
      spawnCalls += 1;
      expect(input.receipt).toMatchObject({
        conversationId,
        purpose: "resume-successor",
        accountId: "default",
        resumeSourcePath: artifactPath,
      });
      expect(input.spec).toMatchObject({
        cwd,
        ["transcript"]: artifactPath,
        launchProfile: profile,
      });
      expect(structuredResumeSessionId(input)).toBe(sessionId);
      const claimed = registry.claimStructuredHost(key, { pid: process.pid, startIdentity: null }, { allowUnhosted: true });
      if (!claimed?.claimOwner || !claimed.structuredHost) throw new Error("legacy recovery claim was unavailable");
      const staged = registry.stageStructuredSpawn(input.receipt.launchId, {
        key,
        artifactPath,
        cwd,
        accountId: "default",
        launchProfile: profile,
        status: "idle",
        host: null,
        structuredHost: {
          ...claimed.structuredHost,
          endpoint: "stdio:recovered",
          process: { pid: process.pid, startIdentity: null },
          writerClaimEpoch: claimed.claimEpoch,
        },
        claimEpoch: claimed.claimEpoch,
        claimOwner: claimed.claimOwner,
        pendingAction: "spawn",
      });
      if (staged.kind !== "settled") throw new Error("legacy recovery staging failed");
      const settled = registry.finalizeStructuredSpawn(input.receipt.launchId);
      if (settled.kind !== "settled") throw new Error("legacy recovery settlement failed");
      journal.append({
        scope: { type: "session", id: conversationId },
        kind: "session-status",
        payload: {
          conversationId,
          sessionKey: key,
          hostKind: "claude-broker",
          host: "hosted",
          turn: "idle",
          provenance: "structured",
          accountId: "default",
          cwd,
          artifactPath,
          capabilities: { steer: false, structuredAttention: true },
          activeTurnId: null,
        },
      });
      return {
        ok: true,
        target: null,
        path: artifactPath,
        launchId: input.receipt.launchId,
        conversationId,
        launched: true,
        retrySafe: false,
        initialMessage: "delivered" as const,
        state: "settled" as const,
      };
    },
  });

  const [first, duplicate] = await Promise.all([recover(), recover()]);
  const laterRetry = await recover();

  expect(first).toMatchObject({ conversationId, path: artifactPath, spawned: true });
  expect(duplicate).toEqual(first);
  expect(laterRetry).toMatchObject({ conversationId, path: artifactPath, spawned: false });
  expect(spawnCalls).toBe(1);
  expect(Object.values(registry.snapshot().receipts).filter((receipt) =>
    receipt.conversationId === conversationId && receipt.purpose === "resume-successor")).toHaveLength(1);
  expect(registry.snapshot().entries[`claude:${sessionId}`]).toMatchObject({
    accountId: "default",
    launchProfile: profile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: "claude-broker",
      endpoint: "stdio:recovered",
      process: { pid: process.pid, startIdentity: null },
    },
    pendingAction: null,
  });
  expect(journal.snapshot().sessions).toMatchObject([{
    conversationId,
    hostKind: "claude-broker",
    host: "hosted",
    turn: "idle",
    accountId: "default",
  }]);
  expect(transcriptDigest()).toBe(beforeTranscript);
  journal.close();
});

function establishRolledBackTmuxOwner(engine: "codex" | "claude", label: string) {
  const sessionId = crypto.randomUUID();
  const cwd = path.join(sandbox, `${engine}-${label}-${sessionId}`);
  const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
  const accountId = `${engine}-${label}-account`;
  const profile = emptyLaunchProfile({ cwd, model: `${engine}-${label}-model`, effort: "high" });
  const key = { engine, sessionId } as const;
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const begun = registry.beginSpawnRequest({
    engine,
    cwd,
    transport: "structured",
    accountId,
    expectedArtifactPath: artifactPath,
    launchProfile: profile,
  });
  if (begun.kind !== "created") throw new Error("structured receipt was unavailable");
  const settled = registry.settleSpawn(begun.receipt.launchId, {
    key,
    artifactPath,
    cwd,
    accountId,
    launchProfile: profile,
    status: "idle",
    host: null,
    structuredHost: {
      kind: engine === "codex" ? "codex-app-server" : "claude-broker",
      endpoint: `stdio:${label}`,
      process: { pid: process.pid, startIdentity: `${label}-structured` },
      eventCursor: 1,
      protocolVersion: "v2",
      writerClaimEpoch: 1,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: `structured-host:${label}`,
    pendingAction: null,
  });
  if (settled.kind !== "settled") throw new Error("structured receipt did not settle");
  registry.terminateStructuredHost(key);
  const tmuxHost: TmuxHostEvidence = {
    kind: "tmux",
    endpoint: `/run/user/1000/${label}`,
    server: { pid: 900, startIdentity: `${label}-server` },
    paneId: `%${label}`,
    panePid: { pid: 901, startIdentity: `${label}-pane` },
    windowName: `${engine}-${label}`,
    agent: { pid: 902, startIdentity: `${label}-agent` },
    argv: [engine, "resume", sessionId],
  };
  registry.upsert({
    ...settled.entry,
    status: "idle",
    host: tmuxHost,
    structuredHost: null,
    claimEpoch: 2,
    claimOwner: null,
    pendingAction: null,
  });
  return {
    artifactPath,
    conversationId: begun.receipt.conversationId,
    key,
    launchId: begun.receipt.launchId,
    registry,
    tmuxHost,
  };
}

test("dead Codex structured recovery retains ownership and starts a pane-less resume host", async () => {
  const sessionId = crypto.randomUUID();
  const cwd = path.join(sandbox, sessionId);
  const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const parentPath = path.join(cwd, "parent.jsonl");
  const parent = registry.ensureConversation("codex", parentPath, "retained-account");
  const reviewed = registry.ensureConversation("codex", path.join(cwd, "reviewed.jsonl"), "retained-account");
  const profile = emptyLaunchProfile({
    cwd,
    model: "gpt-5.6-luna",
    effort: "high",
    readOnly: true,
    permissionMode: "never",
    allowSubagents: true,
    parentConversationId: parent.id,
  });
  const conversation = registry.ensureConversation("codex", artifactPath, "retained-account");
  const original = registry.beginSpawnRequest({
    engine: "codex",
    cwd,
    accountId: "retained-account",
    conversationId: conversation.id,
    parentConversationId: parent.id,
    parentSessionKey: { engine: "codex", sessionId: "parent-session" },
    parentArtifactPath: parentPath,
    role: "reviewer",
    reviewsConversationId: reviewed.id,
    launchProfile: profile,
  });
  if (original.kind !== "created") throw new Error("expected original lineage receipt");
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
        parentConversationId: parent.id,
        purpose: "resume-successor",
        transport: "structured",
        accountId: "retained-account",
      });
      expect(input.spec).toMatchObject({
        cwd,
        engine: "codex",
        ["transcript"]: artifactPath,
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
        initialMessage: "delivered" as const,
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
  const lineageEdges = Object.values(registry.snapshot().lineageEdges)
    .filter((edge) => edge.childConversationId === conversation.id);
  expect(lineageEdges).toHaveLength(1);
  expect(lineageEdges[0]).toMatchObject({
    parentConversationId: parent.id,
    parentSessionKey: { engine: "codex", sessionId: "parent-session" },
    parentArtifactPath: parentPath,
    kind: "review",
    role: "reviewer",
    reviewsConversationId: reviewed.id,
    source: "viewer-spawn",
    evidence: { launchId: original.receipt.launchId },
  });
});

test("dead Claude structured recovery retains ownership and starts a pane-less resume host", async () => {
  const sessionId = crypto.randomUUID();
  const cwd = path.join(sandbox, `claude-${sessionId}`);
  const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const parentPath = path.join(cwd, "reviewed.jsonl");
  const reviewed = registry.ensureConversation("claude", parentPath, "retained-claude-account");
  const parent = registry.ensureConversation("claude", path.join(cwd, "parent.jsonl"), "retained-claude-account");
  const profile = emptyLaunchProfile({
    cwd,
    model: "claude-opus-5-1",
    effort: "high",
    permissionMode: "default",
    allowSubagents: true,
    parentConversationId: reviewed.id,
  });
  const conversation = registry.ensureConversation("claude", artifactPath, "retained-claude-account");
  const original = registry.beginSpawnRequest({
    engine: "claude",
    cwd,
    accountId: "retained-claude-account",
    conversationId: conversation.id,
    parentConversationId: parent.id,
    parentSessionKey: { engine: "claude", sessionId: "parent-session" },
    parentArtifactPath: path.join(cwd, "parent.jsonl"),
    role: "reviewer",
    reviewsConversationId: reviewed.id,
    launchProfile: profile,
  });
  if (original.kind !== "created") throw new Error("expected original lineage receipt");
  registry.upsert({
    key: { engine: "claude", sessionId },
    artifactPath,
    cwd,
    accountId: "retained-claude-account",
    launchProfile: profile,
    status: "dead",
    host: null,
    structuredHost: {
      kind: "claude-broker",
      endpoint: "stdio:released",
      process: null,
      eventCursor: 9,
      protocolVersion: "v2",
      writerClaimEpoch: 5,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 5,
    claimOwner: null,
    pendingAction: null,
  });
  const account: AccountContext = {
    engine: "claude",
    accountId: "retained-claude-account",
    kind: "managed",
    home: path.join(cwd, "account"),
    transcriptRoot: cwd,
    env: { NODE_ENV: "test" },
  };
  let spawnCalls = 0;

  const result = await recoverDeadStructuredConversation({
    path: artifactPath,
    conversationId: conversation.id,
  }, {
    registry,
    client: {} as RuntimeHostClient,
    transport: () => "structured",
    resolveAccount: (engine, accountId) => {
      expect(engine).toBe("claude");
      expect(accountId).toBe("retained-claude-account");
      return account;
    },
    spawn: async (input) => {
      spawnCalls += 1;
      expect(input.prompt).toBe("");
      expect(structuredResumeSessionId(input)).toBe(sessionId);
      expect(input.receipt).toMatchObject({
        conversationId: conversation.id,
        parentConversationId: parent.id,
        purpose: "resume-successor",
        transport: "structured",
        accountId: "retained-claude-account",
      });
      expect(input.spec).toMatchObject({
        cwd,
        engine: "claude",
        ["transcript"]: artifactPath,
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
        initialMessage: "delivered" as const,
        state: "settled",
      };
    },
  });

  expect(spawnCalls).toBe(1);
  expect(result).toMatchObject({
    target: null,
    path: artifactPath,
    conversationId: conversation.id,
    spawned: true,
  });
  const lineageEdges = Object.values(registry.snapshot().lineageEdges)
    .filter((edge) => edge.childConversationId === conversation.id);
  expect(lineageEdges).toHaveLength(1);
  expect(lineageEdges[0]).toMatchObject({
    parentConversationId: parent.id,
    parentSessionKey: { engine: "claude", sessionId: "parent-session" },
    parentArtifactPath: path.join(cwd, "parent.jsonl"),
    kind: "review",
    role: "reviewer",
    reviewsConversationId: reviewed.id,
    source: "viewer-spawn",
    evidence: { launchId: original.receipt.launchId },
  });
});

test("Codex and Claude worker and root recovery retain their original lineage shape", async () => {
  for (const engine of ["codex", "claude"] as const) {
    for (const role of ["worker", "root"] as const) {
      const sessionId = crypto.randomUUID();
      const cwd = path.join(sandbox, `${engine}-${role}-${sessionId}`);
      const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
      fs.mkdirSync(cwd, { recursive: true });
      fs.writeFileSync(artifactPath, "");
      const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
      const parentPath = path.join(cwd, "parent.jsonl");
      const parent = registry.ensureConversation(engine, parentPath, `${engine}-account`);
      const profile = emptyLaunchProfile({ cwd, parentConversationId: role === "worker" ? parent.id : null, role });
      const conversation = registry.ensureConversation(engine, artifactPath, `${engine}-account`);
      if (role === "worker") {
        const original = registry.beginSpawnRequest({
          engine,
          cwd,
          accountId: `${engine}-account`,
          conversationId: conversation.id,
          parentConversationId: parent.id,
          parentSessionKey: { engine, sessionId: "parent-session" },
          parentArtifactPath: parentPath,
          role,
          launchProfile: profile,
        });
        if (original.kind !== "created") throw new Error("expected original worker lineage receipt");
      }
      registry.upsert({
        key: { engine, sessionId },
        artifactPath,
        cwd,
        accountId: `${engine}-account`,
        launchProfile: profile,
        status: "dead",
        host: null,
        structuredHost: {
          kind: engine === "codex" ? "codex-app-server" : "claude-broker",
          endpoint: "stdio:released",
          process: null,
          eventCursor: 0,
          protocolVersion: "v2",
          writerClaimEpoch: 1,
          activeTurnRef: null,
          pendingAttention: [],
          activeFlags: [],
        },
        claimEpoch: 1,
        claimOwner: null,
        pendingAction: null,
      });
      const account: AccountContext = {
        engine,
        accountId: `${engine}-account`,
        kind: "managed",
        home: path.join(cwd, "account"),
        transcriptRoot: cwd,
        env: { NODE_ENV: "test" },
      };

      await recoverDeadStructuredConversation({ path: artifactPath, conversationId: conversation.id }, {
        registry,
        client: {} as RuntimeHostClient,
        transport: () => "structured",
        resolveAccount: () => account,
        spawn: async (input) => ({
          ok: true,
          target: null,
          path: artifactPath,
          launchId: input.receipt.launchId,
          conversationId: conversation.id,
          launched: true,
          retrySafe: false,
          initialMessage: "delivered" as const,
          state: "settled",
        }),
      });

      const lineage = registry.snapshot().lineageEdges[conversation.id];
      if (role === "worker") {
        expect(lineage).toMatchObject({
          parentConversationId: parent.id,
          parentSessionKey: { engine, sessionId: "parent-session" },
          parentArtifactPath: parentPath,
          kind: "spawn",
          role: "worker",
        });
      } else {
        expect(lineage).toBeUndefined();
      }
    }
  }
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
      process: { pid: process.pid, startIdentity: null },
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

test("a dead structured process cannot masquerade as publish-ready ownership", async () => {
  const sessionId = crypto.randomUUID();
  const cwd = path.join(sandbox, `stale-owner-${sessionId}`);
  const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
  const staleProcess = { pid: 2_000_000_000, startIdentity: "stale-wrapper" };
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
      endpoint: "stdio:stale",
      process: staleProcess,
      eventCursor: 7,
      protocolVersion: "v2",
      writerClaimEpoch: 4,
      activeTurnRef: null,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 4,
    claimOwner: `structured-host:${JSON.stringify(staleProcess)}`,
    pendingAction: null,
  });
  let spawnCalls = 0;

  const result = await recoverDeadStructuredConversation({
    path: artifactPath,
    conversationId: conversation.id,
  }, {
    registry,
    client: {} as RuntimeHostClient,
    transport: () => "structured",
    resolveAccount: () => ({
      engine: "codex",
      accountId: "retained-account",
      kind: "managed",
      home: cwd,
      transcriptRoot: cwd,
      env: { NODE_ENV: "test" },
    }),
    spawn: async (input) => {
      spawnCalls += 1;
      return {
        ok: true,
        target: null,
        path: artifactPath,
        launchId: input.receipt.launchId,
        conversationId: conversation.id,
        launched: true,
        retrySafe: false,
        initialMessage: "delivered",
        state: "settled",
      };
    },
  });

  expect(result).toMatchObject({ target: null, conversationId: conversation.id, spawned: true });
  expect(spawnCalls).toBe(1);
});

test.each(["codex", "claude"] as const)("current verified %s tmux ownership outranks completed structured history", async (engine) => {
  const state = establishRolledBackTmuxOwner(engine, "tmux-authority");
  let spawnCalls = 0;

  const result = await recoverDeadStructuredConversation({
    path: state.artifactPath,
    conversationId: state.conversationId,
  }, {
    registry: state.registry,
    transport: () => "structured",
    spawn: async () => {
      spawnCalls += 1;
      throw new Error("verified tmux ownership entered structured recovery");
    },
  });

  expect(result).toBeNull();
  expect(spawnCalls).toBe(0);
  expect(state.registry.snapshot().receipts[state.launchId]).toMatchObject({ state: "completed", transport: "structured" });
  expect(state.registry.snapshot().entries[`${engine}:${state.key.sessionId}`]?.host).toEqual(state.tmuxHost);
});

test.each(["codex", "claude"] as const)("duplicate %s recovery clicks reuse one stale-live recovery until host publication", async (engine) => {
  const sessionId = crypto.randomUUID();
  const cwd = path.join(sandbox, `${engine}-publication-barrier-${sessionId}`);
  const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const conversation = registry.ensureConversation(engine, artifactPath, `${engine}-account`);
  const profile = emptyLaunchProfile({ cwd });
  const key = { engine, sessionId } as const;
  registry.upsert({
    key,
    artifactPath,
    cwd,
    accountId: `${engine}-account`,
    launchProfile: profile,
    status: "live",
    host: null,
    structuredHost: {
      kind: engine === "codex" ? "codex-app-server" : "claude-broker",
      endpoint: "stdio:stale",
      process: { pid: 2_000_000_000, startIdentity: `${engine}-stale-process` },
      eventCursor: 0,
      protocolVersion: "v2",
      writerClaimEpoch: 1,
      activeTurnRef: `${engine}-stale-turn`,
      pendingAttention: [],
      activeFlags: [],
    },
    claimEpoch: 1,
    claimOwner: null,
    pendingAction: null,
  });
  const account: AccountContext = {
    engine,
    accountId: `${engine}-account`,
    kind: "managed",
    home: path.join(cwd, "account"),
    transcriptRoot: cwd,
    env: { NODE_ENV: "test" },
  };
  let releasePublication!: () => void;
  const publication = new Promise<void>((resolve) => { releasePublication = resolve; });
  let claimed!: () => void;
  const claimObserved = new Promise<void>((resolve) => { claimed = resolve; });
  let spawnCalls = 0;
  let deliveryDrainRequests = 0;
  let admissions = 0;
  let terminalRejections = 0;
  const recoverFromClick = async () => {
    const recovered = await recoverDeadStructuredConversation({ path: artifactPath, conversationId: conversation.id }, {
      registry,
      client: {} as RuntimeHostClient,
      transport: () => "structured",
      resolveAccount: () => account,
      spawn: async (input) => {
        spawnCalls += 1;
        registry.upsert({
          key,
          artifactPath,
          cwd,
          accountId: `${engine}-account`,
          launchProfile: profile,
          status: "unhosted",
          host: null,
          structuredHost: {
            kind: engine === "codex" ? "codex-app-server" : "claude-broker",
            endpoint: "stdio:pending",
            process: null,
            eventCursor: 0,
            protocolVersion: "v2",
            writerClaimEpoch: 2,
            activeTurnRef: null,
            pendingAttention: [],
            activeFlags: [],
          },
          claimEpoch: 2,
          claimOwner: "structured-host:publication-barrier",
          pendingAction: "spawn",
        });
        claimed();
        await publication;
        registry.upsert({
          key,
          artifactPath,
          cwd,
          accountId: `${engine}-account`,
          launchProfile: profile,
          status: "idle",
          host: null,
          structuredHost: {
            kind: engine === "codex" ? "codex-app-server" : "claude-broker",
            endpoint: "stdio:published",
            process: { pid: process.pid, startIdentity: "publication-barrier" },
            eventCursor: 0,
            protocolVersion: "v2",
            writerClaimEpoch: 2,
            activeTurnRef: null,
            pendingAttention: [],
            activeFlags: [],
          },
          claimEpoch: 2,
          claimOwner: "structured-host:publication-barrier",
          pendingAction: null,
        });
        return {
          ok: true,
          target: null,
          path: artifactPath,
          launchId: input.receipt.launchId,
          conversationId: conversation.id,
          launched: true,
          retrySafe: false,
          initialMessage: "delivered" as const,
          state: "settled",
        };
      },
      requestDeliveryDrain: () => {
        const published = registry.snapshot().entries[`${engine}:${sessionId}`];
        expect(published).toMatchObject({ status: "idle", pendingAction: null });
        expect(published?.structuredHost?.process).not.toBeNull();
        deliveryDrainRequests += 1;
      },
    });
    const entry = registry.snapshot().entries[`${engine}:${sessionId}`];
    if (!recovered || !entry?.structuredHost?.process || !entry.claimOwner) terminalRejections += 1;
    else admissions += 1;
  };

  const first = recoverFromClick();
  await claimObserved;
  const second = recoverFromClick();
  await Promise.resolve();
  expect(admissions).toBe(0);
  expect(terminalRejections).toBe(0);
  releasePublication();
  await Promise.all([first, second]);

  expect(spawnCalls).toBe(1);
  expect(deliveryDrainRequests).toBe(1);
  expect(admissions).toBe(2);
  expect(terminalRejections).toBe(0);
});

test("a registered legacy Claude transcript bridges into the structured broker", async () => {
  const sessionId = crypto.randomUUID();
  const cwd = path.join(sandbox, `legacy-claude-bridge-${sessionId}`);
  const artifactPath = path.join(cwd, `${sessionId}.jsonl`);
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(artifactPath, "");
  const registry = new AgentRegistry(path.join(cwd, "registry.json"), undefined, undefined, { sqliteMode: "off" });
  const conversation = registry.ensureConversation("claude", artifactPath, "default");
  expect(registry.snapshot().entries[`claude:${sessionId}`]).toBeUndefined();
  let spawnCalls = 0;
  let drainRequests = 0;

  const result = await recoverDeadStructuredConversation({
    path: artifactPath,
    conversationId: conversation.id,
  }, {
    registry,
    client: {} as RuntimeHostClient,
    transport: () => "structured",
    resolveAccount: (engine, accountId) => {
      expect({ engine, accountId }).toEqual({ engine: "claude", accountId: "default" });
      return {
        engine: "claude",
        accountId: "default",
        kind: "managed",
        home: path.join(cwd, "account"),
        transcriptRoot: cwd,
        env: { NODE_ENV: "test" },
      };
    },
    spawn: async (input) => {
      spawnCalls += 1;
      expect(input.receipt).toMatchObject({
        conversationId: conversation.id,
        purpose: "resume-successor",
        transport: "structured",
        accountId: "default",
      });
      expect(input.spec).toMatchObject({
        engine: "claude",
        ["transcript"]: artifactPath,
      });
      return {
        ok: true,
        target: null,
        path: artifactPath,
        launchId: input.receipt.launchId,
        conversationId: conversation.id,
        launched: true,
        retrySafe: false,
        initialMessage: "delivered" as const,
        state: "settled",
      };
    },
    requestDeliveryDrain: () => { drainRequests += 1; },
  });

  expect(result).toMatchObject({
    conversationId: conversation.id,
    path: artifactPath,
    spawned: true,
  });
  expect(spawnCalls).toBe(1);
  expect(drainRequests).toBe(1);
});

test("legacy Codex tmux history remains on the legacy resume path after cutover", async () => {
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
