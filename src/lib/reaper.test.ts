import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry, type RegistryFile } from "@/lib/agent/registry";
import { emptyLaunchProfile, type LaunchProfile } from "@/lib/accounts/migration/contracts";
import type { TranscriptHost } from "@/lib/agent/transcriptHost";
import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

import { evaluateReaper, runEvaluatedReaper, type HeadlessReviewerProcess, type ReaperInput } from "./reaper";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-reaper-test-"));
const NOW = Date.parse("2026-07-12T12:00:00.000Z");
afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

function transcript(index: number): string {
  return `/transcripts/rollout-2026-07-12T00-00-00-019f5${String(index).padStart(7, "0")}-1111-7111-8111-111111111111.jsonl`;
}

function host(index: number, pathname: string, pane = index): TranscriptHost {
  return {
    tmuxServerPid: 900,
    paneId: `%${pane}`,
    panePid: 1000 + pane,
    agentPid: 2000 + pane,
    display: `agents:${pane}.0`,
    windowName: `worker-${pane}`,
    engine: "codex",
    cwd: "/repo",
    agentArgv: ["codex", "resume", pathname],
    agentIdentity: `${2000 + pane}:one`,
    launchId: null,
    claimedPaths: [pathname],
    primaryPath: pathname,
  };
}

function file(pathname: string, ageMinutes: number): FileEntry {
  return {
    path: pathname, root: "codex-sessions", name: path.basename(pathname), project: "repo", title: "worker",
    engine: "codex", kind: "conversation", fmt: "codex", parent: null, mtime: NOW / 1000 - ageMinutes * 60,
    size: 1, activity: "idle", proc: "running", pid: null, model: null, pendingQuestion: null, waitingInput: null,
  } as FileEntry;
}

function flow(id: string, implementerPath: string, reviewerPath: string): Flow {
  return {
    id, template: "implement-review-loop", project: "repo", cwd: "/repo", implementerPath,
    roles: { implementer: { engine: "codex", model: null, effort: null }, reviewer: { engine: "codex", model: null, effort: null } },
    baseRef: "base", baseMode: "merge-base", mode: "auto", reviewerMode: "headless", roundLimit: 1,
    state: "closed", stateDetail: null, rounds: [{
      n: 1, reviewerPath, reviewerPid: null, reviewerPane: null, findingsPath: "/findings", triggeredBy: "marker",
      readyNote: null, verdict: "APPROVE", findingsCount: 0, startedAt: new Date(NOW - 20 * 60_000).toISOString(),
      reviewedAt: new Date(NOW - 6 * 60_000).toISOString(), relayedAt: null, error: null,
    }], createdAt: new Date(NOW - 60 * 60_000).toISOString(), closedAt: new Date(NOW - 31 * 60_000).toISOString(),
  } as Flow;
}

function registryFor(profiles: Map<string, LaunchProfile>, busy = new Set<string>()): RegistryFile {
  const registry = new AgentRegistry(path.join(DIR, `${Math.random()}.json`));
  let index = 0;
  for (const [pathname, profile] of profiles) {
    registry.reconcileConversations([{
      engine: "codex", path: pathname, accountId: "default", launchProfile: profile,
      turn: { state: busy.has(pathname) ? "busy" : "idle", source: busy.has(pathname) ? "lifecycle" : "empty", terminalAt: null },
      observedAt: new Date(NOW - 120 * 60_000).toISOString(),
    }]);
    registry.upsert({
      key: { engine: "codex", sessionId: `019f5${String(index++).padStart(7, "0")}-1111-7111-8111-111111111111` },
      artifactPath: pathname, cwd: "/repo", accountId: "default", launchProfile: profile, status: "idle", host: null,
      claimEpoch: 0, claimOwner: null, pendingAction: null,
    });
  }
  return registry.snapshot();
}

function input(overrides: Partial<ReaperInput> = {}): ReaperInput {
  return {
    now: NOW,
    registry: registryFor(new Map()),
    hosts: [],
    reviewerProcesses: [],
    viewerOwnedPaths: new Set(),
    authorshipUnverifiedPaths: new Set(),
    files: [],
    flows: [],
    manualPaths: new Set(),
    userAuthoredPaths: new Set(),
    missingTranscriptPaths: new Set(),
    mergedFlowIds: new Set(),
    firstObservedAt: {},
    enabled: false,
    ...overrides,
  };
}

