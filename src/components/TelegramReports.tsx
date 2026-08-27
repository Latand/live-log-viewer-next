"use client";

import { useRef, useState } from "react";

import { mdBlocks } from "@/components/feed/markdown";
import type { TelegramReportsState } from "@/hooks/useTelegramReports";
import { type TFunction, useLocale } from "@/lib/i18n";
import {
  REPORT_TIME_ZONE,
  type TelegramReportGroupMode,
  type TelegramReportRow,
  type TelegramReportSettings,
  type TelegramReportStatus,
} from "@/lib/telegram/reportContracts";

/**
 * The Daily Report section of the Telegram panel (issue #1086).
 *
 * It lives INSIDE the existing flyout/sheet — no new navigation, no second
 * surface — and reuses that panel's primitives: the same button shape, the
 * same section rule, the same 44px mobile tap targets. Five views share the
 * section: settings (off / on), the source picker, the analyst-prompt editor,
 * the history list, and one rendered report.
 *
 * The prompt is the operator's own brief — language, tag line, sections,
 * target repository, tone — so it is a plain textarea with a reset, not a
 * form of Viewer-owned fields. It is loaded only when the editor opens,
 * because it may name their private chats.
 */

function reportButtonClass(tone: "neutral" | "accent" = "neutral"): string {
  return `inline-flex min-h-[44px] shrink-0 items-center justify-center rounded-[7px] border border-border px-2.5 py-0.5 text-[11px] font-semibold disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[28px] ${
    tone === "accent" ? "bg-sunken hover:bg-canvas" : "bg-canvas hover:bg-sunken"
  }`;
}

function ReportButton({ label, onClick, disabled, tone }: { label: string; onClick: () => void; disabled?: boolean; tone?: "neutral" | "accent" }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={reportButtonClass(tone)}>
      {label}
    </button>
  );
}

/** The section's one failure banner. Every view renders it, so an action that
    failed is announced wherever the operator was standing when they took it —
    a save rejected in the prompt editor used to leave that view silent. */
function FailureNote({ state }: { state: TelegramReportsState }) {
  const { t } = useLocale();
  if (!state.failure) return null;
  return (
    <p role="alert" className="rounded-[6px] bg-danger-soft px-2 py-1 text-[10.5px] font-semibold leading-snug text-danger">
      {t(reportErrorKey(state.failure.code))}
    </p>
  );
}

function statusColor(status: TelegramReportStatus): string {
  if (status === "ok") return "var(--color-success)";
  if (status === "quiet") return "var(--color-muted)";
  if (status === "running") return "var(--color-accent)";
  if (status === "account-mismatch") return "var(--color-warning)";
  return "var(--color-danger)";
}

function statusKey(status: TelegramReportStatus): Parameters<TFunction>[0] {
  return `telegram.report.status.${status}` as Parameters<TFunction>[0];
}

/** Known backend codes get their sentence; anything else gets the actionable
    generic, so a failed row is never a blank line. */
export function reportErrorKey(code: string | null): Parameters<TFunction>[0] {
  const known: Record<string, Parameters<TFunction>[0]> = {
    not_connected: "telegram.report.err.not_connected",
    reports_disabled: "telegram.report.err.reports_disabled",
    run_in_progress: "telegram.report.err.run_in_progress",
    account_check_failed: "telegram.report.err.account_check_failed",
    connector_unavailable: "telegram.report.err.connector_unavailable",
    sources_failed: "telegram.report.err.sources_failed",
    launch_failed: "telegram.report.err.launch_failed",
    run_ended_without_report: "telegram.report.err.run_ended_without_report",
    timed_out: "telegram.report.err.timed_out",
    invalid_report: "telegram.report.err.invalid_report",
    report_missing: "telegram.report.err.report_missing",
    transport: "telegram.report.err.transport",
  };
  return known[code ?? ""] ?? "telegram.report.err.generic";
}

/* The schedule is stated in the operator's zone, so every clock in this
   section reads in that same zone — a "next run" in the browser's timezone
   beside an "at 10:00 Kyiv" schedule would be two clocks for one thing. */
function shortDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString([], { day: "2-digit", month: "short", timeZone: REPORT_TIME_ZONE });
}

function shortTime(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: REPORT_TIME_ZONE });
}

function windowLabel(row: { windowStart: string; windowEnd: string }): string {
  const hours = Math.max(1, Math.round((Date.parse(row.windowEnd) - Date.parse(row.windowStart)) / 3_600_000));
  return `${hours} h`;
}

