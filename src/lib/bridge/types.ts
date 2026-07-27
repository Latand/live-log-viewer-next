/**
 * #691 — the durable bridge between the two agents.
 *
 * The architecture has exactly two agents and they are not interchangeable. The
 * Codex realtime **voice root** is the sole user-facing gateway: it speaks, it
 * listens, it owns the conversation UI. A separate persistent **manager** owns
 * the board — tasks, pipelines, flows, PRs, workers, deploys. Intent flows
 * user → voice → manager → workers; results and questions flow back
 * manager → voice → user. The voice agent never drives workers directly and the
 * manager never speaks to the user directly.
 *
 * This module carries the shapes that keep those sentences true across process
 * death on either side. Two facts make the seam durable rather than hopeful:
 *
 * 1. Both endpoints are addressed by their **identity record**, never by a
 *    conversation id or transcript path. A root rollover mints a new
 *    conversation under the same `rootId`; a manager model swap retires one
 *    conversation and spawns another under the same record. Neither event may
 *    cost a message, so nothing durable is allowed to name a conversation.
 * 2. Reports are an append-only log with a monotonic `seq`, and the consumer
 *    stores a cursor into it. That is the whole recovery story: whoever wakes up
 *    reads the cursor and drains forward.
 *
 * Never a notification service: nothing here pushes. The manager appends, the
 * gateway drains — while a call is live through the delivery seam, otherwise at
 * the start of its next turn.
 */

export const BRIDGE_CHANNEL_SCHEMA_VERSION = 1 as const;
export const BRIDGE_REPORT_LOG_SCHEMA_VERSION = 1 as const;

/**
 * The manager is named by its designation record, spelled out as a literal so
 * the type system refuses a conversation id in this position. `state/bridge.json`
 * must survive a manager replacement untouched, which it cannot do if it stores
 * the incumbent's identity.
 */
export const MANAGER_RECORD_REF = "orchestrator" as const;
export type ManagerRecordRef = typeof MANAGER_RECORD_REF;

/** Reports retained in the log. Older ones are trimmed, their ids retired. */
export const BRIDGE_REPORT_CAPACITY = 500;
/** Retired ids kept so a trimmed report cannot be re-appended by a late replay. */
export const BRIDGE_RETIRED_ID_CAPACITY = 2_000;
/** §3: report bodies are bounded. Measured in UTF-8 bytes, not code units. */
export const BRIDGE_REPORT_BODY_MAX_BYTES = 2_048;

/**
 * The fixed, small set of things the manager may tell the gateway. Deliberately
 * closed: an open vocabulary is how a work log grows back, and no human-facing
 * lifecycle journal belongs anywhere near the gateway's surface.
 */
export const BRIDGE_REPORT_CLASSES = [
  "status",
  "completed",
  "failed",
  "blocked",
  "review_verdict",
  "question",
  "confirmation_request",
] as const;

export type BridgeReportClass = typeof BRIDGE_REPORT_CLASSES[number];

export function isBridgeReportClass(value: unknown): value is BridgeReportClass {
  return typeof value === "string" && (BRIDGE_REPORT_CLASSES as readonly string[]).includes(value);
}

/** A `confirmation_request` report's authorization payload. One nonce
    authorizes one SHA once; `consumedAt` is the durable single-use record and
    lives here rather than in channel state so the whole round trip is one
    auditable row. */
export interface BridgeConfirmation {
  /** Full 40-hex commit SHA. Nothing shorter is ever accepted. */
  sha: string;
  nonce: string;
  expiresAt: string;
  /** Set the moment a matching answer is accepted. A second answer sees this. */
  consumedAt?: string;
}

export interface BridgeReportV1 {
  /** Monotonic, never reused — THE cursor unit. */
  seq: number;
  /** Derived from the caller's stable `key`; a re-append is a no-op. */
  id: string;
  at: string;
  class: BridgeReportClass;
  /** `clientRequestId` of the directive this answers, when it answers one. */
  correlatesDirective?: string;
  /** Bounded and secret-redacted at write. Transcript payloads never reach it. */
  body: string;
  confirmation?: BridgeConfirmation;
  /** Set on the gap notice the drain synthesizes when the log outran a cursor
      (§7.12). Synthetic rows are never stored — they exist for one batch. */
  synthetic?: true;
}

export interface BridgeReportInput {
  /** Stable identity of the report. The same key always yields the same id,
      which is what makes a manager retry idempotent. */
  key: string;
  class: BridgeReportClass;
  at: string;
  correlatesDirective?: string | null;
  /** Raw candidate text; bounded and redacted before it is stored. */
  body?: string | null;
  confirmation?: { sha: string; nonce: string; expiresAt: string } | null;
}

export interface BridgeReportLogV1 {
  schemaVersion: typeof BRIDGE_REPORT_LOG_SCHEMA_VERSION;
  lastSeq: number;
  /** Highest seq that trimming has removed. A cursor at or below this can no
      longer be resumed exactly, which the drain must say out loud (§7.12). */
  trimmedThroughSeq: number;
  reports: BridgeReportV1[];
  retired: string[];
}

export interface BridgeChannelV1 {
  schemaVersion: typeof BRIDGE_CHANNEL_SCHEMA_VERSION;
  /** `RootLineageV1.rootId` — survives every root session rollover. */
  rootId: string;
  /** The manager's designation record, by name. Never a conversationId. */
  managerRecordRef: ManagerRecordRef;
  /** Last report seq the gateway has fully consumed. */
  managerReportCursor: number;
  updatedAt: string;
  /**
   * The batch currently handed out and not yet acknowledged.
   *
   * An acknowledgement names THIS, not a sequence of the caller's choosing. A
   * caller that could name a seq could retire reports it never received — every
   * blocker and question in the log, silently, from loopback. The token is minted
   * per handout and matched on the way back, so an acknowledgement can only settle
   * the batch that was actually delivered.
   */
  outstanding?: { token: string; throughSeq: number; issuedAt: string };
}

/** §4: at most this many reports reach the gateway in one batch. */
export const BRIDGE_DRAIN_BATCH_MAX = 5;
/** §4: at most one interjection batch per this window while a call is live. */
export const BRIDGE_LIVE_BATCH_INTERVAL_MS = 30_000;

/** What a drain hands its consumer. `gap` is set when the log had already
    trimmed past the cursor, in which case `reports[0]` is the synthetic notice. */
export interface BridgeReportBatch {
  reports: BridgeReportV1[];
  /** Highest seq in `reports`, or the cursor when nothing was pending. */
  throughSeq: number;
  /** Pending reports that did not fit under the batch cap. */
  remaining: number;
  gap: { resumedAtSeq: number; missedThroughSeq: number } | null;
}
