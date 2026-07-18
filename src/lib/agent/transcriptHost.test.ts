import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { withSpawnCapability, type ResumeSpec } from "@/lib/agent/cli";
import { AgentRegistry, type TmuxHostEvidence } from "@/lib/agent/registry";
import { beginRegistryResume, createTranscriptHostResolver, reconcileObservedTranscriptHosts, type TranscriptHost } from "@/lib/agent/transcriptHost";
import { TmuxDeliveryUncertainError } from "@/lib/tmux";
import type { AgentProcess } from "@/lib/scanner/process";
import type { PaneRef, SpawnedPane } from "@/lib/tmux";
import type { FileEntry } from "@/lib/types";

const SESSION = "019f4906-3f67-7b72-9fbc-9ec3b5ad1326";
const PATHNAME = `/home/user/.codex/sessions/2026/07/10/rollout-2026-07-10-${SESSION}.jsonl`;

function entry(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path: PATHNAME,
    root: "codex-sessions",
    name: PATHNAME,
    project: "live-log-viewer-next",
    title: "Issue 31",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "live",
    proc: "running",
    pid: 200,
    model: "gpt-5.6-terra",
    effort: "xhigh",
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  };
}

const spec: ResumeSpec = {
  command: "CODEX_HOME='/profile-terra' codex -m gpt-5.6-terra -c model_reasoning_effort=xhigh resume " + SESSION,
  cwd: "/repo",
  windowName: "codex-resume",
  engine: "codex",
};

test("stable tmux host reconciliation reads one snapshot without registry mutations", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-host-reconcile-read-"));
  class CountingRegistry extends AgentRegistry {
    snapshotCalls = 0;
    upsertCalls = 0;
    markUnhostedCalls = 0;
    reconcileSpawnReceiptCalls = 0;

    override snapshot() {
      this.snapshotCalls += 1;
      return super.snapshot();
    }

    override readOnlySnapshot() {
      this.snapshotCalls += 1;
      return super.readOnlySnapshot();
    }

    override upsert(value: Parameters<AgentRegistry["upsert"]>[0]) {
      this.upsertCalls += 1;
      return super.upsert(value);
    }

    override markUnhosted(value: Parameters<AgentRegistry["markUnhosted"]>[0]) {
      this.markUnhostedCalls += 1;
      return super.markUnhosted(value);
    }

    override reconcileSpawnReceipts(value: Parameters<AgentRegistry["reconcileSpawnReceipts"]>[0]) {
      this.reconcileSpawnReceiptCalls += 1;
      return super.reconcileSpawnReceipts(value);
    }

    resetCounts() {
      this.snapshotCalls = 0;
      this.upsertCalls = 0;
      this.markUnhostedCalls = 0;
      this.reconcileSpawnReceiptCalls = 0;
    }
  }
  const registry = new CountingRegistry(path.join(directory, "registry.json"));
  const host: TranscriptHost = {
    tmuxServerPid: 900,
    paneId: "%1",
    panePid: 100,
    agentPid: 200,
    display: "agents:4.0",
    windowName: "codex-resume",
    engine: "codex",
    cwd: "/repo",
    agentArgv: ["codex", "resume", SESSION],
    agentIdentity: "200:one",
    launchId: null,
    claimedPaths: [PATHNAME],
    primaryPath: PATHNAME,
  };
  const evidence: TmuxHostEvidence = {
    kind: "tmux",
    endpoint: "/run/user/1000/agent-log-viewer",
    server: { pid: 900, startIdentity: "900:one" },
    paneId: "%1",
    panePid: { pid: 100, startIdentity: "100:one" },
    windowName: "codex-resume",
    agent: { pid: 200, startIdentity: "200:one" },
    argv: host.agentArgv,
  };
  registry.upsert({
    key: { engine: "codex", sessionId: SESSION },
    artifactPath: PATHNAME,
    cwd: "/repo",
    accountId: null,
    status: "live",
    host: evidence,
    claimEpoch: 0,
    claimOwner: null,
    pendingAction: null,
  });
  registry.resetCounts();

  reconcileObservedTranscriptHosts([host], { registry, evidenceForHost: () => evidence });

  expect({
    snapshot: registry.snapshotCalls,
    upsert: registry.upsertCalls,
    markUnhosted: registry.markUnhostedCalls,
    reconcileSpawnReceipts: registry.reconcileSpawnReceiptCalls,
  }).toEqual({ snapshot: 1, upsert: 0, markUnhosted: 0, reconcileSpawnReceipts: 0 });
  fs.rmSync(directory, { recursive: true, force: true });
});

