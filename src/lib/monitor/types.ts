import type { LifecycleEventType, LifecycleState, LifecycleTurnState } from "@/lib/lifecycle/vocabulary";

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
  /** The board this item belongs to. `null` means the source is not
      project-scoped (a repository-wide pull request or issue); such an item may
      only correlate through an explicit reference, never through wording. */
  project: string | null;
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

/** How a request found its evidence — which decides how much the match is
    allowed to conclude. */
export type MatchBasis =
  /** The monitor's own card for this exact fingerprint; authoritative. */
  | "monitor-ref"
  /** Wording overlap strong enough to stand on its own. */
  | "wording"
  /** An explicit `#N` the request named, corroborated by wording. */
  | "reference"
  /** An explicit `#N` named in passing, with nothing else agreeing. */
  | "contextual-reference";

export interface EvidenceMatch {
  item: EvidenceItem;
  /** 0..1 wording-overlap strength; 1 for the monitor's own card. */
  score: number;
  basis: MatchBasis;
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
  | { kind: "resolved"; conversationId: string; source: "project-seat" }
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
  /** Whether the audit line actually landed. A run nobody could record reads
      exactly like a run that never happened, so the caller is told and exits
      non-zero rather than reporting a success it cannot evidence. */
  audited: boolean;
  /** Classified requests, richest form, for the delivered report. Never
      persisted to the journal — it carries operator wording. */
  classified: ClassifiedRequest[];
  /** The message delivered to the orchestrator, or null when none was sent. */
  message: string | null;
}

/* ------------------------------------------------------------------------- *
 * The seat tick (issue #1245).
 *
 * The monitor above answers "did an operator request fall through the
 * cracks?". The tick answers the neighbouring question — "is work moving, and
 * is the seat awake to move it?" — over the same evidence vocabulary, the same
 * cards, the same stall rule and the same journal primitives. It lives here
 * rather than in a subsystem of its own precisely because those parts already
 * exist: the Viewer owns the clock and the decision to wake, the seat owns the
 * judgement, and every fact either of them reads is already durable.
 * ------------------------------------------------------------------------- */

/** Why a wake is owed. Kinds are stable strings: they are journaled, counted
    against the retry guard, and named in the message the seat receives. */
export type SeatTickWakeReasonKind =
  /** A terminal, high-signal lane event since the last delivered wake (#1105). */
  | "lane-event"
  /** A parked or non-progressing lane that persisted across two checks. */
  | "stalled"
  /** A board task the operator assigned that nothing has started. */
  | "unstarted-task"
  /** The wake interval elapsed while work is open — "roughly hourly". */
  | "interval";

export const SEAT_TICK_WAKE_REASON_KINDS: readonly SeatTickWakeReasonKind[] = [
  "lane-event",
  "stalled",
  "unstarted-task",
  "interval",
];

export interface SeatTickWakeReason {
  kind: SeatTickWakeReasonKind;
  /** One bounded, publication-safe clause naming what produced the reason. */
  detail: string;
}

/** One line of the wake's body. Bounded and structural — never transcript text. */
export interface SeatTickItem {
  kind: "pipeline" | "task" | "event" | "signal";
  id: string;
  label: string;
}

export type SeatTickVerdict =
  /** The project has open work and nobody seated. Never a spawn. */
  | { kind: "no-seat"; detail: string }
  /** The seat's turn is genuinely progressing. A tick that landed after it
      would be acting on evidence the turn has already superseded, so it is
      dropped rather than queued or held. */
  | { kind: "skipped"; reason: "seat-busy" }
  /** Nothing owed. One journal line, nothing else — the default. */
  | { kind: "quiet"; detail: string }
  | { kind: "wake"; reasons: SeatTickWakeReason[]; items: SeatTickItem[]; deferred: number }
  /** No work, and the proposal slot is due. */
  | { kind: "proactive"; detail: string };

/**
 * The registry's own answer about a turn: the durable activity verdict
 * `agent_activity` reports, never a subtraction over attempt timestamps.
 *
 * `lifecycle` is the shared vocabulary (`running`, `waiting`, `starting`,
 * `stalled`, `gone`, …) and `reason` is the machine-readable clause behind it
 * (`host_gone_turn_open`, `host_alive_transcript_silent`, …). Null means the
 * liveness plane had no answer, which is never read as "dead" and never read as
 * "progressing" either.
 */
export interface SeatTickActivity {
  lifecycle: LifecycleState;
  reason: string;
  /**
   * The turn state the verdict above was computed FROM — the transcript's own
   * evidence, which is a different fact from {@link SeatTickSeatInput.turn}.
   *
   * The two were read as one and disagreed (#1262). The registry's record says
   * a turn is open; the transcript says whether one actually is. A seat that
   * ended its turn and went quiet crosses the silence threshold and is reported
   * `stalled` all the same, because the threshold measures silence rather than
   * an open turn — so a stall that rests on silence is only the seat's stall
   * when this says the turn is open. Absent when the caller carried no row,
   * which is never read as an open turn.
   */
  turnState?: LifecycleTurnState;
}

