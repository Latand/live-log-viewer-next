import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-monitor-audit-"));
const RESTORE = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
process.env.TMPDIR = path.join(SANDBOX, "tmp");
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

const { MONITOR_RUN_HISTORY, appendRunRecord, claimMonitorRun, readRunRecords } = await import("./audit");
import type { MonitorOutcome, MonitorRunRecord } from "./types";

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const journal = path.join(SANDBOX, "journal", "runs.ndjson");
const lock = path.join(SANDBOX, "journal", "run.lock");

function record(runId: string, outcome: MonitorOutcome, detail: string | null = null): MonitorRunRecord {
  return {
    schemaVersion: 1,
    runId,
    startedAt: "2026-07-27T10:00:00.000Z",
    finishedAt: "2026-07-27T10:00:03.000Z",
    outcome,
    detail,
    window: { from: "2026-07-27T04:00:00.000Z", to: "2026-07-27T10:00:00.000Z", hours: 6 },
    scope: { project: "viewer" },
    orchestrator: { resolution: "resolved", conversationId: "conversation_abc", delivered: true },
    scanned: { conversations: 3, operatorMessages: 11 },
    found: { total: 1, byState: { completed: 0, "in-flight": 0, stalled: 0, untracked: 1, "awaiting-confirmation": 0 }, fingerprints: ["abc123"] },
    created: [{ fingerprint: "abc123", taskId: "task-1", state: "untracked" }],
    skipped: [],
  };
}

describe("monitor audit journal", () => {
  test("a clean run, a failed run and a skipped run stay distinguishable", () => {
    appendRunRecord(record("run-1", "clean"), journal);
    appendRunRecord(record("run-2", "failed", "no live orchestrator could be resolved"), journal);
    appendRunRecord(record("run-3", "skipped", "another run holds the lock"), journal);
    const runs = readRunRecords(10, journal);
    expect(runs.map((entry) => entry.outcome)).toEqual(["clean", "failed", "skipped"]);
    expect(runs[1]!.detail).toContain("orchestrator");
  });

  test("a run that found nothing is still a recorded run", () => {
    const empty = { ...record("run-empty", "clean"), found: { total: 0, byState: { completed: 0, "in-flight": 0, stalled: 0, untracked: 0, "awaiting-confirmation": 0 }, fingerprints: [] }, created: [] };
    appendRunRecord(empty, journal);
    const latest = readRunRecords(1, journal)[0]!;
    expect(latest.runId).toBe("run-empty");
    expect(latest.outcome).toBe("clean");
    expect(latest.found.total).toBe(0);
  });

  test("carries no transcript text, no absolute path and no token", () => {
    const raw = fs.readFileSync(journal, "utf8");
    expect(raw).not.toContain(SANDBOX);
    expect(raw).not.toMatch(/\/(?:home|Users)\//);
    expect(raw).not.toContain("deploy script");
  });

  test("a malformed line never hides the runs around it", () => {
    fs.appendFileSync(journal, "{not json\n", "utf8");
    appendRunRecord(record("run-after", "clean"), journal);
    const runs = readRunRecords(2, journal);
    expect(runs.map((entry) => entry.runId)).toEqual(["run-empty", "run-after"]);
  });

  test("keeps the journal bounded", () => {
    const many = path.join(SANDBOX, "bounded", "runs.ndjson");
    for (let index = 0; index < MONITOR_RUN_HISTORY + 20; index += 1) appendRunRecord(record(`run-${index}`, "clean"), many);
    const lines = fs.readFileSync(many, "utf8").trim().split("\n");
    expect(lines.length).toBeLessThanOrEqual(MONITOR_RUN_HISTORY);
    expect(readRunRecords(1, many)[0]!.runId).toBe(`run-${MONITOR_RUN_HISTORY + 19}`);
  });
});

describe("single-flight claim", () => {
  test("a second overlapping run is skipped, not run twice", () => {
    const first = claimMonitorRun({ lockPath: lock, pidAlive: () => true });
    expect(first.claimed).toBe(true);
    const second = claimMonitorRun({ lockPath: lock, pidAlive: () => true });
    expect(second.claimed).toBe(false);
    if (!second.claimed) expect(second.detail).toContain("lock");
    if (first.claimed) first.release();
    const third = claimMonitorRun({ lockPath: lock, pidAlive: () => true });
    expect(third.claimed).toBe(true);
    if (third.claimed) third.release();
  });

  test("a lock left behind by a dead run is reclaimed", () => {
    const abandoned = claimMonitorRun({ lockPath: lock, pidAlive: () => true });
    expect(abandoned.claimed).toBe(true);
    const next = claimMonitorRun({ lockPath: lock, pidAlive: () => false });
    expect(next.claimed).toBe(true);
    if (next.claimed) next.release();
  });
});