function HistoryRow({ row, onOpen, onLeave, busy }: { row: TelegramReportRow; onOpen: (id: string) => void; onLeave: () => void; busy: boolean }) {
  const { t } = useLocale();
  return (
    <li data-report-row className="flex flex-col gap-0.5 border-t border-border py-1.5 first:border-t-0">
      <div className="flex min-w-0 items-center gap-1.5">
        <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: statusColor(row.status) }} />
        <span className="shrink-0 text-[11px] font-semibold text-primary">{shortDate(row.startedAt)}</span>
        <span className="shrink-0 text-[10px] text-muted">{windowLabel(row)}</span>
        <span className="truncate text-[10px] font-semibold" style={{ color: statusColor(row.status) }}>{t(statusKey(row.status))}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {/* The run is a board conversation, so every row that has one deep-links
              to it with the durable `#c=` form — the only route into a run that
              is still going or that failed, where the row's one sentence is all
              the panel can say. The panel closes behind it: on the phone it is a
              full sheet, and the board it just navigated would stay covered. */}
          {row.conversationId ? (
            <a
              href={"#c=" + encodeURIComponent(row.conversationId)}
              onClick={onLeave}
              title={t("telegram.report.openRunTitle")}
              className={reportButtonClass()}
            >
              {t("telegram.report.openRun")}
            </a>
          ) : null}
          {row.hasReport ? (
            <ReportButton label={t("telegram.report.open")} onClick={() => onOpen(row.id)} disabled={busy} />
          ) : null}
        </span>
      </div>
      {row.status === "failed" || row.status === "account-mismatch" ? (
        <p className="pl-3 text-[10px] leading-snug text-danger">
          {row.status === "account-mismatch" ? t("telegram.report.err.account_mismatch") : t(reportErrorKey(row.errorCode))}
        </p>
      ) : null}
    </li>
  );
}

