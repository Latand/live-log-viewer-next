/**
 * Domain vocabulary of the recurring conversation monitor (issue #741).
 *
 * The monitor reads operator-authored messages over a bounded window,
 * correlates each concrete request against the work the machine already
 * tracks, and materializes the gaps as board cards. Everything here is plain
 * data so the decision logic stays pure and testable without a viewer, a
 * registry, or a transcript on disk.
 */

/**
 * How a concrete operator request stands relative to the tracked work.
 *
 * - `completed` — correlated evidence reached a terminal state (a done card, a
 *   closed pipeline, a merged PR).
 * - `in-flight` — correlated evidence is live. `owner` names it; a board card
 *   nobody picked up yet is still in flight with a null owner, and only
 *   crosses into `stalled` once it has sat untouched past the stall threshold.
 * - `stalled` — correlated evidence exists but stopped moving (parked
 *   pipeline, blocked card, or an active item older than the stall threshold).
 * - `untracked` — nothing correlates. This is the gap the monitor materializes.
 * - `awaiting-confirmation` — the monitor will not decide this one: the
 *   correlation is ambiguous, or the request asks for a GitHub issue, which is
 *   never created from inferred intent.
 */
export type RequestState =
  | "completed"
  | "in-flight"
  | "stalled"
  | "untracked"
  | "awaiting-confirmation";

/** A concrete request the operator made, lifted out of a transcript. */
export interface OperatorRequest {
  /** Stable content address of the request; the board idempotency key. */
  fingerprint: string;
  /** Short redacted label used as the card title. */
  title: string;
  /** Redacted, bounded body of what the operator asked for. */
  text: string;
  /** The board this request belongs to; the same scope its card is created on. */
  project: string;
  /** ISO instant the request was made. */
  at: string;
  /** Issue/PR numbers the operator named explicitly (`#741`). */
  references: number[];
  /** The operator asked for a GitHub issue — never actuated, only surfaced. */
  asksForGithubIssue: boolean;
}

/** Lifecycle position of one piece of correlated evidence. */
export type EvidenceState = "terminal" | "active" | "inert";

export type EvidenceKind = "task" | "pipeline" | "flow" | "pull-request" | "issue";

/** One tracked work item the monitor can correlate a request against. */
export interface EvidenceItem {
  kind: EvidenceKind;
  /** Stable id within its kind (task id, pipeline id, `#741`…). */
  id: string;
  title: string;
  state: EvidenceState;
  /** Who is carrying it, when the source names one. */
  owner: string | null;
  /** ISO instant of the item's last movement; null when the source has none. */
  updatedAt: string | null;
  /** Issue/PR numbers this item names. */
  references: number[];
  /** Set when the monitor itself created this item, carrying the fingerprint
      of the request it materialized. This is what makes a re-run idempotent. */
  monitorRef: string | null;
}

export interface EvidenceMatch {
  item: EvidenceItem;
  /** 0..1 correlation strength; 1 for an explicit issue/PR reference. */
  score: number;
}

export interface ClassifiedRequest {
  request: OperatorRequest;
  state: RequestState;
  match: EvidenceMatch | null;
  /** Why the monitor landed on this state, in one publication-safe clause. */
  reason: string;
}

/** How the current orchestrator was resolved, or why it could not be. */
export type OrchestratorResolution =
  | { kind: "resolved"; conversationId: string; source: "durable-record" }
  | { kind: "missing-record" }
  | { kind: "stale-record"; conversationId: string }
  | { kind: "unavailable"; detail: string };

/** Terminal disposition of one monitor run. */
export type MonitorOutcome = "clean" | "failed" | "skipped";

export interface MonitorCreation {
  /** The request this card materialized, or the fixed ref of a condition card
      (see `ORCHESTRATOR_ALERT_REF`). */
  fingerprint: string;
  taskId: string;
  state: RequestState | "orchestrator-alert";
}

export interface MonitorSkip {
  fingerprint: string;
  reason: "already-tracked" | "card-budget" | "dry-run";
}

/**
 * One audited run. Deliberately carries no transcript text, no filesystem
 * path and no account identity: fingerprints, counts and machine ids only, so
 * the journal can be read, pasted and published without laundering.
 */
export interface MonitorRunRecord {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  finishedAt: string;
  outcome: MonitorOutcome;
  /** Why a run failed or was skipped, and on a clean run any note worth
      keeping (unreadable transcripts, an unscoped sweep). */
  detail: string | null;
  window: { from: string; to: string; hours: number };
  scope: { project: string | null };
  orchestrator: { resolution: OrchestratorResolution["kind"]; conversationId: string | null; delivered: boolean };
  scanned: { conversations: number; operatorMessages: number };
  found: { total: number; byState: Record<RequestState, number>; fingerprints: string[] };
  created: MonitorCreation[];
  skipped: MonitorSkip[];
}

export interface MonitorRunReport {
  record: MonitorRunRecord;
  /** Classified requests, richest form, for the delivered report. Never
      persisted to the journal — it carries operator wording. */
  classified: ClassifiedRequest[];
  /** The message delivered to the orchestrator, or null when none was sent. */
  message: string | null;
}
