import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile, sameProviderReceiptOutcome, type NativeGeneration, type ProviderReceipt, type SuccessorProviderPort } from "./contracts";
import { RegisteredSuccessorProvider, type ProviderDependencies } from "./provider";
import type { CodexAppServerClient } from "@/lib/accounts/codexAppServer";
import { AgentRegistry, type ConversationObservation, type TmuxHostEvidence } from "@/lib/agent/registry";

const roots: string[] = [];

function accountRoot(engine: "claude" | "codex", base: string, id: string) {
  const home = path.join(base, id);
  const transcriptRoot = path.join(home, engine === "claude" ? "projects" : "sessions");
  fs.mkdirSync(transcriptRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  fs.chmodSync(transcriptRoot, 0o700);
  return { engine, accountId: id, kind: "managed" as const, home, transcriptRoot, env: { ...process.env } };
}

function codexSessionMeta(id: string, forkedFromId?: string): string {
  return JSON.stringify({
    type: "session_meta",
    payload: { id, ...(forkedFromId ? { forked_from_id: forkedFromId } : {}) },
  }) + "\n";
}

function claudeHost(paneId: string, panePid: number, agentPid = panePid + 10_000): TmuxHostEvidence {
  return {
    kind: "tmux",
    endpoint: "/tmp",
    server: { pid: 700, startIdentity: "server-start" },
    paneId,
    panePid: { pid: panePid, startIdentity: `pane-${panePid}` },
    windowName: "claude-migration-successor",
    agent: { pid: agentPid, startIdentity: `agent-${agentPid}` },
    argv: ["claude"],
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("provider receipt identity ignores timestamp and object key order", () => {
  const tmux = claudeHost("%30", 3030);
  const left: ProviderReceipt = {
    operationId: "canonical-receipt",
    nativeId: "canonical-native",
    path: "/canonical.jsonl",
    continuityPaths: [],
    historyHash: "history",
    host: { kind: "claude-stream", identity: "%30:3030", epoch: 1, verifiedAt: "first", tmuxHost: tmux },
  };
  const right: ProviderReceipt = {
    historyHash: "history",
    continuityPaths: [],
    path: "/canonical.jsonl",
    nativeId: "canonical-native",
    operationId: "canonical-receipt",
    host: {
      verifiedAt: "second",
      epoch: 1,
      identity: "%30:3030",
      kind: "claude-stream",
      tmuxHost: {
        argv: [...tmux.argv],
        agent: { startIdentity: tmux.agent.startIdentity, pid: tmux.agent.pid },
        windowName: tmux.windowName,
        panePid: { startIdentity: tmux.panePid.startIdentity, pid: tmux.panePid.pid },
        paneId: tmux.paneId,
        server: { startIdentity: tmux.server.startIdentity, pid: tmux.server.pid },
        endpoint: tmux.endpoint,
        kind: "tmux",
      },
    },
  };

  expect(sameProviderReceiptOutcome(left, right)).toBeTrue();
});

test("Claude successor provider uses registered homes and shared model normalization", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-claude-"));
  roots.push(base);
  const source = accountRoot("claude", base, "source");
  const target = accountRoot("claude", base, "target");
  const sourcePath = path.join(source.transcriptRoot, "-repo", "019f423a-d6e9-7903-b597-3e676b6ff3d4.jsonl");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(sourcePath, "{}\n", { mode: 0o600 });
  let command = "";
  const dependencies: ProviderDependencies = {
    accounts: {
      resolveSpawn: () => target,
      resolveTranscriptOwner: () => source,
    },
    startCodex: async () => { throw new Error("unexpected Codex client"); },
    claudeStatus: async () => ({ loggedIn: true }),
    spawnClaude: async (spec) => {
      command = spec.command;
      fs.mkdirSync(path.dirname(spec.transcript!), { recursive: true, mode: 0o700 });
      fs.writeFileSync(spec.transcript!, JSON.stringify({ sessionId: path.basename(spec.transcript!, ".jsonl") }) + "\n", { mode: 0o600 });
      return { paneId: "%9", panePid: 99, host: claudeHost("%9", 99) };
    },
    verifyClaudeHost: async () => true,
    registry: new AgentRegistry(path.join(base, "provider-registry.json")),
    claudeJournalRoot: path.join(base, "claude-operations"),
    now: () => "2026-07-10T12:00:00.000Z",
  };
  const provider = new RegisteredSuccessorProvider(dependencies);
  const sourceGeneration: NativeGeneration = {
    id: "019f423a-d6e9-7903-b597-3e676b6ff3d4",
    path: sourcePath,
    accountId: "source",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", model: "claude-fable-20260701", effort: "high" }),
    historyHash: null,
    host: null,
    createdAt: "2026-07-10T11:00:00.000Z",
    archivedAt: null,
  };
  const receipt = await provider.create({ engine: "claude", operationId: "019f423a-d6e9-4903-8597-3e676b6ff3d4", conversationId: "conversation_test", source: sourceGeneration, targetAccountId: "target", recordContinuityPath() {} });
  expect(command).toContain("CLAUDE_CONFIG_DIR=");
  expect(command).toContain("--model' 'fable'");
  expect(command).not.toContain("claude-fable-");
  expect(command).toContain("--effort' 'high'");
  expect(receipt.path.startsWith(target.transcriptRoot + path.sep)).toBeTrue();
  await expect(provider.verify(receipt, { engine: "claude", targetAccountId: "target", launchProfile: sourceGeneration.launchProfile })).resolves.toBeUndefined();
});

test("Claude successor verification rejects a missing durable transcript", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-claude-missing-"));
  roots.push(base);
  const source = accountRoot("claude", base, "source");
  const target = accountRoot("claude", base, "target");
  const sourcePath = path.join(source.transcriptRoot, "source.jsonl");
  fs.writeFileSync(sourcePath, "{}\n", { mode: 0o600 });
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => { throw new Error("unexpected Codex client"); },
    claudeStatus: async () => ({ loggedIn: true }),
    spawnClaude: async () => ({ paneId: "%11", panePid: 111, host: claudeHost("%11", 111) }),
    registry: new AgentRegistry(path.join(base, "provider-registry.json")),
    claudeJournalRoot: path.join(base, "claude-operations"),
    now: () => "2026-07-10T12:00:00.000Z",
  });
  const receipt = await provider.create({
    engine: "claude",
    operationId: "019f423a-d6e9-4903-8597-3e676b6ff3d4",
    conversationId: "conversation_test",
    targetAccountId: "target",
    source: { id: "source", path: sourcePath, accountId: "source", launchProfile: emptyLaunchProfile({ cwd: "/repo" }), historyHash: null, host: null, createdAt: "now", archivedAt: null },
    recordContinuityPath() {},
  });

  await expect(provider.verify(receipt, { engine: "claude", targetAccountId: "target", launchProfile: emptyLaunchProfile({ cwd: "/repo" }) }))
    .rejects.toThrow("durable");
});