function SourcePicker({ state, settings }: { state: TelegramReportsState; settings: TelegramReportSettings }) {
  const { t } = useLocale();
  const chosen = new Map(settings.groups.map((group) => [group.id, group]));
  const listed = state.groups ?? settings.groups.map((group) => ({ id: group.id, title: group.title }));
  const setMode = (id: string, title: string, mode: TelegramReportGroupMode | null) => {
    const groups = settings.groups.filter((group) => group.id !== id);
    if (mode) groups.push({ id, title, mode });
    void state.saveSettings({ ...settings, groups });
  };
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-[10.5px] leading-snug text-muted">{t("telegram.report.sourcesHint")}</p>
      <div className="flex items-center gap-1.5">
        <ReportButton label={t("telegram.report.loadGroups")} onClick={() => void state.loadGroups()} disabled={state.busy} />
      </div>
      {listed.length === 0 ? (
        <p className="text-[10.5px] text-muted">{t("telegram.report.noGroups")}</p>
      ) : (
        <ul className="flex max-h-[180px] flex-col gap-1 overflow-y-auto">
          {listed.map((group) => {
            const mode = chosen.get(group.id)?.mode ?? null;
            return (
              <li key={group.id} className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-[11px] text-primary">{group.title}</span>
                {(["light", "full"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={mode === option}
                    disabled={state.busy}
                    onClick={() => setMode(group.id, group.title, mode === option ? null : option)}
                    className={`inline-flex min-h-[44px] shrink-0 items-center rounded-[6px] border px-1.5 text-[10px] font-semibold disabled:opacity-45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:min-h-[26px] ${
                      mode === option ? "border-accent text-accent" : "border-border text-muted hover:bg-canvas"
                    }`}
                  >
                    {t(option === "light" ? "telegram.report.modeLight" : "telegram.report.modeFull")}
                  </button>
                ))}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function PromptEditor({ state }: { state: TelegramReportsState }) {
  const { t } = useLocale();
  const field = useRef<HTMLTextAreaElement>(null);
  const loaded = state.prompt;
  if (!loaded) return null;
  return (
    <div className="flex flex-col gap-1.5 border-t border-border pt-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-bold text-primary">{t("telegram.report.promptTitle")}</span>
        <span className="ml-auto">
          <ReportButton label={t("telegram.report.back")} onClick={state.closePrompt} disabled={state.busy} />
        </span>
      </div>
      <p className="text-[10.5px] leading-snug text-muted">{t("telegram.report.promptHint")}</p>
      <FailureNote state={state} />
      <textarea
        ref={field}
        defaultValue={loaded.prompt}
        aria-label={t("telegram.report.promptTitle")}
        spellCheck={false}
        className="h-[220px] w-full resize-none rounded-[8px] border border-border bg-canvas p-2 font-mono text-[10.5px] leading-snug outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      />
      <div className="flex items-center gap-1.5">
        <ReportButton
          label={t("telegram.report.promptSave")}
          tone="accent"
          disabled={state.busy}
          onClick={() => {
            const next = field.current?.value ?? "";
            void state.savePrompt(next);
          }}
        />
        <ReportButton
          label={t("telegram.report.promptReset")}
          disabled={state.busy}
          onClick={() => {
            if (field.current) field.current.value = loaded.defaultPrompt;
          }}
        />
      </div>
      {/* The Viewer's own half is stated, so the operator knows what their
          text is added to rather than discovering it in a transcript. */}
      <p className="text-[10px] leading-snug text-secondary">{t("telegram.report.promptPreamble")}</p>
    </div>
  );
}

export function TelegramReportsSection({ state, onClose }: { state: TelegramReportsState; onClose: () => void }) {
  const { t } = useLocale();
  const [picking, setPicking] = useState(false);
  const reports = state.reports;
  const settings = reports?.settings;
  const running = reports?.history.some((row) => row.status === "running") ?? false;

  if (!settings) {
    return (
      <div className="flex flex-col gap-1 border-t border-border pt-1.5">
        <span className="text-[11px] font-bold text-primary">{t("telegram.report.title")}</span>
        <FailureNote state={state} />
        <p className="text-[10.5px] text-muted">{t("telegram.report.loading")}</p>
      </div>
    );
  }

  if (state.prompt) {
    return <PromptEditor state={state} />;
  }

  if (state.openReport) {
    return (
      <div className="flex flex-col gap-1.5 border-t border-border pt-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold text-primary">{t("telegram.report.title")}</span>
          <span className="ml-auto">
            <ReportButton label={t("telegram.report.back")} onClick={state.closeReport} />
          </span>
        </div>
        <FailureNote state={state} />
        {/* The report's own format carries a t.me link per item, so it goes
            through the Viewer's settled prose renderer rather than a <pre>:
            those links are how an item is opened in Telegram, and as bare text
            the phone left only a long-press selection. The renderer keeps the
            newlines (whitespace-pre-wrap), leaves the `#tag` first line literal
            (a heading needs a space after the #) and never touches `[1]`. */}
        <div className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-[8px] bg-canvas p-2 text-[11px] leading-snug text-primary">
          {mdBlocks(state.openReport.text)}
        </div>
      </div>
    );
  }

  const update = (patch: Partial<TelegramReportSettings>) => void state.saveSettings({ ...settings, ...patch });

  return (
    <div className="flex flex-col gap-1.5 border-t border-border pt-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-bold text-primary">{t("telegram.report.title")}</span>
        {settings.enabled ? (
          <span className="ml-auto">
            <ReportButton label={t("telegram.report.disable")} onClick={() => update({ enabled: false })} disabled={state.busy} />
          </span>
        ) : null}
      </div>

      <FailureNote state={state} />

      {!settings.enabled ? (
        <>
          <p className="text-[10.5px] leading-snug text-muted">{t("telegram.report.disabledHint")}</p>
          <ReportButton label={t("telegram.report.enable")} onClick={() => update({ enabled: true })} disabled={state.busy} tone="accent" />
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <label className="text-[10.5px] text-muted" htmlFor="telegram-report-time">{t("telegram.report.at")}</label>
            <input
              id="telegram-report-time"
              type="time"
              value={settings.time}
              disabled={state.busy}
              onChange={(event) => update({ time: event.target.value })}
              className="h-11 w-[116px] rounded-[8px] border border-border bg-canvas px-1.5 text-[11.5px] outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:h-8"
            />
            <span className="text-[9.5px] font-semibold text-secondary">{t("telegram.report.zone")}</span>
          </div>

          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted">
              {t("telegram.report.sourcesSummary", { count: settings.groups.length })}
            </span>
            <ReportButton
              label={picking ? t("telegram.report.sourcesDone") : t("telegram.report.sourcesEdit")}
              onClick={() => setPicking((value) => !value)}
              disabled={state.busy}
            />
          </div>
          {picking ? <SourcePicker state={state} settings={settings} /> : null}

          <div className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted">
              {t(settings.promptIsDefault ? "telegram.report.promptDefault" : "telegram.report.promptEdited")}
            </span>
            <ReportButton label={t("telegram.report.promptEdit")} onClick={() => void state.loadPrompt()} disabled={state.busy} />
          </div>

          <div className="flex items-center gap-1.5">
            <ReportButton
              label={running ? t("telegram.report.running") : t("telegram.report.runNow")}
              onClick={() => void state.runNow()}
              disabled={state.busy || running}
              tone="accent"
            />
            {reports?.nextRunAt ? (
              <span className="min-w-0 flex-1 truncate text-[9.5px] font-semibold text-secondary">
                {t("telegram.report.nextRun", { time: shortTime(reports.nextRunAt) ?? "", date: shortDate(reports.nextRunAt) })}
              </span>
            ) : null}
          </div>
        </>
      )}

      {/* Every retained run is listed: the store keeps
          TELEGRAM_REPORT_HISTORY_LIMIT rows AND their texts, so a list that
          showed the newest handful left weeks of stored reports with no route
          to them. The bounded region is the source picker's — it keeps the
          panel's own controls (log out, delete local data) where they were
          instead of pushing them past two months of rows. */}
      {reports && reports.history.length > 0 ? (
        <ul className="flex max-h-[220px] flex-col overflow-y-auto">
          {reports.history.map((row) => (
            <HistoryRow key={row.id} row={row} onOpen={(id) => void state.openReportById(id)} onLeave={onClose} busy={state.busy} />
          ))}
        </ul>
      ) : settings.enabled ? (
        <p className="text-[10.5px] text-muted">{t("telegram.report.noRuns")}</p>
      ) : null}
    </div>
  );
}
