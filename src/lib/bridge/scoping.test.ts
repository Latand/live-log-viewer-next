import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  acknowledgeBridgeReports,
  appendBridgeReports,
  bridgeChannelPath,
  bridgeReportLogPath,
  drainBridgeReports,
  openBridgeChannel,
  readBridgeChannel,
  readBridgeReportLog,
} from "./store";
import {
  BRIDGE_REPORT_CAPACITY,
  type BridgeChannelScope,
  type BridgeReportInput,
} from "./types";

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function sandbox(): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "llv-bridge-scope-"));
  sandboxes.push(directory);
  process.env.LLV_STATE_DIR = path.join(directory, "state");
}

const NOW = new Date("2026-07-30T12:00:00.000Z");
const PROJECT_A: BridgeChannelScope = {
  project: "repo-project-a",
  seatConversationId: "conversation_seat_a",
};
const PROJECT_B: BridgeChannelScope = {
  project: "repo-project-b",
  seatConversationId: "conversation_seat_b",
};
const PROJECT_A_OTHER_SEAT: BridgeChannelScope = {
  project: PROJECT_A.project,
  seatConversationId: "conversation_seat_a_other",
};

function report(
  key: string,
  scope: BridgeChannelScope,
  overrides: Partial<BridgeReportInput> = {},
): BridgeReportInput {
  return {
    key,
    class: "status",
    at: NOW.toISOString(),
    body: `report ${key}`,
    project: scope.project,
    targetSeatConversationId: scope.seatConversationId,
    ...overrides,
  };
}

test("project B cannot receive or consume project A's report", () => {
  sandbox();
  appendBridgeReports([report("project-a-status", PROJECT_A)]);
  openBridgeChannel("root_b", NOW, PROJECT_B);

  expect(drainBridgeReports({ now: NOW, scope: PROJECT_B }).reports).toEqual([]);

  openBridgeChannel("root_a", NOW, PROJECT_A);
  expect(drainBridgeReports({ now: NOW, scope: PROJECT_A }).reports.map((entry) => entry.body))
    .toEqual(["report project-a-status"]);
});

test("interleaved project channels keep independent cursors", () => {
  sandbox();
  appendBridgeReports([
    report("a-1", PROJECT_A),
    report("b-1", PROJECT_B),
    report("a-2", PROJECT_A),
    report("b-2", PROJECT_B),
  ]);
  openBridgeChannel("root_a", NOW, PROJECT_A);
  openBridgeChannel("root_b", NOW, PROJECT_B);

  const firstA = drainBridgeReports({ now: NOW, limit: 1, scope: PROJECT_A });
  expect(firstA.reports.map((entry) => entry.body)).toEqual(["report a-1"]);
  acknowledgeBridgeReports(firstA.throughSeq, NOW, PROJECT_A);

  const firstB = drainBridgeReports({ now: NOW, limit: 1, scope: PROJECT_B });
  expect(firstB.reports.map((entry) => entry.body)).toEqual(["report b-1"]);
  acknowledgeBridgeReports(firstB.throughSeq, NOW, PROJECT_B);

  expect(drainBridgeReports({ now: NOW, scope: PROJECT_A }).reports.map((entry) => entry.body))
    .toEqual(["report a-2"]);
  expect(drainBridgeReports({ now: NOW, scope: PROJECT_B }).reports.map((entry) => entry.body))
    .toEqual(["report b-2"]);
  expect(readBridgeChannel(PROJECT_A)?.managerReportCursor).toBe(1);
  expect(readBridgeChannel(PROJECT_B)?.managerReportCursor).toBe(2);
});

test("a second root identity cannot reset a project seat's cursor", () => {
  sandbox();
  appendBridgeReports([report("a-1", PROJECT_A)]);
  openBridgeChannel("root_a_first", NOW, PROJECT_A);
  acknowledgeBridgeReports(
    drainBridgeReports({ now: NOW, scope: PROJECT_A }).throughSeq,
    NOW,
    PROJECT_A,
  );

  const reopened = openBridgeChannel("root_a_second", NOW, PROJECT_A);
  expect(reopened.managerReportCursor).toBe(1);
  expect(drainBridgeReports({ now: NOW, scope: PROJECT_A }).reports).toEqual([]);

  appendBridgeReports([report("a-2", PROJECT_A)]);
  expect(drainBridgeReports({ now: NOW, scope: PROJECT_A }).reports.map((entry) => entry.body))
    .toEqual(["report a-2"]);
});

test("an unroutable report is surfaced without being delivered", () => {
  sandbox();
  appendBridgeReports([
    report("waiting-for-seat", PROJECT_A, { targetSeatConversationId: null }),
  ]);
  openBridgeChannel("root_a", NOW, PROJECT_A);

  const batch = drainBridgeReports({ now: NOW, scope: PROJECT_A });
  expect(batch.reports).toEqual([]);
  expect(batch.unrouted).toEqual({ count: 1, legacy: 0, forProject: 1 });
});

test("pre-change channel and report records load with projectless rows quarantined", () => {
  sandbox();
  fs.mkdirSync(path.dirname(bridgeChannelPath()), { recursive: true });
  fs.writeFileSync(bridgeChannelPath(), JSON.stringify({
    schemaVersion: 1,
    rootId: "root_legacy",
    managerRecordRef: "orchestrator",
    managerReportCursor: 7,
    updatedAt: NOW.toISOString(),
  }));
  fs.writeFileSync(bridgeReportLogPath(), JSON.stringify({
    schemaVersion: 1,
    lastSeq: 8,
    trimmedThroughSeq: 0,
    reports: [{
      seq: 8,
      id: "rpt_legacy",
      at: NOW.toISOString(),
      class: "status",
      body: "legacy report body",
    }],
    retired: [],
  }));

  expect(readBridgeChannel()?.managerReportCursor).toBe(7);
  openBridgeChannel("root_a", NOW, PROJECT_A);
  const scoped = drainBridgeReports({ now: NOW, scope: PROJECT_A });
  expect(scoped.reports).toEqual([]);
  expect(scoped.unrouted).toEqual({ count: 1, legacy: 1, forProject: 0 });
  expect(readBridgeChannel()?.managerReportCursor).toBe(7);

  appendBridgeReports(Array.from(
    { length: BRIDGE_REPORT_CAPACITY + 5 },
    (_, index) => report(`new-${index}`, PROJECT_A),
  ));
  expect(readBridgeReportLog().reports.some((entry) => entry.id === "rpt_legacy")).toBe(true);
});

test("a report is deliverable only to the seat that wrote it", () => {
  sandbox();
  appendBridgeReports([report("blocked-a", PROJECT_A, { class: "blocked" })]);
  openBridgeChannel("root_other", NOW, PROJECT_A_OTHER_SEAT);
  expect(drainBridgeReports({ now: NOW, scope: PROJECT_A_OTHER_SEAT }).reports).toEqual([]);

  openBridgeChannel("root_a", NOW, PROJECT_A);
  expect(drainBridgeReports({ now: NOW, scope: PROJECT_A }).reports.map((entry) => entry.class))
    .toEqual(["blocked"]);
});
