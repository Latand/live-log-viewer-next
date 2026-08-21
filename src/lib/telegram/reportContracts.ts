/**
 * Public contracts for Telegram Daily Reports (issue #1086).
 *
 * Everything here may cross the browser boundary, so the same rule that
 * governs `contracts.ts` governs this file: status, window bounds, sanitized
 * error codes and the operator's own settings — never a message body, never a
 * private-dialog identifier, never the session value. The report TEXT is
 * fetched one row at a time through an explicit request and is never part of
 * the list payload.
 */

/** Terminal outcome of one report run, in the exact vocabulary issue #1086
    names, plus the `running` state a live row is displayed in. */
export type TelegramReportStatus = "running" | "ok" | "quiet" | "failed" | "account-mismatch";

export type TelegramReportTrigger = "scheduled" | "manual";

/** How much of a group a run reads: everything, or only what touches the
    operator (mentions, replies, one or two notable threads). */
export type TelegramReportGroupMode = "full" | "light";

export type TelegramReportGroup = {
  /** Marked Telegram chat id, as a string so a 64-bit id survives JSON. */
  id: string;
  title: string;
  mode: TelegramReportGroupMode;
};

export type TelegramReportDays = "daily" | "weekdays";

export type TelegramReportSettings = {
  enabled: boolean;
  /** `HH:MM` in {@link REPORT_TIME_ZONE}. */
  time: string;
  days: TelegramReportDays;
  /** Operator-picked groups. Private dialogs are discovered per run and are
      never listed here — they must not become durable Viewer state. */
  groups: TelegramReportGroup[];
};

/** Sanitized failure vocabulary for a run. A failed run always carries one. */
export type TelegramReportErrorCode =
  | "not_connected"
  | "reports_disabled"
  | "run_in_progress"
  | "sources_failed"
  | "launch_failed"
  | "run_ended_without_report"
  | "timed_out"
  | "invalid_report";

export type TelegramReportRow = {
  id: string;
  trigger: TelegramReportTrigger;
  startedAt: string;
  finishedAt: string | null;
  windowStart: string;
  windowEnd: string;
  status: TelegramReportStatus;
  errorCode: TelegramReportErrorCode | null;
  /** The board conversation that ran it, so the operator can open the run. */
  conversationId: string | null;
  /** Whether a stored report text exists for this row. */
  hasReport: boolean;
  /** Version of the analyst prompt template the run was launched with. */
  promptVersion: string;
};

export type TelegramReportsPayload = {
  settings: TelegramReportSettings;
  history: TelegramReportRow[];
  /** ISO instant of the next scheduled run, or `null` when disabled. */
  nextRunAt: string | null;
};

/** The operator's schedule is stated in their own day, not the host's. */
export const REPORT_TIME_ZONE = "Europe/Kyiv";

export const DEFAULT_TELEGRAM_REPORT_SETTINGS: TelegramReportSettings = {
  enabled: false,
  time: "10:00",
  days: "daily",
  groups: [],
};

/** How many history rows survive; older rows and their texts are evicted. */
export const TELEGRAM_REPORT_HISTORY_LIMIT = 60;

export function validReportTime(value: unknown): value is string {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function validReportChatId(value: unknown): value is string {
  return typeof value === "string" && /^-?\d{1,20}$/.test(value);
}
