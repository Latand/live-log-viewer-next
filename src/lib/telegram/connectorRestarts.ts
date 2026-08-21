import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";

import { ensureTelegramStateDir } from "./sessionStore";

/**
 * Visible connector restarts (issue #1087).
 *
 * The supervisor used to respawn a crashed connector silently: the status
 * surface kept saying `connected` while in-flight agent calls were dropped.
 * This module is the durable memory of those respawns — a count, the last
 * restart time, and a STRUCTURED-ONLY crash record.
 *
 * Structured-only is deliberate: exit code, signal and timestamp are the whole
 * record. The connector's stderr can carry chat titles, usernames and message
 * text, so no line of it is ever persisted here or projected to the browser.
 */

export type TelegramConnectorCrash = {
  at: string;
  exitCode: number | null;
  signal: string | null;
};

export type TelegramConnectorRestarts = {
  version: 1;
  /** Restarts recorded since the file was created. */
  restarts: number;
  lastRestartAt: string | null;
  /** Newest first, capped: enough to count a day's restarts, bounded so a
      crash loop cannot grow the file without limit. */
  recent: TelegramConnectorCrash[];
};

const RESTARTS_FILE = "restarts.json";
const RECENT_LIMIT = 64;

/** The window the status payload counts restarts over. */
export const RESTART_COUNT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How long after a recorded restart a failed call reads as a restart drop. */
export const RESTART_GRACE_MS = 30_000;

const NO_RESTARTS: TelegramConnectorRestarts = Object.freeze({ version: 1, restarts: 0, lastRestartAt: null, recent: [] }) as TelegramConnectorRestarts;

function restartsPath(): string {
  return statePath("telegram", RESTARTS_FILE);
}

function isCrash(value: unknown): value is TelegramConnectorCrash {
  const row = value as Partial<TelegramConnectorCrash> | null;
  return Boolean(row && typeof row === "object"
    && typeof row.at === "string" && !Number.isNaN(Date.parse(row.at))
    && (row.exitCode === null || typeof row.exitCode === "number")
    && (row.signal === null || typeof row.signal === "string"));
}

/** Absent, unreadable or malformed state means "no restarts known" — this is
    a diagnostic surface and must never fail a status read. */
export function readConnectorRestarts(): TelegramConnectorRestarts {
  try {
    if (ensureTelegramStateDir(false) === null) return NO_RESTARTS;
    const row = JSON.parse(fs.readFileSync(restartsPath(), "utf8")) as Partial<TelegramConnectorRestarts>;
    if (row.version !== 1 || typeof row.restarts !== "number" || !Number.isFinite(row.restarts)) return NO_RESTARTS;
    return {
      version: 1,
      restarts: Math.max(0, Math.trunc(row.restarts)),
      lastRestartAt: typeof row.lastRestartAt === "string" ? row.lastRestartAt : null,
      recent: Array.isArray(row.recent) ? row.recent.filter(isCrash).slice(0, RECENT_LIMIT) : [],
    };
  } catch {
    return NO_RESTARTS;
  }
}

/** Appends one restart. Owner-only, atomic, and never throws: a diagnostic
    write must not take down the supervisor path that produced it. */
export function recordConnectorRestart(
  crash: { exitCode: number | null; signal: string | null },
  now: number = Date.now(),
): void {
  const previous = readConnectorRestarts();
  const at = new Date(now).toISOString();
  const next: TelegramConnectorRestarts = {
    version: 1,
    restarts: previous.restarts + 1,
    lastRestartAt: at,
    recent: [{ at, exitCode: crash.exitCode, signal: crash.signal }, ...previous.recent].slice(0, RECENT_LIMIT),
  };
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

export function restartsWithin(
  windowMs: number,
  now: number = Date.now(),
  state: TelegramConnectorRestarts = readConnectorRestarts(),
): number {
  return state.recent.filter((crash) => now - Date.parse(crash.at) < windowMs).length;
}

export function restartedWithin(
  windowMs: number,
  now: number = Date.now(),
  state: TelegramConnectorRestarts = readConnectorRestarts(),
): boolean {
  if (state.lastRestartAt === null) return false;
  const since = now - Date.parse(state.lastRestartAt);
  return Number.isFinite(since) && since >= 0 && since < windowMs;
}

type ExitWatchable = {
  once?(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
};

/** Records the exit of a connector this Viewer spawned, unless the Viewer
    asked for it — a logout or a health-check stop is not a crash. Only a
    child of this process can report an exit code at all; a connector adopted
    from an earlier Viewer generation exits unobserved. */
export function watchConnectorCrash(
  child: ExitWatchable,
  expected: () => boolean,
  now: () => number = Date.now,
): void {
  child.once?.("exit", (code, signal) => {
    if (expected()) return;
    recordConnectorRestart({ exitCode: typeof code === "number" ? code : null, signal: signal ?? null }, now());
  });
}