test("Claude agent exit fails full host verification and leaves the persisted receipt immutable", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-claude-host-failure-"));
  roots.push(base);
  const source = accountRoot("claude", base, "source");
  const target = accountRoot("claude", base, "target");
  const sourcePath = path.join(source.transcriptRoot, "source.jsonl");
  fs.writeFileSync(sourcePath, "{}\n", { mode: 0o600 });
  let verifiedHost: TmuxHostEvidence | null = null;
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => { throw new Error("unexpected Codex client"); },
    claudeStatus: async () => ({ loggedIn: true }),
    spawnClaude: async (spec) => {
      fs.mkdirSync(path.dirname(spec.transcript!), { recursive: true, mode: 0o700 });
      fs.writeFileSync(spec.transcript!, JSON.stringify({ sessionId: path.basename(spec.transcript!, ".jsonl") }) + "\n", { mode: 0o600 });
      return { paneId: "%12", panePid: 1212, host: claudeHost("%12", 1212) };
    },
    verifyClaudeHost: async (host) => { verifiedHost = host; return false; },
    registry: new AgentRegistry(path.join(base, "provider-registry.json")),
    claudeJournalRoot: path.join(base, "claude-operations"),
    now: () => "2026-07-10T12:00:00.000Z",
  });
  const receipt = await provider.create({
    engine: "claude",
    operationId: "claude-host-failure",
    conversationId: "conversation_claude_host_failure",
    targetAccountId: "target",
    source: { id: "source", path: sourcePath, accountId: "source", launchProfile: emptyLaunchProfile({ cwd: "/repo" }), historyHash: null, host: null, createdAt: "now", archivedAt: null },
    recordContinuityPath() {},
  });
  const persisted = structuredClone(receipt);

  await expect(provider.verify(receipt, {
    engine: "claude",
    targetAccountId: "target",
    launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
  })).rejects.toThrow("host is not live");
  expect(receipt).toEqual(persisted);
  expect(verifiedHost).toMatchObject({ paneId: "%12", panePid: { pid: 1212 }, agent: { pid: 11212 } });
});

test("Claude cleanup cancels only the pane PID recorded by the losing receipt", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-claude-cleanup-fence-"));
  roots.push(base);
  const source = accountRoot("claude", base, "source");
  const target = accountRoot("claude", base, "target");
  const cancelled: Array<[string, number]> = [];
  let observedPid = 999;
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => { throw new Error("unexpected Codex client"); },
    claudeStatus: async () => ({ loggedIn: true }),
    spawnClaude: async () => ({ paneId: "%7", panePid: 77, host: claudeHost("%7", 77) }),
    cancelClaude: async (host) => {
      if (observedPid !== host.panePid.pid) return false;
      cancelled.push([host.paneId, host.panePid.pid]);
      return true;
    },
    registry: new AgentRegistry(path.join(base, "provider-registry.json")),
    claudeJournalRoot: path.join(base, "claude-operations"),
    now: () => "2026-07-10T12:00:00.000Z",
  });
  const receipt = {
    operationId: "cleanup-fence",
    nativeId: "cleanup-fence",
    path: path.join(target.transcriptRoot, "cleanup-fence.jsonl"),
    continuityPaths: [],
    historyHash: "history",
    host: { kind: "claude-stream" as const, identity: "%7:77", epoch: 1, verifiedAt: "2026-07-10T12:00:00.000Z", tmuxHost: claudeHost("%7", 77) },
  };

  await expect(provider.cleanup(receipt)).rejects.toThrow("cleanup is still pending");
  expect(cancelled).toEqual([]);
  observedPid = 77;
  await provider.cleanup(receipt);
  expect(cancelled).toEqual([["%7", 77]]);

  const providerWithoutCleanup = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => { throw new Error("unexpected Codex client"); },
    claudeStatus: async () => ({ loggedIn: true }),
    spawnClaude: async () => ({ paneId: "%7", panePid: 77, host: claudeHost("%7", 77) }),
    now: () => "2026-07-10T12:00:00.000Z",
  });
  await expect(providerWithoutCleanup.cleanup(receipt)).rejects.toThrow("cleanup is still pending");

  const absentProvider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => { throw new Error("unexpected Codex client"); },
    claudeStatus: async () => ({ loggedIn: true }),
    spawnClaude: async () => ({ paneId: "%7", panePid: 77, host: claudeHost("%7", 77) }),
    cancelClaude: async () => "absent",
    now: () => "2026-07-10T12:00:00.000Z",
  });
  await absentProvider.cleanup(receipt);

  const unverifiableProvider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => { throw new Error("unexpected Codex client"); },
    claudeStatus: async () => ({ loggedIn: true }),
    spawnClaude: async () => ({ paneId: "%7", panePid: 77, host: claudeHost("%7", 77) }),
    cancelClaude: async () => "unverifiable",
    now: () => "2026-07-10T12:00:00.000Z",
  });
  await expect(unverifiableProvider.cleanup(receipt)).rejects.toThrow("cleanup is still pending");
});