test("registry resume receives one conversation-bound capability at central actuation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-resume-capability-"));
  const registry = new AgentRegistry(path.join(directory, "registry.json"));
  const conversation = registry.ensureConversation("codex", PATHNAME, "terra");
  const previousDigest = "a".repeat(64);
  registry.beginSpawnRequest({
    engine: "codex",
    cwd: "/repo",
    conversationId: conversation.id,
    spawnCapabilityDigest: previousDigest,
  });

  const prepared = beginRegistryResume(entry(), spec, registry);
  if (!prepared) throw new Error("expected a managed resume");
  const capability = registry.rotateSpawnCapabilityForReceipt(prepared.receipt.launchId);
  const launchSpec = withSpawnCapability(prepared.spec, capability);
  const digest = crypto.createHash("sha256").update(capability).digest("hex");

  expect(registry.conversationIdForSpawnCapabilityDigest(previousDigest)).toBeNull();
  expect(registry.conversationIdForSpawnCapabilityDigest(digest)).toBe(conversation.id);
  expect(launchSpec.command.match(/LLV_SPAWN_CAPABILITY=/g)).toHaveLength(1);
  fs.rmSync(directory, { recursive: true, force: true });
});

interface FakeHostState {
  entry: FileEntry;
  panes: Map<number, PaneRef>;
  agents: AgentProcess[];
  ppids: Map<number, number>;
  records: Map<string, { paneId: string; panePid: number; windowName: string; engine: "claude" | "codex" }>;
  delivered: string[];
  deliverAttempts: number;
  deliverError: unknown | null;
  spawnCalls: number;
  failSpawn: boolean;
  panePidOverride: number | null;
  serverPid: number | null;
  paneObservation: "available" | "no-server" | "failure";
  paneObservationError: string;
  identities: Map<number, string>;
  spawnSpecs: Array<{ spec: ResumeSpec; payload: string }>;
  recordServerPid: number | null;
  identitySequence: string[] | null;
  aliveReads: number;
  retireOnAliveRead: number | null;
  launchId: string | null;
  resumeBegan: boolean;
  quarantineAfterResumeBegin: boolean;
  listFileReads: number;
}