test("classifies every policy class and applies its exact idle TTL", () => {
  const duplicate = transcript(1);
  const implementer = transcript(2);
  const reviewer = transcript(3);
  const probe = transcript(4);
  const dead = transcript(5);
  const profiles = new Map([
    [duplicate, emptyLaunchProfile({ cwd: "/repo", role: "worker" })],
    [implementer, emptyLaunchProfile({ cwd: "/repo", role: "worker" })],
    [reviewer, emptyLaunchProfile({ cwd: "/repo", role: "worker" })],
    [probe, emptyLaunchProfile({ cwd: "/repo", role: "worker", title: "overnight soak probe" })],
    [dead, emptyLaunchProfile({ cwd: "/repo", role: "worker" })],
  ]);
  const report = evaluateReaper(input({
    registry: registryFor(profiles),
    hosts: [host(1, duplicate, 8), host(1, duplicate, 9), host(2, implementer), host(4, probe), host(5, dead)],
    reviewerProcesses: [{
      flowId: "flow-1",
      round: 1,
      pid: 3003,
      identity: "3003:one",
      path: reviewer,
    } satisfies HeadlessReviewerProcess],
    files: [file(duplicate, 1), file(implementer, 31), file(reviewer, 6), file(probe, 61)],
    flows: [flow("flow-1", implementer, reviewer)],
    mergedFlowIds: new Set(["flow-1"]),
    missingTranscriptPaths: new Set([dead]),
    viewerOwnedPaths: new Set([probe]),
    authorshipUnverifiedPaths: new Set([dead]),
    firstObservedAt: { "%5:2005:2005:one": new Date(NOW - 31 * 60_000).toISOString() },
  }));

  expect(report.agents.map((agent) => [agent.paneId, agent.class, agent.ttlSeconds, agent.eligible])).toEqual([
    ["%8", "duplicate-resume", 0, true],
    ["%9", "duplicate-resume", 0, false],
    ["%2", "flow-worker", 1800, true],
    ["%4", "probe", 3600, true],
    ["%5", "dead-transcript", 1800, false],
    [null, "headless-reviewer", 300, true],
  ]);
  expect(report.agents.find((agent) => agent.paneId === "%9")?.protectedReasons).toContain("newest-duplicate");
  expect(report.agents.find((agent) => agent.paneId === "%5")?.protectedReasons).toContain("authorship-unverified");
});

test("probe-shaped metadata stays unclassified without Viewer spawn provenance", () => {
  const pathname = transcript(17);
  const report = evaluateReaper(input({
    registry: registryFor(new Map([[pathname, emptyLaunchProfile({ cwd: "/repo", role: "worker", title: "external soak probe" })]])),
    hosts: [host(17, pathname, 17)],
    files: [file(pathname, 120)],
  }));

  expect(report.agents[0]).toMatchObject({ class: null, eligible: false, protectedReasons: ["unclassified"] });
});

test("a newer active flow wins over a closed flow for the same implementer", () => {
  const pathname = transcript(16);
  const historical = flow("flow-old", pathname, transcript(116));
  const active: Flow = {
    ...flow("flow-new", pathname, transcript(216)),
    state: "reviewing",
    closedAt: null,
    createdAt: new Date(NOW - 10 * 60_000).toISOString(),
    rounds: [],
  };
  const report = evaluateReaper(input({
    registry: registryFor(new Map([[pathname, emptyLaunchProfile({ cwd: "/repo", role: "worker" })]])),
    hosts: [host(16, pathname, 16)],
    files: [file(pathname, 120)],
    flows: [historical, active],
    mergedFlowIds: new Set([historical.id]),
  }));

  expect(report.agents[0]).toMatchObject({
    class: "flow-worker",
    flowId: "flow-new",
    eligible: false,
  });
  expect(report.agents[0]?.protectedReasons).toEqual(expect.arrayContaining(["flow-in-progress", "flow-not-merged"]));
});

test("hard exemptions protect user conversations, mid-turn agents, and manual board placements", () => {
  const paths = [transcript(11), transcript(12), transcript(13)];
  const profiles = new Map(paths.map((pathname) => [pathname, emptyLaunchProfile({ cwd: "/repo", role: "worker", title: "soak probe" })]));
  const report = evaluateReaper(input({
    registry: registryFor(profiles, new Set([paths[1]!])),
    hosts: paths.map((pathname, index) => host(11 + index, pathname, 11 + index)),
    files: paths.map((pathname) => file(pathname, 120)),
    userAuthoredPaths: new Set([paths[0]!]),
    manualPaths: new Set([paths[2]!]),
    viewerOwnedPaths: new Set(paths),
  }));

  expect(report.agents.map((agent) => agent.protectedReasons)).toEqual([
    ["user-authored-message"],
    ["mid-turn"],
    ["manual-board-placement"],
  ]);
});

