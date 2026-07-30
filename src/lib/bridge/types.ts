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

/** Routable reports retained in the log. Quarantined rows stay durable until
    an operator-facing resolution path exists. */
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
  /** #795: set when a newer direct deploy intent for the same project repinned
      the authorization. A superseded authorization refuses without consuming. */
  supersededAt?: string;
}

/**
 * SERVER-AUTHENTICATED origin of a report (B+ items 3/4).
 *
 * `bridge_report` is callable from every session, so the log has to say which
 * session each row came from. The label is derived server-side from the
 * durable caller identity — process ancestry merged with the admission-injected
 * spawn capability, checked against the durable orchestrator designation —
 * never from anything the caller supplies. `manager` is the one voice the
 * gateway relays as the manager's own; every other kind is visibly somebody
 * else, and only `manager` may carry a `confirmation_request`.
 */
export interface BridgeReportOrigin {
  kind: "manager" | "agent" | "gateway" | "unidentified";
  conversationId: string | null;
  role: string | null;
}

/** Durable routing identity for one project's designated orchestrator seat.
    Project is the repository-derived identity key; the display label never
    participates. */
export interface BridgeChannelScope {
  project: string;
  seatConversationId: string;
}

/**
 * How a report's origin reads on the way OUT — the label every delivery
 * composer must frame a non-manager row with (HIGH 3 of the #758 review: an
 * origin that is written but never read is not a control). Null means the row
 * speaks in the manager's voice: the designated orchestrator's own reports,
 * and legacy rows written before origin labeling existed, which were
 * manager-only by the gate of that era.
 */
export function bridgeReportOriginLabel(origin: BridgeReportOrigin | undefined): string | null {
  if (!origin || origin.kind === "manager") return null;
  const who = origin.kind === "gateway" ? "voice gateway" : origin.role ?? "agent";
  return origin.conversationId ? `${who} ${origin.conversationId}` : who;
}

export interface BridgeReportV1 {
  /** Monotonic, never reused — THE cursor unit. */
  seq: number;
  /** Derived from the caller's stable `key`; a re-append is a no-op. */
  id: string;
  at: string;
  class: BridgeReportClass;
  /** Server-derived origin. Absent on rows written before origin labeling
      existed, which were manager-only by the gate of that era. */
  origin?: BridgeReportOrigin;
  /** Server-derived repository identity. Absent only on pre-#787 rows. Null
      means the sender could not be resolved and the row is quarantined. */
  project?: string | null;
  /** Server-selected recipient seat. Null or absent rows are unrouted and are
      never handed to a conversation. */
  targetSeatConversationId?: string | null;
  /** `clientRequestId` of the directive this answers, when it answers one. */
  correlatesDirective?: string;
  /** Bounded and secret-redacted at write. Transcript payloads never reach it. */
  body: string;
  confirmation?: BridgeConfirmation;
  /** #795: a direct operator deploy authorization, recorded at intent
      acceptance. Exists purely as the durable single-use authorization row —
      the drain never hands it to a conversation, so the operator is never
      re-prompted for something they already said. */
  directIntent?: true;
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
  /** Server-derived origin label; callers never supply one. */
  origin?: BridgeReportOrigin | null;
  /** Server-derived routing fields. MCP callers cannot supply either field. */
  project?: string | null;
  targetSeatConversationId?: string | null;
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
  /** Highest trimmed seq per routable project-seat channel. Missing on
      pre-#787 files, whose projectless rows are quarantined. */
  trimmedThroughByChannel?: Record<string, number>;
  reports: BridgeReportV1[];
  retired: string[];
}

export interface BridgeChannelV1 {
  schemaVersion: typeof BRIDGE_CHANNEL_SCHEMA_VERSION;
  /** `RootLineageV1.rootId` — survives every root session rollover. */
  rootId: string;
  /** Present on project-scoped channels; absent on the pre-#787 global file. */
  project?: string;
  seatConversationId?: string;
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
  /** Quarantined rows visible to this channel without exposing their bodies.
      `legacy` covers pre-#787 rows whose project is absent. */
  unrouted?: { count: number; legacy: number; forProject: number };
}
