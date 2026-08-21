import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-telegram-reports-route-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");

const { GET, POST } = await import("./route");
const { TelegramReportRunner, setTelegramReportRunnerForTests } = await import("@/lib/telegram/reportRunner");
const { readTelegramReports, saveReportText, updateTelegramReports } = await import("@/lib/telegram/reportStore");

import type { ReportRunnerPorts } from "@/lib/telegram/reportRunner";
import type { TelegramReportsPayload } from "@/lib/telegram/reportContracts";
import type { StoredTelegramConnection } from "@/lib/telegram/sessionStore";

const NOW = Date.parse("2026-08-21T12:00:00.000Z"); // 15:00 Kyiv — after a 10:00 slot
const CONNECTED: StoredTelegramConnection = {
  version: 1,
  status: "connected",
  credentialRef: "credential-ref-placeholder",
  identity: { name: "Account A", username: "account_a" },
  lastHealthCheckAt: "2026-08-21T11:59:00.000Z",
  errorCode: null,
};

const ports: ReportRunnerPorts = {
  now: () => NOW,
  connection: () => CONNECTED,
  readPort: () => ({
    async listChats() { return [{ id: "101", kind: "user" as const, title: "Dialog A", username: null, unread: 0 }]; },
    async lastMessageAt() { return "2026-08-21T09:00:00.000Z"; },
  }),
  spawn: async () => ({ status: 202, body: { conversationId: "conversation_report", launchId: "launch_report", ok: true } }),
  conversationLive: async () => true,
  log: () => {},
};

function get(url = "http://127.0.0.1/api/telegram/reports"): NextRequest {
  return new NextRequest(url, { headers: { host: "127.0.0.1" } });
}

function post(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1/api/telegram/reports", {
    method: "POST",
    headers: { host: "127.0.0.1", origin: "http://127.0.0.1", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  fs.rmSync(path.join(SANDBOX, "state"), { recursive: true, force: true });
  setTelegramReportRunnerForTests(new TelegramReportRunner(ports));
});

afterAll(() => {
  setTelegramReportRunnerForTests(null);
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = OLD_STATE;
});

test("GET serves settings, history and the next run, and never a report body", async () => {
  saveReportText("report-fixture-0008", "#daily_report\nsensitive body");
  updateTelegramReports((state) => {
    state.settings.enabled = true;
    state.cursor.lastScheduledDay = "2026-08-21";
    state.history = [{
      id: "report-fixture-0008",
      trigger: "scheduled",
      startedAt: "2026-08-21T07:00:00.000Z",
      finishedAt: "2026-08-21T07:03:00.000Z",
      windowStart: "2026-08-20T07:00:00.000Z",
      windowEnd: "2026-08-21T07:00:00.000Z",
      status: "ok",
      errorCode: null,
      conversationId: "conversation_report",
      hasReport: true,
      promptVersion: "v1",
    }];
  });
  const response = await GET(get());
  expect(response.status).toBe(200);
  const raw = await response.text();
  expect(raw).not.toContain("sensitive body");
  const { reports } = JSON.parse(raw) as { reports: TelegramReportsPayload };
  expect(reports.settings.enabled).toBe(true);
  expect(reports.history[0].hasReport).toBe(true);
  expect(reports.nextRunAt).toBe("2026-08-22T07:00:00.000Z");
});

test("a report body is served only by explicit id, and an unknown id is a clean 404", async () => {
  const id = "report-fixture-0009";
  saveReportText(id, "#daily_report\n[1] Contact A asked about the schedule.");
  const found = await GET(get(`http://127.0.0.1/api/telegram/reports?report=${id}`));
  expect(found.status).toBe(200);
  expect((await found.json() as { report: string }).report).toContain("[1] Contact A");

  const missing = await GET(get("http://127.0.0.1/api/telegram/reports?report=report-fixture-0000"));
  expect(missing.status).toBe(404);
  const rejected = await GET(get("http://127.0.0.1/api/telegram/reports?report=../../session"));
  expect(rejected.status).toBe(400);
});

test("saving settings validates the time and never fires a run for a slot already past", async () => {
  const invalid = await POST(post({ action: "settings", settings: { enabled: true, time: "25:00", days: "daily", groups: [] } }));
  expect(invalid.status).toBe(400);

  const saved = await POST(post({
    action: "settings",
    settings: { enabled: true, time: "10:00", days: "weekdays", groups: [{ id: "-1001", title: "Team room", mode: "light" }] },
  }));
  expect(saved.status).toBe(200);
  const state = readTelegramReports();
  expect(state.settings).toEqual({ enabled: true, time: "10:00", days: "weekdays", groups: [{ id: "-1001", title: "Team room", mode: "light" }] });
  /* Enabling at 15:00 with a 10:00 slot stamps the day: the first scheduled
     report is tomorrow's, not one fired on the spot. */
  expect(state.cursor.lastScheduledDay).toBe("2026-08-21");
  expect(readTelegramReports().active).toBeNull();
});

test("a group id that is not a chat id is refused", async () => {
  const response = await POST(post({
    action: "settings",
    settings: { enabled: true, time: "10:00", days: "daily", groups: [{ id: "../escape", title: "x", mode: "full" }] },
  }));
  expect(response.status).toBe(400);
});

test("Run now launches a visible run and reports the conversation it opened", async () => {
  await POST(post({ action: "settings", settings: { enabled: true, time: "10:00", days: "daily", groups: [] } }));
  const response = await POST(post({ action: "run-now" }));
  expect(response.status).toBe(202);
  const body = await response.json() as { runId: string; reports: TelegramReportsPayload };
  expect(body.runId.length).toBeGreaterThan(8);
  /* The run is visible immediately; the source pass runs behind the response
     rather than holding the request open for tens of seconds. */
  expect(body.reports.history[0].status).toBe("running");

  /* A second Run now while one is live is refused with a truthful code. */
  const second = await POST(post({ action: "run-now" }));
  expect(second.status).toBe(409);
  expect((await second.json() as { code: string }).code).toBe("run_in_progress");
});

test("a cross-origin action is refused, and an unknown action is a 400", async () => {
  const foreign = new NextRequest("http://127.0.0.1/api/telegram/reports", {
    method: "POST",
    headers: { host: "127.0.0.1", origin: "https://elsewhere.example", "content-type": "application/json" },
    body: JSON.stringify({ action: "run-now" }),
  });
  expect((await POST(foreign)).status).toBe(403);
  expect((await POST(post({ action: "nope" }))).status).toBe(400);
});
