import crypto from "node:crypto";
import fs from "node:fs";

import { statePath } from "@/lib/configDir";
import { writeJsonDurably } from "@/lib/state/durableJson";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";
import { hardenedRedact } from "@/lib/view/compactText";

import {
  BRIDGE_CHANNEL_SCHEMA_VERSION,
  BRIDGE_DRAIN_BATCH_MAX,
  BRIDGE_REPORT_BODY_MAX_BYTES,
  BRIDGE_REPORT_CAPACITY,
  BRIDGE_REPORT_LOG_SCHEMA_VERSION,
  BRIDGE_RETIRED_ID_CAPACITY,
  isBridgeReportClass,
  MANAGER_RECORD_REF,
  type BridgeChannelV1,
  type BridgeChannelScope,
  type BridgeConfirmation,
  type BridgeReportBatch,
  type BridgeReportInput,
  type BridgeReportLogV1,
  type BridgeReportOrigin,
  type BridgeReportV1,
} from "./types";

/**
 * The bridge's durable half: channel state (which root, which manager record,
 * how far the gateway has read) and the append-only report log.
 *
 * Modelled on `src/lib/lifecycle/journal.ts` deliberately — monotonic seq,
 * idempotent append keyed by a caller-stable string, capacity trim with retired
 * ids, one file transaction per write. That journal is the tested shape for "an
 * append-only record a late replay cannot duplicate", and the bridge needs
 * exactly that property for a manager that retries a report after its host died.
 *
 * Two files rather than one, because they have different writers and different
 * failure meanings: the manager appends reports, the gateway advances the
 * cursor, and a busy log must not block a cursor write.
 */

const BRIDGE_CHANNEL_BUSY = "bridge channel is busy";
const BRIDGE_LOG_BUSY = "bridge report log is busy";

function bridgeChannelKey(scope: BridgeChannelScope): string {
  return crypto.createHash("sha256")
    .update(`${scope.project}\0${scope.seatConversationId}`)
    .digest("hex")
    .slice(0, 32);
}

export function bridgeChannelPath(scope?: BridgeChannelScope): string {
  return scope
    ? statePath("bridge-channels", `${bridgeChannelKey(scope)}.json`)
    : statePath("bridge.json");
}

function bridgeChannelPathFromKey(key: string): string {
  return statePath("bridge-channels", `${key}.json`);
}

export function bridgeReportLogPath(): string {
  return statePath("bridge-reports.json");
}

/**
 * Raised when a bridge file exists but cannot be read as one. Fatal by design,
 * for the reason `LifecycleJournalCorruptError` is: a truncated write that read
 * as "nothing here yet" would restart `lastSeq` at 0, and a gateway cursor
 * sitting above a reset `lastSeq` is permanently deaf to the manager with
 * nothing anywhere saying so.
 */
export class BridgeStateCorruptError extends Error {
  readonly statePath: string;

  constructor(target: string, detail: string) {
    super(`the bridge state at ${target} is unreadable (${detail}); move it aside to start a new one`);
    this.name = "BridgeStateCorruptError";
    this.statePath = target;
  }
}