test("concurrent Claude creates reuse one durable migration spawn receipt", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-claude-concurrent-"));
  roots.push(base);
  const source = accountRoot("claude", base, "source");
  const target = accountRoot("claude", base, "target");
  const sourcePath = path.join(source.transcriptRoot, "source.jsonl");
  fs.writeFileSync(sourcePath, "{}\n", { mode: 0o600 });
  const registry = new AgentRegistry(path.join(base, "provider-registry.json"));
  const conversation = registry.ensureConversation("claude", sourcePath, "source");
  let spawns = 0;
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => { throw new Error("unexpected Codex client"); },
    claudeStatus: async () => ({ loggedIn: true }),
    spawnClaude: async (spec) => {
      spawns += 1;
      fs.mkdirSync(path.dirname(spec.transcript!), { recursive: true, mode: 0o700 });
      fs.writeFileSync(spec.transcript!, JSON.stringify({ sessionId: path.basename(spec.transcript!, ".jsonl") }) + "\n", { mode: 0o600 });
      return { paneId: "%21", panePid: 2121, host: claudeHost("%21", 2121) };
    },
    verifyClaudeHost: async () => true,
    registry,
    claudeJournalRoot: path.join(base, "claude-operations"),
    now: () => "2026-07-10T12:00:00.000Z",
  });
  const input = {
    engine: "claude" as const,
    operationId: "claude-concurrent-operation",
    conversationId: conversation.id,
    targetAccountId: "target",
    source: conversation.generations[0]!,
    recordContinuityPath() {},
  };

  const receipts = await Promise.all([provider.create(input), provider.create(input)]);

  expect(spawns).toBe(1);
  expect(receipts[0]).toEqual(receipts[1]);
  const launchReceipts = Object.values(registry.snapshot().receipts);
  expect(launchReceipts).toHaveLength(1);
  expect(launchReceipts[0]).toMatchObject({ conversationId: conversation.id, purpose: "migration-successor" });
});

test("Claude create cancels the live host when continuity persistence fails", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-claude-continuity-failure-"));
  roots.push(base);
  const source = accountRoot("claude", base, "source");
  const target = accountRoot("claude", base, "target");
  const sourcePath = path.join(source.transcriptRoot, "source.jsonl");
  fs.writeFileSync(sourcePath, "{}\n", { mode: 0o600 });
  const registry = new AgentRegistry(path.join(base, "provider-registry.json"));
  const conversation = registry.ensureConversation("claude", sourcePath, "source");
  const cancelled: string[] = [];
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => { throw new Error("unexpected Codex client"); },
    claudeStatus: async () => ({ loggedIn: true }),
    spawnClaude: async (spec) => {
      fs.mkdirSync(path.dirname(spec.transcript!), { recursive: true, mode: 0o700 });
      fs.writeFileSync(spec.transcript!, JSON.stringify({ sessionId: path.basename(spec.transcript!, ".jsonl") }) + "\n", { mode: 0o600 });
      return { paneId: "%25", panePid: 2525, host: claudeHost("%25", 2525) };
    },
    cancelClaude: async (host) => { cancelled.push(host.paneId); return true; },
    registry,
    claudeJournalRoot: path.join(base, "claude-operations"),
    now: () => "2026-07-10T12:00:00.000Z",
  });

  await expect(provider.create({
    engine: "claude",
    operationId: "claude-continuity-failure",
    conversationId: conversation.id,
    targetAccountId: "target",
    source: conversation.generations[0]!,
    recordContinuityPath() { throw new Error("registry unavailable"); },
  })).rejects.toThrow("registry unavailable");

  expect(cancelled).toEqual(["%25"]);
  const spawnReceipt = Object.values(registry.snapshot().receipts)[0]!;
  expect(spawnReceipt).toMatchObject({ state: "path-pending", error: "migration continuity persistence failed" });
  registry.reconcileConversations([{
    engine: "claude",
    path: spawnReceipt.artifactPath!,
    accountId: "target",
    launchProfile: emptyLaunchProfile({ cwd: "/repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-10T12:01:00.000Z",
  }]);
  expect(registry.conversationForPath(spawnReceipt.artifactPath!)?.id).toBe(conversation.id);
  expect(Object.values(registry.snapshot().conversations)).toHaveLength(1);
});

test("Claude replay cancels its verified host when continuity persistence fails", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-claude-replay-continuity-failure-"));
  roots.push(base);
  const source = accountRoot("claude", base, "source");
  const target = accountRoot("claude", base, "target");
  const sourcePath = path.join(source.transcriptRoot, "source.jsonl");
  fs.writeFileSync(sourcePath, "{}\n", { mode: 0o600 });
  const registry = new AgentRegistry(path.join(base, "provider-registry.json"));
  const conversation = registry.ensureConversation("claude", sourcePath, "source");
  const cancelled: string[] = [];
  const dependencies = {
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => { throw new Error("unexpected Codex client"); },
    claudeStatus: async () => ({ loggedIn: true }),
    spawnClaude: async () => ({ paneId: "%26", panePid: 2626, host: claudeHost("%26", 2626) }),
    verifyClaudeHost: async () => true,
    cancelClaude: async (host: TmuxHostEvidence) => { cancelled.push(host.paneId); return true; },
    registry,
    claudeJournalRoot: path.join(base, "claude-operations"),
    now: () => "2026-07-10T12:00:00.000Z",
  } satisfies ProviderDependencies;
  const input = {
    engine: "claude" as const,
    operationId: "claude-replay-continuity-failure",
    conversationId: conversation.id,
    targetAccountId: "target",
    source: conversation.generations[0]!,
    recordContinuityPath() {},
  };
  await new RegisteredSuccessorProvider(dependencies).create(input);

  await expect(new RegisteredSuccessorProvider(dependencies).create({
    ...input,
    recordContinuityPath() { throw new Error("registry unavailable on replay"); },
  })).rejects.toThrow("registry unavailable on replay");

  expect(cancelled).toEqual(["%26"]);
  expect(Object.values(registry.snapshot().receipts)[0]).toMatchObject({ state: "path-pending", error: "migration continuity persistence failed" });
});

