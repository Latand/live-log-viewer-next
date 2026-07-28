import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-monitor-journal-"));
const RESTORE = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
process.env.TMPDIR = path.join(SANDBOX, "tmp");
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

const { MONITOR_RUN_HISTORY, appendRunRecord, claimMonitorRun, readRunRecords, releaseMonitorRun, sanitizeRunRecord } = await import("./journalStore");
import type { MonitorOutcome, MonitorRunRecord } from "./types";

/* Stand-ins for the two things that must never reach the journal, assembled at
   runtime so this file carries neither a transcript-shaped sentence nor a
   home path of its own. */
const SMUGGLED_BODY = "SMUGGLED-TRANSCRIPT-SENTINEL";
const SMUGGLED_PATH = ["", "home", "someone", "Projects", "viewer"].join("/");

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const journal = path.join(SANDBOX, "journal", "runs.ndjson");

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

describe("record sanitation at the boundary", () => {
  test("keeps only audit fields, dropping anything smuggled alongside them", () => {
    const sanitized = sanitizeRunRecord({
      ...record("run-x", "clean"),
      operatorBody: SMUGGLED_BODY,
      cwd: SMUGGLED_PATH,
    } as unknown);
    expect(sanitized).not.toBeNull();
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain(SMUGGLED_BODY);
    expect(serialized).not.toContain(SMUGGLED_PATH);
  });

  test("bounds a long detail and a flood of fingerprints", () => {
    const sanitized = sanitizeRunRecord({
      ...record("run-y", "failed", "x".repeat(5000)),
      found: { total: 2000, byState: {}, fingerprints: Array.from({ length: 2000 }, (_, index) => `f${index}`) },
    } as unknown)!;
    expect(sanitized.detail!.length).toBeLessThanOrEqual(800);
    expect(sanitized.found.fingerprints.length).toBeLessThanOrEqual(500);
  });

  test("refuses anything that is not a run record", () => {
    expect(sanitizeRunRecord(null)).toBeNull();
    expect(sanitizeRunRecord({ runId: "x" })).toBeNull();
    expect(sanitizeRunRecord({ ...record("run-z", "clean"), schemaVersion: 2 })).toBeNull();
    expect(sanitizeRunRecord({ ...record("run-z", "clean"), outcome: "invented" })).toBeNull();
  });
});

describe("single-flight claim", () => {
  test("a second overlapping run loses, and the winner's token frees it", () => {
    const lock = path.join(SANDBOX, "lock-a", "run.lock");
    const first = claimMonitorRun({ lockPath: lock, pidAlive: () => true });
    expect(first.claimed).toBe(true);
    const second = claimMonitorRun({ lockPath: lock, pidAlive: () => true });
    expect(second.claimed).toBe(false);
    if (!second.claimed) expect(second.detail).toContain("lock");

    /* Only the holder may release: a superseded run must not free the lock its
       successor is holding. */
    expect(releaseMonitorRun("some-other-token", { lockPath: lock })).toBe(false);
    expect(first.claimed && releaseMonitorRun(first.token, { lockPath: lock })).toBe(true);
    const third = claimMonitorRun({ lockPath: lock, pidAlive: () => true });
    expect(third.claimed).toBe(true);
  });

  test("a lock left behind by a dead run is reclaimed", () => {
    const lock = path.join(SANDBOX, "lock-b", "run.lock");
    expect(claimMonitorRun({ lockPath: lock, pidAlive: () => true }).claimed).toBe(true);
    expect(claimMonitorRun({ lockPath: lock, pidAlive: () => false }).claimed).toBe(true);
  });

  test("a lock older than the stale window is reclaimed", () => {
    const lock = path.join(SANDBOX, "lock-c", "run.lock");
    expect(claimMonitorRun({ lockPath: lock, pidAlive: () => true, now: () => 1_000 }).claimed).toBe(true);
    expect(claimMonitorRun({ lockPath: lock, pidAlive: () => true, now: () => 1_000 + 40 * 60 * 1000 }).claimed).toBe(true);
  });

  test("exactly one of four racing PROCESSES wins the lock", async () => {
    /* In-process claims prove nothing about atomicity: a read-then-write race
       needs two schedulers. Four children start at one shared instant. */
    const lock = path.join(SANDBOX, "lock-race", "run.lock");
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    const child = path.join(import.meta.dir, "lockClaimChild.ts");
    const startAt = Date.now() + 1_200;
    const results = await Promise.all(Array.from({ length: 4 }, async () => {
      const proc = Bun.spawn(["bun", child, lock, String(startAt)], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as { claimed?: boolean };
    }));
    expect(results.filter((result) => result.claimed === true)).toHaveLength(1);
  }, 30_000);
});
