import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { procBackend } from "@/lib/proc";

import type { MonitorRunRecord } from "./types";

/**
 * The monitor's own audit trail (issue #741).
 *
 * The mechanism this replaces wrote nothing at all on success, so its log was
 * empty whether it had worked perfectly or died on the first call — a silent
 * failure and a silent success were the same artifact. Every run therefore
 * appends exactly one record here, including a run that found nothing and a
 * run that deliberately did not scan: "no line" now means "no run".
 *
 * This journal is the monitor's own artifact, not viewer domain state — board
 * work, conversations and pipelines are still reached only through the Viewer
 * API. What lands here is fingerprints, counts and machine ids: no transcript
 * text, no filesystem path, no account identity.
 */

/** Runs retained before the oldest are dropped. */
export const MONITOR_RUN_HISTORY = 200;

export function monitorJournalPath(): string {
  return process.env.LLV_MONITOR_AUDIT_FILE?.trim() || statePath(path.join("conversation-monitor", "runs.ndjson"));
}

export function monitorLockPath(): string {
  return `${monitorJournalPath()}.lock`;
}

export function appendRunRecord(record: MonitorRunRecord, filePath = monitorJournalPath()): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  trim(filePath);
}

/** Rewrite the journal down to the retention cap once it overruns it. */
function trim(filePath: string): void {
  let lines: string[];
  try {
    lines = fs.readFileSync(filePath, "utf8").split("\n").filter((line) => line.trim());
  } catch {
    return;
  }
  if (lines.length <= MONITOR_RUN_HISTORY) return;
  const kept = lines.slice(-MONITOR_RUN_HISTORY).join("\n");
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${kept}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, filePath);
}

function isRunRecord(value: unknown): value is MonitorRunRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<MonitorRunRecord>;
  return record.schemaVersion === 1 && typeof record.runId === "string" && typeof record.outcome === "string";
}

/** The newest `limit` runs, oldest first. Malformed lines are skipped rather
    than allowed to hide the runs recorded around them. */
export function readRunRecords(limit: number, filePath = monitorJournalPath()): MonitorRunRecord[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const records: MonitorRunRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRunRecord(parsed)) records.push(parsed);
    } catch {
      continue;
    }
  }
  return records.slice(-Math.max(0, limit));
}

export type MonitorClaim =
  | { claimed: true; release(): void }
  | { claimed: false; detail: string };

interface ClaimOptions {
  lockPath?: string;
  pidAlive?: (pid: number) => boolean;
  now?: () => number;
  /** A lock whose owner cannot be proven alive is reclaimed after this long. */
  staleAfterMs?: number;
}

/**
 * Single-flight admission. Two overlapping runs would classify the same
 * requests against the same board and race to create the same cards, so the
 * loser reports `skipped` instead — a recorded decision, not a silent exit.
 */
export function claimMonitorRun(options: ClaimOptions = {}): MonitorClaim {
  const lockPath = options.lockPath ?? monitorLockPath();
  const pidAlive = options.pidAlive ?? ((pid: number) => procBackend.pidAlive(pid));
  const now = options.now ?? Date.now;
  const staleAfterMs = options.staleAfterMs ?? 30 * 60 * 1000;

  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const write = (): MonitorClaim => {
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: new Date(now()).toISOString() }), {
      encoding: "utf8",
      mode: 0o600,
    });
    return { claimed: true, release: () => fs.rmSync(lockPath, { force: true }) };
  };

  let held: { pid?: unknown; at?: unknown };
  try {
    held = JSON.parse(fs.readFileSync(lockPath, "utf8")) as typeof held;
  } catch (error) {
    /* No lock at all, or one written by a run that died mid-write. Either way
       nothing provable owns it. */
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return write();
    return write();
  }
  const pid = typeof held.pid === "number" ? held.pid : null;
  const at = typeof held.at === "string" ? Date.parse(held.at) : NaN;
  const expired = Number.isFinite(at) && now() - at > staleAfterMs;
  if (pid !== null && pidAlive(pid) && !expired) {
    return { claimed: false, detail: "another monitor run holds the lock" };
  }
  return write();
}
