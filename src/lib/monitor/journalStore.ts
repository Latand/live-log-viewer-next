import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { procBackend } from "@/lib/proc";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";

import {
  SEAT_TICK_WAKE_REASON_KINDS,
  type MonitorOutcome,
  type MonitorRunRecord,
  type MonitorSkip,
  type RequestState,
  type SeatTickRunRecord,
  type SeatTickVerdictKind,
  type SeatTickWakeReasonKind,
} from "./types";

/**
 * Server side of the monitor's audit journal and single-flight lock (#741).
 *
 * The monitor process itself never touches these files: it reaches them over
 * `/api/monitor/runs` and `/api/monitor/lock`, the same way it reaches board
 * cards and conversations. Everything that opens a file descriptor lives here,
 * inside the viewer, which is what makes "go through the API rather than state
 * files" true of the monitor rather than merely intended.
 *
 * Two properties this file exists to guarantee:
 *
 * 1. **A run always leaves a line.** The mechanism this replaces wrote nothing
 *    on success, so an empty log meant either flawless operation or total
 *    failure. Now "no line" means "no run".
 * 2. **The claim is atomic.** A read-then-write lock lets two runs both observe
 *    "free" and both proceed, and two monitors racing over one board create
 *    duplicate cards. The claim is an `O_EXCL` create serialized through the
 *    shared file transaction, so exactly one contender wins.
 */

/** Runs retained before the oldest are dropped. */
export const MONITOR_RUN_HISTORY = 200;
/** A lock whose owner cannot be proven alive is reclaimable after this long. */
const LOCK_STALE_AFTER_MS = 30 * 60 * 1000;
const DETAIL_LIMIT = 800;
const FINGERPRINTS_LIMIT = 500;

export function monitorJournalPath(): string {
  return process.env.LLV_MONITOR_AUDIT_FILE?.trim() || statePath(path.join("conversation-monitor", "runs.ndjson"));
}

export function monitorLockPath(): string {
  return `${monitorJournalPath()}.lock`;
}

const REQUEST_STATES: RequestState[] = ["completed", "in-flight", "stalled", "untracked", "awaiting-confirmation"];
const OUTCOMES: MonitorOutcome[] = ["clean", "failed", "skipped"];
const SKIP_REASONS: MonitorSkip["reason"][] = ["already-tracked", "card-budget", "dry-run"];

function text(value: unknown, limit: number): string | null {
  return typeof value === "string" ? value.slice(0, limit) : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * Accept only a record shaped like an audit line, and keep only the fields the
 * journal is allowed to carry. A caller that tried to smuggle transcript text
 * or a path through an extra property loses it here, at the boundary, rather
 * than on the honour system.
 */
export function sanitizeRunRecord(value: unknown): MonitorRunRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const runId = text(raw.runId, 100);
  const outcome = OUTCOMES.find((candidate) => candidate === raw.outcome);
  if (raw.schemaVersion !== 1 || !runId || !outcome) return null;

  const window = (raw.window ?? {}) as Record<string, unknown>;
  const scope = (raw.scope ?? {}) as Record<string, unknown>;
  const orchestrator = (raw.orchestrator ?? {}) as Record<string, unknown>;
  const scanned = (raw.scanned ?? {}) as Record<string, unknown>;
  const found = (raw.found ?? {}) as Record<string, unknown>;
  const byStateRaw = (found.byState ?? {}) as Record<string, unknown>;
  const byState = Object.fromEntries(REQUEST_STATES.map((state) => [state, count(byStateRaw[state])])) as Record<RequestState, number>;

  const creations = Array.isArray(raw.created) ? raw.created : [];
  const skips = Array.isArray(raw.skipped) ? raw.skipped : [];

  return {
    schemaVersion: 1,
    runId,
    startedAt: text(raw.startedAt, 40) ?? "",
    finishedAt: text(raw.finishedAt, 40) ?? "",
    outcome,
    detail: text(raw.detail, DETAIL_LIMIT),
    window: { from: text(window.from, 40) ?? "", to: text(window.to, 40) ?? "", hours: count(window.hours) },
    scope: { project: text(scope.project, 200) },
    orchestrator: {
      resolution: (text(orchestrator.resolution, 40) ?? "unavailable") as MonitorRunRecord["orchestrator"]["resolution"],
      conversationId: text(orchestrator.conversationId, 100),
      delivered: orchestrator.delivered === true,
    },
    scanned: { conversations: count(scanned.conversations), operatorMessages: count(scanned.operatorMessages) },
    found: {
      total: count(found.total),
      byState,
      fingerprints: (Array.isArray(found.fingerprints) ? found.fingerprints : [])
        .filter((entry): entry is string => typeof entry === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(entry))
        .slice(0, FINGERPRINTS_LIMIT),
    },
    created: creations.flatMap((entry) => {
      const creation = (entry ?? {}) as Record<string, unknown>;
      const fingerprint = text(creation.fingerprint, 64);
      const taskId = text(creation.taskId, 100);
      if (!fingerprint || !taskId) return [];
      return [{ fingerprint, taskId, state: (text(creation.state, 40) ?? "untracked") as MonitorRunRecord["created"][number]["state"] }];
    }).slice(0, FINGERPRINTS_LIMIT),
    skipped: skips.flatMap((entry) => {
      const skip = (entry ?? {}) as Record<string, unknown>;
      const fingerprint = text(skip.fingerprint, 64);
      const reason = SKIP_REASONS.find((candidate) => candidate === skip.reason);
      if (!fingerprint || !reason) return [];
      return [{ fingerprint, reason }];
    }).slice(0, FINGERPRINTS_LIMIT),
  };
}

