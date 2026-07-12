import { afterAll, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "@/lib/types";
import { procBackend } from "@/lib/proc";

import type { Flow } from "./types";

process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-flow-engine-test-"));
const { captureReviewHead, newRound, tickFlows, persistTickFlows, flowTickBase, reviewerLaunchPersisted, abandonLaunch, adoptSyntheticLaunchTakeover, recordHeadlessLaunch, relayFixOrPark } = await import("./engine");
const { loadFlows, outputPathFor, saveFlows, stderrPathFor, stdoutPathFor } = await import("./store");

afterAll(() => {
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
});

function entryFor(pathname: string, mtime: number): FileEntry {
  return {
    path: pathname,
    root: "codex-sessions",
    name: path.basename(pathname),
    project: "repo",
    title: "agent",
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime,
    size: fs.statSync(pathname).size,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

function writeCodexEntry(name: string, payload: Record<string, unknown>, mtime: number): FileEntry {
  const pathname = path.join(process.env.LLV_STATE_DIR!, "flow-codex-fixtures", name);
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, JSON.stringify({ type: "session_meta", payload }) + "\n");
  return entryFor(pathname, mtime);
}

test("a review round captures its clean commit immediately before launch", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-flow-reviewed-head-"));
  try {
    expect(spawnSync("git", ["init", "-b", "main"], { cwd: directory }).status).toBe(0);
    expect(spawnSync("git", ["config", "user.email", "flow@example.test"], { cwd: directory }).status).toBe(0);
    expect(spawnSync("git", ["config", "user.name", "Flow Test"], { cwd: directory }).status).toBe(0);
    fs.writeFileSync(path.join(directory, "work.txt"), "committed\n");
    expect(spawnSync("git", ["add", "work.txt"], { cwd: directory }).status).toBe(0);
    expect(spawnSync("git", ["commit", "-m", "reviewed"], { cwd: directory }).status).toBe(0);
    const headSha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).stdout.trim();
    const flow = {
      cwd: directory,
      roles: {
        implementer: { engine: "codex", model: null, effort: "high" },
        reviewer: { engine: "codex", model: null, effort: "xhigh" },
      },
      rounds: [],
    } as unknown as Flow;

    const round = newRound(flow, "marker", null);
    expect(round.reviewHeadSha).toBeNull();
    expect(captureReviewHead(flow, round)).toBe(headSha);
    expect(round.reviewHeadSha).toBe(headSha);
    fs.writeFileSync(path.join(directory, "work.txt"), "uncommitted\n");
    expect(() => captureReviewHead(flow, newRound(flow, "marker", null))).toThrow("review requires a clean committed HEAD");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("review-flow heuristic claim skips a newer native Codex subagent", async () => {
  const startedAt = "2026-01-01T00:00:00.000Z";
  const started = Date.parse(startedAt) / 1000;
  const cwd = "/repo";
  const implementerId = "019f421e-02e1-73e0-9b77-bebde063f10c";
  const rootId = "019f421e-02e1-73e0-9b77-bebde063f10a";
  const childId = "019f423a-d6e9-7903-b597-3e676b6ff3d4";
  const implementer = writeCodexEntry(`rollout-implementer-${implementerId}.jsonl`, { id: implementerId, cwd }, started - 100);
  const root = writeCodexEntry(`rollout-root-${rootId}.jsonl`, { id: rootId, cwd }, started + 5);
  const nativeChild = writeCodexEntry(
    `rollout-child-${childId}.jsonl`,
    {
      id: childId,
      parent_thread_id: rootId,
      cwd,
      source: { subagent: { thread_spawn: { parent_thread_id: rootId } } },
    },
    started + 10,
  );
  const flow: Flow = {
    id: "flow-test",
    template: "implement-review-loop",
    project: "repo",
    cwd,
    implementerPath: implementer.path,
    roles: {
      implementer: { engine: "codex", model: null, effort: "high" },
      reviewer: { engine: "codex", model: null, effort: "xhigh" },
    },
    baseRef: "base",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "pane",
    roundLimit: 5,
    state: "reviewing",
    pausedState: null,
    stateDetail: null,
    rounds: [
      {
        n: 1,
        reviewerPath: null,
        sessionId: null,
        reviewerPid: null,
        reviewerPane: { paneId: "%2", windowName: "codex-new" },
        findingsPath: null,
        triggeredBy: "marker",
        readyNote: null,
        verdict: null,
        findingsCount: null,
        startedAt,
        spawnStartedAt: startedAt,
        relayStartedAt: null,
        reviewedAt: null,
        relayedAt: null,
        error: null,
      },
    ],
    createdAt: startedAt,
    closedAt: null,
  };
  saveFlows([flow]);

  await tickFlows([implementer, nativeChild, root]);
  const after = loadFlows()[0]!;

  expect(after.rounds[0]!.reviewerPath).toBe(root.path);
});


/* ── issue #117 reviewer-spawn hardening tests ── */

test("headless review retries once after an exit without a verdict, then parks on a repeated failure", async () => {
  const startedAt = new Date().toISOString();
  const cwd = "/repo";
  const implementer = writeCodexEntry("retry-implementer.jsonl", { id: "019f421e-02e1-73e0-9b77-bebde063f117", cwd }, Date.now() / 1_000);
  const flow: Flow = {
    id: "flow-retry",
    template: "implement-review-loop",
    project: "repo",
    cwd,
    implementerPath: implementer.path,
    roles: {
      implementer: { engine: "codex", model: null, effort: "high" },
      reviewer: { engine: "codex", model: null, effort: "xhigh" },
    },
    reviewerFallback: { engine: "claude", model: "fable", effort: "high" },
    baseRef: "base",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
    state: "reviewing",
    pausedState: null,
    stateDetail: null,
    rounds: [{
      n: 1,
      reviewerPath: null,
      reviewerRole: { engine: "codex", model: null, effort: "xhigh" },
      accountId: "default",
      attemptedAccounts: ["codex:default"],
      autoRetryCount: 0,
      sessionId: null,
      reviewerPid: 999_999_999,
      reviewerPane: null,
      findingsPath: null,
      triggeredBy: "marker",
      readyNote: null,
      verdict: null,
      findingsCount: null,
      startedAt,
      spawnStartedAt: startedAt,
      relayStartedAt: null,
      reviewedAt: null,
      relayedAt: null,
      error: null,
    }],
    createdAt: startedAt,
    closedAt: null,
  };
  fs.mkdirSync(path.dirname(stdoutPathFor(flow.id, 1)), { recursive: true });
  fs.writeFileSync(stdoutPathFor(flow.id, 1), "reviewer exited before producing a verdict\n");
  fs.writeFileSync(stderrPathFor(flow.id, 1), "stale stderr\n");
  fs.writeFileSync(outputPathFor(flow.id, 1), "stale last message without verdict\n");
  saveFlows([flow]);

  await tickFlows([implementer]);
  const retrying = loadFlows()[0]!;
  expect(retrying.state).toBe("spawning");
  expect(retrying.stateDetail).toContain("retrying automatically");
  expect(retrying.rounds[0]).toMatchObject({ autoRetryCount: 1, accountId: null, reviewerRole: null, attemptedAccounts: ["codex:default"], error: null });
  expect(fs.existsSync(stdoutPathFor(flow.id, 1))).toBeFalse();
  expect(fs.existsSync(stderrPathFor(flow.id, 1))).toBeFalse();
  expect(fs.existsSync(outputPathFor(flow.id, 1))).toBeFalse();

  retrying.rounds[0]!.spawnStartedAt = startedAt;
  saveFlows([retrying]);
  await tickFlows([implementer]);
  const interrupted = loadFlows()[0]!;
  expect(interrupted.state).toBe("needs_decision");
  expect(interrupted.stateDetail).toBe("reviewer tracking was lost before a verdict could be recovered");

  interrupted.state = "reviewing";
  interrupted.rounds[0]!.reviewerPid = 999_999_999;
  interrupted.rounds[0]!.spawnStartedAt = startedAt;
  saveFlows([interrupted]);
  fs.writeFileSync(stdoutPathFor(flow.id, 1), "reviewer exited again\n");

  await tickFlows([implementer]);
  const parked = loadFlows()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain("reviewer verdict was unparseable");
});

test("headless review recovers the rollout verdict before consuming an automatic retry", async () => {
  const startedAt = "2026-07-12T08:35:59.000Z";
  const cwd = "/repo";
  const implementer = writeCodexEntry("recoverable-implementer.jsonl", { id: "019f421e-02e1-73e0-9b77-bebde063f119", cwd }, Date.now() / 1_000);
  const reviewerPath = path.join(import.meta.dir, "fixtures", "codex-review-2026-07-12.jsonl");
  const reviewer = entryFor(reviewerPath, Date.now() / 1_000);
  const flow: Flow = {
    id: "flow-recoverable",
    template: "implement-review-loop",
    project: "repo",
    cwd,
    implementerPath: implementer.path,
    roles: {
      implementer: { engine: "codex", model: null, effort: "high" },
      reviewer: { engine: "codex", model: null, effort: "xhigh" },
    },
    reviewerFallback: { engine: "claude", model: "fable", effort: "high" },
    baseRef: "base",
    baseMode: "head",
    mode: "manual",
    reviewerMode: "headless",
    roundLimit: 5,
    state: "reviewing",
    pausedState: null,
    stateDetail: null,
    rounds: [{
      n: 1,
      reviewerPath,
      reviewerRole: { engine: "codex", model: null, effort: "xhigh" },
      accountId: "default",
      attemptedAccounts: ["codex:default"],
      autoRetryCount: 0,
      sessionId: "11111111-2222-4333-8444-555555555555",
      reviewerPid: 999_999_999,
      reviewerIdentity: "999999999:gone",
      reviewerPane: null,
      findingsPath: null,
      triggeredBy: "marker",
      readyNote: null,
      reviewHeadSha: null,
      verdict: null,
      findingsCount: null,
      startedAt,
      spawnStartedAt: startedAt,
      relayStartedAt: null,
      relayDelivery: null,
      reviewedAt: null,
      terminalAt: null,
      relayedAt: null,
      error: null,
    }],
    createdAt: startedAt,
    closedAt: null,
  };
  fs.mkdirSync(path.dirname(stdoutPathFor(flow.id, 1)), { recursive: true });
  fs.writeFileSync(stdoutPathFor(flow.id, 1), JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: "Review completed; the structured verdict is in the rollout." },
  }) + "\n");
  saveFlows([flow]);

  await tickFlows([implementer, reviewer]);

  expect(loadFlows()[0]).toMatchObject({
    state: "relay_pending",
    rounds: [{ verdict: "REQUEST_CHANGES", findingsCount: 2, autoRetryCount: 0 }],
  });
});

