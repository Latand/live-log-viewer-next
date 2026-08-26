import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  acknowledgeBridgeReports,
  appendBridgeReports,
  bridgeChannelPath,
  bridgeReportId,
  bridgeReportLogPath,
  drainBridgeReports,
  openBridgeChannel,
  readBridgeChannel,
  readBridgeReportLog,
} from "./store";
import {
  BRIDGE_DRAIN_BATCH_MAX,
  BRIDGE_REPORT_BODY_MAX_BYTES,
  BRIDGE_REPORT_CAPACITY,
  MANAGER_RECORD_REF,
  type BridgeReportInput,
} from "./types";

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function sandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-bridge-"));
  sandboxes.push(dir);
  process.env.LLV_STATE_DIR = path.join(dir, "state");
  return dir;
}

const ROOT_ID = "root_2f6c1d9e4a7b";

function report(key: string, overrides: Partial<BridgeReportInput> = {}): BridgeReportInput {
  return {
    key,
    class: "status",
    at: "2026-07-27T12:00:00.000Z",
    body: `report ${key}`,
    project: "repo-project-a",
    targetSeatConversationId: "conversation_seat_a",
    ...overrides,
  };
}

test("the channel links the root identity to the manager record by name, never by conversation", () => {
  sandbox();
  const channel = openBridgeChannel(ROOT_ID);
  expect(channel.rootId).toBe(ROOT_ID);
  expect(channel.managerRecordRef).toBe(MANAGER_RECORD_REF);
  expect(channel.managerReportCursor).toBe(0);

  /* AC22: a manager replacement must cost nothing, which is only true while no
     durable bridge field can name the incumbent. */
  const stored = fs.readFileSync(bridgeChannelPath(), "utf8");
  expect(stored).not.toContain("conversation_");
  expect(Object.keys(JSON.parse(stored) as Record<string, unknown>).sort()).toEqual([
    "managerRecordRef",
    "managerReportCursor",
    "rootId",
    "schemaVersion",
    "updatedAt",
  ]);
});

test("opening the channel twice keeps the first root identity and the live cursor", () => {
  sandbox();
  openBridgeChannel(ROOT_ID);
  appendBridgeReports([report("a"), report("b")]);
  acknowledgeBridgeReports(2);

  const reopened = openBridgeChannel(ROOT_ID);
  expect(reopened.managerReportCursor).toBe(2);
  expect(readBridgeChannel()?.rootId).toBe(ROOT_ID);
});

/* Assembled at runtime so no credential-shaped literal is committed to a public
   repository, while the redactor still receives the real shape it must catch. */
const SECRET_SHAPED = ["sk", "abcdef0123456789"].join("-");

test("reports append with monotonic seq and a body bounded and redacted at write", () => {
  sandbox();
  openBridgeChannel(ROOT_ID);
  const { appended, skipped } = appendBridgeReports([
    report("stage-1", { class: "completed", body: `builder finished; token ${SECRET_SHAPED} in the log` }),
    report("stage-2", { class: "review_verdict", body: "x".repeat(BRIDGE_REPORT_BODY_MAX_BYTES * 2) }),
  ]);

  expect(skipped).toBe(0);
  expect(appended.map((entry) => entry.seq)).toEqual([1, 2]);
  expect(appended[0]!.class).toBe("completed");
  expect(appended[0]!.body).toContain("[redacted]");
  expect(appended[0]!.body).not.toContain(SECRET_SHAPED);
  expect(Buffer.byteLength(appended[1]!.body, "utf8")).toBeLessThanOrEqual(BRIDGE_REPORT_BODY_MAX_BYTES);
});