/**
 * The append half of an audit journal, for any record type.
 *
 * Generalized for the seat tick (#1245), which keeps its own journal of one
 * line per check under the same two guarantees this file exists to give: the
 * append is serialized against the retention rewrite, and every run leaves a
 * line so "no line" means "no run".
 */
export function appendJournalRecord(record: unknown, options: { filePath: string; retention: number; busyMessage: string }): void {
  fs.mkdirSync(path.dirname(options.filePath), { recursive: true, mode: 0o700 });
  /* Serialized, so a concurrent append cannot interleave with the retention
     rewrite below and lose a line. */
  withFileTransactionSync(options.filePath, options.busyMessage, () => {
    fs.appendFileSync(options.filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    trim(options.filePath, options.retention);
  });
}

/** The newest `limit` records, oldest first. A malformed line is skipped rather
    than allowed to hide the runs recorded around it. */
export function readJournalRecords<T>(limit: number, options: { filePath: string; sanitize: (value: unknown) => T | null }): T[] {
  let raw: string;
  try {
    raw = fs.readFileSync(options.filePath, "utf8");
  } catch {
    return [];
  }
  const records: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = options.sanitize(JSON.parse(line) as unknown);
      if (record) records.push(record);
    } catch {
      continue;
    }
  }
  return records.slice(-Math.max(0, limit));
}

export function appendRunRecord(record: MonitorRunRecord, filePath = monitorJournalPath()): void {
  appendJournalRecord(record, { filePath, retention: MONITOR_RUN_HISTORY, busyMessage: "the monitor journal is busy" });
}

function trim(filePath: string, retention: number): void {
  let lines: string[];
  try {
    lines = fs.readFileSync(filePath, "utf8").split("\n").filter((line) => line.trim());
  } catch {
    return;
  }
  if (lines.length <= retention) return;
  const temp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${lines.slice(-retention).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, filePath);
}

export function readRunRecords(limit: number, filePath = monitorJournalPath()): MonitorRunRecord[] {
  return readJournalRecords(limit, { filePath, sanitize: sanitizeRunRecord });
}

/* ------------------------------------------------------------------------- *
 * The seat tick's own journal (#1245), on the same two guarantees.
 *
 * It answers the failure mode nothing on disk could answer before: absence. A
 * seat with no tick left no artifact, so a successor could not tell it was
 * missing one, and the operator could not tell how often the predecessor had
 * been ticking — the successor that finally found a predecessor's schedule
 * guessed both numbers from its transcript. Every check leaves a line here,
 * including a check that threw and a second clock refused at start, so "no
 * line" means "no check" and the cadence is a readable fact.
 * ------------------------------------------------------------------------- */

/** Checks retained before the oldest are dropped. At a five-minute cadence this
    is a bit over a day of history per project, which is the window anything
    diagnosing a tick actually looks at. */
export const SEAT_TICK_RUN_HISTORY = 500;

const SEAT_TICK_VERDICTS: SeatTickVerdictKind[] = ["quiet", "wake", "proactive", "no-seat", "skipped", "error", "refused"];

export function seatTickJournalPath(): string {
  return process.env.LLV_SEAT_TICK_AUDIT_FILE?.trim() || statePath(path.join("seat-tick", "runs.ndjson"));
}

/**
 * Accept only a record shaped like a check line, and keep only the fields the
 * journal is allowed to carry — the same boundary {@link sanitizeRunRecord}
 * draws for a monitor run, for the same reason: a caller that tried to smuggle
 * transcript text, a path or an extra property through loses it here rather
 * than on the honour system.
 */
