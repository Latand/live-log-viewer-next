import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { TelegramReportsState } from "@/hooks/useTelegramReports";
import type { TelegramReportRow, TelegramReportsPayload } from "@/lib/telegram/reportContracts";

import { TelegramReportsSection } from "./TelegramReports";

function row(over: Partial<TelegramReportRow> = {}): TelegramReportRow {
  return {
    id: "report-fixture-0001",
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

function stateFor(reports: Partial<TelegramReportsPayload> | null, over: Partial<TelegramReportsState> = {}): TelegramReportsState {
  return {
    reports: reports === null ? null : {
      settings: { enabled: false, time: "10:00", days: "daily", groups: [], promptIsDefault: true },
      history: [],
      nextRunAt: null,
      ...reports,
    },
    busy: false,
    failure: null,
    openReport: null,
    groups: null,
    ["prompt"]: null,
    refresh: async () => {},
    saveSettings: async () => {},
    runNow: async () => {},
    openReportById: async () => {},
    closeReport: () => {},
    loadGroups: async () => {},
    loadPrompt: async () => {},
    savePrompt: async () => {},
    closePrompt: () => {},
    ...over,
  };
}

const render = (state: TelegramReportsState) => renderToStaticMarkup(<TelegramReportsSection state={state} />);

test("disabled explains the feature and offers a single Enable", () => {
  const html = render(stateFor({}));
  expect(html).toContain("Daily report");
  expect(html).toContain("Enable daily report");
  expect(html).toContain("reads your private dialogs and the groups you pick");
  expect(html).not.toContain("Run now");
});

test("enabled shows the schedule, the sources summary, Run now and the next run", () => {
  const html = render(stateFor({
    settings: { enabled: true, time: "10:00", days: "daily", groups: [{ id: "-1001", title: "Team room", mode: "light" }], promptIsDefault: true },
    nextRunAt: "2026-08-22T07:00:00.000Z",
  }));
  expect(html).toContain('value="10:00"');
  expect(html).toContain("Daily");
  expect(html).toContain("Weekdays");
  expect(html).toContain("Kyiv time");
  expect(html).toContain("active private dialogs + 1 group");
  expect(html).toContain("Run now");
  expect(html).toContain("Turn off");
  expect(html).toContain("No runs yet.");
});

test("history rows carry date, window and status, and only a stored report offers Open", () => {
  const html = render(stateFor({
    settings: { enabled: true, time: "10:00", days: "daily", groups: [], promptIsDefault: true },
    history: [row(), row({ id: "2", status: "quiet", hasReport: false })],
  }));
  expect(html).toContain("24 h");
  expect(html).toContain("report");
  expect(html).toContain("quiet");
  expect(html.match(/>Open</g)?.length).toBe(1);
});

test("a failed row states what went wrong in a sentence, never silence", () => {
  const html = render(stateFor({
    settings: { enabled: true, time: "10:00", days: "daily", groups: [], promptIsDefault: true },
    history: [row({ status: "failed", errorCode: "run_ended_without_report", hasReport: false })],
  }));
  expect(html).toContain("failed");
  expect(html).toContain("The run ended before it wrote a report. Run it again.");
  expect(html).not.toContain(">Open<");
});

test("a wrong-account row says the account did not match and nothing was read", () => {
  const html = render(stateFor({
    settings: { enabled: true, time: "10:00", days: "daily", groups: [], promptIsDefault: true },
    history: [row({ status: "account-mismatch", errorCode: null, hasReport: false })],
  }));
  expect(html).toContain("wrong account");
  expect(html).toContain("Nothing was read.");
});

test("a running row shows the run in progress and blocks a second Run now", () => {
  const html = render(stateFor({
    settings: { enabled: true, time: "10:00", days: "daily", groups: [], promptIsDefault: true },
    history: [row({ status: "running", finishedAt: null, hasReport: false })],
  }));
  expect(html).toContain("running");
  expect(html).toContain("Running…");
  expect(html).toContain("disabled");
});

test("an open report renders its text with a way back to the list", () => {
  const html = render(stateFor(
    { settings: { enabled: true, time: "10:00", days: "daily", groups: [], promptIsDefault: true }, history: [row()] },
    { openReport: { id: row().id, text: "#daily_report\n⏳ Awaiting your reply\n[1] Contact A asked about the schedule." } },
  ));
  expect(html).toContain("#daily_report");
  expect(html).toContain("[1] Contact A asked about the schedule.");
  expect(html).toContain("Back");
});

test("the source picker lists groups with a light and a full pass", () => {
  /* The picker opens from the settings view; with groups loaded it offers the
     two passes per group and nothing else. */
  const state = stateFor(
    { settings: { enabled: true, time: "10:00", days: "daily", groups: [{ id: "-1001", title: "Team room", mode: "full" }], promptIsDefault: true } },
    { groups: [{ id: "-1001", title: "Team room" }, { id: "-1002", title: "Project room" }] },
  );
  const html = renderToStaticMarkup(<TelegramReportsSection state={state} />);
  expect(html).toContain("Groups");
  /* Closed by default — the summary line is what the operator sees first. */
  expect(html).not.toContain("Load my groups");
});

test("an action failure is announced instead of leaving the panel silent", () => {
  const html = render(stateFor({ settings: { enabled: true, time: "10:00", days: "daily", groups: [], promptIsDefault: true } }, { failure: { code: "sources_failed" } }));
  expect(html).toContain("role=\"alert\"");
  expect(html).toContain("The chats to read could not be listed.");
});

test("state that has not loaded yet says so instead of rendering an empty schedule", () => {
  const html = render(stateFor(null));
  expect(html).toContain("Loading…");
  expect(html).not.toContain("Run now");
});

test("the prompt row says whether the brief is the default, and opens the editor", () => {
  const html = render(stateFor({ settings: { enabled: true, time: "10:00", days: "daily", groups: [], promptIsDefault: true } }));
  expect(html).toContain("Prompt: default template");
  expect(html).toContain(">Prompt<");
  const edited = render(stateFor({ settings: { enabled: true, time: "10:00", days: "daily", groups: [], promptIsDefault: false } }));
  expect(edited).toContain("Prompt: edited by you");
});

test("the prompt editor is a plain textarea with save and reset, and states the fixed preamble", () => {
  const html = render(stateFor(
    { settings: { enabled: true, time: "10:00", days: "daily", groups: [], promptIsDefault: false } },
    { prompt: { prompt: "Write the report in Ukrainian.\n#report_tag", defaultPrompt: "Write one report on the operator's Telegram for this window." } },
  ));
  expect(html).toContain("<textarea");
  expect(html).toContain("Write the report in Ukrainian.");
  expect(html).toContain("Save prompt");
  expect(html).toContain("Reset to default");
  expect(html).toContain("The Viewer always adds the window");
  /* The editor replaces the settings view rather than opening a second one. */
  expect(html).not.toContain("Run now");
});
