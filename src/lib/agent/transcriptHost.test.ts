import { describe, expect, test } from "bun:test";

import type { ResumeSpec } from "@/lib/agent/cli";
import { createTranscriptHostResolver } from "@/lib/agent/transcriptHost";
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
}

function fakeHost(existing = true) {
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
  };

  const resolver = createTranscriptHostResolver({
    listFiles: async () => [state.entry],
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
    reconcile: async (hosts) => ({
      quarantinedPaneIds: state.quarantineAfterResumeBegin && state.resumeBegan
        ? hosts.filter((host) => host.launchId === state.launchId).map((host) => host.paneId)
        : [],
    }),
    deliver: async (paneId: string, text: string) => {
      state.deliverAttempts += 1;
      if (state.deliverError) throw state.deliverError;
      state.delivered.push(`${paneId}:${text}`);
    },
  });
  return { state, resolver };
}

describe("transcript host resolver", () => {
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