test("a manager retry under one key yields one seq and one log entry (§7.5)", () => {
  sandbox();
  openBridgeChannel(ROOT_ID);
  const first = appendBridgeReports([report("deploy-settled", { class: "completed" })]);
  const retry = appendBridgeReports([report("deploy-settled", { class: "completed", body: "different prose" })]);

  expect(first.appended).toHaveLength(1);
  expect(retry.appended).toHaveLength(0);
  expect(retry.skipped).toBe(1);
  const log = readBridgeReportLog();
  expect(log.reports).toHaveLength(1);
  expect(log.reports[0]!.id).toBe(bridgeReportId("deploy-settled"));
  expect(log.lastSeq).toBe(1);
});

test("a decision request keeps the caller's key verbatim; other classes keep none (#1168)", () => {
  sandbox();
  openBridgeChannel(ROOT_ID);
  const appended = appendBridgeReports([
    report("lane-4-blocked", { class: "blocked" }),
    report("stage-7-progress", { class: "status" }),
  ]);

  /* The key leaves the log again as the attention item's id, so it round-trips
     exactly for the classes that become one. */
  expect(appended.appended[0]!.key).toBe("lane-4-blocked");
  expect(readBridgeReportLog().reports[0]!.key).toBe("lane-4-blocked");
  /* A class that never enters the queue is identified by its hashed id alone,
     exactly as it was before the field existed. */
  expect(appended.appended[1]!.key).toBeUndefined();
  expect(appended.appended[1]!.id).toBe(bridgeReportId("stage-7-progress"));
});

test("a long report key is accepted for every class, exactly as it was before #1168", () => {
  sandbox();
  openBridgeChannel(ROOT_ID);

  /* #1168 needed the key kept VERBATIM, and nothing on this path reshapes one:
     it is either stored whole or (for the classes that never become an
     attention item) not stored at all. So the length policy the issue's first
     pass added bounded nothing that would otherwise have been broken, while it
     narrowed the acceptance contract of four report classes that have nothing
     to do with the attention queue. It is gone; a caller's key is a caller's
     key again. */
  const long = `lane-${"k".repeat(400)}`;
  const appended = appendBridgeReports([
    report(long, { class: "status" }),
    report(`${long}-done`, { class: "completed" }),
    report(`${long}-failed`, { class: "failed" }),
    report(`${long}-verdict`, { class: "review_verdict" }),
    report(`${long}-blocked`, { class: "blocked" }),
    report(`${long}-question`, { class: "question" }),
  ]);
  expect(appended.appended).toHaveLength(6);
  expect(readBridgeReportLog().lastSeq).toBe(6);

  /* And the decision requests still carry theirs back out whole — the property
     the queue's identity actually depends on. */
  expect(readBridgeReportLog().reports.map((entry) => entry.key)).toEqual([
    undefined,
    undefined,
    undefined,
    undefined,
    `${long}-blocked`,
    `${long}-question`,
  ]);
});

test("the drain returns one bounded batch oldest first and reports what is left", () => {
  sandbox();
  openBridgeChannel(ROOT_ID);
  appendBridgeReports(Array.from({ length: 8 }, (_, index) => report(`r${index}`)));

  const batch = drainBridgeReports();
  expect(batch.reports).toHaveLength(BRIDGE_DRAIN_BATCH_MAX);
  expect(batch.reports.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5]);
  expect(batch.throughSeq).toBe(5);
  expect(batch.remaining).toBe(3);
  expect(batch.gap).toBeNull();
});

test("the cursor is durable, so a quiet night arrives once and never replays (§7.4)", () => {
  sandbox();
  openBridgeChannel(ROOT_ID);
  appendBridgeReports([report("a"), report("b")]);

  acknowledgeBridgeReports(drainBridgeReports().throughSeq);
  expect(drainBridgeReports().reports).toEqual([]);

  appendBridgeReports([report("c")]);
  const afterGap = drainBridgeReports();
  expect(afterGap.reports.map((entry) => entry.seq)).toEqual([3]);
});