test("lost reviewer tracking parks with an accurate cause and does not spawn a duplicate", async () => {
  const startedAt = "2026-07-12T08:35:59.000Z";
  const cwd = "/repo";
  const implementer = writeCodexEntry("lost-tracking-implementer.jsonl", { id: "019f421e-02e1-73e0-9b77-bebde063f120", cwd }, Date.now() / 1_000);
  const flow: Flow = {
    id: "flow-lost-tracking",
    template: "implement-review-loop",
    project: "repo",
    cwd,
    implementerPath: implementer.path,
    roles: {
      implementer: { engine: "codex", model: null, effort: "high" },
      reviewer: { engine: "codex", model: null, effort: "xhigh" },
    },
    reviewerFallback: null,
    baseRef: "base",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
    state: "reviewing",
    pausedState: null,
    stateDetail: null,
    rounds: [{
      n: 1,
      reviewerPath: null,
      reviewerRole: { engine: "codex", model: null, effort: "xhigh" },
      accountId: "default",
      attemptedAccounts: ["codex:default"],
      autoRetryCount: 0,
      sessionId: null,
      reviewerPid: null,
      reviewerIdentity: null,
      reviewerPane: null,
      findingsPath: null,
      triggeredBy: "marker",
      readyNote: null,
      reviewHeadSha: null,
      verdict: null,
      findingsCount: null,
      startedAt,
      spawnStartedAt: startedAt,
      relayStartedAt: null,
      relayDelivery: null,
      reviewedAt: null,
      terminalAt: null,
      relayedAt: null,
      error: null,
    }],
    createdAt: startedAt,
    closedAt: null,
  };
  saveFlows([flow]);

  await tickFlows([implementer]);

  expect(loadFlows()[0]).toMatchObject({
    state: "needs_decision",
    stateDetail: "reviewer tracking was lost before a verdict could be recovered",
    rounds: [{ autoRetryCount: 0 }],
  });
});