test("live migration generations are independent hosts and remain protected through handoff", () => {
  const source = transcript(14);
  const successor = transcript(114);
  const profile = emptyLaunchProfile({ cwd: "/repo", role: "worker", title: "soak probe" });
  const registry = registryFor(new Map([[source, profile]]));
  const conversation = Object.values(registry.conversations)[0]!;
  const sourceGeneration = conversation.generations[0]!;
  conversation.generations.push({
    ...sourceGeneration,
    id: "codex:successor-generation",
    path: successor,
    accountId: "target",
    createdAt: new Date(NOW - 5 * 60_000).toISOString(),
  });
  conversation.migration = {
    intentId: "intent-1",
    phase: "verifying",
    targetId: "target",
    revision: 1,
    error: null,
    errorCode: null,
    operationId: "operation-1",
    sourceGenerationId: sourceGeneration.id,
    providerReceipt: null,
    pendingContinuityPaths: [],
    boardProject: null,
    boardOperationId: null,
    boardPlacementProject: null,
    updatedAt: new Date(NOW - 5 * 60_000).toISOString(),
  };

  const report = evaluateReaper(input({
    registry,
    hosts: [host(14, source, 14), host(114, successor, 114)],
    files: [file(source, 120), file(successor, 120)],
    viewerOwnedPaths: new Set([source, successor]),
  }));

  expect(report.agents.map((agent) => agent.class)).toEqual(["probe", "probe"]);
  expect(report.agents.every((agent) => agent.protectedReasons.includes("migration-in-progress"))).toBe(true);
  expect(report.agents.every((agent) => !agent.eligible)).toBe(true);
});

test("a transcript omitted by the recency-capped scanner is not classified as missing", () => {
  const pathname = transcript(15);
  const report = evaluateReaper(input({
    registry: registryFor(new Map([[pathname, emptyLaunchProfile({ cwd: "/repo", role: "worker" })]])),
    hosts: [host(15, pathname, 15)],
    files: [],
    missingTranscriptPaths: new Set(),
  }));

  expect(report.agents[0]).toMatchObject({ class: null, eligible: false, protectedReasons: ["unclassified"] });
});

test("dry-run is the default and real mode journals every actuation with its class reason", async () => {
  const pathname = transcript(20);
  const base = input({
    registry: registryFor(new Map([[pathname, emptyLaunchProfile({ cwd: "/repo", role: "worker", title: "probe" })]])),
    hosts: [host(20, pathname, 20)], files: [file(pathname, 61)],
    viewerOwnedPaths: new Set([pathname]),
  });
  let kills = 0;
  const dry = await runEvaluatedReaper(evaluateReaper(base), {
    actuate: async () => { kills += 1; return true; }, journal: () => {},
  });
  expect(dry.mode).toBe("dry-run");
  expect(kills).toBe(0);

  const journal: unknown[] = [];
  const real = await runEvaluatedReaper(evaluateReaper({ ...base, enabled: true }), {
    actuate: async () => { kills += 1; return true; }, journal: (record) => journal.push(record),
  });
  expect(real.mode).toBe("active");
  expect(real.agents[0]?.action).toBe("reaped");
  expect(journal).toMatchObject([{ paneId: "%20", class: "probe", reason: "idle-ttl-exceeded", outcome: "reaped" }]);
});

test("one rejected actuation is journaled and later candidates continue", async () => {
  const first = transcript(31);
  const second = transcript(32);
  const report = evaluateReaper(input({
    enabled: true,
    registry: registryFor(new Map([
      [first, emptyLaunchProfile({ cwd: "/repo", role: "worker", title: "probe" })],
      [second, emptyLaunchProfile({ cwd: "/repo", role: "worker", title: "probe" })],
    ])),
    hosts: [host(31, first, 31), host(32, second, 32)],
    files: [file(first, 61), file(second, 61)],
    viewerOwnedPaths: new Set([first, second]),
  }));
  const journals: unknown[] = [];
  let attempts = 0;

  await expect(runEvaluatedReaper(report, {
    actuate: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("lock rejected");
      return true;
    },
    journal: (record) => journals.push(record),
  })).resolves.toBe(report);

  expect(report.agents.map((agent) => agent.action)).toEqual(["kill-failed", "reaped"]);
  expect(journals).toMatchObject([{ outcome: "kill-failed" }, { outcome: "reaped" }]);
});

test("an errored headless reviewer ages from its persisted terminal timestamp", () => {
  const reviewerPath = transcript(41);
  const erroredFlow = flow("flow-errored-reviewer", transcript(40), reviewerPath);
  erroredFlow.rounds[0] = {
    ...erroredFlow.rounds[0]!,
    verdict: null,
    reviewedAt: null,
    error: "reviewer timed out",
    terminalAt: new Date(NOW - 6 * 60_000).toISOString(),
  };
  const report = evaluateReaper(input({
    flows: [erroredFlow],
    reviewerProcesses: [{
      flowId: erroredFlow.id,
      round: 1,
      pid: 3041,
      identity: "3041:one",
      path: reviewerPath,
    }],
  }));

  expect(report.agents[0]).toMatchObject({
    class: "headless-reviewer",
    idleSeconds: 360,
    eligible: true,
    protectedReasons: [],
  });
});
