import { afterEach, expect, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { emptyLaunchProfile, migrationSuccessorLaunchProfile, sameProviderReceiptOutcome, type NativeGeneration, type ProviderReceipt, type SuccessorProviderPort } from "./contracts";
import {
  authorizeCodexForkRetry,
  codexForkArtifacts,
  CodexForkOutcomeUnknownError,
  RegisteredSuccessorProvider,
  type ProviderDependencies,
} from "./provider";
import { CodexAppServerError, type CodexAppServerClient } from "@/lib/accounts/codexAppServer";
import { AgentRegistry, type ConversationObservation, type TmuxHostEvidence } from "@/lib/agent/registry";
import { ClaudeStreamBrokerHost } from "@/lib/runtime/claudeStreamBrokerHost";
import type { EngineHost, HostState } from "@/lib/runtime/engineHost";
import { StructuredDeliveryControllerUnavailableError } from "@/lib/runtime/structuredDeliveryController";

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

function titledProviderSource(source: NativeGeneration): NativeGeneration {
  return {
    ...source,
    launchProfile: emptyLaunchProfile({
      ...source.launchProfile,
      title: source.launchProfile.title ?? "Migrate provider fixture",
    }),
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

test("Codex successor host publication is single-owner and cleanup releases that owner", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-published-host-"));
  roots.push(base);
  const source = accountRoot("codex", base, "source");
  const target = accountRoot("codex", base, "target");
  let publications = 0;
  let cleanups = 0;
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => { throw new Error("unexpected Codex client"); },
    claudeStatus: async () => ({ loggedIn: true }),
    publishCodexHost: async () => {
      publications += 1;
      await Promise.resolve();
      return async () => { cleanups += 1; };
    },
    now: () => "2026-07-13T12:00:00.000Z",
  });
  const receipt: ProviderReceipt = {
    operationId: "publish-operation",
    nativeId: "22222222-2222-\x34222-8222-222222222222",
    path: path.join(target.transcriptRoot, "22222222-2222-\x34222-8222-222222222222.jsonl"),
    continuityPaths: [],
    historyHash: "history",
    host: {
      kind: "codex-app-server",
      identity: "22222222-2222-\x34222-8222-222222222222",
      epoch: 1,
      verifiedAt: "2026-07-13T12:00:00.000Z",
    },
  };
  const input = {
    engine: "codex" as const,
    conversationId: "conversation_published_host" as const,
    targetAccountId: "target",
    launchProfile: emptyLaunchProfile({ cwd: base }),
  };

  await Promise.all([provider.publishHost(receipt, input), provider.publishHost(receipt, input)]);
  expect(publications).toBe(1);
  await provider.cleanup(receipt);
  expect(cleanups).toBe(1);
});

test("Claude successor cleanup releases its published broker owner", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-published-claude-host-"));
  roots.push(base);
  const source = accountRoot("claude", base, "source");
  const target = accountRoot("claude", base, "target");
  let publications = 0;
  let cleanups = 0;
  let legacyCancellations = 0;
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => { throw new Error("unexpected Codex client"); },
    claudeStatus: async () => ({ loggedIn: true }),
    cancelClaude: async () => { legacyCancellations += 1; return true; },
    publishClaudeHost: async () => {
      publications += 1;
      return async () => { cleanups += 1; };
    },
    now: () => "2026-07-13T12:00:00.000Z",
  });
  const tmux = claudeHost("%45", 4545);
  const receipt: ProviderReceipt = {
    operationId: "publish-claude-operation",
    nativeId: "45454545-4545-\x34545-8545-454545454545",
    path: path.join(target.transcriptRoot, "45454545-4545-\x34545-8545-454545454545.jsonl"),
    continuityPaths: [],
    historyHash: "history",
    host: {
      kind: "claude-stream",
      identity: "%45:4545",
      epoch: 1,
      verifiedAt: "2026-07-13T12:00:00.000Z",
      tmuxHost: tmux,
    },
  };
  await provider.publishHost(receipt, {
    engine: "claude",
    conversationId: "conversation_published_claude_host",
    targetAccountId: "target",
    launchProfile: emptyLaunchProfile({ cwd: base }),
  });
  await provider.cleanup(receipt);

  expect(publications).toBe(1);
  expect(cleanups).toBe(1);
  expect(legacyCancellations).toBe(0);
});

test("Claude publication waits for controller startup before replacing its verified successor", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-claude-controller-startup-"));
  roots.push(base);
  const source = accountRoot("claude", base, "source");
  const target = accountRoot("claude", base, "target");
  const registry = new AgentRegistry(path.join(base, "provider-registry.json"));
  const nativeId = "47474747-4747-\x34474-8747-474747474747";
  const transcript = path.join(target.transcriptRoot, `${nativeId}.jsonl`);
  fs.writeFileSync(transcript, JSON.stringify({ sessionId: nativeId }) + "\n", { mode: 0o600 });
  const tmux = claudeHost("%47", 4747);
  let tmuxLive = true;
  let cancellations = 0;
  let adoptions = 0;
  let releases = 0;
  const state: HostState = {
    status: "idle",
    sessionKey: nativeId,
    endpoint: "stdio:claude-controller-startup",
    pid: process.pid,
    processStartIdentity: null,
    eventCursor: 0,
    protocolVersion: "test-v1",
    activeTurnRef: null,
    pendingAttention: [],
    activeFlags: [],
    account: null,
  };
  let stateListener: ((state: HostState) => void) | null = null;
  const fakeHost = {
    identity: { sessionId: nativeId },
    setWriterFence() {},
    health: async () => state,
    onStateChange(listener: (next: HostState) => void) {
      stateListener = listener;
      return () => { stateListener = null; };
    },
    release: async () => {
      releases += 1;
      stateListener?.({ ...state, status: "dead", endpoint: "stdio:released", pid: null });
    },
  } as unknown as ClaudeStreamBrokerHost & EngineHost;
  const adopt = spyOn(ClaudeStreamBrokerHost, "adopt").mockImplementation(async () => {
    adoptions += 1;
    return fakeHost;
  });
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => { throw new Error("unexpected Codex client"); },
    claudeStatus: async () => ({ loggedIn: true }),
    verifyClaudeHost: async () => tmuxLive,
    cancelClaude: async () => {
      if (!tmuxLive) return "absent";
      cancellations += 1;
      tmuxLive = false;
      return true;
    },
    registry,
    now: () => "2026-07-22T09:00:00.000Z",
  });
  const receipt: ProviderReceipt = {
    operationId: "claude-controller-startup",
    nativeId,
    path: transcript,
    continuityPaths: [transcript],
    historyHash: "claude-controller-startup-history",
    host: {
      kind: "claude-stream",
      identity: "%47:4747",
      epoch: 1,
      verifiedAt: "2026-07-22T09:00:00.000Z",
      tmuxHost: tmux,
    },
  };
  const input = {
    engine: "claude" as const,
    conversationId: "conversation_claude_controller_startup" as const,
    targetAccountId: "target",
    launchProfile: emptyLaunchProfile({ cwd: base }),
  };
  const structuredFlag = process.env.LLV_STRUCTURED_HOSTS;
  process.env.LLV_STRUCTURED_HOSTS = "1";
  const controller = (process as typeof process & {
    __llvStructuredDeliveryController?: { registerActiveHost: ((item: unknown) => Promise<() => Promise<void>>) | null };
  }).__llvStructuredDeliveryController!;
  const originalRegister = controller.registerActiveHost;
  controller.registerActiveHost = null;
  try {
    await provider.verify(receipt, { engine: "claude", targetAccountId: "target", launchProfile: input.launchProfile });
    await expect(provider.publishHost(receipt, input)).rejects.toThrow("controller is unavailable");
    expect({ tmuxLive, cancellations, adoptions, releases }).toEqual({
      tmuxLive: true,
      cancellations: 0,
      adoptions: 0,
      releases: 0,
    });

    controller.registerActiveHost = async () => {
      controller.registerActiveHost = null;
      throw new StructuredDeliveryControllerUnavailableError();
    };
    await expect(provider.publishHost(receipt, input)).rejects.toThrow("controller is unavailable");
    expect({ tmuxLive, cancellations, adoptions, releases }).toEqual({
      tmuxLive: false,
      cancellations: 1,
      adoptions: 1,
      releases: 1,
    });

    controller.registerActiveHost = async () => async () => {};
    await provider.verify(receipt, { engine: "claude", targetAccountId: "target", launchProfile: input.launchProfile });
    await provider.publishHost(receipt, input);
    await provider.cleanup(receipt);
    expect({ tmuxLive, cancellations, adoptions, releases }).toEqual({
      tmuxLive: false,
      cancellations: 1,
      adoptions: 2,
      releases: 2,
    });
  } finally {
    controller.registerActiveHost = originalRegister;
    adopt.mockRestore();
    if (structuredFlag === undefined) delete process.env.LLV_STRUCTURED_HOSTS;
    else process.env.LLV_STRUCTURED_HOSTS = structuredFlag;
  }
});