test("pane restart during the pre-handle checkpoint parks before launching another reviewer", async () => {
  const startedAt = "2026-07-12T09:30:00.000Z";
  const cwd = "/missing-pane-review-worktree";
  const implementer = writeCodexEntry("pane-pre-handle-implementer.jsonl", { id: "019f421e-02e1-73e0-9b77-bebde063f121", cwd }, Date.now() / 1_000);
  const flow: Flow = {
    id: "flow-pane-pre-handle",
    template: "implement-review-loop",
    project: "repo",
    cwd,
    implementerPath: implementer.path,
    roles: {
      implementer: { engine: "codex", model: null, effort: "high" },
      reviewer: { engine: "codex", model: null, effort: "xhigh" },
    },
    reviewerFallback: null,
    baseRef: "base",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "pane",
    roundLimit: 5,
    state: "spawning",
    pausedState: null,
    stateDetail: null,
    rounds: [{
      n: 1,
      reviewerPath: null,
      reviewerRole: { engine: "codex", model: null, effort: "xhigh" },
      accountId: "default",
      attemptedAccounts: [],
      autoRetryCount: 0,
      sessionId: null,
      reviewerPid: null,
      reviewerIdentity: null,
      reviewerPane: null,
      findingsPath: null,
      triggeredBy: "marker",
      readyNote: null,
      reviewHeadSha: null,
      verdict: null,
      findingsCount: null,
      startedAt,
      spawnStartedAt: startedAt,
      relayStartedAt: null,
      relayDelivery: null,
      reviewedAt: null,
      terminalAt: null,
      relayedAt: null,
      error: null,
    }],
    createdAt: startedAt,
    closedAt: null,
  };
  saveFlows([flow]);

  await tickFlows([implementer]);

  expect(loadFlows()[0]).toMatchObject({
    state: "needs_decision",
    stateDetail: "reviewer launch tracking is unavailable",
    rounds: [{ reviewerPane: null, reviewerPid: null, reviewerPath: null }],
  });
});

