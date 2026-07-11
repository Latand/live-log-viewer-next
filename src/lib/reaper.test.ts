import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry, type RegistryFile } from "@/lib/agent/registry";
import { emptyLaunchProfile, type LaunchProfile } from "@/lib/accounts/migration/contracts";
import type { TranscriptHost } from "@/lib/agent/transcriptHost";
import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

import { evaluateReaper, runEvaluatedReaper, type ReaperInput } from "./reaper";

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
    hosts: [host(1, duplicate, 8), host(1, duplicate, 9), host(2, implementer), host(3, reviewer), host(4, probe), host(5, dead)],
    files: [file(duplicate, 1), file(implementer, 31), file(reviewer, 6), file(probe, 61)],
    flows: [flow("flow-1", implementer, reviewer)],
    mergedFlowIds: new Set(["flow-1"]),
    missingTranscriptPaths: new Set([dead]),
    firstObservedAt: { "%5:2005:2005:one": new Date(NOW - 31 * 60_000).toISOString() },
  }));

  expect(report.agents.map((agent) => [agent.paneId, agent.class, agent.ttlSeconds, agent.eligible])).toEqual([
    ["%8", "duplicate-resume", 0, true],
    ["%9", "duplicate-resume", 0, false],
    ["%2", "flow-worker", 1800, true],
    ["%3", "headless-reviewer", 300, true],
    ["%4", "probe", 3600, true],
    ["%5", "dead-transcript", 1800, true],
  ]);
  expect(report.agents.find((agent) => agent.paneId === "%9")?.protectedReasons).toContain("newest-duplicate");
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
  }));

  expect(report.agents.map((agent) => agent.protectedReasons)).toEqual([
    ["user-authored-message"],
    ["mid-turn"],
    ["manual-board-placement"],
  ]);
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
