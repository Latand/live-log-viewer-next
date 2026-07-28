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

test("a confirmation_request carries its authorization and nothing else does", () => {
  sandbox();
  openBridgeChannel(ROOT_ID);
  const sha = "a".repeat(40);
  const { appended } = appendBridgeReports([
    report("confirm-1", {
      class: "confirmation_request",
      body: "gates green on #726",
      confirmation: { sha, nonce: "nonce-1", expiresAt: "2026-07-27T12:10:00.000Z" },
    }),
    report("plain", { class: "status", confirmation: { sha, nonce: "nope", expiresAt: "2026-07-27T12:10:00.000Z" } }),
  ]);

  expect(appended[0]!.confirmation).toEqual({ sha, nonce: "nonce-1", expiresAt: "2026-07-27T12:10:00.000Z" });
  expect(appended[1]!.confirmation).toBeUndefined();
});

test("the drain tolerates a channel that was never opened", () => {
  sandbox();
  appendBridgeReports([report("a")]);
  const batch = drainBridgeReports();
  expect(batch.reports.map((entry) => entry.seq)).toEqual([1]);
  expect(fs.existsSync(bridgeReportLogPath())).toBe(true);
});
