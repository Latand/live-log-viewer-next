import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

import {
  DEFAULT_TELEGRAM_REPORT_SETTINGS,
  TELEGRAM_REPORT_HISTORY_LIMIT,
  validReportChatId,
  validReportTime,
  type TelegramReportGroup,
  type TelegramReportRow,
  type TelegramReportSettings,
} from "./reportContracts";
import { DEFAULT_DAILY_REPORT_PROMPT, MAX_DAILY_REPORT_PROMPT_LENGTH } from "./reportPrompt";
import type { ReportScheduleCursor } from "./reportSchedule";
import { atomicSecretWrite, ensureTelegramStateDir, readSafeJson, readSafeText, removeSafeFile } from "./sessionStore";

/**
 * Owner-only persistence for Telegram Daily Reports (issue #1086).
 *
 * Everything lives beside the credential, under the same 0700 directory and
 * the same 0600 fence (`sessionStore.ts`), because it is the same class of
 * data: the operator's own Telegram life, readable by nobody else on the host.
 *
 *  - `reports.json` — settings, the operator's analyst prompt, the schedule
 *    cursor, the active run, and the history rows. Rows carry status, window
 *    and sanitized error code only; no message body and no private-dialog
 *    identifier ever enters a row. The PROMPT may well name the operator's
 *    private chats — it is their brief — so it lives here, owner-only, and
 *    leaves only by the explicit request that serves it back to the panel or
 *    into the run it was written for.
 *  - `report-<runId>.md` — one report text, written by the Viewer.
 *  - `run-<runId>.sources.json` — the source plan a run reads. Owner-only, so
 *    the private dialogs a run must visit never travel through the prompt,
 *    the transcript, or the registry.
 *  - `run-<runId>.out.md` — the run's INBOX: the file the agent writes. It is
 *    the one file here the Viewer does not write, so it is fenced by owner and
 *    file type but not by mode (an agent's umask is not ours to dictate); the
 *    Viewer ingests it into `report-<runId>.md` and unlinks it immediately.
 *
 * The whole file is small and rewritten atomically, and every mutation is a
 * synchronous read-modify-write with no await in between, so two concurrent
 * callers in this single-threaded server cannot interleave.
 */

const REPORTS_FILE = "reports.json";
/** A report text longer than this is a runaway, not a report. */
const MAX_REPORT_BYTES = 256 * 1024;

export type ActiveTelegramReportRun = {
  runId: string;
  trigger: TelegramReportRow["trigger"];
  startedAt: string;
  windowStart: string;
  windowEnd: string;
  conversationId: string | null;
  promptVersion: string;
};

/** What is actually stored: the payload's settings minus the flag the payload
    derives from the prompt beside them. */
export type StoredReportSettings = Omit<TelegramReportSettings, "promptIsDefault">;

export type TelegramReportsFile = {
  version: 1;
  settings: StoredReportSettings;
  /** The operator's analyst brief. `null` means "the shipped default", so an
      operator who never edited it follows the template as it improves. */
  ["prompt"]: string | null;
  cursor: ReportScheduleCursor;
  active: ActiveTelegramReportRun | null;
  history: TelegramReportRow[];
};

function reportsPath(): string {
  return statePath("telegram", REPORTS_FILE);
}

export function reportTextPath(runId: string): string {
  return statePath("telegram", `report-${runId}.md`);
}

export function reportSourcesPath(runId: string): string {
  return statePath("telegram", `run-${runId}.sources.json`);
}

export function reportInboxPath(runId: string): string {
  return statePath("telegram", `run-${runId}.out.md`);
}

/** The neutral scratch dir a report run is launched in: never a repository,
    never the server's own cwd. */