test("a fenced Claude publication keeps receipt cleanup available", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-fenced-claude-publication-"));
  roots.push(base);
  const source = accountRoot("claude", base, "source");
  const target = accountRoot("claude", base, "target");
  let ownershipChecks = 0;
  const cancelled: string[] = [];
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => { throw new Error("unexpected Codex client"); },
    claudeStatus: async () => ({ loggedIn: true }),
    cancelClaude: async (host) => { cancelled.push(host.paneId); return true; },
    publishClaudeHost: async (input) => {
      if (input.ownsOperation && !await input.ownsOperation()) return async () => {};
      throw new Error("stale publication unexpectedly retained ownership");
    },
    now: () => "2026-07-20T12:00:00.000Z",
  });
  const tmux = claudeHost("%46", 4646);
  const receipt: ProviderReceipt = {
    operationId: "fenced-claude-publication",
    nativeId: "46464646-4646-\x34646-8646-464646464646",
    path: path.join(target.transcriptRoot, "46464646-4646-\x34646-8646-464646464646.jsonl"),
    continuityPaths: [],
    historyHash: "history",
    host: {
      kind: "claude-stream",
      identity: "%46:4646",
      epoch: 1,
      verifiedAt: "2026-07-20T12:00:00.000Z",
      tmuxHost: tmux,
    },
  };

  await provider.publishHost(receipt, {
    engine: "claude",
    conversationId: "conversation_fenced_claude_publication",
    targetAccountId: "target",
    launchProfile: emptyLaunchProfile({ cwd: base }),
    ownsOperation: async () => {
      ownershipChecks += 1;
      return ownershipChecks === 1;
    },
  });
  await provider.cleanup(receipt);

  expect(ownershipChecks).toBeGreaterThanOrEqual(2);
  expect(cancelled).toEqual(["%46"]);
});

const FORK_SOURCE_ID = "019f423a-d6e9-\x34903-b597-3e676b6ff3d4";
const FORK_OPERATION_ID = "7d1c2b3a-4e5f-\x34a6b-8c7d-9e0f1a2b3c4d";

function claudeForkFixture(base: string) {
  const source = accountRoot("claude", base, "source");
  const target = accountRoot("claude", base, "target");
  const sourcePath = path.join(source.transcriptRoot, "-repo", `${FORK_SOURCE_ID}.jsonl`);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true, mode: 0o700 });
  const quoted = `"sessionId":"${FORK_SOURCE_ID}"`;
  fs.writeFileSync(sourcePath, [
    JSON.stringify({ type: "user", sessionId: FORK_SOURCE_ID, cwd: "/repo", message: { role: "user", content: "Привіт, почнімо ✅" } }),
    JSON.stringify({ type: "summary", leafUuid: "leaf", summary: "carries no session field" }),
    JSON.stringify({ type: "assistant", sessionId: FORK_SOURCE_ID, message: { role: "assistant", content: [{ type: "text", text: `a quoted ${quoted} inside a value` }] } }),
  ].join("\n") + "\n", { mode: 0o600 });
  const sourceGeneration: NativeGeneration = {
    id: FORK_SOURCE_ID,
    path: sourcePath,
    accountId: "source",
    launchProfile: migrationSuccessorLaunchProfile(emptyLaunchProfile({ cwd: "/repo", model: "fable", title: "Claude session" })),
    historyHash: null,
    host: null,
    createdAt: "2026-07-10T11:00:00.000Z",
    archivedAt: null,
  };
  const dependencies = {
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => { throw new Error("unexpected Codex client"); },
    claudeStatus: async () => ({ loggedIn: true }),
    registry: new AgentRegistry(path.join(base, "provider-registry.json")),
    claudeJournalRoot: path.join(base, "claude-operations"),
    now: () => "2026-07-10T12:00:00.000Z",
  } satisfies ProviderDependencies;
  const input = {
    engine: "claude" as const,
    operationId: FORK_OPERATION_ID,
    conversationId: "conversation_fork_test" as const,
    targetAccountId: "target",
    source: sourceGeneration,
    recordContinuityPath() {},
  };
  const successorPath = path.join(target.transcriptRoot, "-repo", `${FORK_OPERATION_ID}.jsonl`);
  return { source, target, sourcePath, sourceGeneration, dependencies, input, successorPath };
}

test("Claude successor is a fork the viewer writes into the target root, with no launch", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-claude-fork-"));
  roots.push(base);
  const fixture = claudeForkFixture(base);
  const recorded: string[] = [];
  const provider = new RegisteredSuccessorProvider(fixture.dependencies);

  const receipt = await provider.create({ ...fixture.input, recordContinuityPath(pathname) { recorded.push(pathname); } });

  expect(receipt).toEqual({
    operationId: FORK_OPERATION_ID,
    nativeId: FORK_OPERATION_ID,
    path: fixture.successorPath,
    continuityPaths: [fixture.successorPath],
    historyHash: expect.any(String),
    host: { kind: "claude-fork", identity: FORK_OPERATION_ID, epoch: 1, verifiedAt: "2026-07-10T12:00:00.000Z" },
  });
  expect(recorded).toEqual([fixture.successorPath]);
  const forked = fs.readFileSync(fixture.successorPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(forked.map((record) => record.sessionId)).toEqual([FORK_OPERATION_ID, undefined, FORK_OPERATION_ID]);
  expect((forked[0]!.message as { content: string }).content).toBe("Привіт, почнімо ✅");
  /* A mention inside a value is text, not identity: it stays as written. */
  expect(JSON.stringify(forked[2])).toContain(FORK_SOURCE_ID);
  expect(fs.statSync(fixture.successorPath).mode & 0o777).toBe(0o600);
  expect(Object.values(fixture.dependencies.registry.snapshot().receipts)).toHaveLength(0);
  await expect(provider.verify(receipt, { engine: "claude", targetAccountId: "target", launchProfile: fixture.sourceGeneration.launchProfile }))
    .resolves.toBeUndefined();
});

test("Claude successor verification rejects a fork that is no longer durable", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-claude-fork-missing-"));
  roots.push(base);
  const fixture = claudeForkFixture(base);
  const provider = new RegisteredSuccessorProvider(fixture.dependencies);
  const receipt = await provider.create(fixture.input);
  fs.rmSync(receipt.path);

  await expect(provider.verify(receipt, { engine: "claude", targetAccountId: "target", launchProfile: fixture.sourceGeneration.launchProfile }))
    .rejects.toThrow("durable");
});