/** The active seat as the check sees it: durable identity, the registry's turn
    state for its conversation, and that turn's activity verdict. */
export interface SeatTickSeatInput {
  conversationId: string;
  seatEpoch: number;
  path: string | null;
  turn: "busy" | "idle" | "terminal" | "unknown";
  activity: SeatTickActivity | null;
}

/**
 * One open pipeline, projected through the monitor's evidence vocabulary
 * (`evidence.ts`) plus the one thing evidence cannot see: whether the turn its
 * running stage holds is still progressing.
 */
export interface SeatTickPipelineInput {
  id: string;
  title: string;
  /** `terminal` closed or completed, `inert` parked, `active` otherwise. */
  state: EvidenceState;
  /** Newest movement instant. Carried for the change fingerprint only — the
      stall rule never subtracts it from the clock. */
  updatedAt: string | null;
  /** The activity verdict for the conversation holding this lane's running
      stage, or null when no stage is running or the plane had no answer. */
  stageActivity: SeatTickActivity | null;
  stageId: string | null;
}

export interface SeatTickTaskInput {
  id: string;
  title: string;
  status: "inbox" | "assigned" | "blocked" | "done";
  /** A linked pipeline or a live assignment already owns it. */
  owned: boolean;
  /** When the card last moved. An assigned card nobody started is only an
      unstarted TASK while this is recent; past the backlog bound it is
      backlog, and a wake reason nothing can discharge (#1262). */
  updatedAt: string | null;
}

export interface SeatTickEventInput {
  /** Journal seq — the cursor the tick advances only on a delivered wake. */
  seq: number;
  at: string;
  type: LifecycleEventType;
  /** Bounded summary the journal already stored; never raw transcript text. */
  summary: string;
  pipelineId: string | null;
}

/** A durable log line the Viewer already writes: a deploy outcome, the host
    retirement report, a seat whose own turn stopped progressing. */
export interface SeatTickSignalInput {
  id: string;
  label: string;
}

/** The knobs a deployment may turn. The wake interval is deliberately absent:
    it is the bound the ADR commits to, so it is a constant with no override
    (see `SEAT_TICK_WAKE_INTERVAL_MS`) rather than a field something can set. */
export interface SeatTickPolicy {
  checkIntervalMs: number;
  /**
   * What the tick asks the liveness plane to call stalled: forty minutes by
   * default, and the number that travels into the read rather than a second
   * threshold derived here.
   *
   * It measures SILENCE — the gap since the newest transcript record, tool
   * traffic included — and nothing else. Not how long a turn has been open: a
   * turn writing every thirty seconds never crosses it however long it runs.
   * And not "silence under an open turn" either, which is the reading that
   * looks obvious and is wrong — the liveness verdict crosses into `stalled`
   * on silence whether the transcript's turn is open or settled, so whether a
   * seat is stalled or merely quiet is decided by
   * {@link SeatTickActivity.turnState} beside it (#1262).
   */
  stallAfterMs: number;
  proposalIntervalMs: number;
  itemsPerWake: number;
  retryGuard: number;
  /** How long an assigned card nobody started stays an unstarted task before
      it becomes backlog the wake stops naming (#1262). */
  backlogAfterMs: number;
}

/**
 * What a wake changes about the row when it lands.
 *
 * Carried on the outstanding wake because a retained wake lands — or fails to —
 * after the check that raised it has ended, and the check that observes the
 * landing no longer holds the decision behind it. Committing the wake stamp
 * from anything else would credit the seat with a different message.
 */
export interface SeatTickWakeCommit {
  /** A proposal wake, which advances the 24-hour slot as well as the stamp. */
  proposal: boolean;
  reasons: SeatTickWakeReasonKind[];
  fingerprint: string;
  eventsThrough: number;
}

/**
 * A wake the delivery layer accepted and has NOT landed, retained durably
 * against the conversation it was addressed to.
 *
 * It is remembered because the retention outlives the check that made it, and
 * both questions the tick can still ask about it are asked of whichever layer
 * is holding it:
 *
 * - **Did it land?** Only the holder knows. Until it answers, no stamp moves
 *   and no lifecycle event is acknowledged.
 * - **Can it be taken back?** The seat can rotate while the payload waits, and
 *   a payload that then flushes reaches a predecessor that no longer holds the
 *   project — the exact failure this mechanism exists to end.
 *
 * {@link operationId} is what makes both questions answerable of the right
 * layer: a send the runtime host queued is the runtime host's, and marking the
 * Viewer's mirror of it does not stop the host's drain from delivering it.
 */