test("Claude replay resumes a pane-free birth receipt and fences terminal spawn state", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-claude-receipt-recovery-"));
  roots.push(base);
  const source = accountRoot("claude", base, "source");
  const target = accountRoot("claude", base, "target");
  const sourcePath = path.join(source.transcriptRoot, "source.jsonl");
  fs.writeFileSync(sourcePath, "{}\n", { mode: 0o600 });
  const registry = new AgentRegistry(path.join(base, "provider-registry.json"));
  const conversation = registry.ensureConversation("claude", sourcePath, "source");
  let spawns = 0;
  let forceTerminal = false;
  const cancelled: string[] = [];
  const dependencies = {
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => { throw new Error("unexpected Codex client"); },
    claudeStatus: async () => ({ loggedIn: true }),
    spawnClaude: async (spec: ReturnType<typeof import("@/lib/agent/cli").claudeSuccessorSpecFor>, launch: import("@/lib/agent/registry").SpawnReceipt) => {
      spawns += 1;
      fs.mkdirSync(path.dirname(spec.transcript!), { recursive: true, mode: 0o700 });
      fs.writeFileSync(spec.transcript!, JSON.stringify({ sessionId: path.basename(spec.transcript!, ".jsonl") }) + "\n", { mode: 0o600 });
      if (forceTerminal) registry.invalidateSpawnHost(launch.launchId, "forced terminal receipt");
      return { paneId: "%23", panePid: 2323, host: claudeHost("%23", 2323) };
    },
    verifyClaudeHost: async () => true,
    cancelClaude: async (host: TmuxHostEvidence) => { cancelled.push(host.paneId); return true; },
    registry,
    claudeJournalRoot: path.join(base, "claude-operations"),
    now: () => "2026-07-10T12:00:00.000Z",
  } satisfies ProviderDependencies;
  const input = {
    engine: "claude" as const,
    operationId: "claude-pane-free-retry",
    conversationId: conversation.id,
    targetAccountId: "target",
    source: conversation.generations[0]!,
    recordContinuityPath() {},
  };

  await expect(new RegisteredSuccessorProvider({
    ...dependencies,
    afterClaudeReceiptCreated() { throw new Error("simulated crash after receipt birth"); },
  }).create(input)).rejects.toThrow("simulated crash after receipt birth");
  expect(spawns).toBe(0);
  await expect(new RegisteredSuccessorProvider(dependencies).create(input)).resolves.toMatchObject({ host: { identity: "%23:2323" } });
  expect(spawns).toBe(1);

  forceTerminal = true;
  const recorded: string[] = [];
  await expect(new RegisteredSuccessorProvider(dependencies).create({
    ...input,
    operationId: "claude-terminal-fence",
    recordContinuityPath(pathname) { recorded.push(pathname); },
  })).rejects.toThrow("became terminal");
  expect(recorded).toEqual([]);
  expect(cancelled).toEqual(["%23"]);
});

test("Claude crash recovery reuses the exact host and observer settlement keeps one owner", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-claude-crash-recovery-"));
  roots.push(base);
  const source = accountRoot("claude", base, "source");
  const target = accountRoot("claude", base, "target");
  const sourcePath = path.join(source.transcriptRoot, "source.jsonl");
  fs.writeFileSync(sourcePath, "{}\n", { mode: 0o600 });
  const registry = new AgentRegistry(path.join(base, "provider-registry.json"));
  const conversation = registry.ensureConversation("claude", sourcePath, "source");
  let spawns = 0;
  const dependencies = {
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => { throw new Error("unexpected Codex client"); },
    claudeStatus: async () => ({ loggedIn: true }),
    spawnClaude: async (spec: ReturnType<typeof import("@/lib/agent/cli").claudeSuccessorSpecFor>) => {
      spawns += 1;
      fs.mkdirSync(path.dirname(spec.transcript!), { recursive: true, mode: 0o700 });
      fs.writeFileSync(spec.transcript!, JSON.stringify({ sessionId: path.basename(spec.transcript!, ".jsonl") }) + "\n", { mode: 0o600 });
      return { paneId: "%22", panePid: 2222, host: claudeHost("%22", 2222) };
    },
    verifyClaudeHost: async () => true,
    registry,
    claudeJournalRoot: path.join(base, "claude-operations"),
    now: () => "2026-07-10T12:00:00.000Z",
  } satisfies ProviderDependencies;
  const input = {
    engine: "claude" as const,
    operationId: "claude-crash-operation",
    conversationId: conversation.id,
    targetAccountId: "target",
    source: conversation.generations[0]!,
    recordContinuityPath() {},
  };

  await expect(new RegisteredSuccessorProvider({
    ...dependencies,
    afterClaudeSpawned() { throw new Error("simulated crash after Claude spawn"); },
  }).create(input)).rejects.toThrow("simulated crash after Claude spawn");
  const launchBeforeRecovery = Object.values(registry.snapshot().receipts)[0]!;
  registry.reconcileConversations([{
    engine: "claude",
    path: launchBeforeRecovery.artifactPath!,
    accountId: "target",
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-10T12:01:00.000Z",
  }]);
  expect(Object.values(registry.snapshot().conversations)).toHaveLength(1);
  expect(registry.conversationForPath(launchBeforeRecovery.artifactPath!)?.id).toBe(conversation.id);
  const receipt = await new RegisteredSuccessorProvider(dependencies).create(input);
  const launch = Object.values(registry.snapshot().receipts)[0]!;
  const settled = registry.settleSpawn(launch.launchId, {
    key: { engine: "claude", sessionId: receipt.nativeId },
    artifactPath: receipt.path,
    cwd: launch.cwd,
    accountId: "target",
    status: "live",
    host: receipt.host.tmuxHost!,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });

  expect(spawns).toBe(1);
  expect(settled).toMatchObject({ kind: "settled", conversation: { id: conversation.id } });
  expect(Object.values(registry.snapshot().conversations)).toHaveLength(1);
  expect(registry.conversation(conversation.id)?.generations.map((generation) => generation.path)).toEqual([sourcePath]);
});