test("a legacy tmux successor receipt still verifies pane liveness", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-claude-legacy-pane-"));
  roots.push(base);
  const source = accountRoot("claude", base, "source");
  const target = accountRoot("claude", base, "target");
  let verifiedHost: TmuxHostEvidence | null = null;
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => { throw new Error("unexpected Codex client"); },
    claudeStatus: async () => ({ loggedIn: true }),
    verifyClaudeHost: async (host) => { verifiedHost = host; return false; },
    registry: new AgentRegistry(path.join(base, "provider-registry.json")),
    now: () => "2026-07-10T12:00:00.000Z",
  });
  const transcript = path.join(target.transcriptRoot, "legacy-pane.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ sessionId: "legacy-pane" }) + "\n", { mode: 0o600 });
  const receipt: ProviderReceipt = {
    operationId: "legacy-pane",
    nativeId: "legacy-pane",
    path: transcript,
    continuityPaths: [],
    historyHash: "history",
    host: { kind: "claude-stream", identity: "%12:1212", epoch: 1, verifiedAt: "2026-07-10T12:00:00.000Z", tmuxHost: claudeHost("%12", 1212) },
  };

  await expect(provider.verify(receipt, { engine: "claude", targetAccountId: "target", launchProfile: emptyLaunchProfile({ cwd: "/repo" }) }))
    .rejects.toThrow("host is not live");
  expect(verifiedHost).toMatchObject({ paneId: "%12", panePid: { pid: 1212 } });
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

  const structuredFlag = process.env.LLV_STRUCTURED_HOSTS;
  process.env.LLV_STRUCTURED_HOSTS = "0";
  try {
    await provider.publishHost(receipt, {
      engine: "claude",
      conversationId: "conversation_cleanup_fence",
      targetAccountId: "target",
      launchProfile: emptyLaunchProfile({ cwd: base }),
    });
  } finally {
    if (structuredFlag === undefined) delete process.env.LLV_STRUCTURED_HOSTS;
    else process.env.LLV_STRUCTURED_HOSTS = structuredFlag;
  }
  await expect(provider.cleanup(receipt)).rejects.toThrow("cleanup is still pending");
  expect(cancelled).toEqual([]);
  observedPid = 77;
  await provider.cleanup(receipt);
  expect(cancelled).toEqual([["%7", 77]]);

  const providerWithoutCleanup = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => { throw new Error("unexpected Codex client"); },
    claudeStatus: async () => ({ loggedIn: true }),
    now: () => "2026-07-10T12:00:00.000Z",
  });
  await expect(providerWithoutCleanup.cleanup(receipt)).rejects.toThrow("cleanup is still pending");

  const absentProvider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => { throw new Error("unexpected Codex client"); },
    claudeStatus: async () => ({ loggedIn: true }),
    cancelClaude: async () => "absent",
    now: () => "2026-07-10T12:00:00.000Z",
  });
  await absentProvider.cleanup(receipt);

  const unverifiableProvider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => { throw new Error("unexpected Codex client"); },
    claudeStatus: async () => ({ loggedIn: true }),
    cancelClaude: async () => "unverifiable",
    now: () => "2026-07-10T12:00:00.000Z",
  });
  await expect(unverifiableProvider.cleanup(receipt)).rejects.toThrow("cleanup is still pending");
});

test("concurrent Claude creates publish one fork and return one receipt", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-claude-fork-concurrent-"));
  roots.push(base);
  const fixture = claudeForkFixture(base);
  const provider = new RegisteredSuccessorProvider(fixture.dependencies);

  const receipts = await Promise.all([provider.create(fixture.input), provider.create(fixture.input)]);

  expect(receipts[0]).toEqual(receipts[1]);
  expect(fs.readdirSync(path.dirname(fixture.successorPath)).sort()).toEqual([
    `${FORK_OPERATION_ID}.jsonl`,
    `${FORK_OPERATION_ID}.jsonl.llv-receipt.json`,
  ]);
  expect(Object.values(fixture.dependencies.registry.snapshot().receipts)).toHaveLength(0);
});

test("Claude create writes no fork when continuity persistence fails", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-claude-fork-continuity-failure-"));
  roots.push(base);
  const fixture = claudeForkFixture(base);

  await expect(new RegisteredSuccessorProvider(fixture.dependencies).create({
    ...fixture.input,
    recordContinuityPath() { throw new Error("registry unavailable"); },
  })).rejects.toThrow("registry unavailable");

  expect(fs.existsSync(path.dirname(fixture.successorPath))).toBeFalse();
});

test("Claude replay after a crash between the fork and its receipt reuses the fork", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-claude-fork-replay-"));
  roots.push(base);
  const fixture = claudeForkFixture(base);

  await expect(new RegisteredSuccessorProvider({
    ...fixture.dependencies,
    afterClaudeForked() { throw new Error("simulated crash after fork"); },
  }).create(fixture.input)).rejects.toThrow("simulated crash after fork");
  const written = fs.statSync(fixture.successorPath);

  const receipt = await new RegisteredSuccessorProvider(fixture.dependencies).create(fixture.input);

  expect(receipt.path).toBe(fixture.successorPath);
  const reused = fs.statSync(fixture.successorPath);
  expect([reused.ino, reused.mtimeMs, reused.size]).toEqual([written.ino, written.mtimeMs, written.size]);
});

test("Claude fork receipt cleanup owns no pane", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-claude-fork-cleanup-"));
  roots.push(base);
  const fixture = claudeForkFixture(base);
  const provider = new RegisteredSuccessorProvider({
    ...fixture.dependencies,
    cancelClaude: async () => { throw new Error("a fork has no pane to cancel"); },
  });
  const receipt = await provider.create(fixture.input);

  await expect(provider.cleanup(receipt)).resolves.toBeUndefined();
});

test("Codex cross-account successor stages the source rollout before resuming paginated history", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-codex-paginated-lineage-"));
  roots.push(base);
  const source = accountRoot("codex", base, "origin");
  const target = accountRoot("codex", base, "successor");
  const sourceId = "11111111-1111-\x34111-8111-111111111111";
  const forkId = "22222222-2222-\x34222-8222-222222222222";
  const relativeSourcePath = path.join("2026", "08", "31", `rollout-${sourceId}.jsonl`);
  const sourcePath = path.join(source.transcriptRoot, relativeSourcePath);
  const forkPath = path.join(source.transcriptRoot, "2026", "08", "31", `rollout-${forkId}.jsonl`);
  const stagedSourcePath = path.join(target.transcriptRoot, relativeSourcePath);
  const fullSourceHistory = codexSessionMeta(sourceId)
    + JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: "first turn" } }) + "\n"
    + JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: "full answer" } }) + "\n";
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(sourcePath, fullSourceHistory, { mode: 0o600 });
  const continuityPaths: string[] = [];
  let historySeenBySuccessor: string | null = null;
  const client = (home: string) => ({
    async readAccount() { return { account: { type: "chatgpt" }, requiresOpenaiAuth: true }; },
    async forkThread() {
      fs.writeFileSync(forkPath, codexSessionMeta(forkId, sourceId), { mode: 0o600 });
      return { id: forkId, path: forkPath };
    },
    async resumeThread(id: string, options: { path: string }) {
      if (home !== target.home) throw new Error("source account unexpectedly resumed the successor");
      if (!fs.existsSync(stagedSourcePath)) {
        throw new Error(`invalid paginated history lineage for ${id}: missing source rollout`);
      }
      historySeenBySuccessor = fs.readFileSync(stagedSourcePath, "utf8");
      expect(fs.readFileSync(options.path, "utf8")).toContain(`\"forked_from_id\":\"${sourceId}\"`);
      return { id, path: options.path };
    },
    async readThread(id: string) { return { id, path: null }; },
    async setThreadName() {},
    async setThreadGoal() {},
    close() {},
  }) as unknown as CodexAppServerClient;
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async (home) => client(home),
    claudeStatus: async () => ({ loggedIn: false }),
    journalRoot: path.join(base, "migration-journal"),
    now: () => "2026-08-31T20:13:00.000Z",
  });

  const receipt = await provider.create({
    engine: "codex",
    operationId: "cross-account-paginated-lineage",
    conversationId: "conversation_paginated_lineage",
    targetAccountId: target.accountId,
    source: {
      id: sourceId,
      path: sourcePath,
      accountId: source.accountId,
      launchProfile: migrationSuccessorLaunchProfile(emptyLaunchProfile({ cwd: base, title: "History fixture" })),
      historyHash: null,
      host: null,
      createdAt: "2026-08-31T19:00:00.000Z",
      archivedAt: null,
    },
    recordContinuityPath(pathname) { continuityPaths.push(pathname); },
  });

  expect(historySeenBySuccessor as string | null).toBe(fullSourceHistory);
  expect(fs.readFileSync(stagedSourcePath, "utf8")).toBe(fullSourceHistory);
  expect(receipt.continuityPaths).toEqual([forkPath, stagedSourcePath, receipt.path]);
  expect(continuityPaths).toEqual(receipt.continuityPaths);
});

