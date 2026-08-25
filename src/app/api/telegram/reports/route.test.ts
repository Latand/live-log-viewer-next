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
const { DEFAULT_DAILY_REPORT_PROMPT } = await import("@/lib/telegram/reportPrompt");
const { localDayKey } = await import("@/lib/telegram/reportSchedule");

import type { ReportRunnerPorts } from "@/lib/telegram/reportRunner";
import type { TelegramReportsPayload } from "@/lib/telegram/reportContracts";
import type { StoredTelegramConnection } from "@/lib/telegram/sessionStore";

const NOW = Date.parse("2026-08-21T12:00:00.000Z"); // 15:00 Kyiv — after a 10:00 slot
const CONNECTED: StoredTelegramConnection = {
  version: 1,
  status: "connected",
  credentialRef: "credential-ref-placeholder",
  identity: { name: "Account A", username: "account_a", id: "770000001" },
  lastHealthCheckAt: "2026-08-21T11:59:00.000Z",
  errorCode: null,
  identityIdUpgradedAt: null,
};

const ports: ReportRunnerPorts = {
  now: () => NOW,
  connection: () => CONNECTED,
  beginReadPhase: async () => () => {},
  readPort: () => ({
    async getMe() { return CONNECTED.identity; },
    async feedDialogs() { return { dialogs: [], coveredSinceMs: Date.parse("2026-08-18T00:00:00.000Z") }; },
    async listChats() { return [{ id: "101", kind: "user" as const, title: "Dialog A", username: null, unread: 0 }]; },
    async pageChats() { return []; },
    async lastMessageAt() { return "2026-08-21T09:00:00.000Z"; },
  }),
  migrateIdentity: async () => {},
  spawn: async () => ({ status: 202, body: { conversationId: "conversation_report", launchId: "launch_report", ok: true } }),
  reportRunConversation: async () => null,
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
  const invalid = await POST(post({ action: "settings", settings: { enabled: true, time: "25:00", groups: [] } }));
  expect(invalid.status).toBe(400);

  /* A midnight slot has passed at every hour of every day, so this asserts the
     rule rather than the clock the suite happens to run on: the route stamps
     the day from `Date.now()` (a request has no fake clock to inject), and an
     expectation pinned to one date was a test that could only pass on the day
     it was written. */
  const saved = await POST(post({
    action: "settings",
    settings: { enabled: true, time: "00:00", groups: [{ id: "-1001", title: "Team room", mode: "light" }] },
  }));
  expect(saved.status).toBe(200);
  const state = readTelegramReports();
  expect(state.settings).toEqual({ enabled: true, time: "00:00", groups: [{ id: "-1001", title: "Team room", mode: "light" }] });
  /* Enabling after today's slot has passed stamps the day: the first scheduled
     report is tomorrow's, not one fired on the spot. */
  expect(state.cursor.lastScheduledDay).toBe(localDayKey(Date.now()));
  expect(readTelegramReports().active).toBeNull();
});

test("a group id that is not a chat id is refused", async () => {
  const response = await POST(post({
    action: "settings",
    settings: { enabled: true, time: "10:00", groups: [{ id: "../escape", title: "x", mode: "full" }] },
  }));
  expect(response.status).toBe(400);
});

test("Run now launches a visible run and reports the conversation it opened", async () => {
  await POST(post({ action: "settings", settings: { enabled: true, time: "10:00", groups: [] } }));
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

test("the analyst prompt is served by its own request and never in the polled payload", async () => {
  const edited = "Report in Ukrainian. First line: #report_tag. Mention what Group A decided.";
  updateTelegramReports((state) => { state.prompt = edited; });

  const list = await GET(get());
  const raw = await list.text();
  /* The panel polls this every twenty seconds; the brief may name private
     chats, so it is not in it — only whether it is still the default. */
  expect(raw).not.toContain("#report_tag");
  expect((JSON.parse(raw) as { reports: TelegramReportsPayload }).reports.settings.promptIsDefault).toBe(false);

  const fetched = await GET(get("http://127.0.0.1/api/telegram/reports?prompt=1"));
  const body = await fetched.json() as { prompt: string; defaultPrompt: string };
  expect(body.prompt).toBe(edited);
  expect(body.defaultPrompt).toBe(DEFAULT_DAILY_REPORT_PROMPT);
});

test("an ordinary settings save leaves the stored prompt alone; sending one replaces it", async () => {
  updateTelegramReports((state) => { state.prompt = "Report in Ukrainian."; });
  const settings = { enabled: true, time: "09:00", groups: [] };
  await POST(post({ action: "settings", settings }));
  expect(readTelegramReports().prompt).toBe("Report in Ukrainian.");

  await POST(post({ action: "settings", settings, prompt: "Report in English, tag #report_tag." }));
  expect(readTelegramReports().prompt).toBe("Report in English, tag #report_tag.");

  /* Saving the default back is the reset. */
  await POST(post({ action: "settings", settings, prompt: DEFAULT_DAILY_REPORT_PROMPT }));
  expect(readTelegramReports().prompt).toBeNull();

  const rejected = await POST(post({ action: "settings", settings, prompt: 42 }));
  expect(rejected.status).toBe(400);
});