export function reportWorkspaceDir(): string {
  const override = process.env.LLV_TELEGRAM_REPORT_CWD?.trim();
  const dir = override || statePath("telegram", "report-workspace");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const DEFAULT_STORED_SETTINGS: StoredReportSettings = {
  enabled: DEFAULT_TELEGRAM_REPORT_SETTINGS.enabled,
  time: DEFAULT_TELEGRAM_REPORT_SETTINGS.time,
  groups: [],
};

const EMPTY: TelegramReportsFile = {
  version: 1,
  settings: DEFAULT_STORED_SETTINGS,
  ["prompt"]: null,
  cursor: { lastSuccessfulWindowEndAt: null, unreportedSinceAt: null, lastScheduledDay: null },
  active: null,
  history: [],
};

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function sanitizeGroups(value: unknown): TelegramReportGroup[] {
  if (!Array.isArray(value)) return [];
  const groups: TelegramReportGroup[] = [];
  for (const raw of value.slice(0, 50)) {
    const row = raw as { id?: unknown; title?: unknown; mode?: unknown };
    if (!validReportChatId(row.id)) continue;
    groups.push({
      id: row.id,
      title: typeof row.title === "string" ? row.title.slice(0, 120) : row.id,
      mode: row.mode === "light" ? "light" : "full",
    });
  }
  return groups;
}

export function sanitizeReportSettings(value: unknown): StoredReportSettings {
  const row = (value && typeof value === "object" ? value : {}) as Partial<TelegramReportSettings>;
  return {
    enabled: row.enabled === true,
    time: validReportTime(row.time) ? row.time : DEFAULT_TELEGRAM_REPORT_SETTINGS.time,
    groups: sanitizeGroups(row.groups),
  };
}

/**
 * A prompt on its way into storage: bounded, trimmed, and collapsed back to
 * `null` when it is the default — an operator who resets ends up exactly where
 * they started, with no stale copy of a template that has since moved on.
 * Anything that is not a usable string is refused rather than silently
 * replacing the brief with an empty one.
 */
export function sanitizeReportPrompt(value: unknown): string | null | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed === DEFAULT_DAILY_REPORT_PROMPT.trim()) return null;
  return trimmed.slice(0, MAX_DAILY_REPORT_PROMPT_LENGTH);
}

/** The brief a run is launched with: the operator's, or the default. */
export function effectiveReportPrompt(file: TelegramReportsFile): string {
  return file.prompt ?? DEFAULT_DAILY_REPORT_PROMPT;
}

function sanitizeRow(value: unknown): TelegramReportRow | null {
  const row = (value && typeof value === "object" ? value : {}) as Partial<TelegramReportRow>;
  const id = text(row.id);
  const startedAt = text(row.startedAt);
  if (!id || !startedAt) return null;
  const status = row.status;
  return {
    id,
    trigger: row.trigger === "manual" ? "manual" : "scheduled",
    startedAt,
    finishedAt: text(row.finishedAt),
    windowStart: text(row.windowStart) ?? startedAt,
    windowEnd: text(row.windowEnd) ?? startedAt,
    status: status === "ok" || status === "quiet" || status === "failed" || status === "account-mismatch" || status === "running"
      ? status
      : "failed",
    errorCode: (text(row.errorCode) as TelegramReportRow["errorCode"]) ?? null,
    conversationId: text(row.conversationId),
    hasReport: row.hasReport === true,
    promptVersion: text(row.promptVersion) ?? "unknown",
  };
}

function sanitizeActive(value: unknown): ActiveTelegramReportRun | null {
  const row = (value && typeof value === "object" ? value : {}) as Partial<ActiveTelegramReportRun>;
  const runId = text(row.runId);
  const startedAt = text(row.startedAt);
  if (!runId || !startedAt) return null;
  return {
    runId,
    trigger: row.trigger === "manual" ? "manual" : "scheduled",
    startedAt,
    windowStart: text(row.windowStart) ?? startedAt,
    windowEnd: text(row.windowEnd) ?? startedAt,
    conversationId: text(row.conversationId),
    promptVersion: text(row.promptVersion) ?? "unknown",
  };
}