test("Codex successor provider accepts authenticated ChatGPT account responses and standard 0755 roots", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-codex-"));
  roots.push(base);
  const source = accountRoot("codex", base, "source");
  const target = accountRoot("codex", base, "target");
  for (const directory of [source.home, source.transcriptRoot, target.home, target.transcriptRoot]) fs.chmodSync(directory, 0o755);
  const sourceId = "019f423a-d6e9-\x37903-b597-3e676b6ff3d4";
  const sourcePath = path.join(source.transcriptRoot, "2026", "07", "10", `rollout-${sourceId}.jsonl`);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(sourcePath, codexSessionMeta(sourceId), { mode: 0o644 });
  const forkId = "019f423a-d6e9-\x34903-8597-3e676b6ff3d4";
  const forkPath = path.join(source.transcriptRoot, "2026", "07", "10", `rollout-${forkId}.jsonl`);
  const calls: string[] = [];
  let resumeOptions: unknown = null;
  let goalOptions: unknown = null;
  let threadName: string | null = null;
  let targetAuthenticated = false;
  const client = (home: string) => ({
    async readAccount() {
      calls.push(`${path.basename(home)}:account`);
      return { account: home === target.home && !targetAuthenticated ? null : { type: "chatgpt" }, requiresOpenaiAuth: true };
    },
    async forkThread() { calls.push("source:fork"); fs.writeFileSync(forkPath, codexSessionMeta(forkId, sourceId), { mode: 0o644 }); return { id: forkId, path: forkPath }; },
    async resumeThread(id: string, options: unknown) { calls.push("target:resume"); resumeOptions = options; return { id, path: null }; },
    async readThread(id: string) { calls.push("target:read"); return { id, path: null }; },
    async setThreadName(_id: string, title: string) { calls.push("target:name"); threadName = title; },
    async setThreadGoal(_id: string, objective: string, status: string) { calls.push("target:goal"); goalOptions = { objective, status }; },
    close() { calls.push(`${path.basename(home)}:close`); },
  }) as unknown as CodexAppServerClient;
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async (home) => client(home),
    claudeStatus: async () => ({ loggedIn: false }),
    now: () => "2026-07-10T12:00:00.000Z",
  });
  const profile = migrationSuccessorLaunchProfile(emptyLaunchProfile({ cwd: "/repo", model: "gpt-5.6-terra", effort: "high", fast: true, permissionMode: "never", readOnly: true, title: "Codex", goal: { objective: "Ship", status: "active", tokensUsed: null, timeUsedSeconds: null } }));
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
  const stagedSourcePath = path.join(target.transcriptRoot, "2026", "07", "10", `rollout-${sourceId}.jsonl`);
  const failedTargetCopy = path.join(target.transcriptRoot, "2026", "07", "10", `rollout-${forkId}.jsonl`);
  expect(recorded).toEqual([forkPath, stagedSourcePath, failedTargetCopy]);

  targetAuthenticated = true;
  const receipt = await provider.create(input);
  expect(receipt.nativeId).toBe(forkId);
  expect(receipt.path.startsWith(target.transcriptRoot + path.sep)).toBeTrue();
  expect(receipt.continuityPaths).toEqual([forkPath, stagedSourcePath, receipt.path]);
  expect(fs.readFileSync(receipt.path, "utf8")).toContain("session_meta");
  expect(calls).toContain("source:fork");
  expect(calls).toContain("target:resume");
  expect(calls).toContain("target:name");
  expect(calls).toContain("target:goal");
  expect(threadName as string | null).toBe("migration successor · Ship");
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
  const sourceId = "039f423a-d6e9-\x37903-b597-3e676b6ff3d4";
  const forkId = "039f423a-d6e9-\x34903-8597-3e676b6ff3d4";
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
    async setThreadName() {},
    close() {},
  }) as unknown as CodexAppServerClient;
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => client(), claudeStatus: async () => ({ loggedIn: false }),
    now: () => "2026-07-10T12:00:00.000Z", journalRoot: path.join(base, "journal"),
  });
  const input = { engine: "codex" as const, operationId: "definite-fork-retry", conversationId: "conversation_definite" as const, targetAccountId: "target", source: { id: sourceId, path: sourcePath, accountId: "source", launchProfile: emptyLaunchProfile({ cwd: "/repo", title: "Migrate provider fixture" }), historyHash: null, host: null, createdAt: "now", archivedAt: null }, recordContinuityPath() {} };
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
  const sourceId = "119f423a-d6e9-\x37903-b597-3e676b6ff3d4";
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
    async setThreadName() {},
    close() {},
  }) as unknown as CodexAppServerClient;
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => client(),
    claudeStatus: async () => ({ loggedIn: false }),
    journalRoot,
    now: () => "2026-07-10T12:00:00.000Z",
  });
  const input = {
    engine: "codex" as const,
    operationId: "concurrent-operation",
    conversationId: "conversation_test" as const,
    targetAccountId: "target",
    source: { id: sourceId, path: sourcePath, accountId: "source", launchProfile: emptyLaunchProfile({ cwd: "/repo", title: "Migrate provider fixture" }), historyHash: null, host: null, createdAt: "now", archivedAt: null },
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
  const sourceId = "219f423a-d6e9-\x37903-b597-3e676b6ff3d4";
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
    async setThreadName() {},
    close() {},
  }) as unknown as CodexAppServerClient;
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => client(),
    claudeStatus: async () => ({ loggedIn: false }),
    journalRoot: path.join(base, "provider-journal"),
    scanCodexForkArtifacts() { scanCalls += 1; return []; },
    now: () => "2026-07-10T12:00:00.000Z",
  });
  const generation = { id: sourceId, path: sourcePath, accountId: "source", launchProfile: emptyLaunchProfile({ cwd: "/repo", title: "Migrate provider fixture" }), historyHash: null, host: null, createdAt: "now", archivedAt: null };

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
  const sourceId = "319f423a-d6e9-\x37903-b597-3e676b6ff3d4";
  const forkId = "319f423a-d6e9-\x34903-8597-3e676b6ff3d4";
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
    async setThreadName() {},
    close() {},
  }) as unknown as CodexAppServerClient;
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => client(),
    claudeStatus: async () => ({ loggedIn: false }),
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
      source: { id: sourceId, path: sourcePath, accountId: "source", launchProfile: emptyLaunchProfile({ cwd: "/repo", title: "Migrate provider fixture" }), historyHash: null, host: null, createdAt: "now", archivedAt: null },
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
  const sourceId = "019f423a-d6e9-\x37903-b597-3e676b6ff3d4";
  const forkId = "019f423a-d6e9-\x34903-8597-3e676b6ff3d4";
  const ambiguousId = "019f423a-d6e9-\x34903-8597-3e676b6ff3ff";
  const sourcePath = path.join(source.transcriptRoot, `rollout-${sourceId}.jsonl`);
  const forkPath = path.join(source.transcriptRoot, `rollout-${forkId}.jsonl`);
  const ambiguousPath = path.join(source.transcriptRoot, `rollout-${ambiguousId}.jsonl`);
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
    async setThreadName() {},
    close() {},
  }) as unknown as CodexAppServerClient;
  const dependencies = {
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => client(),
    claudeStatus: async () => ({ loggedIn: false }),
    now: () => "2026-07-10T12:00:00.000Z",
    journalRoot,
    scanCodexForkArtifacts: () => [
      { id: forkId, path: forkPath },
      { id: ambiguousId, path: ambiguousPath },
    ].filter((artifact) => fs.existsSync(artifact.path)),
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
    source: titledProviderSource(conversation.generations[0]!),
    recordContinuityPath(pathname: string) { registry.recordConversationContinuityPath(conversation.id, pathname); },
  };
  const crashed = new RegisteredSuccessorProvider({
    ...dependencies,
    afterCodexForkReturned() { throw new Error("simulated crash before exact fork receipt"); },
  } as ProviderDependencies);

  await expect(crashed.create(input)).rejects.toThrow("simulated crash before exact fork receipt");
  expect(forkCalls).toBe(1);

  /* A second artifact of the same source used to be an impasse. The retry keeps
     this operation's identity, so the impasse was permanent; it now resolves the
     way the cross-operation path does — newest adopted, older kept as history. */
  fs.writeFileSync(ambiguousPath, codexSessionMeta(ambiguousId, sourceId), { mode: 0o600 });
  const olderThanTheFork = new Date(fs.statSync(forkPath).mtimeMs - 60_000);
  fs.utimesSync(ambiguousPath, olderThanTheFork, olderThanTheFork);

  const receipt = await new RegisteredSuccessorProvider(dependencies).create(input);
  expect(fs.existsSync(ambiguousPath)).toBeTrue();
  expect(registry.conversation(conversation.id)?.continuityPaths).toContain(ambiguousPath);
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
  const sourceId = "029f423a-d6e9-\x37903-b597-3e676b6ff3d4";
  const forkId = "029f423a-d6e9-\x34903-8597-3e676b6ff3d4";
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
    async setThreadName() {},
    close() {},
  }) as unknown as CodexAppServerClient;
  const dependencies = {
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => client(),
    claudeStatus: async () => ({ loggedIn: false }),
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
    source: titledProviderSource(conversation.generations[0]!),
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
  expect(fs.readdirSync(target.transcriptRoot).filter((name) => name.endsWith(".jsonl"))).toHaveLength(2);
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
    async forkThread() { return { id: "019f423a-d6e9-\x34903-8597-3e676b6ff3d4", path: foreignPath }; },
    async setThreadName() {},
    close() {},
  } as unknown as CodexAppServerClient;
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => client,
    claudeStatus: async () => ({ loggedIn: false }),
    now: () => "2026-07-10T12:00:00.000Z",
  });
  const recorded: string[] = [];

  await expect(provider.create({
    engine: "codex",
    operationId: "foreign-fork",
    conversationId: "conversation_test",
    targetAccountId: "target",
    source: { id: "source", path: sourcePath, accountId: "source", launchProfile: emptyLaunchProfile({ cwd: "/repo", title: "Migrate provider fixture" }), historyHash: null, host: null, createdAt: "now", archivedAt: null },
    recordContinuityPath(pathname) { recorded.push(pathname); },
  })).rejects.toThrow("unsafe-source");
  expect(recorded).toEqual([]);
});