test("unknown Claude transcript model omits the successor override", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-unknown-"));
  roots.push(base);
  const source = accountRoot("claude", base, "source");
  const target = accountRoot("claude", base, "target");
  const sourcePath = path.join(source.transcriptRoot, "source.jsonl");
  fs.writeFileSync(sourcePath, "{}\n", { mode: 0o600 });
  let command = "";
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => { throw new Error("unexpected Codex client"); },
    claudeStatus: async () => ({ loggedIn: true }),
    spawnClaude: async (spec) => { command = spec.command; return { paneId: "%10", panePid: 110, host: claudeHost("%10", 110) }; },
    registry: new AgentRegistry(path.join(base, "provider-registry.json")),
    claudeJournalRoot: path.join(base, "claude-operations"),
    now: () => "2026-07-10T12:00:00.000Z",
  });
  await provider.create({
    engine: "claude",
    operationId: "019f423a-d6e9-4903-8597-3e676b6ff3d4",
    conversationId: "conversation_test",
    targetAccountId: "target",
    source: { id: "native", path: sourcePath, accountId: "source", launchProfile: emptyLaunchProfile({ cwd: "/repo", model: "mythos-1" }), historyHash: null, host: null, createdAt: "now", archivedAt: null },
    recordContinuityPath() {},
  });
  expect(command).not.toContain("--model");
});

test("Codex successor provider accepts authenticated ChatGPT account responses and standard 0755 roots", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-codex-"));
  roots.push(base);
  const source = accountRoot("codex", base, "source");
  const target = accountRoot("codex", base, "target");
  for (const directory of [source.home, source.transcriptRoot, target.home, target.transcriptRoot]) fs.chmodSync(directory, 0o755);
  const sourceId = "019f423a-d6e9-7903-b597-3e676b6ff3d4";
  const sourcePath = path.join(source.transcriptRoot, "2026", "07", "10", `rollout-${sourceId}.jsonl`);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(sourcePath, codexSessionMeta(sourceId), { mode: 0o644 });
  const forkId = "019f423a-d6e9-4903-8597-3e676b6ff3d4";
  const forkPath = path.join(source.transcriptRoot, "2026", "07", "10", `rollout-${forkId}.jsonl`);
  const calls: string[] = [];
  let resumeOptions: unknown = null;
  let goalOptions: unknown = null;
  let targetAuthenticated = false;
  const client = (home: string) => ({
    async readAccount() {
      calls.push(`${path.basename(home)}:account`);
      return { account: home === target.home && !targetAuthenticated ? null : { type: "chatgpt" }, requiresOpenaiAuth: true };
    },
    async forkThread() { calls.push("source:fork"); fs.writeFileSync(forkPath, codexSessionMeta(forkId, sourceId), { mode: 0o644 }); return { id: forkId, path: forkPath }; },
    async resumeThread(id: string, options: unknown) { calls.push("target:resume"); resumeOptions = options; return { id, path: null }; },
    async readThread(id: string) { calls.push("target:read"); return { id, path: null }; },
    async setThreadName() { calls.push("target:name"); },
    async setThreadGoal(_id: string, objective: string, status: string) { calls.push("target:goal"); goalOptions = { objective, status }; },
    close() { calls.push(`${path.basename(home)}:close`); },
  }) as unknown as CodexAppServerClient;
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async (home) => client(home),
    claudeStatus: async () => ({ loggedIn: false }),
    spawnClaude: async () => { throw new Error("unexpected Claude spawn"); },
    now: () => "2026-07-10T12:00:00.000Z",
  });
  const profile = emptyLaunchProfile({ cwd: "/repo", model: "gpt-5.6-terra", effort: "high", fast: true, permissionMode: "never", readOnly: true, title: "Migration", goal: { objective: "Ship", status: "active", tokensUsed: null, timeUsedSeconds: null } });
  const recorded: string[] = [];
  const input = {
    engine: "codex",
    operationId: "operation-codex",
    conversationId: "conversation_test",
    targetAccountId: "target",
    source: { id: sourceId, path: sourcePath, accountId: "source", launchProfile: profile, historyHash: null, host: null, createdAt: "now", archivedAt: null },
    recordContinuityPath(pathname: string) { recorded.push(pathname); },
  } as Parameters<SuccessorProviderPort["create"]>[0] & { recordContinuityPath(pathname: string): void };
  await expect(provider.create(input)).rejects.toThrow("target Codex account is not authenticated");
  const failedTargetCopy = path.join(target.transcriptRoot, "2026", "07", "10", `rollout-${forkId}.jsonl`);
  expect(recorded).toEqual([forkPath, failedTargetCopy]);

  targetAuthenticated = true;
  const receipt = await provider.create(input);
  expect(receipt.nativeId).toBe(forkId);
  expect(receipt.path.startsWith(target.transcriptRoot + path.sep)).toBeTrue();
  expect(receipt.continuityPaths).toEqual([forkPath, receipt.path]);
  expect(fs.readFileSync(receipt.path, "utf8")).toContain("session_meta");
  expect(calls).toContain("source:fork");
  expect(calls).toContain("target:resume");
  expect(calls).toContain("target:name");
  expect(calls).toContain("target:goal");
  expect(resumeOptions).toEqual({ path: receipt.path, cwd: "/repo", model: "gpt-5.6-terra", effort: "high", fast: true, approvalPolicy: "never", sandbox: "read-only" });
  expect(goalOptions).toEqual({ objective: "Ship", status: "active" });
  await provider.verify(receipt, { engine: "codex", targetAccountId: "target", launchProfile: profile });
  expect(calls.filter((call) => call === "target:read").length).toBeGreaterThanOrEqual(2);
  targetAuthenticated = false;
  await expect(provider.verify(receipt, { engine: "codex", targetAccountId: "target", launchProfile: profile }))
    .rejects.toThrow("target Codex account is not authenticated");
});