export function bridgeReportId(key: string): string {
  return `rpt_${crypto.createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
}

/**
 * Bodies are prose the gateway may read aloud, so unlike a lifecycle summary
 * this keeps the manager's own line structure. What it does not keep: secrets,
 * and anything past the byte cap.
 */
export function bridgeReportBody(value: string | null | undefined): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const redacted = hardenedRedact(value).trim();
  const bytes = Buffer.from(redacted, "utf8");
  if (bytes.byteLength <= BRIDGE_REPORT_BODY_MAX_BYTES) return redacted;
  /* Truncate on a scalar boundary: `toString` on a slice that splits a
     multi-byte sequence yields U+FFFD, which would be a silent corruption of
     text the gateway is about to speak. The ellipsis has to fit too. */
  const marker = "…";
  const budget = BRIDGE_REPORT_BODY_MAX_BYTES - Buffer.byteLength(marker, "utf8");
  let end = budget;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return `${bytes.subarray(0, end).toString("utf8")}${marker}`;
}

function readJsonFile(target: string): unknown | null {
  let contents: string;
  try {
    contents = fs.readFileSync(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new BridgeStateCorruptError(target, `it could not be read: ${(error as Error).message}`);
  }
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new BridgeStateCorruptError(target, "it is not valid JSON — the last write was truncated");
  }
}

function normalizeConfirmation(value: unknown): BridgeConfirmation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<BridgeConfirmation>;
  if (typeof candidate.sha !== "string" || typeof candidate.nonce !== "string") return undefined;
  if (typeof candidate.expiresAt !== "string") return undefined;
  return {
    sha: candidate.sha,
    nonce: candidate.nonce,
    expiresAt: candidate.expiresAt,
    ...(typeof candidate.consumedAt === "string" ? { consumedAt: candidate.consumedAt } : {}),
  };
}

function normalizeOrigin(value: unknown): BridgeReportOrigin | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as { kind?: unknown; conversationId?: unknown; role?: unknown };
  if (candidate.kind !== "manager" && candidate.kind !== "agent" && candidate.kind !== "gateway" && candidate.kind !== "unidentified") return undefined;
  if (candidate.kind === "unidentified") return { kind: "unidentified", conversationId: null, role: null };
  return {
    kind: candidate.kind,
    conversationId: typeof candidate.conversationId === "string" ? candidate.conversationId : null,
    role: typeof candidate.role === "string" ? candidate.role : null,
  };
}

function normalizeReport(value: unknown): BridgeReportV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<BridgeReportV1>;
  if (typeof candidate.id !== "string" || !candidate.id) return null;
  if (!Number.isInteger(candidate.seq) || (candidate.seq as number) < 1) return null;
  if (typeof candidate.at !== "string" || !candidate.at) return null;
  if (!isBridgeReportClass(candidate.class)) return null;
  const confirmation = candidate.class === "confirmation_request"
    ? normalizeConfirmation(candidate.confirmation)
    : undefined;
  const origin = normalizeOrigin(candidate.origin);
  const project = typeof candidate.project === "string"
    ? candidate.project
    : candidate.project === null ? null : undefined;
  const targetSeatConversationId = typeof candidate.targetSeatConversationId === "string"
    ? candidate.targetSeatConversationId
    : candidate.targetSeatConversationId === null ? null : undefined;
  return {
    id: candidate.id,
    seq: candidate.seq as number,
    at: candidate.at,
    class: candidate.class,
    body: typeof candidate.body === "string" ? candidate.body : "",
    ...(origin ? { origin } : {}),
    ...(project !== undefined ? { project } : {}),
    ...(targetSeatConversationId !== undefined ? { targetSeatConversationId } : {}),
    ...(typeof candidate.correlatesDirective === "string" ? { correlatesDirective: candidate.correlatesDirective } : {}),
    ...(confirmation ? { confirmation } : {}),
  };
}

function emptyLog(): BridgeReportLogV1 {
  return {
    schemaVersion: BRIDGE_REPORT_LOG_SCHEMA_VERSION,
    lastSeq: 0,
    trimmedThroughSeq: 0,
    trimmedThroughByChannel: {},
    reports: [],
    retired: [],
  };
}

/** Every recorded row must survive the round trip. A row that does not is
    damage, not noise: dropping it silently would rewrite the manager's history
    on the next append, so it stops the read instead. */
function normalizeLog(value: unknown, target: string): BridgeReportLogV1 {
  if (value === null) return emptyLog();
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeStateCorruptError(target, "its contents are not a report log object");
  }
  const file = value as Partial<BridgeReportLogV1>;
  if (file.reports !== undefined && !Array.isArray(file.reports)) {
    throw new BridgeStateCorruptError(target, "its reports field is not an array");
  }
  const raw = file.reports ?? [];
  const reports: BridgeReportV1[] = [];
  for (const [index, candidate] of raw.entries()) {
    const report = normalizeReport(candidate);
    if (!report) throw new BridgeStateCorruptError(target, `recorded report ${index + 1} of ${raw.length} is malformed`);
    reports.push(report);
  }
  reports.sort((left, right) => left.seq - right.seq);
  const highest = reports.at(-1)?.seq ?? 0;
  const oldest = reports[0]?.seq ?? 0;
  const recordedTrim = Number.isInteger(file.trimmedThroughSeq) ? file.trimmedThroughSeq as number : 0;
  return {
    schemaVersion: BRIDGE_REPORT_LOG_SCHEMA_VERSION,
    lastSeq: Math.max(Number.isInteger(file.lastSeq) ? file.lastSeq as number : 0, highest),
    /* The oldest retained seq is the authority on what was trimmed: a recorded
       value that disagrees would let a gap pass unannounced. */
    trimmedThroughSeq: Math.max(recordedTrim, oldest > 0 ? oldest - 1 : 0),
    trimmedThroughByChannel: file.trimmedThroughByChannel
      && typeof file.trimmedThroughByChannel === "object"
      && !Array.isArray(file.trimmedThroughByChannel)
      ? Object.fromEntries(Object.entries(file.trimmedThroughByChannel)
        .filter((entry): entry is [string, number] =>
          Number.isInteger(entry[1]) && entry[1] > 0))
      : {},
    reports,
    retired: Array.isArray(file.retired) ? file.retired.filter((id): id is string => typeof id === "string") : [],
  };
}

function readLog(): BridgeReportLogV1 {
  const target = bridgeReportLogPath();
  return normalizeLog(readJsonFile(target), target);
}

/** The durable report log exactly as stored. */
export function readBridgeReportLog(): BridgeReportLogV1 {
  return readLog();
}

function normalizeChannel(
  value: unknown,
  target: string,
  scope?: BridgeChannelScope,
): BridgeChannelV1 | null {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BridgeStateCorruptError(target, "its contents are not a channel object");
  }
  const file = value as Partial<BridgeChannelV1>;
  if (typeof file.rootId !== "string" || !file.rootId) return null;
  if (scope && (file.project !== scope.project || file.seatConversationId !== scope.seatConversationId)) {
    throw new BridgeStateCorruptError(target, "its project or seat does not match the scoped channel path");
  }
  const outstanding = file.outstanding;
  return {
    schemaVersion: BRIDGE_CHANNEL_SCHEMA_VERSION,
    rootId: file.rootId,
    ...(scope
      ? { project: scope.project, seatConversationId: scope.seatConversationId }
      : {
        ...(typeof file.project === "string" ? { project: file.project } : {}),
        ...(typeof file.seatConversationId === "string"
          ? { seatConversationId: file.seatConversationId }
          : {}),
      }),
    managerRecordRef: MANAGER_RECORD_REF,
    managerReportCursor: Number.isInteger(file.managerReportCursor) && (file.managerReportCursor as number) > 0
      ? file.managerReportCursor as number
      : 0,
    updatedAt: typeof file.updatedAt === "string" ? file.updatedAt : new Date(0).toISOString(),
    ...(outstanding
      && typeof outstanding === "object"
      && typeof (outstanding as { token?: unknown }).token === "string"
      && Number.isInteger((outstanding as { throughSeq?: unknown }).throughSeq)
      ? { outstanding: outstanding as { token: string; throughSeq: number; issuedAt: string } }
      : {}),
  };
}

/**
 * Record the batch just handed out and mint the token that settles it.
 *
 * Overwrites any previous outstanding batch: a handout supersedes the one before it,
 * and the cursor is monotonic anyway, so a stale token can only ever try to settle a
 * position already passed.
 */
export function issueBridgeAckToken(
  throughSeq: number,
  now = new Date(),
  scope?: BridgeChannelScope,
): string {
  const target = bridgeChannelPath(scope);
  return withFileTransactionSync(target, BRIDGE_CHANNEL_BUSY, () => {
    const current = readBridgeChannel(scope);
    if (!current) throw new Error("the bridge channel is not open");
    const token = scope
      ? `ack_${bridgeChannelKey(scope)}_${crypto.randomBytes(18).toString("hex")}`
      : `ack_${crypto.randomBytes(18).toString("hex")}`;
    writeJsonDurably(target, {
      ...current,
      outstanding: { token, throughSeq, issuedAt: now.toISOString() },
    } satisfies BridgeChannelV1);
    return token;
  });
}

/**
 * Settle the outstanding batch by its token.
 *
 * The seq comes from what was HANDED OUT, never from the caller — so a caller cannot
 * retire reports it never received by naming their sequence.
 */
export function redeemBridgeAckToken(token: string, now = new Date()): { ok: boolean; throughSeq: number } {
  const scopedKey = /^ack_([0-9a-f]{32})_[0-9a-f]{36}$/.exec(token)?.[1];
  const target = scopedKey ? bridgeChannelPathFromKey(scopedKey) : bridgeChannelPath();
  return withFileTransactionSync(target, BRIDGE_CHANNEL_BUSY, () => {
    const current = normalizeChannel(readJsonFile(target), target);
    if (scopedKey && current && (
      !current.project
      || !current.seatConversationId
      || bridgeChannelKey({
        project: current.project,
        seatConversationId: current.seatConversationId,
      }) !== scopedKey
    )) {
      throw new BridgeStateCorruptError(target, "its stored scope does not match its acknowledgement token");
    }
    if (!current?.outstanding || current.outstanding.token !== token) {
      return { ok: false, throughSeq: current?.managerReportCursor ?? 0 };
    }
    const throughSeq = Math.max(current.managerReportCursor, current.outstanding.throughSeq);
    const next: BridgeChannelV1 = {
      ...current,
      managerReportCursor: throughSeq,
      updatedAt: now.toISOString(),
    };
    delete next.outstanding;
    writeJsonDurably(target, next);
    return { ok: true, throughSeq };
  });
}

/** Channel state as stored, or null when the bridge was never opened. */
export function readBridgeChannel(scope?: BridgeChannelScope): BridgeChannelV1 | null {
  const target = bridgeChannelPath(scope);
  return normalizeChannel(readJsonFile(target), target, scope);
}

/**
 * Resolve the channel for this root, creating it on first sight.
 *
 * Idempotent and cursor-preserving: the gateway calls this on every start, and a
 * root rollover calls it with the same `rootId` the lineage minted once — so
 * neither event may reset how far the manager's reports have been consumed.
 */
export function openBridgeChannel(
  rootId: string,
  now = new Date(),
  scope?: BridgeChannelScope,
): BridgeChannelV1 {
  if (!rootId.trim()) throw new Error("bridge channel requires a root identity");
  const target = bridgeChannelPath(scope);
  return withFileTransactionSync(target, BRIDGE_CHANNEL_BUSY, () => {
    const current = readBridgeChannel(scope);
    /* The project seat owns the durable channel and cursor. Root identity
       records its first opener; additional roots preserve the position. */
    if (current) return current;
    const channel: BridgeChannelV1 = {
      schemaVersion: BRIDGE_CHANNEL_SCHEMA_VERSION,
      rootId,
      ...(scope ? { project: scope.project, seatConversationId: scope.seatConversationId } : {}),
      managerRecordRef: MANAGER_RECORD_REF,
      managerReportCursor: 0,
      updatedAt: now.toISOString(),
    };
    writeJsonDurably(target, channel);
    return channel;
  });
}

/**
 * Append every report whose id is not already recorded (or already retired by
 * trimming), in one file transaction. Returns what was actually added, so a
 * manager can tell a genuinely new report from a replay of one it already sent.
 */
export function appendBridgeReports(
  inputs: readonly BridgeReportInput[],
): { appended: BridgeReportV1[]; skipped: number } {
  if (inputs.length === 0) return { appended: [], skipped: 0 };
  return withFileTransactionSync(bridgeReportLogPath(), BRIDGE_LOG_BUSY, () => {
    const file = readLog();
    const known = new Set<string>([...file.reports.map((report) => report.id), ...file.retired]);
    const appended: BridgeReportV1[] = [];
    let skipped = 0;
    for (const input of inputs) {
      const id = bridgeReportId(input.key);
      if (known.has(id)) {
        skipped += 1;
        continue;
      }
      known.add(id);
      file.lastSeq += 1;
      /* Authorization belongs to `confirmation_request` alone. Accepting it on
         any other class would create a second, unreviewed path to a deploy. */
      const confirmation = input.class === "confirmation_request"
        ? normalizeConfirmation(input.confirmation)
        : undefined;
      const report: BridgeReportV1 = {
        id,
        seq: file.lastSeq,
        at: input.at,
        class: input.class,
        body: bridgeReportBody(input.body),
        ...(input.origin ? { origin: normalizeOrigin(input.origin) } : {}),
        ...("project" in input ? { project: typeof input.project === "string" ? input.project : null } : {}),
        ...("targetSeatConversationId" in input
          ? {
            targetSeatConversationId: typeof input.targetSeatConversationId === "string"
              ? input.targetSeatConversationId
              : null,
          }
          : {}),
        ...(input.correlatesDirective ? { correlatesDirective: input.correlatesDirective } : {}),
        ...(confirmation ? { confirmation } : {}),
      };
      file.reports.push(report);
      appended.push(report);
    }
    if (appended.length === 0) return { appended, skipped };
    if (file.reports.length > BRIDGE_REPORT_CAPACITY) {
      const legacyCursor = readBridgeChannel()?.managerReportCursor ?? 0;
      let remaining = file.reports.length - BRIDGE_REPORT_CAPACITY;
      const trimmed: BridgeReportV1[] = [];
      const retained: BridgeReportV1[] = [];
      for (const report of file.reports) {
        /* Unrouted rows are the quarantine. Trimming them would turn "visible
           and waiting" into silent loss, including every pre-#787 row whose
           intended project cannot be reconstructed safely. */
        const quarantined = !report.targetSeatConversationId
          || (report.project == null && report.seq > legacyCursor);
        if (remaining > 0 && !quarantined) {
          trimmed.push(report);
          remaining -= 1;
        } else {
          retained.push(report);
        }
      }
      file.reports = retained;
      const oldestRetained = retained[0]?.seq ?? file.lastSeq + 1;
      file.trimmedThroughSeq = Math.max(file.trimmedThroughSeq, oldestRetained - 1);
      file.trimmedThroughByChannel ??= {};
      for (const report of trimmed) {
        if (!report.project || !report.targetSeatConversationId) continue;
        const key = bridgeChannelKey({
          project: report.project,
          seatConversationId: report.targetSeatConversationId,
        });
        file.trimmedThroughByChannel[key] = Math.max(
          file.trimmedThroughByChannel[key] ?? 0,
          report.seq,
        );
      }
      file.retired = [...file.retired, ...trimmed.map((report) => report.id)].slice(-BRIDGE_RETIRED_ID_CAPACITY);
    }
    writeJsonDurably(bridgeReportLogPath(), file);
    return { appended, skipped };
  });
}

function gapNotice(cursor: number, resumedAtSeq: number, missedThroughSeq: number, at: string): BridgeReportV1 {
  const missed = missedThroughSeq - cursor;
  return {
    id: `rpt_gap_${missedThroughSeq}`,
    /* The notice carries the trimmed head's seq, so acknowledging the batch
       lands the cursor exactly where the surviving history starts. */
    seq: missedThroughSeq,
    at,
    class: "status",
    body: `The bridge report log was trimmed past this conversation's position: ${missed} earlier report(s) are no longer available. Resuming at report ${resumedAtSeq}.`,
    synthetic: true,
  };
}