function fakeHost(
  existing = true,
  reconcile?: (hosts: TranscriptHost[]) => { quarantinedPaneIds: string[] },
  confirmAlive?: (host: TranscriptHost) => void,
) {
  const state: FakeHostState = {
    entry: entry({ pid: existing ? 200 : null, proc: existing ? "running" : null }),
    panes: existing ? new Map([[100, { paneId: "%1", target: "agents:4.0" }]]) : new Map(),
    agents: existing
      ? [{ pid: 200, engine: "codex", argv: ["codex", "resume", SESSION], cwd: "/repo", tty: 1 }]
      : [],
    ppids: existing ? new Map([[200, 100]]) : new Map(),
    records: new Map(),
    delivered: [],
    deliverAttempts: 0,
    deliverError: null,
    spawnCalls: 0,
    failSpawn: false,
    panePidOverride: null,
    serverPid: 900,
    paneObservation: "available",
    paneObservationError: "tmux list-panes failed",
    identities: new Map(existing ? [[200, "200:one"]] : []),
    spawnSpecs: [],
    recordServerPid: 900,
    identitySequence: null,
    aliveReads: 0,
    retireOnAliveRead: null,
    launchId: null,
    resumeBegan: false,
    quarantineAfterResumeBegin: false,
    listFileReads: 0,
  };

  const resolver = createTranscriptHostResolver({
    listFiles: async () => {
      state.listFileReads += 1;
      return [state.entry];
    },
    panes: async () => {
      if (state.paneObservation === "failure") return { kind: "failure" as const, error: state.paneObservationError };
      if (state.paneObservation === "no-server") return { kind: "no-server" as const };
      return { kind: "available" as const, panes: state.panes };
    },
    ppidMap: () => state.ppids,
    agents: () => state.agents,
    serverPid: async () => state.serverPid,
    resumeRecords: async () => state.recordServerPid === null ? null : ({ serverPid: state.recordServerPid, records: new Map(state.records) }),
    panePid: async (paneId: string) => state.panePidOverride ?? [...state.panes.entries()].find(([, pane]) => pane.paneId === paneId)?.[0] ?? null,
    alive: (pid: number) => {
      state.aliveReads += 1;
      if (state.retireOnAliveRead === state.aliveReads) {
        state.panes.clear();
        state.agents = [];
        state.ppids.clear();
        state.entry = { ...state.entry, pid: null, proc: null };
        return false;
      }
      return state.agents.some((agent) => agent.pid === pid);
    },
    argv: (pid: number) => state.agents.find((agent) => agent.pid === pid)?.argv ?? [],
    parentPid: (pid: number) => state.ppids.get(pid) ?? null,
    identity: (pid: number) => {
      if (state.identitySequence?.length) return state.identitySequence.shift() ?? null;
      const identity = state.identities.get(pid) ?? null;
      return identity;
    },
    launchId: async () => state.launchId,
    beginResume: () => {
      state.resumeBegan = true;
      return null;
    },
    conversationIdForPath: (pathname: string) => pathname === PATHNAME ? "conversation_test" : null,
    spawn: async (resumeSpec: ResumeSpec, payload: string): Promise<SpawnedPane> => {
      state.spawnCalls += 1;
      state.spawnSpecs.push({ spec: resumeSpec, payload });
      if (state.failSpawn) throw new Error("tmux resume failed");
      await Promise.resolve();
      const panePid = 300;
      const pane = { paneId: "%9", display: "agents:5.0", panePid };
      state.panes = new Map([[panePid, { paneId: pane.paneId, target: pane.display }]]);
      state.panePidOverride = null;
      state.agents = [{ pid: 400, engine: "codex", argv: ["codex", "resume", SESSION], cwd: "/repo", tty: 1 }];
      state.identities = new Map([[400, "400:one"]]);
      state.ppids = new Map([[400, panePid]]);
      state.entry = { ...state.entry, pid: 400, proc: "running" };
      state.recordServerPid = state.serverPid;
      return pane;
    },
    remember: async (pathname: string, resumeSpec: ResumeSpec, pane: SpawnedPane) => {
      if (!pane.panePid) return;
      state.records.set(pathname, { paneId: pane.paneId, panePid: pane.panePid, windowName: resumeSpec.windowName, engine: resumeSpec.engine });
    },
    reconcile: async (hosts) => reconcile?.(hosts) ?? ({
      quarantinedPaneIds: state.quarantineAfterResumeBegin && state.resumeBegan
        ? hosts.filter((host) => host.launchId === state.launchId).map((host) => host.paneId)
        : [],
    }),
    confirmAlive,
    deliver: async (paneId: string, text: string) => {
      state.deliverAttempts += 1;
      if (state.deliverError) throw state.deliverError;
      state.delivered.push(`${paneId}:${text}`);
    },
  });
  return { state, resolver };
}

