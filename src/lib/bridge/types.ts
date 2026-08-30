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
/** Answered report seqs kept alongside the log (#1168). Bounded for the same
    reason `retired` is: the file is state, not history. */
export const BRIDGE_ANSWERED_REF_CAPACITY = 500;
/**
 * How long an unanswered `blocked`/`question` report keeps asking (#1168).
 *
 * The same reasoning `STALLED_ATTENTION_TTL` carries, and the same two hours:
 * the attention queue answers "who needs me right now", and a decision request
 * the operator has already settled some other way — in the orchestrator's own
 * conversation, in person — must not sit in the queue forever with nothing in
 * the log able to retire it.
 */
export const BRIDGE_ASK_TTL_SECONDS = 2 * 3600;
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
] as const;

export type BridgeReportClass = typeof BRIDGE_REPORT_CLASSES[number];

export function isBridgeReportClass(value: unknown): value is BridgeReportClass {
  return typeof value === "string" && (BRIDGE_REPORT_CLASSES as readonly string[]).includes(value);
}

/** #795 (superseded design): logs written before the designated agent owned the
    deploy decision contain `confirmation_request` rows — the retired operator
    confirmation round trip. They must still READ (a durable log that stops
    parsing loses the manager's history), but nothing writes them, their
    authorization payloads are dropped at read, and the drain never hands one
    to a conversation. */
export const LEGACY_CONFIRMATION_CLASS = "confirmation_request" as const;

export type BridgeStoredReportClass = BridgeReportClass | typeof LEGACY_CONFIRMATION_CLASS;

export function isStoredBridgeReportClass(value: unknown): value is BridgeStoredReportClass {
  return isBridgeReportClass(value) || value === LEGACY_CONFIRMATION_CLASS;
}

/**
 * The two classes in which the manager is ASKING rather than reporting: `blocked`
 * ("I cannot proceed") and `question` ("I need an answer"). They are the only
 * rows that open an attention item, the only rows whose caller key is kept
 * verbatim, and the only rows a directive can answer (#1168).
 */
export function isBridgeDecisionRequestClass(value: BridgeStoredReportClass): boolean {
  return value === "blocked" || value === "question";
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
 * else.
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

/**
 * Resolves a recorded seat identity to the conversation id the registry calls
 * it now (#1168). Both the ask projection and a directive's settlement run
 * EVERY seat identity through the same one — see `seatIdentity.ts`.
 */
export type CanonicalSeatConversationId = (conversationId: string) => string;

export interface BridgeReportV1 {
  /** Monotonic, never reused — THE cursor unit. */
  seq: number;
  /** Derived from the caller's stable `key`; a re-append is a no-op. */
  id: string;
  /** The caller's own `key`, verbatim — the identity #1168 puts on the
      attention item, which the hashed `id` cannot spell back out. Kept only on
      the decision-request classes, which are the only rows that become an
      attention item; absent on every other class and on rows written before
      this field existed, which open no ask at all rather than being enqueued
      under some other identity. */
  key?: string;
  at: string;
  class: BridgeStoredReportClass;
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
  /** Report seqs a gateway directive answered with `[bridge ref=<seq>]`
      (#1168). Kept here rather than on a channel because a seq is already
      log-global, and because the attention queue must read ONE file to know
      whether a report is still asking. */
  answeredRefs?: number[];
  /** Answers waiting on their own delivery (#1131). `bridge_directive` may be
      ACCEPTED rather than delivered — the manager is mid-turn and the send is
      queued — and recording the answer then would clear a decision request
      nobody has read yet. The ref is parked here against the operation id the
      send returned, and the ask projection clears it once the durable delivery
      record says that operation was delivered. A send that failed leaves the
      ask standing, which is the safe end of the trade. */
  pendingAnswers?: BridgePendingAnswerV1[];
}

export interface BridgePendingAnswerV1 {
  ref: number;
  /** The accepted send that must arrive before the ref counts as answered. */
  operationId: string;
  project: string;
  seatConversationId: string;
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
