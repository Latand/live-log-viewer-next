import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { FileEntry } from "@/lib/types";

import type { Flow } from "./types";

process.env.LLV_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "llv-flow-engine-test-"));
const { tickFlows } = await import("./engine");
const { loadFlows, saveFlows, stdoutPathFor } = await import("./store");

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
  saveFlows([flow]);

  await tickFlows([implementer]);
  const retrying = loadFlows()[0]!;
  expect(retrying.state).toBe("spawning");
  expect(retrying.stateDetail).toContain("retrying automatically");
  expect(retrying.rounds[0]).toMatchObject({ autoRetryCount: 1, accountId: null, reviewerRole: null, attemptedAccounts: ["codex:default"], error: null });

  retrying.state = "reviewing";
  retrying.rounds[0]!.reviewerPid = 999_999_999;
  retrying.rounds[0]!.spawnStartedAt = startedAt;
  saveFlows([retrying]);
  fs.writeFileSync(stdoutPathFor(flow.id, 1), "reviewer exited again\n");

  await tickFlows([implementer]);
  const parked = loadFlows()[0]!;
  expect(parked.state).toBe("needs_decision");
  expect(parked.stateDetail).toContain("reviewer verdict was unparseable");
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