test("a definite Codex fork rejection can retry the same operation", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-codex-definite-retry-"));
  roots.push(base);
  const source = accountRoot("codex", base, "source");
  const target = accountRoot("codex", base, "target");
  const sourceId = "039f423a-d6e9-7903-b597-3e676b6ff3d4";
  const forkId = "039f423a-d6e9-4903-8597-3e676b6ff3d4";
  const sourcePath = path.join(source.transcriptRoot, `rollout-${sourceId}.jsonl`);
  const forkPath = path.join(source.transcriptRoot, `rollout-${forkId}.jsonl`);
  fs.writeFileSync(sourcePath, codexSessionMeta(sourceId), { mode: 0o600 });
  let forkCalls = 0;
  const client = () => ({
    async readAccount() { return { account: { type: "chatgpt" }, requiresOpenaiAuth: true }; },
    async forkThread() {
      forkCalls += 1;
      if (forkCalls === 1) throw new Error("request rejected before dispatch");
      fs.writeFileSync(forkPath, codexSessionMeta(forkId, sourceId), { mode: 0o600 });
      return { id: forkId, path: forkPath };
    },
    async resumeThread(id: string) { return { id, path: null }; },
    async readThread(id: string) { return { id, path: null }; },
    close() {},
  }) as unknown as CodexAppServerClient;
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => client(), claudeStatus: async () => ({ loggedIn: false }),
    spawnClaude: async () => { throw new Error("unexpected Claude spawn"); },
    now: () => "2026-07-10T12:00:00.000Z", journalRoot: path.join(base, "journal"),
  });
  const input = { engine: "codex" as const, operationId: "definite-fork-retry", conversationId: "conversation_definite" as const, targetAccountId: "target", source: { id: sourceId, path: sourcePath, accountId: "source", launchProfile: emptyLaunchProfile({ cwd: "/repo" }), historyHash: null, host: null, createdAt: "now", archivedAt: null }, recordContinuityPath() {} };
  await expect(provider.create(input)).rejects.toThrow("request rejected before dispatch");
  await expect(provider.create(input)).resolves.toMatchObject({ nativeId: forkId });
  expect(forkCalls).toBe(2);
});

test("concurrent Codex creates publish one successor for the same operation", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-codex-concurrent-"));
  roots.push(base);
  const source = accountRoot("codex", base, "source");
  const target = accountRoot("codex", base, "target");
  const journalRoot = path.join(base, "provider-journal");
  const sourceId = "119f423a-d6e9-7903-b597-3e676b6ff3d4";
  const sourcePath = path.join(source.transcriptRoot, `rollout-${sourceId}.jsonl`);
  fs.writeFileSync(sourcePath, codexSessionMeta(sourceId), { mode: 0o600 });
  let forkCalls = 0;
  const client = () => ({
    async readAccount() { return { account: { type: "chatgpt" }, requiresOpenaiAuth: true }; },
    async forkThread() {
      forkCalls += 1;
      const call = forkCalls;
      await new Promise((resolve) => setTimeout(resolve, 10));
      const id = `119f423a-d6e9-4903-8597-${String(call).padStart(12, "0")}`;
      const forkPath = path.join(source.transcriptRoot, `rollout-${id}.jsonl`);
      fs.writeFileSync(forkPath, codexSessionMeta(id, sourceId), { mode: 0o600 });
      return { id, path: forkPath };
    },
    async resumeThread(id: string) { return { id, path: null }; },
    async readThread(id: string) { return { id, path: null }; },
    close() {},
  }) as unknown as CodexAppServerClient;
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => client(),
    claudeStatus: async () => ({ loggedIn: false }),
    spawnClaude: async () => { throw new Error("unexpected Claude spawn"); },
    journalRoot,
    now: () => "2026-07-10T12:00:00.000Z",
  });
  const input = {
    engine: "codex" as const,
    operationId: "concurrent-operation",
    conversationId: "conversation_test" as const,
    targetAccountId: "target",
    source: { id: sourceId, path: sourcePath, accountId: "source", launchProfile: emptyLaunchProfile({ cwd: "/repo" }), historyHash: null, host: null, createdAt: "now", archivedAt: null },
    recordContinuityPath() {},
  };

  const results = await Promise.all([provider.create(input), provider.create(input)]);

  expect(forkCalls).toBe(1);
  expect(results[0]).toEqual(results[1]);
});

test("a fresh 51-conversation Codex drain skips recovery history scans", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-codex-mass-drain-"));
  roots.push(base);
  const source = accountRoot("codex", base, "source");
  const target = accountRoot("codex", base, "target");
  const sourceId = "219f423a-d6e9-7903-b597-3e676b6ff3d4";
  const sourcePath = path.join(source.transcriptRoot, `rollout-${sourceId}.jsonl`);
  fs.writeFileSync(sourcePath, codexSessionMeta(sourceId), { mode: 0o600 });
  let forkCalls = 0;
  let scanCalls = 0;
  const client = () => ({
    async readAccount() { return { account: { type: "chatgpt" }, requiresOpenaiAuth: true }; },
    async forkThread() {
      forkCalls += 1;
      const id = `219f423a-d6e9-4903-8597-${String(forkCalls).padStart(12, "0")}`;
      const forkPath = path.join(source.transcriptRoot, `rollout-${id}.jsonl`);
      fs.writeFileSync(forkPath, codexSessionMeta(id, sourceId), { mode: 0o600 });
      return { id, path: forkPath };
    },
    async resumeThread(id: string) { return { id, path: null }; },
    async readThread(id: string) { return { id, path: null }; },
    close() {},
  }) as unknown as CodexAppServerClient;
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => client(),
    claudeStatus: async () => ({ loggedIn: false }),
    spawnClaude: async () => { throw new Error("unexpected Claude spawn"); },
    journalRoot: path.join(base, "provider-journal"),
    scanCodexForkArtifacts() { scanCalls += 1; return []; },
    now: () => "2026-07-10T12:00:00.000Z",
  });
  const generation = { id: sourceId, path: sourcePath, accountId: "source", launchProfile: emptyLaunchProfile({ cwd: "/repo" }), historyHash: null, host: null, createdAt: "now", archivedAt: null };

  for (let index = 0; index < 51; index += 1) {
    await provider.create({
      engine: "codex",
      operationId: `mass-drain-${index}`,
      conversationId: `conversation_mass_${index}`,
      targetAccountId: "target",
      source: generation,
      recordContinuityPath() {},
    });
  }

  expect(forkCalls).toBe(51);
  expect(scanCalls).toBe(0);
});