/**
 * The pending batch for the gateway: oldest first, bounded, from the durable
 * cursor.
 *
 * Read-only — draining does not advance anything. The cursor moves in
 * {@link acknowledgeBridgeReports}, and only after the consumer has actually
 * taken delivery, because a batch lost between here and the call must arrive
 * again rather than vanish.
 */
export function drainBridgeReports(
  options: { limit?: number; now?: Date; scope?: BridgeChannelScope } = {},
): BridgeReportBatch {
  const scope = options.scope;
  const limit = Math.max(1, Math.min(BRIDGE_DRAIN_BATCH_MAX, options.limit ?? BRIDGE_DRAIN_BATCH_MAX));
  const cursor = readBridgeChannel(scope)?.managerReportCursor ?? 0;
  const file = readLog();
  const pending = file.reports.filter((report) =>
    report.seq > cursor
    && (!scope
      || (
        report.project === scope.project
        && report.targetSeatConversationId === scope.seatConversationId
      )));
  const legacyCursor = readBridgeChannel()?.managerReportCursor ?? 0;
  const legacyUnrouted = scope
    ? file.reports.filter((report) =>
      report.project == null && report.seq > legacyCursor).length
    : 0;
  const projectUnrouted = scope
    ? file.reports.filter((report) =>
      report.project === scope.project
      && !report.targetSeatConversationId).length
    : 0;

  /* §7.12 — the log outran this consumer. Resuming at the head is the only
     option left, so the batch says so in a row the gateway will read out rather
     than skipping history in silence. */
  const trimmedThrough = scope
    ? file.trimmedThroughByChannel?.[bridgeChannelKey(scope)] ?? 0
    : file.trimmedThroughSeq;
  const gap = cursor < trimmedThrough
    ? { resumedAtSeq: trimmedThrough + 1, missedThroughSeq: trimmedThrough }
    : null;
  const notice = gap
    ? [gapNotice(cursor, gap.resumedAtSeq, gap.missedThroughSeq, (options.now ?? new Date()).toISOString())]
    : [];
  const reports = [...notice, ...pending].slice(0, limit);
  const throughSeq = reports.reduce((highest, report) => Math.max(highest, report.seq), cursor);
  return {
    reports,
    throughSeq,
    remaining: notice.length + pending.length - reports.length,
    gap,
    ...(scope
      ? {
        unrouted: {
          count: legacyUnrouted + projectUnrouted,
          legacy: legacyUnrouted,
          forProject: projectUnrouted,
        },
      }
      : {}),
  };
}

/**
 * Advance the gateway's durable cursor. Monotonic: a late acknowledgement from a
 * batch that a newer one already superseded must not re-open reports the user
 * has already heard.
 */
export function acknowledgeBridgeReports(
  throughSeq: number,
  now = new Date(),
  scope?: BridgeChannelScope,
): BridgeChannelV1 | null {
  if (!Number.isInteger(throughSeq) || throughSeq < 1) return readBridgeChannel(scope);
  const target = bridgeChannelPath(scope);
  return withFileTransactionSync(target, BRIDGE_CHANNEL_BUSY, () => {
    const current = readBridgeChannel(scope);
    if (!current) return null;
    if (throughSeq <= current.managerReportCursor) return current;
    const next: BridgeChannelV1 = { ...current, managerReportCursor: throughSeq, updatedAt: now.toISOString() };
    writeJsonDurably(target, next);
    return next;
  });
}