test("a retry under a fresh operation identity recovers the fork the failed attempt left behind", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-codex-cross-operation-"));
  roots.push(base);
  const source = accountRoot("codex", base, "source");
  const target = accountRoot("codex", base, "target");
  const journalRoot = path.join(base, "provider-journal");
  const sourceId = "419f423a-d6e9-\x37903-b597-3e676b6ff3d4";
  const sourcePath = path.join(source.transcriptRoot, `rollout-${sourceId}.jsonl`);
  fs.writeFileSync(sourcePath, codexSessionMeta(sourceId), { mode: 0o600 });
  let forkCalls = 0;
  let targetAuthenticated = false;
  const client = (home: string) => ({
    async readAccount() {
      return home === target.home && !targetAuthenticated
        ? { account: null, requiresOpenaiAuth: true }
        : { account: { type: "chatgpt" }, requiresOpenaiAuth: true };
    },
    async forkThread() {
      forkCalls += 1;
      const id = `419f423a-d6e9-4903-8597-${String(forkCalls).padStart(12, "0")}`;
      const forkPath = path.join(source.transcriptRoot, `rollout-${id}.jsonl`);
      fs.writeFileSync(forkPath, codexSessionMeta(id, sourceId), { mode: 0o600 });
      return { id, path: forkPath };
    },
    async resumeThread(id: string) { return { id, path: null }; },
    async readThread(id: string) { return { id, path: null }; },
    async setThreadName() {},
    close() {},
  }) as unknown as CodexAppServerClient;
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async (home) => client(home),
    claudeStatus: async () => ({ loggedIn: false }),
    journalRoot,
    now: () => "2026-07-10T12:00:00.000Z",
  });
  const recorded: string[] = [];
  const attempt = (operationId: string) => ({
    engine: "codex" as const,
    operationId,
    conversationId: "conversation_cross_operation" as const,
    targetAccountId: "target",
    source: { id: sourceId, path: sourcePath, accountId: "source", launchProfile: emptyLaunchProfile({ cwd: "/repo", title: "Migrate provider fixture" }), historyHash: null, host: null, createdAt: "now", archivedAt: null },
    recordContinuityPath(pathname: string) { recorded.push(pathname); },
  });

  /* The incident: the post-fork step fails, and the retry arrives with a new
     operation identity, so the journal it prepares is fresh. */
  await expect(provider.create(attempt("attempt-one"))).rejects.toThrow("target Codex account is not authenticated");
  expect(forkCalls).toBe(1);

  targetAuthenticated = true;
  const receipt = await provider.create(attempt("attempt-two"));

  expect(forkCalls).toBe(1);
  expect(receipt.nativeId).toBe("419f423a-d6e9-\x34903-8597-000000000001");
  expect(fs.readdirSync(source.transcriptRoot).filter((name) => name !== path.basename(sourcePath))).toHaveLength(1);
});

test("orphan forks whose provenance died with their journals are re-forked once and all kept as history", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-codex-orphan-forks-"));
  roots.push(base);
  const source = accountRoot("codex", base, "source");
  const target = accountRoot("codex", base, "target");
  const journalRoot = path.join(base, "provider-journal");
  const sourceId = "519f423a-d6e9-\x37903-b597-3e676b6ff3d4";
  const sourcePath = path.join(source.transcriptRoot, `rollout-${sourceId}.jsonl`);
  fs.writeFileSync(sourcePath, codexSessionMeta(sourceId), { mode: 0o600 });
  const conversationId = "conversation_orphan_forks";
  const orphanIds = ["519f423a-d6e9-\x34903-8597-000000000001", "519f423a-d6e9-\x34903-8597-000000000002"];
  const orphanPath = (id: string) => path.join(source.transcriptRoot, `rollout-${id}.jsonl`);
  /* The state the operator's machine was found in: several attempts at one move
     each left a full-history fork, and each of their journals died before it
     could record which fork it had made. */
  fs.mkdirSync(journalRoot, { recursive: true, mode: 0o700 });
  orphanIds.forEach((id, index) => {
    fs.writeFileSync(orphanPath(id), codexSessionMeta(id, sourceId), { mode: 0o600 });
    const when = new Date(1_760_000_000_000 + (index + 1) * 60_000);
    fs.utimesSync(orphanPath(id), when, when);
    const journalName = `${crypto.createHash("sha256").update(`orphan-${index}`).digest("hex")}.json`;
    fs.writeFileSync(path.join(journalRoot, journalName), JSON.stringify({
      version: 1,
      operationId: `orphan-${index}`,
      conversationId,
      sourceNativeId: sourceId,
      sourceRoot: fs.realpathSync(source.transcriptRoot),
      targetRoot: fs.realpathSync(target.transcriptRoot),
      createdAtMs: when.getTime() - 1_000,
      forkRequestedAtMs: when.getTime() - 500,
      fork: null,
    }), { mode: 0o600 });
  });
  let forkCalls = 0;
  const freshForkId = "519f423a-d6e9-\x34903-8597-000000000009";
  const client = () => ({
    async readAccount() { return { account: { type: "chatgpt" }, requiresOpenaiAuth: true }; },
    async forkThread() {
      forkCalls += 1;
      fs.writeFileSync(orphanPath(freshForkId), codexSessionMeta(freshForkId, sourceId), { mode: 0o600 });
      return { id: freshForkId, path: orphanPath(freshForkId) };
    },
    async resumeThread(id: string) { return { id, path: null }; },
    async readThread(id: string) { return { id, path: null }; },
    async setThreadName() {},
    close() {},
  }) as unknown as CodexAppServerClient;
  const recorded: string[] = [];
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => client(),
    claudeStatus: async () => ({ loggedIn: false }),
    journalRoot,
    now: () => "2026-07-10T12:00:00.000Z",
  });

  const receipt = await provider.create({
    engine: "codex",
    operationId: "orphan-recovery",
    conversationId,
    targetAccountId: "target",
    source: { id: sourceId, path: sourcePath, accountId: "source", launchProfile: emptyLaunchProfile({ cwd: "/repo", title: "Migrate provider fixture" }), historyHash: null, host: null, createdAt: "now", archivedAt: null },
    recordContinuityPath(pathname: string) { recorded.push(pathname); },
  });

  /* Recovery FINDS both orphans — that is the point of the scan — but it cannot
     find out what either was forked FROM, because the journals that would have
     said died first. An unprovable fork is treated as a possibly stale one: the
     source may have gained turns since, and seating the successor on an older
     snapshot would drop them silently and permanently. So one fresh fork is
     taken from the source as it stands now. */
  expect(forkCalls).toBe(1);
  expect(receipt.nativeId).toBe(freshForkId);
  /* And nothing recovered is thrown away. Both orphans are handed back as the
     conversation's history, which is what makes the re-fork safe rather than
     merely cautious: no work becomes unreachable. */
  expect(recorded).toContain(orphanPath(orphanIds[0]!));
  expect(recorded).toContain(orphanPath(orphanIds[1]!));
  expect(fs.existsSync(orphanPath(orphanIds[0]!))).toBeTrue();
  expect(fs.existsSync(orphanPath(orphanIds[1]!))).toBeTrue();

  /* A replay adopts the fork this operation just made — its provenance IS
     recorded now — so the fail-safe fires exactly once and a retry loop cannot
     fork the source over and over. */
  recorded.length = 0;
  const replayed = await provider.create({
    engine: "codex",
    operationId: "orphan-recovery",
    conversationId,
    targetAccountId: "target",
    source: { id: sourceId, path: sourcePath, accountId: "source", launchProfile: emptyLaunchProfile({ cwd: "/repo", title: "Migrate provider fixture" }), historyHash: null, host: null, createdAt: "now", archivedAt: null },
    recordContinuityPath(pathname: string) { recorded.push(pathname); },
  });

  expect(forkCalls).toBe(1);
  expect(replayed.nativeId).toBe(freshForkId);
  expect(recorded).toContain(orphanPath(orphanIds[0]!));
  expect(recorded).toContain(orphanPath(orphanIds[1]!));
});