export interface SeatTickOutstandingWake {
  clientMessageId: string;
  conversationId: string;
  seatEpoch: number;
  /** The runtime host operation holding this wake, when the runtime took it.
      Null when the retention is the Viewer registry's own reservation — an
      account migration hold, or a legacy send that never reached a host. */
  operationId: string | null;
  commit: SeatTickWakeCommit;
}

/** The durable row per project, `state/seat-tick.json`. */
export interface SeatTickProjectState {
  seatEpoch: number | null;
  lastCheckAt: string | null;
  lastWakeAt: string | null;
  lastWakeReasons: SeatTickWakeReasonKind[];
  /** Consecutive wakes carrying this reason that changed nothing. */
  wakesWithoutChange: Partial<Record<SeatTickWakeReasonKind, number>>;
  quietSince: string | null;
  idleSince: string | null;
  lastProposalAt: string | null;
  /** Lane ids observed stalled at the previous check — the whole memory behind
      "persisted across two consecutive checks". */
  stalledSeen: string[];
  /** Board and pipeline movement digest at the last delivered wake. Equal
      fingerprints across two wakes is what "the wake changed nothing" means. */
  lastWakeFingerprint: string | null;
  /**
   * Lifecycle journal seq the seat has actually been TOLD about.
   *
   * Advanced only by a delivered wake. Acknowledging at read time is how a
   * lane event gets lost across a rotation or a refused send: the cursor moves,
   * the message never arrives, and nothing offers the event again.
   *
   * Null means the tick has never established where the journal stood for this
   * project, which is not the same as zero. Zero is a real cursor with the
   * whole journal ahead of it, and a first check that read it that way handed
   * the seat four days of settled work as its instruction for the turn
   * (#1262). The first check seals it to the journal head instead — a first
   * run has no backlog to catch up on — and every later check pages from it.
   */
  eventsThrough: number | null;
  /** The last wake the layer accepted without landing, and the seat it was
      addressed to. Survives a rotation precisely so the successor's first check
      can revoke what is still waiting for the predecessor. */
  outstandingWake: SeatTickOutstandingWake | null;
}

export interface SeatTickCheckInput {
  project: string;
  now: number;
  seat: SeatTickSeatInput | null;
  pipelines: readonly SeatTickPipelineInput[];
  tasks: readonly SeatTickTaskInput[];
  /** Events after {@link SeatTickProjectState.eventsThrough}, oldest first. */
  events: readonly SeatTickEventInput[];
  /** Whether a terminal high-signal event is pending anywhere past the cursor,
      including beyond the page `events` carries. Asking this over the whole
      pending range is what stops a backlog from burying the one class of event
      the seat cannot decide without. */
  terminalPending: boolean;
  signals: readonly SeatTickSignalInput[];
  /** Digest of everything a wake could change. Compared against the previous
      wake's, never interpreted. */
  changeFingerprint: string;
  state: SeatTickProjectState;
  policy: SeatTickPolicy;
}

/** A card the check owes the board, identified by its `monitor-ref:` value so a
    second check re-finds it instead of minting a twin. */
export interface SeatTickCard {
  ref: string;
  kind: "no-seat" | "retry-guard";
  detail: string;
}

export interface SeatTickDecision {
  verdict: SeatTickVerdict;
  /** The row to persist for this check, whatever the delivery does next. */
  state: SeatTickProjectState;
  cards: SeatTickCard[];
}

/** What one check recorded. Five kinds are journal-only: `error` is a check
    that threw, `refused` a sweep or a second clock refused for want of
    authority, and the other three are what became of a retained wake — it was
    taken back from a seat that had already been replaced (`revoked`), the
    layer holding it delivered it after all (`landed`), or that layer settled it
    without ever delivering it (`dropped`). */
export type SeatTickVerdictKind =
  | SeatTickVerdict["kind"]
  | "error"
  | "refused"
  | "revoked"
  | "landed"
  | "dropped";

/**
 * One audited check. Like {@link MonitorRunRecord} it carries no transcript
 * text, no filesystem path and no account identity — counts, kinds and machine
 * ids only, so the journal can be read, pasted and published as it stands.
 */
export interface SeatTickRunRecord {
  schemaVersion: 1;
  at: string;
  project: string;
  seatEpoch: number | null;
  verdict: SeatTickVerdictKind;
  reasons: SeatTickWakeReasonKind[];
  /** Items carried in the wake, and items the per-wake bound held back. */
  items: number;
  deferred: number;
  /** Lifecycle journal seq the seat has been told about after this check. */
  eventsThrough: number;
  delivery: { clientMessageId: string; outcome: string } | null;
  detail: string | null;
}

export function emptySeatTickState(): SeatTickProjectState {
  return {
    seatEpoch: null,
    lastCheckAt: null,
    lastWakeAt: null,
    lastWakeReasons: [],
    wakesWithoutChange: {},
    quietSince: null,
    idleSince: null,
    lastProposalAt: null,
    stalledSeen: [],
    lastWakeFingerprint: null,
    eventsThrough: null,
    outstandingWake: null,
  };
}
