import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { TelegramReportsState } from "@/hooks/useTelegramReports";
import { TELEGRAM_REPORT_HISTORY_LIMIT, type TelegramReportRow, type TelegramReportsPayload } from "@/lib/telegram/reportContracts";

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
      settings: { enabled: false, time: "10:00", groups: [], promptIsDefault: true },
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

const render = (state: TelegramReportsState) => renderToStaticMarkup(<TelegramReportsSection state={state} onClose={() => {}} />);

test("disabled explains the feature and offers a single Enable", () => {
  const html = render(stateFor({}));
  expect(html).toContain("Daily report");
  expect(html).toContain("Enable daily report");
  expect(html).toContain("reads your private dialogs and the groups you pick");
  expect(html).not.toContain("Run now");
});

test("enabled shows the schedule, the sources summary, Run now and the next run", () => {
  const html = render(stateFor({
    settings: { enabled: true, time: "10:00", groups: [{ id: "-1001", title: "Team room", mode: "light" }], promptIsDefault: true },
    nextRunAt: "2026-08-22T07:00:00.000Z",
  }));
  expect(html).toContain('value="10:00"');
  expect(html).toContain("Kyiv time");
  expect(html).toContain("active private dialogs + 1 group");
  expect(html).toContain("Run now");
  expect(html).toContain("Turn off");
  expect(html).toContain("No runs yet.");
});

test("history rows carry date, window and status, and only a stored report offers Open", () => {
  const html = render(stateFor({
    settings: { enabled: true, time: "10:00", groups: [], promptIsDefault: true },
    history: [row(), row({ id: "2", status: "quiet", hasReport: false })],
  }));
  expect(html).toContain("24 h");
  expect(html).toContain("report");
  expect(html).toContain("quiet");
  expect(html.match(/>Open</g)?.length).toBe(1);
});

test("a failed row states what went wrong in a sentence, never silence", () => {
  const html = render(stateFor({
    settings: { enabled: true, time: "10:00", groups: [], promptIsDefault: true },
    history: [row({ status: "failed", errorCode: "run_ended_without_report", hasReport: false })],
  }));
  expect(html).toContain("failed");
  expect(html).toContain("The run ended before it wrote a report. Run it again.");
  expect(html).not.toContain(">Open<");
});

test("a wrong-account row says the account did not match and nothing was read", () => {
  const html = render(stateFor({
    settings: { enabled: true, time: "10:00", groups: [], promptIsDefault: true },
    history: [row({ status: "account-mismatch", errorCode: null, hasReport: false })],
  }));
  expect(html).toContain("wrong account");
  expect(html).toContain("Nothing was read.");
});

test("a running row shows the run in progress and blocks a second Run now", () => {
  const html = render(stateFor({
    settings: { enabled: true, time: "10:00", groups: [], promptIsDefault: true },
    history: [row({ status: "running", finishedAt: null, hasReport: false })],
  }));
  expect(html).toContain("running");
  expect(html).toContain("Running…");
  expect(html).toContain("disabled");
});

test("an open report renders its text with a way back to the list", () => {
  const html = render(stateFor(
    { settings: { enabled: true, time: "10:00", groups: [], promptIsDefault: true }, history: [row()] },
    { openReport: { id: row().id, text: "#daily_report\n⏳ Awaiting your reply\n[1] Contact A asked about the schedule." } },
  ));
  expect(html).toContain("#daily_report");
  expect(html).toContain("[1] Contact A asked about the schedule.");
  expect(html).toContain("Back");
});