test("acknowledging never moves the cursor backwards", () => {
  sandbox();
  openBridgeChannel(ROOT_ID);
  appendBridgeReports([report("a"), report("b"), report("c")]);
  acknowledgeBridgeReports(3);
  acknowledgeBridgeReports(1);
  expect(readBridgeChannel()?.managerReportCursor).toBe(3);
});

test("a cursor the trim outran resumes at the head behind one explicit gap notice (§7.12)", () => {
  sandbox();
  openBridgeChannel(ROOT_ID);
  appendBridgeReports(Array.from({ length: BRIDGE_REPORT_CAPACITY + 20 }, (_, index) => report(`r${index}`)));

  const log = readBridgeReportLog();
  expect(log.reports).toHaveLength(BRIDGE_REPORT_CAPACITY);
  expect(log.trimmedThroughSeq).toBe(20);

  /* The gateway never acknowledged anything, so its cursor sits at 0 — below
     everything the log still holds. */
  const batch = drainBridgeReports();
  expect(batch.gap).toEqual({ resumedAtSeq: 21, missedThroughSeq: 20 });
  expect(batch.reports[0]!.synthetic).toBe(true);
  expect(batch.reports[0]!.class).toBe("status");
  expect(batch.reports[0]!.body).toContain("20");
  expect(batch.reports.slice(1).map((entry) => entry.seq)).toEqual([21, 22, 23, 24]);
  expect(batch.reports).toHaveLength(BRIDGE_DRAIN_BATCH_MAX);
});

test("a trimmed report cannot be resurrected by a late replay", () => {
  sandbox();
  openBridgeChannel(ROOT_ID);
  appendBridgeReports(Array.from({ length: BRIDGE_REPORT_CAPACITY + 5 }, (_, index) => report(`r${index}`)));

  const replay = appendBridgeReports([report("r0")]);
  expect(replay.appended).toHaveLength(0);
  expect(replay.skipped).toBe(1);
});

test("a legacy confirmation_request row still reads, sheds its authorization payload, and never drains", () => {
  /* Logs written before #795's superseding contract carry the retired operator
     confirmation rows. The log must keep reading (history survives), the dead
     nonce must not, and no legacy row may resurface as a conversation. */
  sandbox();
  openBridgeChannel(ROOT_ID);
  fs.mkdirSync(path.dirname(bridgeReportLogPath()), { recursive: true });
  fs.writeFileSync(bridgeReportLogPath(), JSON.stringify({
    schemaVersion: 1,
    lastSeq: 1,
    trimmedThroughSeq: 0,
    reports: [{
      id: "rpt_legacy_confirm",
      seq: 1,
      at: "2026-07-27T12:00:00.000Z",
      class: "confirmation_request",
      project: "repo-project-a",
      targetSeatConversationId: "conversation_seat_a",
      body: "gates green on #726",
      confirmation: { sha: "a".repeat(40), nonce: "nonce-legacy", expiresAt: "2026-07-27T12:10:00.000Z" },
      directIntent: true,
    }],
    retired: [],
  }));

  const log = readBridgeReportLog();
  expect(log.reports).toHaveLength(1);
  expect(log.reports[0]!.class).toBe("confirmation_request");
  expect(log.reports[0] as unknown as Record<string, unknown>).not.toHaveProperty("confirmation");
  expect(drainBridgeReports().reports).toEqual([]);

  /* Appends after the legacy row keep working, and only the new row drains. */
  appendBridgeReports([report("after-legacy")]);
  expect(drainBridgeReports().reports.map((entry) => entry.id)).toEqual([bridgeReportId("after-legacy")]);
  expect(fs.readFileSync(bridgeReportLogPath(), "utf8")).not.toContain("nonce-legacy");
});

test("the drain tolerates a channel that was never opened", () => {
  sandbox();
  appendBridgeReports([report("a")]);
  const batch = drainBridgeReports();
  expect(batch.reports.map((entry) => entry.seq)).toEqual([1]);
  expect(fs.existsSync(bridgeReportLogPath())).toBe(true);
});
