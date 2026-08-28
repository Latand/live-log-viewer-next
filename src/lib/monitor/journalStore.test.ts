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

const {
  MONITOR_RUN_HISTORY,
  SEAT_TICK_RUN_HISTORY,
  appendRunRecord,
  appendSeatTickRecord,
  claimMonitorRun,
  readRunRecords,
  readSeatTickRecords,
  releaseMonitorRun,
  sanitizeRunRecord,
  sanitizeSeatTickRecord,
  seatTickJournalPath,
} = await import("./journalStore");
import type { MonitorOutcome, MonitorRunRecord, SeatTickRunRecord } from "./types";

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

/**
 * The seat tick's half of the same journal (#1245). Same append, same retention
 * rewrite, same boundary — a second record type rather than a second file's
 * worth of machinery.
 */
describe("seat tick check journal", () => {
  const journal = path.join(SANDBOX, "seat-tick", "runs.ndjson");

  function check(over: Partial<SeatTickRunRecord> = {}): SeatTickRunRecord {
    return {
      schemaVersion: 1,
      at: "2026-08-28T12:00:00.000Z",
      project: "viewer",
      seatEpoch: 7,
      verdict: "quiet",
      reasons: [],
      items: 0,
      deferred: 0,
      eventsThrough: 12,
      delivery: null,
      detail: "nothing owed",
      ...over,
    };
  }

  test("the journal path lives under the viewer state dir and carries no configuration", () => {
    expect(seatTickJournalPath()).toBe(path.join(SANDBOX, "state", "seat-tick", "runs.ndjson"));
  });

  test("every check leaves exactly one line, so no line means no check", () => {
    appendSeatTickRecord(check(), journal);
    appendSeatTickRecord(check({ at: "2026-08-28T12:05:00.000Z", verdict: "wake", reasons: ["stalled"], items: 2 }), journal);
    const records = readSeatTickRecords(10, journal);
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({ verdict: "wake", reasons: ["stalled"], items: 2 });
  });

  /* The lines that exist so an absence is never a silence: a wake nobody
     received, a check that threw, a clock refused for want of authority, and a
     wake taken back from a seat that had already been replaced. */
  test("a refused send, a failed check, a refused clock and a revoked wake are all on the record", () => {
    const refusals = path.join(SANDBOX, "seat-tick-refusals.ndjson");
    appendSeatTickRecord(check({ verdict: "wake", delivery: { clientMessageId: "seat-tick:viewer:7:interval:fp", outcome: "seat-rotated" } }), refusals);
    appendSeatTickRecord(check({ verdict: "error", detail: "the check failed: the delivery layer is unavailable" }), refusals);
    appendSeatTickRecord(check({ verdict: "refused", project: "", detail: "a second seat tick start was refused" }), refusals);
    appendSeatTickRecord(check({ verdict: "refused", project: "", detail: "the seat tick sweep was refused and this process's clock stopped" }), refusals);
    appendSeatTickRecord(check({ verdict: "revoked", delivery: { clientMessageId: "seat-tick:viewer:7:interval:fp", outcome: "revoked" }, detail: "a wake the delivery layer had accepted but not landed was revoked" }), refusals);
    const records = readSeatTickRecords(10, refusals);
    expect(records.map((entry) => entry.verdict)).toEqual(["wake", "error", "refused", "refused", "revoked"]);
    expect(records[0]!.delivery).toEqual({ clientMessageId: "seat-tick:viewer:7:interval:fp", outcome: "seat-rotated" });
    expect(records[1]!.detail).toContain("the check failed");
    /* A refusal is the one kind of line about the process rather than a
       project, so it is the one kind allowed to name none. */
    expect(records[2]!.project).toBe("");
    /* The sweep a promoted successor took over: the refusal outlives the
       process that wrote it, which is the whole reason it goes here. */
    expect(records[3]!.detail).toContain("clock stopped");
    expect(records[4]!.delivery).toEqual({ clientMessageId: "seat-tick:viewer:7:interval:fp", outcome: "revoked" });
  });

  test("the sanitizer keeps only journal fields — smuggled transcript text and paths lose at the boundary", () => {
    const kept = sanitizeSeatTickRecord({ ...check(), transcript: SMUGGLED_BODY, agentPath: SMUGGLED_PATH });
    expect(kept).not.toBeNull();
    expect(JSON.stringify(kept)).not.toContain(SMUGGLED_BODY);
    expect(JSON.stringify(kept)).not.toContain(SMUGGLED_PATH);
  });

  test("an unknown verdict, a missing project or a foreign schema is not a journal line", () => {
    expect(sanitizeSeatTickRecord({ ...check(), verdict: "deploy" })).toBeNull();
    expect(sanitizeSeatTickRecord({ ...check(), project: "" })).toBeNull();
    expect(sanitizeSeatTickRecord({ ...check(), project: "", verdict: "refused" })).not.toBeNull();
    /* A revoked wake is always about one project's seat, so a nameless one is
       a line nothing can be read out of. */
    expect(sanitizeSeatTickRecord({ ...check(), project: "", verdict: "revoked" })).toBeNull();
    expect(sanitizeSeatTickRecord({ ...check(), schemaVersion: 2 })).toBeNull();
    expect(sanitizeSeatTickRecord("a line")).toBeNull();
  });

  test("an unknown reason kind is dropped rather than journaled as fact", () => {
    expect(sanitizeSeatTickRecord({ ...check(), reasons: ["stalled", "made-up", "interval"] })?.reasons).toEqual(["stalled", "interval"]);
  });

  test("a malformed line is skipped instead of hiding the checks around it", () => {
    const partial = path.join(SANDBOX, "seat-tick-partial.ndjson");
    fs.writeFileSync(partial, `${JSON.stringify(check())}\n{"broken":\n${JSON.stringify(check({ verdict: "no-seat" }))}\n`);
    expect(readSeatTickRecords(10, partial).map((entry) => entry.verdict)).toEqual(["quiet", "no-seat"]);
  });

  test("retention drops the oldest lines rather than growing without bound", () => {
    const rolling = path.join(SANDBOX, "seat-tick-rolling.ndjson");
    for (let index = 0; index < SEAT_TICK_RUN_HISTORY + 5; index += 1) {
      appendSeatTickRecord(check({ detail: `check ${index}` }), rolling);
    }
    const records = readSeatTickRecords(SEAT_TICK_RUN_HISTORY + 50, rolling);
    expect(records).toHaveLength(SEAT_TICK_RUN_HISTORY);
    expect(records[0]!.detail).toBe("check 5");
  });
});