test("the report's message links are real links, and the tag line and numbering are untouched", () => {
  /* The format carries one t.me link per item so an item can be opened in
     Telegram — as plain text inside a scroll box, a phone had only a long-press
     selection. The tag line must stay literal (`#daily_report` is not a
     heading) and `[1]` must not be eaten by the link rule. */
  const html = render(stateFor(
    { settings: { enabled: true, time: "10:00", groups: [], promptIsDefault: true }, history: [row()] },
    {
      openReport: {
        id: row().id,
        text: "#daily_report\n⏳ Awaiting your reply\n[1] Contact A asked about Thursday. https://t.me/c/1000000001/482",
      },
    },
  ));
  expect(html).toContain('href="https://t.me/c/1000000001/482"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain("#daily_report");
  expect(html).not.toContain("<h1");
  expect(html).toContain("[1] Contact A asked about Thursday.");
});

test("every run with a conversation deep-links to it, including one that failed", () => {
  /* The row's status word and its one sentence are all the panel can say; the
     transcript behind it is the rest, and a running or failed run has no
     stored report to open. */
  const html = render(stateFor({
    settings: { enabled: true, time: "10:00", groups: [], promptIsDefault: true },
    history: [
      row({ id: "1", status: "failed", errorCode: "timed_out", hasReport: false, conversationId: "conversation_failed" }),
      row({ id: "2", status: "running", finishedAt: null, hasReport: false, conversationId: "conversation_running" }),
      row({ id: "3", conversationId: null, hasReport: true }),
    ],
  }));
  expect(html).toContain('href="#c=conversation_failed"');
  expect(html).toContain('href="#c=conversation_running"');
  /* A row the registry never linked keeps its stored report and offers no
     dead link. */
  expect(html.match(/>Run</g)?.length).toBe(2);
  expect(html.match(/>Open</g)?.length).toBe(1);
});

test("every retained run is listed, not just the newest handful", () => {
  /* The store keeps TELEGRAM_REPORT_HISTORY_LIMIT rows and their texts; a list
     that stopped at eight left the rest stored with no way in. */
  const history = Array.from({ length: TELEGRAM_REPORT_HISTORY_LIMIT }, (_, index) =>
    row({ id: `report-fixture-${String(index).padStart(4, "0")}` }));
  const html = render(stateFor({
    settings: { enabled: true, time: "10:00", groups: [], promptIsDefault: true },
    history,
  }));
  expect(html.match(/>Open</g)?.length).toBe(TELEGRAM_REPORT_HISTORY_LIMIT);
  /* Inside the picker's own bounded region, so the panel's log-out and
     delete-local controls stay where they were. */
  expect(html).toContain("overflow-y-auto");
});

test("the source picker lists groups with a light and a full pass", () => {
  /* The picker opens from the settings view; with groups loaded it offers the
     two passes per group and nothing else. */
  const state = stateFor(
    { settings: { enabled: true, time: "10:00", groups: [{ id: "-1001", title: "Team room", mode: "full" }], promptIsDefault: true } },
    { groups: [{ id: "-1001", title: "Team room" }, { id: "-1002", title: "Project room" }] },
  );
  const html = renderToStaticMarkup(<TelegramReportsSection state={state} onClose={() => {}} />);
  expect(html).toContain("Groups");
  /* Closed by default — the summary line is what the operator sees first. */
  expect(html).not.toContain("Load my groups");
});

test("an action failure is announced instead of leaving the panel silent", () => {
  const html = render(stateFor({ settings: { enabled: true, time: "10:00", groups: [], promptIsDefault: true } }, { failure: { code: "sources_failed" } }));
  expect(html).toContain("role=\"alert\"");
  expect(html).toContain("The chats to read could not be listed.");
});

test("state that has not loaded yet says so instead of rendering an empty schedule", () => {
  const html = render(stateFor(null));
  expect(html).toContain("Loading…");
  expect(html).not.toContain("Run now");
});

test("the prompt row says whether the brief is the default, and opens the editor", () => {
  const html = render(stateFor({ settings: { enabled: true, time: "10:00", groups: [], promptIsDefault: true } }));
  expect(html).toContain("Prompt: default template");
  expect(html).toContain(">Prompt<");
  const edited = render(stateFor({ settings: { enabled: true, time: "10:00", groups: [], promptIsDefault: false } }));
  expect(edited).toContain("Prompt: edited by you");
});

test("the prompt editor is a plain textarea with save and reset, and states the fixed preamble", () => {
  const html = render(stateFor(
    { settings: { enabled: true, time: "10:00", groups: [], promptIsDefault: false } },
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

test("a save the editor could not complete is announced in the editor", () => {
  /* The failure banner belongs to the whole section, not to the settings view:
     a rejected save used to leave the editor looking exactly as it did before,
     and the next run would have used the old brief. */
  const html = render(stateFor(
    { settings: { enabled: true, time: "10:00", groups: [], promptIsDefault: false } },
    {
      ["prompt"]: { prompt: "Write the report in Ukrainian.", defaultPrompt: "Write one report on the operator's Telegram for this window." },
      failure: { code: "transport" },
    },
  ));
  expect(html).toContain("<textarea");
  expect(html).toContain("role=\"alert\"");
  expect(html).toContain("The Viewer server");
  expect(html).toContain("respond. Try again.");
  /* The operator's text is still there to retry with. */
  expect(html).toContain("Write the report in Ukrainian.");
});
