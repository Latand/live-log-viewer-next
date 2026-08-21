import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-telegram-reports-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

const {
  clearTelegramReports,
  ingestReportInbox,
  readReportText,
  readTelegramReports,
  reportInboxPath,
  reportTextPath,
  reportWorkspaceDir,
  saveReportText,
  updateTelegramReports,
  writeReportSources,
} = await import("./reportStore");
const { TELEGRAM_REPORT_HISTORY_LIMIT } = await import("./reportContracts");

import type { TelegramReportRow } from "./reportContracts";

function row(id: string, over: Partial<TelegramReportRow> = {}): TelegramReportRow {
  return {
    id,
    trigger: "scheduled",
    startedAt: "2026-08-21T07:00:00.000Z",
    finishedAt: "2026-08-21T07:04:00.000Z",
    windowStart: "2026-08-20T07:00:00.000Z",
    windowEnd: "2026-08-21T07:00:00.000Z",
    status: "ok",
    errorCode: null,
    conversationId: "conversation_placeholder",
    hasReport: true,
    promptVersion: "v1",
    ...over,
  };
}

beforeEach(() => {
  fs.rmSync(path.join(SANDBOX, "state"), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
});

test("settings, cursor and history survive a restart, and the file is owner-only", () => {
  updateTelegramReports((state) => {
    state.settings = { enabled: true, time: "09:30", days: "weekdays", groups: [{ id: "-1001", title: "Team room", mode: "light" }] };
    state.cursor.lastSuccessfulWindowEndAt = "2026-08-21T07:00:00.000Z";
    state.history = [row("report-fixture-0001")];
  });
  /* A fresh read is what a restarted Viewer does. */
  const reread = readTelegramReports();
  expect(reread.settings.time).toBe("09:30");
  expect(reread.settings.days).toBe("weekdays");
  expect(reread.settings.groups).toEqual([{ id: "-1001", title: "Team room", mode: "light" }]);
  expect(reread.cursor.lastSuccessfulWindowEndAt).toBe("2026-08-21T07:00:00.000Z");
  expect(reread.history.map((item) => item.id)).toEqual(["report-fixture-0001"]);

  const stat = fs.statSync(path.join(SANDBOX, "state", "telegram", "reports.json"));
  expect(stat.mode & 0o077).toBe(0);
});

test("a report body is stored owner-only and read back by id", () => {
  const id = "report-fixture-0002";
  saveReportText(id, "#daily_report\n⏳ Awaiting your reply\n[1] Contact A asked about the schedule.");
  expect(readReportText(id)).toContain("[1] Contact A asked");
  expect(fs.statSync(reportTextPath(id)).mode & 0o077).toBe(0);
  expect(readReportText("report-fixture-0003")).toBeNull();
});

test("history is capped and evicted rows take their report bodies with them", () => {
  const ids = Array.from({ length: TELEGRAM_REPORT_HISTORY_LIMIT + 3 }, (_, index) =>
    `report-fixture-cap-${String(index).padStart(3, "0")}`);
  for (const id of ids) saveReportText(id, `#daily_report\nbody ${id}`);
  updateTelegramReports((state) => {
    state.history = ids.map((id) => row(id));
  });
  const kept = readTelegramReports().history;
  expect(kept.length).toBe(TELEGRAM_REPORT_HISTORY_LIMIT);
  expect(readReportText(ids[0])).toBeTruthy();
  /* The three that fell off the end left nothing behind on disk. */
  for (const id of ids.slice(TELEGRAM_REPORT_HISTORY_LIMIT)) expect(readReportText(id)).toBeNull();
});

test("the run's inbox file is ingested once, re-stored owner-only, and unlinked", () => {
  const id = "report-fixture-0005";
  writeReportSources(id, { privateDialogs: [] });
  const inbox = reportInboxPath(id);
  /* The agent writes with its own umask; the Viewer must still accept it. */
  fs.writeFileSync(inbox, "#daily_report\nQUIET\n", { mode: 0o644 });
  const ingested = ingestReportInbox(id);
  expect(ingested).toContain("QUIET");
  expect(fs.existsSync(inbox)).toBe(false);
  expect(ingestReportInbox(id)).toBeNull();

  saveReportText(id, ingested!);
  expect(fs.statSync(reportTextPath(id)).mode & 0o077).toBe(0);
});

test("an oversized or symlinked inbox file is refused and removed", () => {
  const id = "report-fixture-0006";
  const inbox = reportInboxPath(id);
  reportWorkspaceDir();
  fs.writeFileSync(inbox, "x".repeat(512 * 1024));
  expect(ingestReportInbox(id)).toBeNull();
  expect(fs.existsSync(inbox)).toBe(false);

  const elsewhere = path.join(SANDBOX, "outside.md");
  fs.writeFileSync(elsewhere, "#daily_report\nplanted\n");
  fs.symlinkSync(elsewhere, inbox);
  expect(ingestReportInbox(id)).toBeNull();
  expect(fs.existsSync(inbox)).toBe(false);
  /* The symlink target itself is left alone; only our path was removed. */
  expect(fs.existsSync(elsewhere)).toBe(true);
});

test("logging out clears the whole report corpus", () => {
  const id = "report-fixture-0007";
  saveReportText(id, "#daily_report\nbody");
  updateTelegramReports((state) => {
    state.settings.enabled = true;
    state.history = [row(id)];
  });
  clearTelegramReports();
  const after = readTelegramReports();
  expect(after.settings.enabled).toBe(false);
  expect(after.history).toEqual([]);
  expect(readReportText(id)).toBeNull();
});