describe("transcript host resolver", () => {
  test("elects canonical ownership from a supplied transcript snapshot without another scan", async () => {
    const { resolver, state } = fakeHost();
    const supplied = [{ ...state.entry, title: "Current resource title", activity: "recent" as const }];

    const snapshot = await resolver.readTranscriptHosts(true, supplied);

    expect(snapshot.canonicalFor(PATHNAME)?.display).toBe("agents:4.0");
    expect(snapshot.conflicts).toEqual([]);
    expect(state.listFileReads).toBe(0);
  });

  test("keeps the native child canonical when a launcher wrapper shares its session", async () => {
    const reconciled: number[][] = [];
    const { resolver, state } = fakeHost(true, (hosts) => {
      reconciled.push(hosts.map((host) => host.agentPid));
      return { quarantinedPaneIds: [] };
    });
    state.agents = [
      { pid: 200, engine: "codex", argv: ["node", "/home/user/.bun/bin/codex", "resume", SESSION], cwd: "/repo", tty: 1 },
      { pid: 201, engine: "codex", argv: ["/vendor/codex", "resume", SESSION], cwd: "/repo", tty: 1 },
    ];
    state.ppids = new Map([[200, 100], [201, 200]]);
    state.identities = new Map([[200, "200:wrapper"], [201, "201:native"]]);
    state.entry = { ...state.entry, pid: 200 };

    const wrapperAttributed = await resolver.readTranscriptHosts(true);
    state.entry = { ...state.entry, pid: 201 };
    state.agents.reverse();
    const nativeAttributed = await resolver.readTranscriptHosts(true);

    expect(wrapperAttributed.hosts.map((host) => host.agentPid)).toEqual([201]);
    expect(wrapperAttributed.canonicalFor(PATHNAME)?.agentPid).toBe(201);
    expect(nativeAttributed.hosts.map((host) => host.agentPid)).toEqual([201]);
    expect(nativeAttributed.canonicalFor(PATHNAME)?.agentPid).toBe(201);
    expect(reconciled).toEqual([[201], [201]]);
  });

  test("keeps parallel same-session processes visible when neither wraps the other", async () => {
    const { resolver, state } = fakeHost();
    state.agents.push({ pid: 201, engine: "codex", argv: ["/vendor/codex", "resume", SESSION], cwd: "/repo", tty: 1 });
    state.ppids.set(201, 100);
    state.identities.set(201, "201:parallel");

    const snapshot = await resolver.readTranscriptHosts(true);

    expect(snapshot.hosts.map((host) => host.agentPid)).toEqual([200, 201]);
  });

  test("carries the pane launch marker into observation reconciliation", async () => {
    const { resolver, state } = fakeHost();
    state.launchId = "019f4906-3f67-7b72-9fbc-9ec3b5ad1326";

    const snapshot = await resolver.readTranscriptHosts(true);

    expect(snapshot.hosts[0]?.launchId).toBe(state.launchId);
  });

  test("observes and delivers to the same canonical live pane", async () => {
    const { resolver, state } = fakeHost();

    expect((await resolver.readTranscriptHosts(true)).canonicalFor(PATHNAME)?.display).toBe("agents:4.0");
    expect(await resolver.deliverToTranscriptHost({ entry: state.entry, spec, payload: "steer" })).toEqual({
      ok: true,
      outcome: "delivered-to-live",
      target: "agents:4.0",
    });
    expect(state.spawnCalls).toBe(0);
    expect(state.delivered).toEqual(["%1:steer"]);
  });

  test("resolves dialog and composer delivery for an account-home Claude session after late readiness", async () => {
    const sessionId = "88d36d1d-d681-4dc3-ac3b-0b0c54f33c7e";
    const accountPath = `/home/user/.config/agent-log-viewer/accounts/claude/work/projects/-repo/${sessionId}.jsonl`;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-account-home-host-"));
    const registry = new AgentRegistry(path.join(directory, "registry.json"));
    const begun = registry.beginSpawnRequest({ engine: "claude", cwd: "/repo", accountId: "work" });
    if (begun.kind !== "created") throw new Error("expected create");
    registry.bindSpawnPane(begun.receipt.launchId, {
      endpoint: "/tmp",
      server: { pid: 900, startIdentity: null },
      paneId: "%1",
      panePid: { pid: 100, startIdentity: null },
      target: "agents:4.0",
    });
    registry.failSpawn(begun.receipt.launchId, "agent never reached a launch-ready prompt");
    expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
      state: "conflicted",
      error: "agent never reached a launch-ready prompt",
    });
    const { resolver, state } = fakeHost(true, (hosts) => {
      const quarantinedPaneIds: string[] = [];
      for (const host of hosts) {
        const settled = registry.completeObservedSpawn(host.launchId!, {
          key: { engine: "claude", sessionId },
          artifactPath: accountPath,
          cwd: host.cwd,
          accountId: null,
          status: "live",
          host: {
            kind: "tmux",
            endpoint: "/tmp",
            server: { pid: host.tmuxServerPid, startIdentity: "900:observed" },
            paneId: host.paneId,
            panePid: { pid: host.panePid, startIdentity: "100:observed" },
            windowName: host.windowName ?? "",
            agent: { pid: host.agentPid, startIdentity: host.agentIdentity },
            argv: host.agentArgv,
          },
          claimEpoch: 0,
          claimOwner: null,
          pendingAction: null,
        });
        if (settled.kind === "conflict") quarantinedPaneIds.push(host.paneId);
      }
      return { quarantinedPaneIds };
    });
    state.entry = entry({
      path: accountPath,
      root: "claude-projects",
      name: accountPath,
      engine: "claude",
      fmt: "claude",
      pid: 200,
      proc: "running",
    });
    state.agents = [{ pid: 200, engine: "claude", argv: ["claude", "--session-id", sessionId], cwd: "/repo", tty: 1 }];
    state.launchId = begun.receipt.launchId;

    expect((await resolver.readTranscriptHosts(true)).canonicalFor(accountPath)?.paneId).toBe("%1");
    expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
      state: "completed",
      error: null,
    });
    expect(await resolver.deliverToTranscriptHost({ entry: state.entry, spec: { ...spec, engine: "claude" }, payload: "composer message" })).toMatchObject({
      ok: true,
      outcome: "delivered-to-live",
      target: "agents:4.0",
    });
    expect(state.delivered).toEqual(["%1:composer message"]);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("successful composer delivery releases a recoverable pane quarantine", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-delivery-quarantine-"));
    const registry = new AgentRegistry(path.join(directory, "registry.json"));
    const begun = registry.beginSpawnRequest({ engine: "codex", cwd: "/repo", accountId: null });
    if (begun.kind !== "created") throw new Error("expected create");
    registry.bindSpawnPane(begun.receipt.launchId, {
      endpoint: "/tmp",
      server: { pid: 900, startIdentity: null },
      paneId: "%1",
      panePid: { pid: 100, startIdentity: null },
      target: "agents:4.0",
    });
    registry.failSpawn(begun.receipt.launchId, "agent never reached a launch-ready prompt");
    const { resolver, state } = fakeHost(true, undefined, (host) => {
      registry.confirmSpawnPaneAlive(begun.receipt.launchId, {
        kind: "tmux",
        endpoint: "/tmp",
        server: { pid: host.tmuxServerPid, startIdentity: "900:observed" },
        paneId: host.paneId,
        panePid: { pid: host.panePid, startIdentity: "100:observed" },
        windowName: host.windowName ?? "",
        agent: { pid: host.agentPid, startIdentity: host.agentIdentity },
        argv: host.agentArgv,
      }, { engine: host.engine, cwd: host.cwd });
    });

    expect(await resolver.deliverToTranscriptHost({ entry: state.entry, spec, payload: "release quarantine" })).toMatchObject({
      ok: true,
      outcome: "delivered-to-live",
    });
    expect(registry.snapshot().receipts[begun.receipt.launchId]).toMatchObject({
      state: "host-verified",
      error: null,
    });
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("serializes two cold sends into one resume and delivers both payloads", async () => {
    const { resolver, state } = fakeHost(false);

    const [first, second] = await Promise.all([
      resolver.deliverToTranscriptHost({ entry: state.entry, spec, payload: "first" }),
      resolver.deliverToTranscriptHost({ entry: state.entry, spec, payload: "second" }),
    ]);

    expect(state.spawnCalls).toBe(1);
    expect(first).toEqual({ ok: true, outcome: "resumed", target: "agents:5.0" });
    expect(second).toEqual({ ok: true, outcome: "delivered-to-live", target: "agents:5.0" });
    expect(state.delivered.sort()).toEqual(["%9:first", "%9:second"]);
  });

  test("stops delivery when migration advancement rejects the observed successor", async () => {
    const { resolver, state } = fakeHost(false);
    state.launchId = "resume-launch";
    state.quarantineAfterResumeBegin = true;

    const outcome = await resolver.deliverToTranscriptHost({ entry: state.entry, spec, payload: "must stay canonical" });

    expect(outcome).toEqual({
      ok: false,
      outcome: "failed",
      error: "conversation has a quarantined live pane",
      status: 409,
    });
    expect(state.resumeBegan).toBe(true);
    expect(state.spawnCalls).toBe(1);
    expect(state.deliverAttempts).toBe(0);
    expect(state.delivered).toEqual([]);

    const snapshot = await resolver.readTranscriptHosts(true);
    expect(snapshot.hosts.map((host) => host.paneId)).toEqual(["%9"]);
    expect(snapshot.canonicalFor(PATHNAME)).toBeNull();
    expect(snapshot.conflicts).toEqual([{
      conversationId: "conversation_test",
      paths: [PATHNAME],
      paneIds: ["%9"],
      quarantinedPaneIds: ["%9"],
    }]);

    expect(await resolver.deliverToTranscriptHost({ entry: state.entry, spec, payload: "retry stays fenced" })).toEqual({
      ok: false,
      outcome: "failed",
      error: "conversation has a quarantined live pane",
      status: 409,
    });
    expect(state.spawnCalls).toBe(1);
    expect(state.deliverAttempts).toBe(0);
  });

  test("surfaces duplicate live panes for one conversation and refuses a third resume", async () => {
    const { resolver, state } = fakeHost();
    state.panes.set(101, { paneId: "%2", target: "agents:6.0" });
    state.agents.push({ pid: 201, engine: "codex", argv: ["codex", "resume", SESSION], cwd: "/repo", tty: 1 });
    state.ppids.set(201, 101);
    state.identities.set(201, "201:one");

    const snapshot = await resolver.readTranscriptHosts(true);

    expect(snapshot.canonicalFor(PATHNAME)).toBeNull();
    expect(snapshot.conflicts).toEqual([{
      conversationId: "conversation_test",
      paths: [PATHNAME],
      paneIds: ["%1", "%2"],
    }]);
    expect(await resolver.deliverToTranscriptHost({ entry: state.entry, spec, payload: "single owner required" })).toEqual({
      ok: false,
      outcome: "failed",
      error: "conversation has multiple live panes",
      status: 409,
    });
    expect(state.spawnCalls).toBe(0);
  });

  test("a recycled scanner pid stays orphaned while current argv ownership remains canonical", async () => {
    const { resolver, state } = fakeHost();
    state.agents[0] = {
      ...state.agents[0]!,
      argv: ["codex", "resume", "00000000-0000-0000-0000-000000000000"],
    };
    state.panes.set(101, { paneId: "%2", target: "agents:6.0" });
    state.agents.push({ pid: 201, engine: "codex", argv: ["codex", "resume", SESSION], cwd: "/repo", tty: 1 });
    state.ppids.set(201, 101);
    state.identities.set(201, "201:one");

    const snapshot = await resolver.readTranscriptHosts(true);

    expect(snapshot.hosts.find((host) => host.agentPid === 200)?.primaryPath).toBeNull();
    expect(snapshot.canonicalFor(PATHNAME)?.agentPid).toBe(201);
    expect(snapshot.conflicts).toEqual([]);
  });

  test("reports resumed to a joined sender that owns recovery after the live host exits", async () => {
    const { resolver, state } = fakeHost();
    /* decide() validates once, then each concurrent sender validates again.
       The second sender observes the same pane after its process exited and
       therefore becomes the owner of the shared recovery decision. */
    state.retireOnAliveRead = 3;

    const [first, second] = await Promise.all([
      resolver.deliverToTranscriptHost({ entry: state.entry, spec, payload: "first" }),
      resolver.deliverToTranscriptHost({ entry: state.entry, spec, payload: "second" }),
    ]);

    expect(first).toEqual({ ok: true, outcome: "delivered-to-live", target: "agents:4.0" });
    expect(second).toEqual({ ok: true, outcome: "resumed", target: "agents:5.0" });
    expect(state.spawnCalls).toBe(1);
    expect(state.delivered).toEqual(["%1:first", "%9:second"]);
  });

  test("recovers a pane pid mismatch through one controlled resume", async () => {
    const { resolver, state } = fakeHost();
    state.panePidOverride = 999;

    const outcome = await resolver.deliverToTranscriptHost({ entry: state.entry, spec, payload: "recover" });

    expect(outcome).toEqual({ ok: true, outcome: "resumed", target: "agents:5.0" });
    expect(state.spawnCalls).toBe(1);
    expect(state.delivered).toEqual(["%9:recover"]);
  });

  test("recovers when the tmux server changes after host observation", async () => {
    const { resolver, state } = fakeHost();
    state.serverPid = 901;

    const outcome = await resolver.deliverToTranscriptHost({ entry: state.entry, spec, payload: "recover" });

    expect(outcome).toEqual({ ok: true, outcome: "resumed", target: "agents:5.0" });
    expect(state.spawnCalls).toBe(1);
    expect(state.recordServerPid).toBe(901);
  });

  test("recovers when an agent pid is reused between observation and delivery", async () => {
    const { resolver, state } = fakeHost();
    state.identitySequence = ["200:one", "200:reused", "200:reused"];

    const outcome = await resolver.deliverToTranscriptHost({ entry: state.entry, spec, payload: "recover" });

    expect(outcome).toEqual({ ok: true, outcome: "resumed", target: "agents:5.0" });
    expect(state.spawnCalls).toBe(1);
  });

  test("recovers when the observed pane was deleted before delivery", async () => {
    const { resolver, state } = fakeHost();
    state.panes.clear();

    const outcome = await resolver.deliverToTranscriptHost({ entry: state.entry, spec, payload: "recover" });

    expect(outcome).toEqual({ ok: true, outcome: "resumed", target: "agents:5.0" });
    expect(state.spawnCalls).toBe(1);
  });

  test("refuses a resume record whose agent no longer claims the transcript", async () => {
    const { resolver, state } = fakeHost();
    state.entry = { ...state.entry, pid: null, proc: null };
    state.agents = [{ ...state.agents[0]!, argv: ["codex", "resume", "00000000-0000-0000-0000-000000000000"] }];
    state.records.set(PATHNAME, { paneId: "%1", panePid: 100, windowName: "codex-resume", engine: "codex" });

    const outcome = await resolver.deliverToTranscriptHost({ entry: state.entry, spec, payload: "recover" });

    expect(outcome).toEqual({ ok: true, outcome: "resumed", target: "agents:5.0" });
    expect(state.spawnCalls).toBe(1);
  });

  test("returns explicit failures to every caller and permits a later retry", async () => {
    const { resolver, state } = fakeHost(false);
    state.failSpawn = true;

    const failures = await Promise.all([
      resolver.deliverToTranscriptHost({ entry: state.entry, spec, payload: "one" }),
      resolver.deliverToTranscriptHost({ entry: state.entry, spec, payload: "two" }),
    ]);
    expect(failures).toEqual([
      { ok: false, outcome: "failed", error: "tmux resume failed", status: 500 },
      { ok: false, outcome: "failed", error: "tmux resume failed", status: 500 },
    ]);
    expect(state.spawnCalls).toBe(1);

    state.failSpawn = false;
    expect(await resolver.deliverToTranscriptHost({ entry: state.entry, spec, payload: "retry" })).toEqual({
      ok: true,
      outcome: "resumed",
      target: "agents:5.0",
    });
    expect(state.spawnCalls).toBe(2);
  });

  test("reports post-paste delivery ambiguity without retyping the payload", async () => {
    const { resolver, state } = fakeHost();
    state.deliverError = new TmuxDeliveryUncertainError("Enter failed after paste");

    const outcome = await resolver.deliverToTranscriptHost({ entry: state.entry, spec, payload: "send once" });

    expect(outcome).toEqual({
      ok: false,
      outcome: "failed",
      error: "Enter failed after paste",
      status: 500,
      actuation: "started",
    });
    expect(state.deliverAttempts).toBe(1);
    expect(state.delivered).toHaveLength(0);
  });

  test("fails closed on tmux observation errors without spawning a replacement", async () => {
    const { resolver, state } = fakeHost(false);
    state.paneObservation = "failure";

    const outcome = await resolver.deliverToTranscriptHost({ entry: state.entry, spec, payload: "recover" });

    expect(outcome).toEqual({
      ok: false,
      outcome: "failed",
      error: "tmux pane observation failed: tmux list-panes failed",
      status: 500,
    });
    expect(state.spawnCalls).toBe(0);
  });
});