export function readTelegramReports(): TelegramReportsFile {
  let parsed: unknown = null;
  try {
    parsed = readSafeJson(reportsPath());
  } catch {
    /* A tampered or unreadable reports file is not a credential: the feature
       falls back to defaults rather than taking the whole panel down. */
    return { ...EMPTY, settings: { ...EMPTY.settings }, cursor: { ...EMPTY.cursor }, history: [] };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ...EMPTY, settings: { ...EMPTY.settings }, cursor: { ...EMPTY.cursor }, history: [] };
  }
  const row = parsed as Partial<TelegramReportsFile>;
  const cursor = (row.cursor && typeof row.cursor === "object" ? row.cursor : {}) as Partial<ReportScheduleCursor>;
  return {
    version: 1,
    settings: sanitizeReportSettings(row.settings),
    ["prompt"]: typeof row.prompt === "string" && row.prompt.trim()
      ? row.prompt.slice(0, MAX_DAILY_REPORT_PROMPT_LENGTH)
      : null,
    cursor: {
      lastSuccessfulWindowEndAt: text(cursor.lastSuccessfulWindowEndAt),
      unreportedSinceAt: text(cursor.unreportedSinceAt),
      lastScheduledDay: text(cursor.lastScheduledDay),
    },
    active: sanitizeActive(row.active),
    history: Array.isArray(row.history)
      ? row.history.map(sanitizeRow).filter((item): item is TelegramReportRow => item !== null)
      : [],
  };
}

function writeTelegramReports(file: TelegramReportsFile): void {
  atomicSecretWrite(reportsPath(), JSON.stringify(file));
}

/**
 * The single mutation path. Synchronous read → mutate → write, so a caller
 * never holds a stale copy across an await, and history is trimmed (with the
 * evicted rows' texts) on every write.
 */
export function updateTelegramReports(
  mutate: (file: TelegramReportsFile) => void,
): TelegramReportsFile {
  const file = readTelegramReports();
  mutate(file);
  const kept = file.history.slice(0, TELEGRAM_REPORT_HISTORY_LIMIT);
  for (const evicted of file.history.slice(TELEGRAM_REPORT_HISTORY_LIMIT)) deleteReportArtifacts(evicted.id);
  file.history = kept;
  writeTelegramReports(file);
  return file;
}

export function saveReportText(runId: string, report: string): void {
  atomicSecretWrite(reportTextPath(runId), report);
}

export function readReportText(runId: string): string | null {
  try {
    return readSafeText(reportTextPath(runId));
  } catch {
    return null;
  }
}

export function writeReportSources(runId: string, plan: unknown): string {
  const pathname = reportSourcesPath(runId);
  atomicSecretWrite(pathname, JSON.stringify(plan, null, 2) + "\n");
  return pathname;
}

/**
 * Ingests the file the RUN wrote.
 *
 * The agent's own umask decides that file's mode, so this is the one read in
 * the telegram directory that cannot demand 0600 — it demands a regular,
 * non-symlinked file owned by this uid and a bounded size, which is what
 * actually distinguishes our run's output from somebody else's plant. The
 * bytes are then re-written owner-only by {@link saveReportText}, and the
 * inbox file is removed whatever the outcome.
 */
export function ingestReportInbox(runId: string): string | null {
  const pathname = reportInboxPath(runId);
  try {
    if (ensureTelegramStateDir(false) === null) return null;
    const stat = fs.lstatSync(pathname);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return null;
    if (stat.size === 0 || stat.size > MAX_REPORT_BYTES) return null;
    return fs.readFileSync(pathname, "utf8");
  } catch {
    return null;
  } finally {
    try { fs.rmSync(pathname, { force: true }); } catch { /* best effort */ }
  }
}

/** Removes a finished run's working files. The source plan names the
    operator's private dialogs, so it does not outlive the run that needed it;
    the report text is the only thing a settled run leaves behind. */
export function deleteRunScratch(runId: string): void {
  try { removeSafeFile(reportSourcesPath(runId)); } catch { /* best effort */ }
  try { fs.rmSync(reportInboxPath(runId), { force: true }); } catch { /* best effort */ }
}

/** Removes everything one run owns on disk, report text included. */
export function deleteReportArtifacts(runId: string): void {
  try { removeSafeFile(reportTextPath(runId)); } catch { /* best effort */ }
  deleteRunScratch(runId);
}

/** Telegram logout / local deletion removes the report corpus with the
    credential — the reports are readings of that account. */
export function clearTelegramReports(): void {
  const file = readTelegramReports();
  for (const row of file.history) deleteReportArtifacts(row.id);
  if (file.active) deleteReportArtifacts(file.active.runId);
  try { removeSafeFile(reportsPath()); } catch { /* best effort */ }
  try {
    const workspace = statePath("telegram", "report-workspace");
    fs.rmSync(workspace, { recursive: true, force: true });
  } catch { /* best effort */ }
}

export function reportsFilePath(): string {
  return path.resolve(reportsPath());
}