export function sanitizeSeatTickRecord(value: unknown): SeatTickRunRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const project = text(raw.project, 200) ?? "";
  const verdict = SEAT_TICK_VERDICTS.find((candidate) => candidate === raw.verdict);
  if (raw.schemaVersion !== 1 || !verdict) return null;
  /* Every line names the project it decided about — except the refusal of a
     second clock, which is about the process and no project in particular. A
     nameless line of any other kind is a line nothing can be read out of. */
  if (!project && verdict !== "refused") return null;

  const delivery = (raw.delivery ?? null) as Record<string, unknown> | null;
  const clientMessageId = delivery ? text(delivery.clientMessageId, 200) : null;
  const outcome = delivery ? text(delivery.outcome, 60) : null;

  return {
    schemaVersion: 1,
    at: text(raw.at, 40) ?? "",
    project,
    seatEpoch: typeof raw.seatEpoch === "number" && Number.isSafeInteger(raw.seatEpoch) ? raw.seatEpoch : null,
    verdict,
    reasons: (Array.isArray(raw.reasons) ? raw.reasons : [])
      .filter((entry): entry is SeatTickWakeReasonKind => SEAT_TICK_WAKE_REASON_KINDS.includes(entry as SeatTickWakeReasonKind)),
    items: count(raw.items),
    deferred: count(raw.deferred),
    eventsThrough: count(raw.eventsThrough),
    delivery: clientMessageId && outcome ? { clientMessageId, outcome } : null,
    detail: text(raw.detail, DETAIL_LIMIT),
  };
}

export function appendSeatTickRecord(record: SeatTickRunRecord, filePath = seatTickJournalPath()): void {
  appendJournalRecord(record, { filePath, retention: SEAT_TICK_RUN_HISTORY, busyMessage: "the seat tick journal is busy" });
}

/** The newest `limit` checks, oldest first. */
export function readSeatTickRecords(limit: number, filePath = seatTickJournalPath()): SeatTickRunRecord[] {
  return readJournalRecords(limit, { filePath, sanitize: sanitizeSeatTickRecord });
}

export type MonitorLockClaim =
  | { claimed: true; token: string }
  | { claimed: false; detail: string };

interface LockOptions {
  lockPath?: string;
  pidAlive?: (pid: number) => boolean;
  now?: () => number;
  staleAfterMs?: number;
}

interface LockOwner {
  pid: number;
  token: string;
  at: string;
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<LockOwner>;
    if (typeof parsed.pid !== "number" || typeof parsed.token !== "string") return null;
    return { pid: parsed.pid, token: parsed.token, at: typeof parsed.at === "string" ? parsed.at : "" };
  } catch {
    return null;
  }
}

/**
 * Take the single-flight lock, or report who holds it.
 *
 * The create is `wx` — an atomic "fail if it exists" — and the whole
 * read/steal/create sequence runs inside the shared file transaction, so two
 * contenders cannot both conclude the lock is free. A holder that is provably
 * gone (dead pid) or impossibly old is reclaimed; anything else loses.
 */
export function claimMonitorRun(options: LockOptions = {}): MonitorLockClaim {
  const lockPath = options.lockPath ?? monitorLockPath();
  const pidAlive = options.pidAlive ?? ((pid: number) => procBackend.pidAlive(pid));
  const now = options.now ?? Date.now;
  const staleAfterMs = options.staleAfterMs ?? LOCK_STALE_AFTER_MS;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  return withFileTransactionSync(lockPath, "the monitor lock is busy", (): MonitorLockClaim => {
    const token = crypto.randomUUID();
    const write = (): MonitorLockClaim => {
      const descriptor = fs.openSync(lockPath, "wx", 0o600);
      try {
        fs.writeFileSync(descriptor, JSON.stringify({ pid: process.pid, token, at: new Date(now()).toISOString() }), "utf8");
      } finally {
        fs.closeSync(descriptor);
      }
      return { claimed: true, token };
    };

    if (!fs.existsSync(lockPath)) return write();
    const owner = readOwner(lockPath);
    const at = owner ? Date.parse(owner.at) : NaN;
    const expired = !Number.isFinite(at) || now() - at > staleAfterMs;
    if (owner && pidAlive(owner.pid) && !expired) {
      return { claimed: false, detail: "another monitor run holds the lock" };
    }
    /* Provably abandoned: a crashed run, or one so old it cannot still be
       running. Remove and re-create rather than overwrite, so the create stays
       the exclusive operation. */
    fs.rmSync(lockPath, { force: true });
    return write();
  });
}

/** Release the lock, but only for the run that holds it: a late release from a
    superseded run must never free the lock its successor is holding. */
export function releaseMonitorRun(token: string, options: LockOptions = {}): boolean {
  const lockPath = options.lockPath ?? monitorLockPath();
  if (!fs.existsSync(lockPath)) return false;
  return withFileTransactionSync(lockPath, "the monitor lock is busy", () => {
    const owner = readOwner(lockPath);
    if (!owner || owner.token !== token) return false;
    fs.rmSync(lockPath, { force: true });
    return true;
  });
}
