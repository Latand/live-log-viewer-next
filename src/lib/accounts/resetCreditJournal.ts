import fs from "node:fs";
import path from "node:path";

import type { AppServerRateLimits, AppServerResetCreditOutcome } from "@/lib/accounts/codexAppServer";
import { statePath } from "@/lib/configDir";

/**
 * Append-only record of every usage-limit reset redemption the Viewer attempted
 * (issue #1373): who asked, when, for which account, what the backend answered,
 * and the window before and after. A reset credit is a spend; the record is
 * what makes it accountable after the fact. Nothing decides from this file —
 * it is a REPORT, so an unreadable journal answers with an empty list rather
 * than blocking a redemption or a read.
 */

const JOURNAL_NAME = "codex-reset-credits.ndjson";
const ROTATE_BYTES = 2 * 1024 * 1024;

export type ResetCreditActor =
  | { kind: "operator" }
  | { kind: "agent"; conversationId: string };

/** The governing window at one moment: the fullest window the probe reported. */
export interface ResetCreditWindowSummary {
  usedPercent: number;
  resetsAt: number | null;
  windowDurationMins: number | null;
}

export interface ResetCreditJournalEntry {
  at: string;
  engine: "codex";
  accountId: string;
  accountKind: "legacy" | "managed";
  actor: ResetCreditActor;
  idempotencyKey: string;
  /** The backend's answer, or `consume_failed` when no answer arrived. */
  outcome: AppServerResetCreditOutcome | "consume_failed";
  /** True when the pre-read showed no credit and nothing was sent. */
  refusedLocally: boolean;
  before: { availableCount: number | null; window: ResetCreditWindowSummary | null };
  after: { availableCount: number | null; window: ResetCreditWindowSummary | null } | null;
  /** Redacted failure text when `outcome` is `consume_failed`. */
  detail: string | null;
}

function journalFile(): string {
  return statePath(JOURNAL_NAME);
}

/** The window a reset would open: the fullest one the snapshot carries. */
export function governingWindowSummary(rateLimits: AppServerRateLimits | null | undefined): ResetCreditWindowSummary | null {
  if (!rateLimits) return null;
  const windows = [rateLimits.primary, rateLimits.secondary].filter((window) => window !== null);
  const governing = windows.sort((left, right) => right.usedPercent - left.usedPercent)[0];
  return governing ? { usedPercent: governing.usedPercent, resetsAt: governing.resetsAt, windowDurationMins: governing.windowDurationMins } : null;
}

/** Appends one entry; returns false when the write failed so the caller can
    say the redemption happened but its record did not. */
export function appendResetCreditJournal(entry: ResetCreditJournalEntry): boolean {
  const file = journalFile();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      if (fs.statSync(file).size > ROTATE_BYTES) fs.renameSync(file, file + ".1");
    } catch {
      /* first write */
    }
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", { encoding: "utf8", mode: 0o600 });
    return true;
  } catch (error) {
    console.error("[reset-credits] journal append failed", error);
    return false;
  }
}

function isEntry(value: unknown): value is ResetCreditJournalEntry {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ResetCreditJournalEntry>;
  return typeof record.at === "string" && record.engine === "codex" && typeof record.accountId === "string"
    && typeof record.outcome === "string" && typeof record.idempotencyKey === "string" && typeof record.actor === "object" && record.actor !== null;
}

/** Newest entries first, at most `limit`; a missing or damaged journal reads as empty. */
export function readResetCreditJournal(limit = 20): ResetCreditJournalEntry[] {
  let text: string;
  try { text = fs.readFileSync(journalFile(), "utf8"); } catch { return []; }
  const entries: ResetCreditJournalEntry[] = [];
  for (const line of text.split("\n").reverse()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isEntry(parsed)) entries.push(parsed);
    } catch {
      /* a torn tail line is not a record */
    }
    if (entries.length >= limit) break;
  }
  return entries;
}