test("first Codex operation fsyncs every newly created journal directory entry", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-codex-journal-fsync-"));
  roots.push(base);
  const source = accountRoot("codex", base, "source");
  const target = accountRoot("codex", base, "target");
  const sourceId = "319f423a-d6e9-7903-b597-3e676b6ff3d4";
  const forkId = "319f423a-d6e9-4903-8597-3e676b6ff3d4";
  const sourcePath = path.join(source.transcriptRoot, `rollout-${sourceId}.jsonl`);
  const forkPath = path.join(source.transcriptRoot, `rollout-${forkId}.jsonl`);
  const journalParent = path.join(base, "new-state");
  const journalRoot = path.join(journalParent, "provider-journal");
  fs.writeFileSync(sourcePath, codexSessionMeta(sourceId), { mode: 0o600 });
  const client = () => ({
    async readAccount() { return { account: { type: "chatgpt" }, requiresOpenaiAuth: true }; },
    async forkThread() {
      fs.writeFileSync(forkPath, codexSessionMeta(forkId, sourceId), { mode: 0o600 });
      return { id: forkId, path: forkPath };
    },
    async resumeThread(id: string) { return { id, path: null }; },
    async readThread(id: string) { return { id, path: null }; },
    close() {},
  }) as unknown as CodexAppServerClient;
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => client(),
    claudeStatus: async () => ({ loggedIn: false }),
    spawnClaude: async () => { throw new Error("unexpected Claude spawn"); },
    journalRoot,
    now: () => "2026-07-10T12:00:00.000Z",
  });
  const syncedDirectories: string[] = [];
  const fsync = fs.fsyncSync.bind(fs);
  fs.fsyncSync = ((descriptor: number) => {
    try {
      const pathname = fs.readlinkSync(`/proc/self/fd/${descriptor}`);
      if (fs.fstatSync(descriptor).isDirectory()) syncedDirectories.push(pathname);
    } catch { /* descriptor observability is platform-dependent */ }
    return fsync(descriptor);
  }) as typeof fs.fsyncSync;
  try {
    await provider.create({
      engine: "codex",
      operationId: "journal-first-operation",
      conversationId: "conversation_journal_fsync",
      targetAccountId: "target",
      source: { id: sourceId, path: sourcePath, accountId: "source", launchProfile: emptyLaunchProfile({ cwd: "/repo" }), historyHash: null, host: null, createdAt: "now", archivedAt: null },
      recordContinuityPath() {},
    });
  } finally {
    fs.fsyncSync = fsync;
  }

  expect(syncedDirectories).toContain(base);
  expect(syncedDirectories).toContain(journalParent);
});

test("Codex successor provider recovers a validated fork created before exact receipt persistence", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-codex-fork-recovery-"));
  roots.push(base);
  const source = accountRoot("codex", base, "source");
  const target = accountRoot("codex", base, "target");
  const journalRoot = path.join(base, "provider-journal");
  const sourceId = "019f423a-d6e9-7903-b597-3e676b6ff3d4";
  const forkId = "019f423a-d6e9-4903-8597-3e676b6ff3d4";
  const sourcePath = path.join(source.transcriptRoot, `rollout-${sourceId}.jsonl`);
  const forkPath = path.join(source.transcriptRoot, `rollout-${forkId}.jsonl`);
  fs.writeFileSync(sourcePath, codexSessionMeta(sourceId), { mode: 0o600 });
  let forkCalls = 0;
  const client = () => ({
    async readAccount() { return { account: { type: "chatgpt" }, requiresOpenaiAuth: true }; },
    async forkThread() {
      forkCalls += 1;
      fs.writeFileSync(forkPath, codexSessionMeta(forkId, sourceId), { mode: 0o600 });
      return { id: forkId, path: forkPath };
    },
    async resumeThread(id: string) { return { id, path: null }; },
    async readThread(id: string) { return { id, path: null }; },
    close() {},
  }) as unknown as CodexAppServerClient;
  const dependencies = {
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => client(),
    claudeStatus: async () => ({ loggedIn: false }),
    spawnClaude: async () => { throw new Error("unexpected Claude spawn"); },
    now: () => "2026-07-10T12:00:00.000Z",
    journalRoot,
  } as ProviderDependencies & { journalRoot: string; afterCodexForkReturned?: () => void };
  const registry = new AgentRegistry(path.join(base, "registry.json"));
  const conversation = registry.ensureConversation("codex", sourcePath, "source");
  registry.setConversationMigration(conversation.id, {
    intentId: "fork-recovery",
    phase: "successor-starting",
    targetId: "target",
    revision: 1,
    error: null,
    updatedAt: "2026-07-10T12:00:00.000Z",
  });
  const input = {
    engine: "codex" as const,
    operationId: "operation-fork-recovery",
    conversationId: conversation.id,
    targetAccountId: "target",
    source: conversation.generations[0]!,
    recordContinuityPath(pathname: string) { registry.recordConversationContinuityPath(conversation.id, pathname); },
  };
  const crashed = new RegisteredSuccessorProvider({
    ...dependencies,
    afterCodexForkReturned() { throw new Error("simulated crash before exact fork receipt"); },
  } as ProviderDependencies);

  await expect(crashed.create(input)).rejects.toThrow("simulated crash before exact fork receipt");
  expect(forkCalls).toBe(1);

  const ambiguousId = "019f423a-d6e9-4903-8597-3e676b6ff3ff";
  const ambiguousPath = path.join(source.transcriptRoot, `rollout-${ambiguousId}.jsonl`);
  fs.writeFileSync(ambiguousPath, codexSessionMeta(ambiguousId, sourceId), { mode: 0o600 });
  await expect(new RegisteredSuccessorProvider(dependencies).create(input)).rejects.toThrow("ambiguous");
  expect(forkCalls).toBe(1);
  fs.rmSync(ambiguousPath);

  const receipt = await new RegisteredSuccessorProvider(dependencies).create(input);
  const observation = (pathname: string, accountId: string): ConversationObservation => ({
    engine: "codex",
    path: pathname,
    accountId,
    launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
    turn: { state: "idle", source: "empty", terminalAt: null },
    observedAt: "2026-07-10T12:01:00.000Z",
  });
  registry.reconcileConversations([
    observation(forkPath, "source"),
    observation(receipt.path, "target"),
  ]);

  expect(forkCalls).toBe(1);
  expect(receipt.nativeId).toBe(forkId);
  expect(Object.values(registry.snapshot().conversations)).toHaveLength(1);
  expect(registry.conversationForPath(forkPath)?.id).toBe(conversation.id);
  expect(registry.conversationForPath(receipt.path)?.id).toBe(conversation.id);
});