test("orphan forks recorded by journals that predate conversation identity are still recovered", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-codex-legacy-journals-"));
  roots.push(base);
  const source = accountRoot("codex", base, "source");
  const target = accountRoot("codex", base, "target");
  const journalRoot = path.join(base, "provider-journal");
  const sourceId = "619f423a-d6e9-\x37903-b597-3e676b6ff3d4";
  const sourcePath = path.join(source.transcriptRoot, `rollout-${sourceId}.jsonl`);
  fs.writeFileSync(sourcePath, codexSessionMeta(sourceId), { mode: 0o600 });
  const orphanIds = ["619f423a-d6e9-\x34903-8597-000000000001", "619f423a-d6e9-\x34903-8597-000000000002"];
  const orphanPath = (id: string) => path.join(source.transcriptRoot, `rollout-${id}.jsonl`);
  /* The journals the operator's disk actually holds: every one of them was
     written before a journal carried a conversation identity at all, so the only
     thing tying them to this move is the source thread and the two roots. */
  fs.mkdirSync(journalRoot, { recursive: true, mode: 0o700 });
  const journalName = (operationId: string) => `${crypto.createHash("sha256").update(operationId).digest("hex")}.json`;
  orphanIds.forEach((id, index) => {
    fs.writeFileSync(orphanPath(id), codexSessionMeta(id, sourceId), { mode: 0o600 });
    const when = new Date(1_760_000_000_000 + (index + 1) * 60_000);
    fs.utimesSync(orphanPath(id), when, when);
    fs.writeFileSync(path.join(journalRoot, journalName(`legacy-${index}`)), JSON.stringify({
      version: 1,
      operationId: `legacy-${index}`,
      conversationId: null,
      sourceNativeId: sourceId,
      sourceRoot: fs.realpathSync(source.transcriptRoot),
      targetRoot: fs.realpathSync(target.transcriptRoot),
      createdAtMs: when.getTime() - 1_000,
      forkRequestedAtMs: when.getTime() - 500,
      fork: null,
    }), { mode: 0o600 });
  });
  let forkCalls = 0;
  const freshForkId = "619f423a-d6e9-\x34903-8597-000000000009";
  const client = () => ({
    async readAccount() { return { account: { type: "chatgpt" }, requiresOpenaiAuth: true }; },
    async forkThread() {
      forkCalls += 1;
      fs.writeFileSync(orphanPath(freshForkId), codexSessionMeta(freshForkId, sourceId), { mode: 0o600 });
      return { id: freshForkId, path: orphanPath(freshForkId) };
    },
    async resumeThread(id: string) { return { id, path: null }; },
    async readThread(id: string) { return { id, path: null }; },
    async setThreadName() {},
    close() {},
  }) as unknown as CodexAppServerClient;
  const recorded: string[] = [];
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => client(),
    claudeStatus: async () => ({ loggedIn: false }),
    journalRoot,
    now: () => "2026-07-10T12:00:00.000Z",
  });

  const receipt = await provider.create({
    engine: "codex",
    operationId: "legacy-recovery",
    conversationId: "conversation_legacy_journals",
    targetAccountId: "target",
    source: { id: sourceId, path: sourcePath, accountId: "source", launchProfile: emptyLaunchProfile({ cwd: "/repo", title: "Migrate provider fixture" }), historyHash: null, host: null, createdAt: "now", archivedAt: null },
    recordContinuityPath(pathname: string) { recorded.push(pathname); },
  });

  /* A journal old enough to predate conversation identity also predates any
     record of what its fork was taken from, so recovery reaches these the same
     way it reaches any other unprovable fork: adopt nothing, fork once from the
     source as it stands, keep everything found as history. Recovery still did
     its job — the orphans are attached to this conversation instead of being
     stranded, which is the whole reason to scan legacy journals at all. */
  expect(forkCalls).toBe(1);
  expect(receipt.nativeId).toBe(freshForkId);
  expect(recorded).toContain(orphanPath(orphanIds[0]!));
  expect(recorded).toContain(orphanPath(orphanIds[1]!));
  expect(fs.existsSync(orphanPath(orphanIds[0]!))).toBeTrue();
  expect(fs.existsSync(orphanPath(orphanIds[1]!))).toBeTrue();
  /* Reading a legacy journal names it, so the next scan matches it exactly. */
  const backfilled = JSON.parse(fs.readFileSync(path.join(journalRoot, journalName("legacy-0")), "utf8")) as { conversationId: string | null };
  expect(backfilled.conversationId).toBe("conversation_legacy_journals");
});