test("overlapping ticks preserve an active pre-handle launch and adopt its reviewer after a synthetic takeover", async () => {
  const startedAt = new Date().toISOString();
  const leaseUntil = new Date(Date.now() + 60_000).toISOString();
  const cwd = "/repo";
  const implementer = writeCodexEntry("overlap-launch-implementer.jsonl", { id: "019f421e-02e1-73e0-9b77-bebde063f123", cwd }, Date.now() / 1_000);
  const flow: Flow = {
    id: "flow-overlap-launch",
    template: "implement-review-loop",
    project: "repo",
    cwd,
    implementerPath: implementer.path,
    roles: {
      implementer: { engine: "codex", model: null, effort: "high" },
      reviewer: { engine: "codex", model: null, effort: "xhigh" },
    },
    reviewerFallback: null,
    baseRef: "base",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "pane",
    roundLimit: 5,
    state: "spawning",
    pausedState: null,
    stateDetail: null,
    rounds: [{
      n: 1,
      reviewerPath: null,
      reviewerRole: { engine: "codex", model: null, effort: "xhigh" },
      accountId: "default",
      attemptedAccounts: [],
      autoRetryCount: 0,
      sessionId: null,
      reviewerPid: null,
      reviewerIdentity: null,
      reviewerPane: null,
      findingsPath: null,
      triggeredBy: "marker",
      readyNote: null,
      reviewHeadSha: null,
      verdict: null,
      findingsCount: null,
      startedAt,
      spawnStartedAt: startedAt,
      launchId: "launch-overlap",
      launchLeaseUntil: leaseUntil,
      relayStartedAt: null,
      relayDelivery: null,
      reviewedAt: null,
      terminalAt: null,
      relayedAt: null,
      error: null,
    }],
    createdAt: startedAt,
    closedAt: null,
  };
  saveFlows([flow]);

  await tickFlows([implementer]);
  expect(loadFlows()[0]).toMatchObject({
    state: "spawning",
    stateDetail: null,
    rounds: [{ launchId: "launch-overlap", reviewerPane: null }],
  });

  const staleTakeover = loadFlows()[0]!;
  staleTakeover.state = "needs_decision";
  staleTakeover.stateDetail = "reviewer tracking was lost before a verdict could be recovered";
  saveFlows([staleTakeover]);
  const launchedRound = {
    ...flow.rounds[0]!,
    reviewerPane: { paneId: "%77", windowName: "codex-review" },
    launchLeaseUntil: null,
  };

  expect(adoptSyntheticLaunchTakeover(flow.id, launchedRound)).toBeTrue();
  expect(loadFlows()[0]).toMatchObject({
    state: "reviewing",
    stateDetail: null,
    rounds: [{ launchId: "launch-overlap", launchLeaseUntil: null, reviewerPane: { paneId: "%77" } }],
  });
});

