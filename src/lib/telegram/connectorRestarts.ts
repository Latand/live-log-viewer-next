import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

import { ensureTelegramStateDir } from "./sessionStore";

/**
 * Visible connector restarts (issue #1087), in two steps. A death is persisted
 * the moment it is DETECTED, as a structured-only crash record — exit code,
 * signal and timestamp are the whole record, because connector stderr can carry
 * chat titles, usernames and message text. It becomes a COUNTED restart only
 * once a replacement has verified: a respawn that never came back is a standing
 * failure, not a completed restart.
 */

export type TelegramConnectorCrash = { at: string; exitCode: number | null; signal: string | null };

export type TelegramConnectorRestarts = {
  version: 1;
  /** Replacements that verified. */
  restarts: number;
  lastRestartAt: string | null;
  /** Counted restarts, newest first, capped so a crash loop cannot grow the file. */
  recent: TelegramConnectorCrash[];
  /** A detected death whose replacement has not verified yet. */
  pending: TelegramConnectorCrash | null;
};

const RESTARTS_FILE = "restarts.json";
const RECENT_LIMIT = 64;

/** The window the status payload counts restarts over. */
export const RESTART_COUNT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How long after a counted restart a failed call reads as a restart drop. */
export const RESTART_GRACE_MS = 30_000;

const NO_RESTARTS: TelegramConnectorRestarts = Object.freeze({ version: 1, restarts: 0, lastRestartAt: null, recent: [], pending: null }) as TelegramConnectorRestarts;

function restartsPath(): string {
  return statePath("telegram", RESTARTS_FILE);
}

function asCrash(value: unknown): TelegramConnectorCrash | null {
  const row = value as Partial<TelegramConnectorCrash> | null;
  if (!row || typeof row !== "object" || typeof row.at !== "string" || Number.isNaN(Date.parse(row.at))) return null;
  if (!(row.exitCode === null || typeof row.exitCode === "number") || !(row.signal === null || typeof row.signal === "string")) return null;
  return { at: row.at, exitCode: row.exitCode ?? null, signal: row.signal ?? null };
}

/** Absent, unreadable or malformed state means "no restarts known" — this is a
    diagnostic surface and must never fail a status read. */
export function readConnectorRestarts(): TelegramConnectorRestarts {
  try {
    if (ensureTelegramStateDir(false) === null) return NO_RESTARTS;
    const row = JSON.parse(fs.readFileSync(restartsPath(), "utf8")) as Partial<TelegramConnectorRestarts>;
    if (row.version !== 1 || typeof row.restarts !== "number" || !Number.isFinite(row.restarts)) return NO_RESTARTS;
    const recent = (Array.isArray(row.recent) ? row.recent : []).map(asCrash);
    return {
      version: 1,
      restarts: Math.max(0, Math.trunc(row.restarts)),
      lastRestartAt: typeof row.lastRestartAt === "string" ? row.lastRestartAt : null,
      recent: recent.filter((crash): crash is TelegramConnectorCrash => crash !== null).slice(0, RECENT_LIMIT),
      pending: asCrash(row.pending),
    };
  } catch {
    return NO_RESTARTS;
  }
}

/** Owner-only, atomic, and never throws: a diagnostic write must not take down
    the supervisor path that produced it. */
function writeConnectorRestarts(next: TelegramConnectorRestarts): void {
  const target = restartsPath();
  const tmp = path.join(path.dirname(target), `.${RESTARTS_FILE}.${process.pid}.tmp`);
  try {
    ensureTelegramStateDir(true);
    fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(tmp, target);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* nothing else to clean */ }
  }
}

/** Detection. The first detection of a death wins, so the exit code a watched
    child reported is not overwritten by the pid-file sweep that notices the
    same death without one. */
export function recordConnectorCrash(crash: { exitCode: number | null; signal: string | null }, now: number = Date.now()): void {
  const previous = readConnectorRestarts();
  if (previous.pending) return;
  writeConnectorRestarts({ ...previous, pending: { at: new Date(now).toISOString(), ...crash } });
}

/** Completion: a replacement verified, so the detected death becomes a counted
    restart, timed from the death itself. With nothing detected this is a no-op
    — a first spawn or an operator reconnect is not a restart. */
export function confirmConnectorRestart(): void {
  const previous = readConnectorRestarts();
  const pending = previous.pending;
  if (!pending) return;
  writeConnectorRestarts({
    version: 1,
    restarts: previous.restarts + 1,
    lastRestartAt: pending.at,
    recent: [pending, ...previous.recent].slice(0, RECENT_LIMIT),
    pending: null,
  });
}

export function restartsWithin(windowMs: number, now = Date.now(), state = readConnectorRestarts()): number {
  return state.recent.filter((crash) => now - Date.parse(crash.at) < windowMs).length;
}

export function restartedWithin(windowMs: number, now = Date.now(), state = readConnectorRestarts()): boolean {
  if (state.lastRestartAt === null) return false;
  const since = now - Date.parse(state.lastRestartAt);
  return Number.isFinite(since) && since >= 0 && since < windowMs;
}

type ExitWatchable = { once?(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown };

/** Detects the exit of a connector this Viewer spawned, unless the Viewer asked
    for it — a logout or a health-check stop is not a crash. A connector adopted
    from an earlier Viewer generation has no exit channel here; its death is
    detected from the pid file by the supervisor instead. */
export function watchConnectorCrash(child: ExitWatchable, expected: () => boolean, now: () => number = Date.now): void {
  child.once?.("exit", (code, signal) => {
    if (expected()) return;
    recordConnectorCrash({ exitCode: typeof code === "number" ? code : null, signal: signal ?? null }, now());
  });
}