test("the structured-transport resume ladder refuses to open a legacy tmux Claude window", async () => {
  const previousTransport = process.env.LLV_SPAWN_TRANSPORT;
  process.env.LLV_SPAWN_TRANSPORT = "structured";
  try {
    const claudePath = "/home/user/.claude/projects/-repo/0f0e9d8c-0000-4000-8000-000000000001.jsonl";
    const claudeEntry = entry({
      path: claudePath,
      name: claudePath,
      root: "claude-projects",
      engine: "claude",
      fmt: "claude",
      pid: null,
      proc: "done",
      activity: "idle",
    });
    const { spawnAgentWithPrompt } = await import("@/lib/tmux");
    const resolver = createTranscriptHostResolver({
      listFiles: async () => [claudeEntry],
      panes: async () => ({ kind: "no-server" as const }),
      ppidMap: () => new Map(),
      agents: () => [],
      serverPid: async () => null,
      resumeRecords: async () => null,
      panePid: async () => null,
      alive: () => false,
      argv: () => [],
      parentPid: () => null,
      identity: () => null,
      /* The production resume ladder — a spawn here would create the exact
         stale interactive pane observed as %23 in session 50c0f4cf. */
      spawn: (resumeSpec, text, receipt) => spawnAgentWithPrompt(resumeSpec, text, receipt),
      remember: async () => { throw new Error("a refused resume must never be remembered as a pane"); },
      deliver: async () => { throw new Error("a refused resume must never deliver into a pane"); },
    });

    const outcome = await resolver.deliverToTranscriptHost({
      entry: claudeEntry,
      spec: {
        command: "claude --dangerously-skip-permissions --resume 0f0e9d8c-0000-4000-8000-000000000001",
        cwd: "/repo",
        windowName: "claude-resume",
        engine: "claude",
      },
      payload: "hello",
    });

    expect(outcome.ok).toBeFalse();
    if (!outcome.ok) expect(outcome.error).toMatch(/structured transport prohibits legacy tmux Claude launches/);
  } finally {
    if (previousTransport === undefined) delete process.env.LLV_SPAWN_TRANSPORT;
    else process.env.LLV_SPAWN_TRANSPORT = previousTransport;
  }
});