test("synthetic takeover preserves an identity-less headless launch lease for the next Viewer", async () => {
  const startedAt = new Date().toISOString();
  const leaseUntil = new Date(Date.now() + 60_000).toISOString();
  const cwd = "/repo";
  const implementer = writeCodexEntry("adopt-identity-lease-implementer.jsonl", { id: "019f421e-02e1-73e0-9b77-bebde063f125", cwd }, Date.now() / 1_000);
  const reviewer = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  reviewer.unref();
  const flow: Flow = {
    id: "flow-adopt-identity-lease",
    template: "implement-review-loop",
    project: "repo",
    cwd,
    implementerPath: implementer.path,
    roles: {
      implementer: { engine: "codex", model: null, effort: "high" },
      reviewer: { engine: "codex", model: null, effort: "xhigh" },
    },
    reviewerFallback: null,
    baseRef: "base",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
    state: "needs_decision",
    pausedState: null,
    stateDetail: "reviewer tracking was lost before a verdict could be recovered",
    rounds: [{
      n: 1,
      reviewerPath: null,
      reviewerRole: { engine: "codex", model: null, effort: "xhigh" },
      accountId: "default",
      attemptedAccounts: ["codex:default"],
      autoRetryCount: 0,
      sessionId: null,
      reviewerPid: null,
      reviewerIdentity: null,
      reviewerPane: null,
      findingsPath: null,
      triggeredBy: "marker",
      readyNote: null,
      reviewHeadSha: null,
      verdict: null,
      findingsCount: null,
      startedAt,
      spawnStartedAt: startedAt,
      launchId: "launch-adopt-identity-lease",
      launchLeaseUntil: leaseUntil,
      relayStartedAt: null,
      relayDelivery: null,
      reviewedAt: null,
      terminalAt: null,
      relayedAt: null,
      error: null,
    }],
    createdAt: startedAt,
    closedAt: null,
  };
  saveFlows([flow]);
  const launchedRound = {
    ...flow.rounds[0]!,
    reviewerPid: reviewer.pid ?? null,
    reviewerIdentity: null,
  };

  try {
    expect(adoptSyntheticLaunchTakeover(flow.id, launchedRound)).toBeTrue();
    expect(loadFlows()[0]).toMatchObject({
      state: "reviewing",
      stateDetail: null,
      rounds: [{ reviewerPid: reviewer.pid, reviewerIdentity: null, launchLeaseUntil: leaseUntil, autoRetryCount: 0 }],
    });

    await tickFlows([implementer]);
    expect(loadFlows()[0]).toMatchObject({
      state: "reviewing",
      stateDetail: null,
      rounds: [{ reviewerPid: reviewer.pid, reviewerIdentity: null, launchLeaseUntil: leaseUntil, autoRetryCount: 0 }],
    });

    const recovered = loadFlows()[0]!;
    recovered.rounds[0]!.reviewerIdentity = procBackend.processIdentity(reviewer.pid!);
    saveFlows([recovered]);
    await tickFlows([implementer]);
    expect(loadFlows()[0]).toMatchObject({
      state: "reviewing",
      rounds: [{ reviewerPid: reviewer.pid, reviewerIdentity: expect.any(String), launchLeaseUntil: null, autoRetryCount: 0 }],
    });
  } finally {
    if (reviewer.pid) {
      try { process.kill(reviewer.pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
});

test("identity-less headless post-spawn checkpoint keeps its cross-Viewer lease until identity recovery", async () => {
  const startedAt = new Date().toISOString();
  const leaseUntil = new Date(Date.now() + 60_000).toISOString();
  const cwd = "/repo";
  const implementer = writeCodexEntry("identity-lease-implementer.jsonl", { id: "019f421e-02e1-73e0-9b77-bebde063f124", cwd }, Date.now() / 1_000);
  const reviewer = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  reviewer.unref();
  const flow: Flow = {
    id: "flow-identity-lease",
    template: "implement-review-loop",
    project: "repo",
    cwd,
    implementerPath: implementer.path,
    roles: {
      implementer: { engine: "codex", model: null, effort: "high" },
      reviewer: { engine: "codex", model: null, effort: "xhigh" },
    },
    reviewerFallback: null,
    baseRef: "base",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
    state: "reviewing",
    pausedState: null,
    stateDetail: null,
    rounds: [{
      n: 1,
      reviewerPath: null,
      reviewerRole: { engine: "codex", model: null, effort: "xhigh" },
      accountId: "default",
      attemptedAccounts: ["codex:default"],
      autoRetryCount: 0,
      sessionId: null,
      reviewerPid: null,
      reviewerIdentity: null,
      reviewerPane: null,
      findingsPath: null,
      triggeredBy: "marker",
      readyNote: null,
      reviewHeadSha: null,
      verdict: null,
      findingsCount: null,
      startedAt,
      spawnStartedAt: startedAt,
      launchId: "launch-identity-lease",
      launchLeaseUntil: leaseUntil,
      relayStartedAt: null,
      relayDelivery: null,
      reviewedAt: null,
      terminalAt: null,
      relayedAt: null,
      error: null,
    }],
    createdAt: startedAt,
    closedAt: null,
  };
  recordHeadlessLaunch(flow.rounds[0]!, {
    pid: reviewer.pid ?? null,
    identity: null,
    sessionId: null,
    reviewerPath: null,
  });
  saveFlows([flow]);

  try {
    expect(loadFlows()[0]!.rounds[0]!.launchLeaseUntil).toBe(leaseUntil);
    await tickFlows([implementer]);
    expect(loadFlows()[0]).toMatchObject({
      state: "reviewing",
      stateDetail: null,
      rounds: [{ reviewerPid: reviewer.pid, reviewerIdentity: null, launchLeaseUntil: leaseUntil, autoRetryCount: 0 }],
    });

    const recovered = loadFlows()[0]!;
    recovered.rounds[0]!.reviewerIdentity = procBackend.processIdentity(reviewer.pid!);
    saveFlows([recovered]);
    await tickFlows([implementer]);
    expect(loadFlows()[0]).toMatchObject({
      state: "reviewing",
      rounds: [{ reviewerIdentity: expect.any(String), launchLeaseUntil: null }],
    });
  } finally {
    if (reviewer.pid) {
      try { process.kill(reviewer.pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
});

test("restart recovery accepts a conclusive Codex artifact without process identity or scanner entry", async () => {
  const startedAt = "2026-07-12T09:35:00.000Z";
  const cwd = "/repo";
  const implementer = writeCodexEntry("artifact-recovery-implementer.jsonl", { id: "019f421e-02e1-73e0-9b77-bebde063f122", cwd }, Date.now() / 1_000);
  const reviewer = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  reviewer.unref();
  const flow: Flow = {
    id: "flow-artifact-recovery",
    template: "implement-review-loop",
    project: "repo",
    cwd,
    implementerPath: implementer.path,
    roles: {
      implementer: { engine: "codex", model: null, effort: "high" },
      reviewer: { engine: "codex", model: null, effort: "xhigh" },
    },
    reviewerFallback: null,
    baseRef: "base",
    baseMode: "head",
    mode: "manual",
    reviewerMode: "headless",
    roundLimit: 5,
    state: "reviewing",
    pausedState: null,
    stateDetail: null,
    rounds: [{
      n: 1,
      reviewerPath: null,
      reviewerRole: { engine: "codex", model: null, effort: "xhigh" },
      accountId: "default",
      attemptedAccounts: ["codex:default"],
      autoRetryCount: 0,
      sessionId: null,
      reviewerPid: reviewer.pid ?? null,
      reviewerIdentity: null,
      reviewerPane: null,
      findingsPath: null,
      triggeredBy: "marker",
      readyNote: null,
      reviewHeadSha: null,
      verdict: null,
      findingsCount: null,
      startedAt,
      spawnStartedAt: startedAt,
      relayStartedAt: null,
      relayDelivery: null,
      reviewedAt: null,
      terminalAt: null,
      relayedAt: null,
      error: null,
    }],
    createdAt: startedAt,
    closedAt: null,
  };
  fs.mkdirSync(path.dirname(outputPathFor(flow.id, 1)), { recursive: true });
  fs.writeFileSync(outputPathFor(flow.id, 1), "VERDICT: APPROVE\n\nReview completed.");
  saveFlows([flow]);

  try {
    await tickFlows([implementer]);
    expect(loadFlows()[0]).toMatchObject({
      state: "relay_pending",
      rounds: [{ verdict: "APPROVE", findingsCount: 0, autoRetryCount: 0 }],
    });
  } finally {
    if (reviewer.pid) {
      try { process.kill(reviewer.pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
});

test("restart recovery keeps a launched Claude fallback bound to its persisted effective role", async () => {
  const startedAt = new Date().toISOString();
  const cwd = "/repo";
  const implementer = writeCodexEntry("fallback-restart-implementer.jsonl", { id: "019f421e-02e1-73e0-9b77-bebde063f118", cwd }, Date.now() / 1_000);
  const flow: Flow = {
    id: "flow-fallback-restart",
    template: "implement-review-loop",
    project: "repo",
    cwd,
    implementerPath: implementer.path,
    roles: {
      implementer: { engine: "codex", model: null, effort: "high" },
      reviewer: { engine: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
    },
    reviewerFallback: { engine: "claude", model: "fable", effort: "high" },
    baseRef: "base",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
    state: "spawning",
    pausedState: null,
    stateDetail: null,
    rounds: [{
      n: 1,
      reviewerPath: null,
      reviewerRole: { engine: "claude", model: "fable", effort: "high" },
      accountId: "fable-main",
      attemptedAccounts: ["codex:default", "claude:fable-main"],
      autoRetryCount: 1,
      sessionId: null,
      reviewerPid: 999_999_999,
      reviewerPane: null,
      findingsPath: null,
      triggeredBy: "marker",
      readyNote: null,
      verdict: null,
      findingsCount: null,
      startedAt,
      spawnStartedAt: startedAt,
      relayStartedAt: null,
      reviewedAt: null,
      relayedAt: null,
      error: null,
    }],
    createdAt: startedAt,
    closedAt: null,
  };
  fs.mkdirSync(path.dirname(stdoutPathFor(flow.id, 1)), { recursive: true });
  fs.writeFileSync(stdoutPathFor(flow.id, 1), "VERDICT: APPROVE\n\nFallback review completed.\n");
  saveFlows([flow]);

  await tickFlows([implementer]);
  expect(loadFlows()[0]).toMatchObject({
    state: "reviewing",
    rounds: [{ reviewerRole: { engine: "claude", model: "fable", effort: "high" }, accountId: "fable-main" }],
  });

  await tickFlows([implementer]);
  expect(loadFlows()[0]).toMatchObject({
    state: "relaying",
    rounds: [{ verdict: "APPROVE", reviewerRole: { engine: "claude" } }],
  });
});

/* ── issue #118 group/override concurrency tests ── */

test("a mid-flight round is polled with its frozen reviewer role, not a raced set-roles (issue #118 Finding 1)", async () => {
  const startedAt = "2026-02-02T00:00:00.000Z";
  const started = Date.parse(startedAt) / 1000;
  const cwd = "/repo";
  const implementerId = "029f421e-02e1-73e0-9b77-bebde063f20c";
  const reviewerId = "029f421e-02e1-73e0-9b77-bebde063f20b";
  const implementer = writeCodexEntry(`rollout-impl2-${implementerId}.jsonl`, { id: implementerId, cwd }, started - 100);
  /* The reviewer candidate is a CODEX session, matching the round's frozen role. */
  const reviewerCandidate = writeCodexEntry(`rollout-rev2-${reviewerId}.jsonl`, { id: reviewerId, cwd }, started + 5);
  const flow: Flow = {
    id: "flow-freeze",
    template: "implement-review-loop",
    project: "repo",
    cwd,
    implementerPath: implementer.path,
    /* The live flow role has already been switched to claude by a set-roles that
       raced the running reviewer — the round must ignore it. */
    roles: {
      implementer: { engine: "codex", model: null, effort: "high" },
      reviewer: { engine: "claude", model: "fable", effort: null },
    },
    baseRef: "base",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "pane",
    roundLimit: 5,
    state: "reviewing",
    pausedState: null,
    stateDetail: null,
    rounds: [
      {
        n: 1,
        reviewerPath: null,
        sessionId: null,
        reviewerPid: null,
        /* Frozen at spawn: this reviewer is codex. */
        reviewerRole: { engine: "codex", model: null, effort: "xhigh" },
        reviewerPane: { paneId: "%3", windowName: "codex-rev" },
        findingsPath: null,
        triggeredBy: "marker",
        readyNote: null,
        verdict: null,
        findingsCount: null,
        startedAt,
        spawnStartedAt: startedAt,
        relayStartedAt: null,
        reviewedAt: null,
        relayedAt: null,
        error: null,
      },
    ],
    createdAt: startedAt,
    closedAt: null,
  };
  saveFlows([flow]);

  await tickFlows([implementer, reviewerCandidate]);
  const after = loadFlows()[0]!;

  /* The heuristic claimed the codex candidate: it used the round's frozen codex
     role. Had it read flow.roles.reviewer (now claude), no claude entry exists
     and the reviewer path would still be null. */
  expect(after.rounds[0]!.reviewerPath).toBe(reviewerCandidate.path);
  expect(after.rounds[0]!.reviewerRole).toEqual({ engine: "codex", model: null, effort: "xhigh" });
});

test("persistTickFlows never reverts a concurrent operator config change (issue #118 Finding 2)", () => {
  /* On disk: the operator has switched the reviewer to claude/fable and bumped
     the round limit. */
  const onDisk = {
    id: "flow-race",
    template: "implement-review-loop",
    project: "repo",
    cwd: "/repo",
    implementerPath: "/impl",
    roles: {
      implementer: { engine: "codex", model: null, effort: "high" },
      reviewer: { engine: "claude", model: "fable", effort: null },
    },
    baseRef: "base",
    baseMode: "head",
    mode: "manual",
    reviewerMode: "headless",
    roundLimit: 9,
    state: "reviewing",
    pausedState: null,
    stateDetail: null,
    rounds: [],
    createdAt: "2026-04-04T00:00:00Z",
    closedAt: null,
  } as unknown as Flow;
  saveFlows([onDisk]);

  /* A stale tick clone that started from the same reviewing state, still carries
     the OLD codex reviewer, roundLimit 5, auto mode; the tick advanced it to
     relaying (no operator lifecycle change happened, only config). */
  const staleClone = structuredClone(onDisk);
  staleClone.roles.reviewer = { engine: "codex", model: null, effort: "xhigh" };
  staleClone.roundLimit = 5;
  staleClone.mode = "auto";
  const base = flowTickBase([staleClone]); // captured before the tick mutates it
  staleClone.state = "relaying";
  persistTickFlows([staleClone], base);

  const after = loadFlows()[0]!;
  /* Operator-owned config survives from disk; the tick's own state change lands. */
  expect(after.roles.reviewer).toMatchObject({ engine: "claude", model: "fable" });
  expect(after.roundLimit).toBe(9);
  expect(after.mode).toBe("manual");
  expect(after.state).toBe("relaying");
});

function raceFlow(over: Partial<Flow>): Flow {
  return {
    id: "flow-x",
    template: "implement-review-loop",
    project: "repo",
    cwd: "/repo",
    implementerPath: "/impl",
    roles: { implementer: { engine: "codex", model: null, effort: "high" }, reviewer: { engine: "codex", model: null, effort: "xhigh" } },
    baseRef: "base",
    baseMode: "head",
    mode: "auto",
    reviewerMode: "headless",
    roundLimit: 5,
    state: "reviewing",
    pausedState: null,
    stateDetail: null,
    rounds: [],
    createdAt: "2026-05-05T00:00:00Z",
    closedAt: null,
    ...over,
  } as unknown as Flow;
}

test("persistTickFlows respects a concurrent close instead of reopening the flow (issue #118 review)", () => {
  /* The tick started with the flow reviewing; the operator closed it during the
     tick's awaited spawn/relay. */
  const started = raceFlow({ state: "reviewing" });
  saveFlows([started]);
  const clone = structuredClone(started);
  const base = flowTickBase([clone]);
  /* Operator close lands on disk. */
  saveFlows([raceFlow({ state: "closed", closedAt: "2026-05-05T01:00:00Z" })]);
  /* The tick, unaware, computed a busy state and saves. */
  clone.state = "relaying";
  persistTickFlows([clone], base);

  const after = loadFlows()[0]!;
  expect(after.state).toBe("closed");
  expect(after.closedAt).toBe("2026-05-05T01:00:00Z");
});

test("persistTickFlows preserves a flow created during the tick (issue #118 review)", () => {
  const started = raceFlow({ id: "flow-old", state: "reviewing" });
  saveFlows([started]);
  const clone = structuredClone(started);
  const base = flowTickBase([clone]);
  /* Operator creates a new flow while the tick is awaiting. */
  saveFlows([started, raceFlow({ id: "flow-new", state: "waiting_ready" })]);
  clone.state = "relaying";
  persistTickFlows([clone], base);

  const after = loadFlows();
  expect(after.map((flow) => flow.id).sort()).toEqual(["flow-new", "flow-old"]);
  /* The ticked flow still advanced; the new flow survived untouched. */
  expect(after.find((flow) => flow.id === "flow-old")!.state).toBe("relaying");
  expect(after.find((flow) => flow.id === "flow-new")!.state).toBe("waiting_ready");
});

test("a reviewer spawned into a concurrently closed flow is detected as orphaned and its handle dropped (issue #118 review Finding 1)", () => {
  /* The tick entered spawning and persisted spawnStartedAt; base = spawning. */
  const spawning = raceFlow({
    id: "flow-spawn",
    state: "spawning",
    reviewerMode: "pane",
    rounds: [{
      n: 1, reviewerPath: null, reviewerRole: { engine: "codex", model: null, effort: "xhigh" },
      reviewerPane: null, findingsPath: null, triggeredBy: "button", readyNote: null, verdict: null,
      findingsCount: null, startedAt: "2026-06-06T00:00:00Z", spawnStartedAt: "2026-06-06T00:00:01Z",
      relayStartedAt: null, reviewedAt: null, relayedAt: null, error: null,
    }],
  });
  saveFlows([spawning]);
  const clone = structuredClone(spawning);
  const base = flowTickBase([clone]);

  /* The operator closes the flow while the pane is being created; on disk it has
     no pane handle yet, so close could not stop the reviewer. */
  saveFlows([raceFlow({ id: "flow-spawn", state: "closed", closedAt: "2026-06-06T00:01:00Z", reviewerMode: "pane", rounds: spawning.rounds })]);

  /* The tick finishes spawning: it stamps the pane handle and persists. */
  clone.state = "reviewing";
  clone.rounds[0]!.reviewerPane = { paneId: "%9", windowName: "codex-rev" };
  persistTickFlows([clone], base);

  const after = loadFlows()[0]!;
  /* The close is respected (not reopened) and the pane handle was NOT persisted. */
  expect(after.state).toBe("closed");
  expect(after.rounds[0]!.reviewerPane).toBeNull();
  /* So the launch is detected as un-persisted and the pane gets cleaned up. */
  expect(reviewerLaunchPersisted(loadFlows()[0], clone.rounds[0]!)).toBe(false);
});

test("a pause during pane launch orphans nothing and lets resume re-spawn (issue #118 review Finding 2)", () => {
  /* Tick is mid-spawn (spawnStartedAt set, no handle yet); base = spawning. */
  const spawning = raceFlow({
    id: "flow-pause",
    state: "spawning",
    reviewerMode: "pane",
    rounds: [{
      n: 1, reviewerPath: null, reviewerRole: { engine: "codex", model: null, effort: "xhigh" },
      reviewerPane: null, findingsPath: null, triggeredBy: "button", readyNote: null, verdict: null,
      findingsCount: null, startedAt: "2026-06-06T00:00:00Z", spawnStartedAt: "2026-06-06T00:00:01Z",
      relayStartedAt: null, reviewedAt: null, relayedAt: null, error: null,
    }],
  });
  saveFlows([spawning]);
  const clone = structuredClone(spawning);
  const base = flowTickBase([clone]);

  /* The operator pauses while the pane is being created. */
  saveFlows([raceFlow({ id: "flow-pause", state: "paused", pausedState: "spawning", reviewerMode: "pane", rounds: spawning.rounds })]);

  /* The tick stamps the pane handle and persists — the merge drops it (paused). */
  clone.state = "reviewing";
  clone.rounds[0]!.reviewerPane = { paneId: "%9", windowName: "codex-rev" };
  persistTickFlows([clone], base);

  /* The handle did not persist, so the launch is orphaned and must be cleaned up. */
  expect(reviewerLaunchPersisted(loadFlows()[0], clone.rounds[0]!)).toBe(false);
  expect(loadFlows()[0]!.state).toBe("paused");

  /* Cleanup clears the abandoned spawn markers so resume re-spawns fresh rather
     than parking as "interrupted". */
  abandonLaunch("flow-pause", 1);
  const after = loadFlows()[0]!.rounds[0]!;
  expect(after.spawnStartedAt).toBeNull();
  expect(after.reviewerPane).toBeNull();
});

test("reviewerLaunchPersisted tracks the handle, not just close state", () => {
  const round = { n: 1, reviewerPane: { paneId: "%5", windowName: "w" }, reviewerPid: null } as never;
  /* Handle present on disk → owned. */
  saveFlows([raceFlow({ id: "flow-own", state: "reviewing", rounds: [{ ...(round as object), reviewerPath: null, reviewerRole: null, findingsPath: null, triggeredBy: "button", readyNote: null, verdict: null, findingsCount: null, startedAt: "t", spawnStartedAt: "t", relayStartedAt: null, reviewedAt: null, relayedAt: null, error: null } as never] })]);
  expect(reviewerLaunchPersisted(loadFlows()[0], round)).toBe(true);
  /* Missing flow → lost. */
  expect(reviewerLaunchPersisted(undefined, round)).toBe(false);
});

function limitFlow(rounds: number, roundLimit: number): Flow {
  return raceFlow({
    id: "flow-limit",
    state: "relaying",
    roundLimit,
    rounds: Array.from({ length: rounds }, (_unused, i) => ({
      n: i + 1, reviewerPath: null, findingsPath: null, triggeredBy: "marker", readyNote: null,
      verdict: "REQUEST_CHANGES", findingsCount: 0, startedAt: "t", reviewedAt: "t", relayedAt: null, error: null,
    })) as never,
  });
}

test("the post-relay transition honors a concurrent Extend, not the stale clone limit (issue #118 review Finding 3)", () => {
  /* Disk was extended to 8 during the awaited delivery; the tick clone still has 5. */
  saveFlows([limitFlow(5, 8)]);
  const clone = structuredClone(loadFlows()[0]!);
  clone.roundLimit = 5;
  relayFixOrPark(clone);
  /* 5 rounds < fresh 8 → keep iterating, not parked; the clone adopts the fresh limit. */
  expect(clone.state).toBe("fixing");
  expect(clone.roundLimit).toBe(8);
});

test("the post-relay transition honors a concurrent Set-Limit lower, parking as expected (issue #118 review Finding 3)", () => {
  /* Disk was lowered to 4; the stale clone (5) would have allowed another round. */
  saveFlows([limitFlow(4, 4)]);
  const clone = structuredClone(loadFlows()[0]!);
  clone.roundLimit = 5;
  relayFixOrPark(clone);
  expect(clone.state).toBe("needs_decision");
  expect(clone.stateDetail).toBe("round limit reached");
});

test("relayFixOrPark treats a 0 limit as unlimited", () => {
  saveFlows([limitFlow(9, 0)]);
  const clone = structuredClone(loadFlows()[0]!);
  relayFixOrPark(clone);
  expect(clone.state).toBe("fixing");
});
