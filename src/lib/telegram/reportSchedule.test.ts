import { expect, test } from "bun:test";

import { DEFAULT_TELEGRAM_REPORT_SETTINGS, type TelegramReportSettings } from "./reportContracts";
import {
  REPORT_WINDOW_CAP_MS,
  localDayKey,
  localWeekday,
  nextScheduledRunAt,
  reportWindowFor,
  scheduledRunDue,
  slotInstant,
  type ReportScheduleCursor,
} from "./reportSchedule";

/* Kyiv runs UTC+3 in summer and UTC+2 in winter, which is the whole reason the
   schedule is stated in the operator's zone rather than in UTC. */
const AUGUST_SLOT = Date.parse("2026-08-21T07:00:00.000Z"); // 10:00 Kyiv, Friday
const settings = (over: Partial<TelegramReportSettings> = {}): TelegramReportSettings => ({
  ...DEFAULT_TELEGRAM_REPORT_SETTINGS,
  enabled: true,
  ...over,
});
const cursor = (over: Partial<ReportScheduleCursor> = {}): ReportScheduleCursor => ({
  lastSuccessfulWindowEndAt: null,
  lastScheduledDay: null,
  ...over,
});

test("the schedule time is the operator's local time on both sides of DST", () => {
  expect(slotInstant("2026-08-21", "10:00")).toBe(AUGUST_SLOT);
  expect(slotInstant("2026-01-15", "10:00")).toBe(Date.parse("2026-01-15T08:00:00.000Z"));
  /* Late UTC evening is already the next Kyiv day. */
  expect(localDayKey(Date.parse("2026-08-21T22:30:00.000Z"))).toBe("2026-08-22");
  expect(localWeekday(AUGUST_SLOT)).toBe(5);
});

test("a run is due once the local slot has passed, and only once that day", () => {
  expect(scheduledRunDue({ now: AUGUST_SLOT - 60_000, settings: settings(), cursor: cursor() })).toBe(false);
  expect(scheduledRunDue({ now: AUGUST_SLOT, settings: settings(), cursor: cursor() })).toBe(true);
  expect(scheduledRunDue({
    now: AUGUST_SLOT + 3_600_000,
    settings: settings(),
    cursor: cursor({ lastScheduledDay: "2026-08-21" }),
  })).toBe(false);
  expect(scheduledRunDue({ now: AUGUST_SLOT, settings: settings({ enabled: false }), cursor: cursor() })).toBe(false);
});

test("a slot missed while the Viewer was down is caught up on the next tick", () => {
  /* The Viewer was off from Tuesday; nothing ticked at 10:00 on any of those
     days. The stamped day — not a timer — is what says the run is owed. */
  const due = scheduledRunDue({
    now: AUGUST_SLOT + 2 * 3_600_000,
    settings: settings(),
    cursor: cursor({ lastScheduledDay: "2026-08-18" }),
  });
  expect(due).toBe(true);
});

test("weekdays skips the weekend and lands on Monday", () => {
  const saturday = Date.parse("2026-08-22T09:00:00.000Z");
  expect(scheduledRunDue({ now: saturday, settings: settings({ days: "weekdays" }), cursor: cursor() })).toBe(false);
  const next = nextScheduledRunAt({ now: saturday, settings: settings({ days: "weekdays" }), cursor: cursor() });
  expect(next).toBe(slotInstant("2026-08-24", "10:00"));
});

test("the next run is tomorrow's slot once today's has been taken", () => {
  const next = nextScheduledRunAt({
    now: AUGUST_SLOT + 60_000,
    settings: settings(),
    cursor: cursor({ lastScheduledDay: "2026-08-21" }),
  });
  expect(next).toBe(slotInstant("2026-08-22", "10:00"));
  expect(nextScheduledRunAt({ now: AUGUST_SLOT, settings: settings({ enabled: false }), cursor: cursor() })).toBeNull();
});

test("the window runs from the last successful report, 24 h on a first run, capped at 72 h", () => {
  const now = AUGUST_SLOT;
  const first = reportWindowFor(now, cursor());
  expect(Date.parse(first.endAt)).toBe(now);
  expect(Date.parse(first.endAt) - Date.parse(first.startAt)).toBe(24 * 3_600_000);

  const yesterday = new Date(now - 26 * 3_600_000).toISOString();
  const caughtUp = reportWindowFor(now, cursor({ lastSuccessfulWindowEndAt: yesterday }));
  /* A failed day is covered because the cursor never moved past it. */
  expect(caughtUp.startAt).toBe(yesterday);

  const ancient = new Date(now - 40 * 24 * 3_600_000).toISOString();
  const capped = reportWindowFor(now, cursor({ lastSuccessfulWindowEndAt: ancient }));
  expect(Date.parse(capped.endAt) - Date.parse(capped.startAt)).toBe(REPORT_WINDOW_CAP_MS);

  /* A cursor in the future (clock stepped back) collapses to the first-run
     window instead of an inverted range. */
  const future = reportWindowFor(now, cursor({ lastSuccessfulWindowEndAt: new Date(now + 3_600_000).toISOString() }));
  expect(Date.parse(future.endAt) - Date.parse(future.startAt)).toBe(24 * 3_600_000);
});