test("two forks inside one operation's own window resolve to the newest", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-codex-same-operation-ambiguity-"));
  roots.push(base);
  const source = accountRoot("codex", base, "source");
  const target = accountRoot("codex", base, "target");
  const journalRoot = path.join(base, "provider-journal");
  const sourceId = "719f423a-d6e9-\x37903-b597-3e676b6ff3d4";
  const sourcePath = path.join(source.transcriptRoot, `rollout-${sourceId}.jsonl`);
  fs.writeFileSync(sourcePath, codexSessionMeta(sourceId), { mode: 0o600 });
  const forkIds = ["719f423a-d6e9-\x34903-8597-000000000001", "719f423a-d6e9-\x34903-8597-000000000002"];
  const forkPath = (id: string) => path.join(source.transcriptRoot, `rollout-${id}.jsonl`);
  let forkCalls = 0;
  const client = () => ({
    async readAccount() { return { account: { type: "chatgpt" }, requiresOpenaiAuth: true }; },
    async forkThread() {
      forkCalls += 1;
      /* One request, two artifacts on disk — the outcome this operation's own
         journal cannot disambiguate, because it died before recording a fork. */
      const stamped = Date.now();
      forkIds.forEach((id, index) => {
        fs.writeFileSync(forkPath(id), codexSessionMeta(id, sourceId), { mode: 0o600 });
        const when = new Date(stamped + (index + 1) * 60_000);
        fs.utimesSync(forkPath(id), when, when);
      });
      throw new CodexAppServerError("fork outcome is unknown", "unknown");
    },
    async resumeThread(id: string) { return { id, path: null }; },
    async readThread(id: string) { return { id, path: null }; },
    async setThreadName() {},
    close() {},
  }) as unknown as CodexAppServerClient;
  const recorded: string[] = [];
  const dependencies = {
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => client(),
    claudeStatus: async () => ({ loggedIn: false }),
    journalRoot,
    now: () => "2026-07-10T12:00:00.000Z",
  } as ProviderDependencies & { journalRoot: string };
  const input = {
    engine: "codex" as const,
    operationId: "same-operation-ambiguity",
    conversationId: "conversation_same_operation" as const,
    targetAccountId: "target",
    source: { id: sourceId, path: sourcePath, accountId: "source", launchProfile: emptyLaunchProfile({ cwd: "/repo", title: "Migrate provider fixture" }), historyHash: null, host: null, createdAt: "now", archivedAt: null },
    recordContinuityPath(pathname: string) { recorded.push(pathname); },
  };

  await expect(new RegisteredSuccessorProvider(dependencies).create(input)).rejects.toBeInstanceOf(CodexForkOutcomeUnknownError);
  expect(forkCalls).toBe(1);

  /* The retry keeps the same operation identity, so an impasse here would be
     permanent. It resolves the same way the cross-operation path does. */
  const receipt = await new RegisteredSuccessorProvider(dependencies).create(input);

  expect(forkCalls).toBe(1);
  expect(receipt.nativeId).toBe(forkIds[1]);
  expect(recorded).toContain(forkPath(forkIds[0]!));
  expect(fs.existsSync(forkPath(forkIds[0]!))).toBeTrue();
  expect(fs.existsSync(forkPath(forkIds[1]!))).toBeTrue();
});

test("an explicit retry reauthorizes one fork after an unknown outcome produced no artifact", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-codex-empty-unknown-"));
  roots.push(base);
  const source = accountRoot("codex", base, "source");
  const target = accountRoot("codex", base, "target");
  const journalRoot = path.join(base, "provider-journal");
  const sourceId = "729f423a-d6e9-\x37903-b597-3e676b6ff3d4";
  const forkId = "729f423a-d6e9-\x34903-8597-000000000001";
  const sourcePath = path.join(source.transcriptRoot, `rollout-${sourceId}.jsonl`);
  const forkPath = path.join(source.transcriptRoot, `rollout-${forkId}.jsonl`);
  fs.writeFileSync(sourcePath, codexSessionMeta(sourceId), { mode: 0o600 });
  let forkCalls = 0;
  const client = () => ({
    async readAccount() { return { account: { type: "chatgpt" }, requiresOpenaiAuth: true }; },
    async forkThread() {
      forkCalls += 1;
      if (forkCalls === 1) throw new CodexAppServerError("fork outcome is unknown", "unknown");
      fs.writeFileSync(forkPath, codexSessionMeta(forkId, sourceId), { mode: 0o600 });
      return { id: forkId, path: forkPath };
    },
    async resumeThread(id: string) { return { id, path: null }; },
    async readThread(id: string) { return { id, path: null }; },
    async setThreadName() {},
    close() {},
  }) as unknown as CodexAppServerClient;
  const dependencies = {
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => client(),
    claudeStatus: async () => ({ loggedIn: false }),
    journalRoot,
    now: () => "2026-07-10T12:00:00.000Z",
  } as ProviderDependencies & { journalRoot: string };
  const provider = new RegisteredSuccessorProvider(dependencies);
  const input = {
    engine: "codex" as const,
    operationId: "empty-unknown-operation",
    conversationId: "conversation_empty_unknown" as const,
    targetAccountId: "target",
    source: { id: sourceId, path: sourcePath, accountId: "source", launchProfile: emptyLaunchProfile({ cwd: "/repo", title: "Migrate provider fixture" }), historyHash: null, host: null, createdAt: "now", archivedAt: null },
    recordContinuityPath() {},
  };

  await expect(provider.create(input)).rejects.toBeInstanceOf(CodexForkOutcomeUnknownError);
  await expect(provider.create(input)).rejects.toBeInstanceOf(CodexForkOutcomeUnknownError);
  expect(forkCalls).toBe(1);

  expect(await authorizeCodexForkRetry(
    input.operationId,
    input.conversationId,
    journalRoot,
    () => [{ id: forkId, path: path.join(source.transcriptRoot, "vanished-fork.jsonl") }],
  )).toBe("reauthorized");

  const receipt = await provider.create(input);
  expect(forkCalls).toBe(2);
  expect(receipt.nativeId).toBe(forkId);
  expect(fs.existsSync(receipt.path)).toBeTrue();
  const journalFile = path.join(
    journalRoot,
    `${crypto.createHash("sha256").update(input.operationId).digest("hex")}.json`,
  );
  const journal = JSON.parse(fs.readFileSync(journalFile, "utf8")) as {
    forkRecoveryFloorMs: number | null;
    forkRequestedAtMs: number | null;
  };
  expect(journal.forkRecoveryFloorMs).toBeNumber();
  expect(journal.forkRequestedAtMs).toBeNumber();
});

test("a late artifact from the first uncertain attempt is adopted after an operator retry", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-codex-late-fork-"));
  roots.push(base);
  const source = accountRoot("codex", base, "source");
  const target = accountRoot("codex", base, "target");
  const journalRoot = path.join(base, "provider-journal");
  const sourceId = "739f423a-d6e9-\x37903-b597-3e676b6ff3d4";
  const lateForkId = "739f423a-d6e9-\x34903-8597-000000000001";
  const sourcePath = path.join(source.transcriptRoot, `rollout-${sourceId}.jsonl`);
  const lateForkPath = path.join(source.transcriptRoot, `rollout-${lateForkId}.jsonl`);
  fs.writeFileSync(sourcePath, codexSessionMeta(sourceId), { mode: 0o600 });
  let forkCalls = 0;
  const client = () => ({
    async readAccount() { return { account: { type: "chatgpt" }, requiresOpenaiAuth: true }; },
    async forkThread() {
      forkCalls += 1;
      throw new CodexAppServerError("fork outcome is unknown", "unknown");
    },
    async resumeThread(id: string) { return { id, path: null }; },
    async readThread(id: string) { return { id, path: null }; },
    async setThreadName() {},
    close() {},
  }) as unknown as CodexAppServerClient;
  const dependencies = {
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async () => client(),
    claudeStatus: async () => ({ loggedIn: false }),
    journalRoot,
    now: () => "2026-07-10T12:00:00.000Z",
  } as ProviderDependencies & { journalRoot: string };
  const provider = new RegisteredSuccessorProvider(dependencies);
  const input = {
    engine: "codex" as const,
    operationId: "late-fork-operation",
    conversationId: "conversation_late_fork" as const,
    targetAccountId: "target",
    source: { id: sourceId, path: sourcePath, accountId: "source", launchProfile: emptyLaunchProfile({ cwd: "/repo", title: "Migrate provider fixture" }), historyHash: null, host: null, createdAt: "now", archivedAt: null },
    recordContinuityPath() {},
  };

  await expect(provider.create(input)).rejects.toBeInstanceOf(CodexForkOutcomeUnknownError);
  expect(forkCalls).toBe(1);
  expect(await authorizeCodexForkRetry(input.operationId, input.conversationId, journalRoot, () => [])).toBe("reauthorized");
  fs.writeFileSync(lateForkPath, codexSessionMeta(lateForkId, sourceId), { mode: 0o600 });

  const receipt = await provider.create(input);
  expect(forkCalls).toBe(1);
  expect(receipt.nativeId).toBe(lateForkId);
});