test("Codex successor provider reuses one published copy after a crash", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-codex-copy-recovery-"));
  roots.push(base);
  const source = accountRoot("codex", base, "source");
  const target = accountRoot("codex", base, "target");
  const journalRoot = path.join(base, "provider-journal");
  const sourceId = "029f423a-d6e9-7903-b597-3e676b6ff3d4";
  const forkId = "029f423a-d6e9-4903-8597-3e676b6ff3d4";
  const sourcePath = path.join(source.transcriptRoot, `rollout-${sourceId}.jsonl`);
  const forkPath = path.join(source.transcriptRoot, `rollout-${forkId}.jsonl`);
  fs.writeFileSync(sourcePath, codexSessionMeta(sourceId), { mode: 0o600 });
  let forkCalls = 0;
  const client = () => ({
    async readAccount() { return { account: { type: "chatgpt" }, requiresOpenaiAuth: true }; },
    async forkThread() {
      forkCalls += 1;
      fs.writeFileSync(forkPath, codexSessionMeta(forkId, sourceId), { mode: 0o600 });
      return { id: forkId, path: forkPath };
    },
    async resumeThread(id: string) { return { id, path: null }; },
    async readThread(id: string) { return { id, path: null }; },
    close() {},
  }) as unknown as CodexAppServerClient;
  const dependencies = {
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => client(),
    claudeStatus: async () => ({ loggedIn: false }),
    spawnClaude: async () => { throw new Error("unexpected Claude spawn"); },
    now: () => "2026-07-10T12:00:00.000Z",
    journalRoot,
  } as ProviderDependencies & { journalRoot: string; afterCodexCopyPublished?: () => void };
  const registry = new AgentRegistry(path.join(base, "registry.json"));
  const conversation = registry.ensureConversation("codex", sourcePath, "source");
  registry.setConversationMigration(conversation.id, {
    intentId: "copy-recovery",
    phase: "successor-starting",
    targetId: "target",
    revision: 1,
    error: null,
    updatedAt: "2026-07-10T12:00:00.000Z",
  });
  const input = {
    engine: "codex" as const,
    operationId: "operation-copy-recovery",
    conversationId: conversation.id,
    targetAccountId: "target",
    source: conversation.generations[0]!,
    recordContinuityPath(pathname: string) { registry.recordConversationContinuityPath(conversation.id, pathname); },
  };
  const crashed = new RegisteredSuccessorProvider({
    ...dependencies,
    afterCodexCopyPublished() { throw new Error("simulated crash after copy"); },
  } as ProviderDependencies);

  await expect(crashed.create(input)).rejects.toThrow("simulated crash after copy");
  const copiedPath = path.join(target.transcriptRoot, path.basename(forkPath));
  const published = fs.statSync(copiedPath);
  expect(forkCalls).toBe(1);

  const receipt = await new RegisteredSuccessorProvider(dependencies).create(input);
  registry.reconcileConversations([
    {
      engine: "codex",
      path: forkPath,
      accountId: "source",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-10T12:01:00.000Z",
    },
    {
      engine: "codex",
      path: receipt.path,
      accountId: "target",
      launchProfile: emptyLaunchProfile({ cwd: "/repo", project: "repo" }),
      turn: { state: "idle", source: "empty", terminalAt: null },
      observedAt: "2026-07-10T12:01:00.000Z",
    },
  ]);

  expect(forkCalls).toBe(1);
  expect(receipt.path).toBe(copiedPath);
  expect(fs.statSync(receipt.path).ino).toBe(published.ino);
  expect(fs.readdirSync(source.transcriptRoot).filter((name) => name.endsWith(".jsonl"))).toHaveLength(2);
  expect(fs.readdirSync(target.transcriptRoot).filter((name) => name.endsWith(".jsonl"))).toHaveLength(1);
  expect(Object.values(registry.snapshot().conversations)).toHaveLength(1);
});

test("Codex successor provider rejects an unregistered fork path before recording ownership", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-codex-foreign-"));
  roots.push(base);
  const source = accountRoot("codex", base, "source");
  const target = accountRoot("codex", base, "target");
  const sourcePath = path.join(source.transcriptRoot, "rollout-source.jsonl");
  const foreignPath = path.join(base, "foreign-rollout.jsonl");
  fs.writeFileSync(sourcePath, "{}\n", { mode: 0o600 });
  fs.writeFileSync(foreignPath, "{}\n", { mode: 0o600 });
  const client = {
    async readAccount() { return { account: { type: "chatgpt" }, requiresOpenaiAuth: true }; },
    async forkThread() { return { id: "019f423a-d6e9-4903-8597-3e676b6ff3d4", path: foreignPath }; },
    close() {},
  } as unknown as CodexAppServerClient;
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => client,
    claudeStatus: async () => ({ loggedIn: false }),
    spawnClaude: async () => { throw new Error("unexpected Claude spawn"); },
    now: () => "2026-07-10T12:00:00.000Z",
  });
  const recorded: string[] = [];

  await expect(provider.create({
    engine: "codex",
    operationId: "foreign-fork",
    conversationId: "conversation_test",
    targetAccountId: "target",
    source: { id: "source", path: sourcePath, accountId: "source", launchProfile: emptyLaunchProfile({ cwd: "/repo" }), historyHash: null, host: null, createdAt: "now", archivedAt: null },
    recordContinuityPath(pathname) { recorded.push(pathname); },
  })).rejects.toThrow("unsafe-source");
  expect(recorded).toEqual([]);
});