test("a legacy journal backfills its first recovery floor before retry authorization clears the request", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-codex-legacy-floor-"));
  roots.push(base);
  const journalRoot = path.join(base, "provider-journal");
  fs.mkdirSync(journalRoot, { recursive: true, mode: 0o700 });
  const operationId = "legacy-floor-operation";
  const conversationId = "conversation_legacy_floor";
  const requestedAt = 1_700_000_000_000;
  const filename = path.join(
    journalRoot,
    `${crypto.createHash("sha256").update(operationId).digest("hex")}.json`,
  );
  fs.writeFileSync(filename, JSON.stringify({
    version: 1,
    operationId,
    conversationId,
    sourceNativeId: "749f423a-d6e9-\x37903-b597-3e676b6ff3d4",
    sourceRoot: path.join(base, "source"),
    targetRoot: path.join(base, "target"),
    createdAtMs: requestedAt - 5_000,
    forkRequestedAtMs: requestedAt,
    fork: null,
    forkSource: null,
    supersededForks: [],
  }, null, 2));

  expect(await authorizeCodexForkRetry(operationId, conversationId, journalRoot, () => [])).toBe("reauthorized");
  const after = JSON.parse(fs.readFileSync(filename, "utf8")) as {
    forkRecoveryFloorMs: number | null;
    forkRequestedAtMs: number | null;
  };
  expect(after.forkRecoveryFloorMs).toBe(requestedAt);
  expect(after.forkRequestedAtMs).toBe(null);
  expect(await authorizeCodexForkRetry(operationId, conversationId, journalRoot, () => [])).toBe("not-needed");
  expect((JSON.parse(fs.readFileSync(filename, "utf8")) as { forkRecoveryFloorMs: number }).forkRecoveryFloorMs).toBe(requestedAt);
});

test("a retry re-forks when the source gained turns while the migration was parked", async () => {
  /* A `failed-recoverable` migration stays parked, and `deliveryFence` keeps
     letting the operator talk to the source while it is. So the source advances
     under a fork that was already taken, and adopting that fork would seat the
     successor on the older snapshot and drop every turn added since. */
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-codex-parked-advance-"));
  roots.push(base);
  const source = accountRoot("codex", base, "source");
  const target = accountRoot("codex", base, "target");
  const journalRoot = path.join(base, "provider-journal");
  const sourceId = "819f423a-d6e9-\x37903-b597-3e676b6ff3d4";
  const sourcePath = path.join(source.transcriptRoot, `rollout-${sourceId}.jsonl`);
  const turn = (text: string) => JSON.stringify({ type: "turn", payload: { text } }) + "\n";
  fs.writeFileSync(sourcePath, codexSessionMeta(sourceId) + turn("before the migration"), { mode: 0o600 });
  let forkCalls = 0;
  let targetAuthenticated = false;
  const forkIdFor = (call: number) => `819f423a-d6e9-4903-8597-${String(call).padStart(12, "0")}`;
  const forkPathFor = (id: string) => path.join(source.transcriptRoot, `rollout-${id}.jsonl`);
  const client = (home: string) => ({
    async readAccount() {
      return home === target.home && !targetAuthenticated
        ? { account: null, requiresOpenaiAuth: true }
        : { account: { type: "chatgpt" }, requiresOpenaiAuth: true };
    },
    async forkThread() {
      forkCalls += 1;
      const id = forkIdFor(forkCalls);
      /* What a real fork is: this thread's own header over a copy of the
         source's turns as they stand right now. */
      const turns = fs.readFileSync(sourcePath, "utf8").split("\n").slice(1).join("\n");
      fs.writeFileSync(forkPathFor(id), codexSessionMeta(id, sourceId) + turns, { mode: 0o600 });
      return { id, path: forkPathFor(id) };
    },
    async resumeThread(id: string) { return { id, path: null }; },
    async readThread(id: string) { return { id, path: null }; },
    async setThreadName() {},
    close() {},
  }) as unknown as CodexAppServerClient;
  const provider = new RegisteredSuccessorProvider({
    accounts: { resolveSpawn: () => target, resolveTranscriptOwner: () => source },
    startCodex: async (home) => client(home),
    claudeStatus: async () => ({ loggedIn: false }),
    journalRoot,
    now: () => "2026-07-10T12:00:00.000Z",
  });
  const recorded: string[] = [];
  const attempt = (operationId: string) => ({
    engine: "codex" as const,
    operationId,
    conversationId: "conversation_parked_advance" as const,
    targetAccountId: "target",
    source: { id: sourceId, path: sourcePath, accountId: "source", launchProfile: emptyLaunchProfile({ cwd: "/repo", title: "Migrate provider fixture" }), historyHash: null, host: null, createdAt: "now", archivedAt: null },
    recordContinuityPath(pathname: string) { recorded.push(pathname); },
  });

  await expect(provider.create(attempt("parked-attempt-one"))).rejects.toThrow("target Codex account is not authenticated");
  expect(forkCalls).toBe(1);

  /* The parked window: the operator keeps working, and the source gains a turn
     the first attempt's fork has never seen. */
  fs.appendFileSync(sourcePath, turn("said while the migration was parked"));
  targetAuthenticated = true;
  recorded.length = 0;
  const receipt = await provider.create(attempt("parked-attempt-two"));

  expect(forkCalls).toBe(2);
  expect(receipt.nativeId).toBe(forkIdFor(2));
  const successor = fs.readFileSync(receipt.path, "utf8");
  expect(successor).toContain("said while the migration was parked");
  expect(successor).toContain("before the migration");
  /* The stale fork is never removed — it is handed back as recorded continuity. */
  expect(recorded).toContain(forkPathFor(forkIdFor(1)));
  expect(fs.existsSync(forkPathFor(forkIdFor(1)))).toBeTrue();
  expect(fs.existsSync(forkPathFor(forkIdFor(2)))).toBeTrue();

  /* And a replay of the same attempt against an unchanged source changes
     nothing: no third fork, the same successor, the same continuity. */
  const retryContinuity = [...recorded].sort();
  recorded.length = 0;
  const replayed = await provider.create(attempt("parked-attempt-two"));

  expect(forkCalls).toBe(2);
  expect(replayed.nativeId).toBe(forkIdFor(2));
  expect([...recorded].sort()).toEqual(retryContinuity);
});

test("a truncated fork scan says so, and only transcripts draw on its bound", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "llv-provider-codex-scan-bound-"));
  roots.push(base);
  const sessions = path.join(base, "sessions");
  fs.mkdirSync(sessions, { recursive: true, mode: 0o700 });
  const sourceId = "919f423a-d6e9-\x37903-b597-3e676b6ff3d4";
  const forkIds = ["919f423a-d6e9-\x34903-8597-000000000001", "919f423a-d6e9-\x34903-8597-000000000002"];
  for (const id of forkIds) {
    fs.writeFileSync(path.join(sessions, `rollout-${id}.jsonl`), codexSessionMeta(id, sourceId), { mode: 0o600 });
  }
  /* Receipts, locks and whatever else shares the session tree. None of them can
     ever be a fork, so none of them may cost the scan a slot. */
  for (let index = 0; index < 50; index += 1) {
    fs.writeFileSync(path.join(sessions, `rollout-noise-${index}.llv-receipt.json`), "{}", { mode: 0o600 });
  }
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const found = codexForkArtifacts(sessions, sourceId, 0, forkIds.length);

    expect(found.map((artifact) => artifact.id).sort()).toEqual([...forkIds].sort());
    expect(warnings).not.toHaveBeenCalled();

    /* One transcript past the bound: the scan runs short, and a caller that
       forks again because of it now has a log line saying why. */
    const extraId = "919f423a-d6e9-\x34903-8597-000000000003";
    fs.writeFileSync(path.join(sessions, `rollout-${extraId}.jsonl`), codexSessionMeta(extraId, sourceId), { mode: 0o600 });
    const truncated = codexForkArtifacts(sessions, sourceId, 0, forkIds.length);

    expect(truncated.length).toBeLessThan(3);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(warnings.mock.calls[0]![0]).toBe("[account-migration] Codex fork recovery scan hit its bound");
    expect(warnings.mock.calls[0]![1]).toMatchObject({ root: sessions, limit: forkIds.length });
  } finally {
    warnings.mockRestore();
  }
});
