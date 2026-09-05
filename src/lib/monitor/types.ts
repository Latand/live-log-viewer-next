import type { LifecycleEventType, LifecycleState, LifecycleTurnState } from "@/lib/lifecycle/vocabulary";

import type { EffectiveSeatTickSettings } from "./seatTickSettings";

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
  /** A terminal, high-signal lane event since the last delivered wake (#1105),
      belonging to a lane that has NOT itself reached a terminal state. */
  | "lane-event"
  /** A lane that finished and left a pull request open behind it (#1289). */
  | "unmerged-pr"
  /** A parked or non-progressing lane that persisted across two checks. */
  | "stalled"
  /** A board task the operator assigned that nothing has started. */
  | "unstarted-task"
  /** The wake interval elapsed while work is open — "roughly hourly". */
  | "interval"
  /** A standalone child the seat spawned reached a terminal outcome nobody has
      harvested (#1465): its result is the seat's next obligation, once. */
  | "child-terminal";

export const SEAT_TICK_WAKE_REASON_KINDS: readonly SeatTickWakeReasonKind[] = [
  "lane-event",
  "unmerged-pr",
  "stalled",
  "unstarted-task",
  "interval",
  "child-terminal",
];

export interface SeatTickWakeReason {
  kind: SeatTickWakeReasonKind;
  /** One bounded, publication-safe clause naming what produced the reason. */
  detail: string;
}

/** One line of the wake's body. Bounded and structural — never transcript text. */
export interface SeatTickItem {
  kind: "pipeline" | "task" | "event" | "signal" | "pull-request" | "child";
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
  | {
    kind: "wake";
    reasons: SeatTickWakeReason[];
    items: SeatTickItem[];
    deferred: number;
    /** Evidence this check could not read (#1298). The reasons above stand
        without it; this is what the wake says it could not see. */
    gaps: SeatTickEvidenceGap[];
  }
  /** No work, and the proposal slot is due. */
  | { kind: "proactive"; detail: string }
  /**
   * The check could not establish that nothing is owed, and nothing else was
   * owed either.
   *
   * Quiet is a conclusion, and a conclusion drawn from evidence that could not
   * be read is the failure this whole mechanism exists to prevent, so the
   * check says so instead. It moves no stamp: the wake interval and the retry
   * guard are exactly where the previous check left them, and the next check
   * asks again. A failure cannot spend the hourly budget.
   *
   * What it no longer does is hold back the reasons that did NOT depend on the
   * unreadable source (#1298). Those are carried by a wake that names the gap,
   * because a check whose whole decision is aborted by one failed read is the
   * same silence to the operator as the quiet this verdict exists to refuse —
   * and for four hours, with two lanes parked, that is exactly what it was.
   */
  | { kind: "error"; detail: string };

/**
 * One evidence source a check could not read (#1298).
 *
 * It travels ON the wake rather than instead of it. A failed source withdraws
 * the reasons that rest on it and nothing else, so the seat is woken by
 * whatever still stands and told, in the same message, which evidence was
 * missing from the picture it is being asked to act on.
 */
export interface SeatTickEvidenceGap {
  /** Which evidence is missing. A stable token: it names the card the standing
      failure is reported under, so two outages of one source are one card. */
  source: "pull-requests" | "children";
  /** The class of the failure, as the source itself reported it. Machine
      token, because the journal line carrying it is published. */
  gap: SeatTickPullRequestGap | SeatTickChildrenGap;
  /** What the seat loses while it stands, in one publication-safe clause. */
  detail: string;
}

/**
 * An unbroken run of failures of one evidence source, remembered across checks
 * (#1298).
 *
 * The source it describes had been failing on every check for four hours with
 * nothing anywhere saying so out loud, and before that it had failed on every
 * check since the feature shipped. Two things follow from remembering the run,
 * and the row exists for both:
 *
 * - A source that cannot be read AT ALL is reported once, on the board, rather
 *   than only as another journal line every few minutes for ever.
 * - Past that same point the read itself slows to the project's wake interval.
 *   It cannot buy silence by slowing down: the gap this row holds is replayed
 *   on every check in between, so the decision is exactly the decision a fresh
 *   failed read would have produced.
 */
export interface SeatTickSourceGap {
  /** The class of the newest failure in the run. */
  gap: SeatTickPullRequestGap;
  /** The first failure in it — what "how long has this been broken" reads. */
  since: string;
  /** The newest attempt, which is what the retry window is measured from. */
  lastAttemptAt: string;
  /** Attempts in this run, the newest included. */
  attempts: number;
  /** The standing failure is already on the board. Raised once per run, so an
      operator who closes the card is not handed it again five minutes later. */
  reported: boolean;
}

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
      backlog, and a wake reason nothing can discharge (#1262). Because it
      decides that, it is also part of the change fingerprint: moving the card
      is the discharge, and a retry guard that could not see the movement would
      suppress the reason past the condition that raised it. */
  updatedAt: string | null;
}

export interface SeatTickEventInput {
  /** Journal seq — the cursor the tick advances only on a delivered wake, or
      seals past when this check established that nothing here is owed. */
  seq: number;
  at: string;
  type: LifecycleEventType;
  /** Bounded summary the journal already stored; never raw transcript text. */
  summary: string;
  pipelineId: string | null;
  /**
   * Whether the lane this event names has since reached a terminal state
   * (#1285), which is the difference between work waiting to start and history.
   *
   * A wake exists to name what is owed NOW. An event about a pipeline that
   * closed yesterday cannot be that: the lane is over, and establishing so was
   * the entire cost of three consecutive wakes — two of them naming lanes the
   * seat had closed itself earlier in the same session. Events that name no
   * pipeline at all (a deploy outcome, a held delivery) are never terminal by
   * this field: nothing about them has finished.
   */
  pipelineTerminal: boolean;
}

/**
 * A pull request a finished lane left open (#1289).
 *
 * The mirror of the field above, and the same property read from the other
 * side. `hasOpenWork` counts open lanes and board cards, so a lane that
 * COMPLETED with its pull request still unmerged was indistinguishable from
 * finished work: the tick answered `quiet — nothing owed` every five minutes
 * for twelve hours while three approved pull requests sat there. Finishing is
 * exactly what creates the seat's next obligation, so the finished lane's open
 * pull request is carried here and named in its own wake reason.
 *
 * It discharges itself: the source reads OPEN pull requests, so a merge or a
 * close removes the row and the reason goes quiet with no second mechanism.
 */
export interface SeatTickPullRequestInput {
  number: number;
  /** Bounded, already redacted by the source. */
  title: string;
  /** The finished lane whose branch is this pull request's head. */
  pipelineId: string;
  pipelineTitle: string;
  updatedAt: string | null;
}

/**
 * Why a check could not establish what this project's finished lanes left open.
 *
 * Machine tokens only, because the journal line carrying one is published:
 * `gh` could not be run or exited non-zero (`command-failed`), was killed at
 * its timeout (`timed-out`), answered with anything but a JSON array of rows
 * that can be attributed to a branch (`malformed-output`), or the lane records
 * the pull requests are correlated against could not be read
 * (`lanes-unreadable`).
 */
export type SeatTickPullRequestGap =
  | "timed-out"
  | "command-failed"
  | "malformed-output"
  | "lanes-unreadable";

/**
 * Why a check could not read the seat's spawned children (#1465). One token:
 * the registry snapshot the projection is read from could not be taken at all.
 * There is no card and no standing-run row for it — the registry is the
 * Viewer's own store, and a Viewer that cannot read it has larger problems the
 * board already shows.
 */
export type SeatTickChildrenGap = "registry-unreadable";

/**
 * One standalone child the seat spawned (#1465), projected from the durable
 * registry alone: the lineage edge, the launch receipt, the conversation's own
 * turn record and its host entries. No transcript is opened for it.
 *
 * `running` is a child with live host evidence — open work, and agenda enough
 * for the interval wake. `terminal` is a child whose outcome is the seat's to
 * harvest: it finished (`finished`) or its launch failed (`failed`). `unknown`
 * is a child the registry cannot place — no conversation record, or a turn it
 * never observed with no host behind it — and it is neither open work nor
 * harvestable: an unknown is kept unknown, never counted as completed.
 */
export interface SeatTickChildInput {
  conversationId: string;
  /** Bounded, already redacted by the source. */
  title: string;
  status: "running" | "terminal" | "unknown";
  outcome: "finished" | "failed" | null;
  /** When the terminal outcome was recorded, for ordering the harvest oldest
      first. Null while the child is not terminal. */
  terminalAt: string | null;
  /** The liveness plane's verdict for a running child's open turn, asked only
      when the registry says the turn is open. Null is no verdict, never a
      stall. */
  activity: SeatTickActivity | null;
}

/** A durable log line the Viewer already writes: a deploy outcome, the host
    retirement report, a seat whose own turn stopped progressing. */
export interface SeatTickSignalInput {
  id: string;
  label: string;
}

/** The knobs a deployment may turn. The wake interval is deliberately absent
    HERE: the default lives in `SEAT_TICK_WAKE_INTERVAL_MS` and the only thing
    that changes it is a project's own recorded settings (#1275), never an
    environment variable and never a per-deployment default. */
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
  /** Terminal children this wake names (#1465). A landing records them as
      harvested; a wake that never lands leaves them owed. */
  children: string[];
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
      fingerprints across two wakes is what "the wake changed nothing" means,
      so the digest has to cover every field a wake reason is decided from —
      otherwise a guard keyed on it outlives its own condition (#1262). */
  lastWakeFingerprint: string | null;
  /**
   * Lifecycle journal seq the seat has actually been told about, or that this
   * check established nothing is owed on.
   *
   * A wake is what advances it past anything a seat still has to act on.
   * Acknowledging THAT at read time is how a lane event gets lost across a
   * rotation or a refused send: the cursor moves, the message never arrives,
   * and nothing offers the event again.
   *
   * The other half is #1285. Everything in front of the first event that is
   * still owed — routine progress, and terminal events belonging to lanes that
   * have themselves finished — is history a single look discharges, so a check
   * seals the cursor past it with no wake at all. Without that, a cursor that
   * fell behind drained at `itemsPerWake` per hourly wake: a burst of fifty
   * historical events became a ten-hour tail of resumed hosts and paid turns,
   * and the seat could not tell it from real work without reading every item.
   * The seal never crosses a live event, so nothing that is owed is discharged
   * by it.
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
  /** The pull-request source's unbroken run of failures (#1298), or null while
      it is answering. Cleared by an answer and by nothing else. */
  pullRequestGap: SeatTickSourceGap | null;
  /**
   * The harvest cursor (#1465): conversation ids of terminal children a
   * DELIVERED wake has already named. Written by the landing and by nothing
   * else, so a wake that was refused, dropped or left uncertain leaves the
   * child owed, and a check that raises the same wake again names it again.
   *
   * An exact id set rather than a time watermark: the projection is bounded,
   * and a child seen running again is released from it, so a worker the seat
   * re-instructs is owed again when it next finishes. Survives a rotation like
   * the event cursor — it is a fact about what the project was told.
   */
  harvestedChildren: string[];
}

export interface SeatTickCheckInput {
  project: string;
  now: number;
  seat: SeatTickSeatInput | null;
  pipelines: readonly SeatTickPipelineInput[];
  tasks: readonly SeatTickTaskInput[];
  /** Events after {@link SeatTickProjectState.eventsThrough}, oldest first. */
  events: readonly SeatTickEventInput[];
  /** Pull requests that finished lanes left open (#1289). Empty whenever the
      project has no finished lane, no repository to ask, or the check could
      not raise a wake at all — all of which are answers. A read that FAILED is
      not one of them; it arrives below. */
  pullRequests: readonly SeatTickPullRequestInput[];
  /**
   * Set when the list above could not be established.
   *
   * A check that cannot see what its finished lanes left open has not shown
   * that nothing is owed, so it may not go quiet: with nothing else owed the
   * check ends as an `error` the controller journals and retries, and no stamp
   * moves. A `gh` outage cannot buy the very silence it would otherwise be
   * mistaken for.
   *
   * What it does NOT do is withdraw the rest of the decision (#1298). Only the
   * reasons that rest on this evidence are withheld — the pull-request list
   * above is empty because it could not be read, so no `unmerged-pr` reason is
   * composed from it. A parked lane, a lane event and an unstarted card have
   * nothing to do with GitHub, and a wake carrying one of those goes out with
   * a {@link SeatTickEvidenceGap} naming what was unreadable.
   */
  pullRequestsUnavailable: SeatTickPullRequestGap | null;
  signals: readonly SeatTickSignalInput[];
  /** The seat's own standalone children (#1465), bounded and project-scoped,
      with already-harvested terminal ones removed. Empty when the seat spawned
      nothing, and empty when the registry could not be read — the field below
      says which. */
  children: readonly SeatTickChildInput[];
  /** Set when the children could not be projected at all. Read exactly like
      {@link SeatTickCheckInput.pullRequestsUnavailable}: the reasons resting on
      it are withheld, every other reason still wakes, and with nothing else
      owed the check ends `error` rather than quiet. */
  childrenUnavailable: SeatTickChildrenGap | null;
  /**
   * Digest of everything a wake could change, in two parts separated by a dot:
   * the evidence every check reads, then the pull-request evidence.
   *
   * Two parts because one of them can be missing (#1298). A single digest over
   * whatever happened to be readable makes an unreadable source look exactly
   * like a merged pull request — the rows are gone either way — and the retry
   * guard reads "the board moved" off that and resets. A source that failed
   * every other check would then hand every reason an unbounded wake, which is
   * the guard being walked around by the very gap that was supposed to cost
   * nothing. So the second part reads `unread` when the source could not be
   * read, and {@link seatTickBoardMoved} is the only thing that interprets it.
   */
  changeFingerprint: string;
  state: SeatTickProjectState;
  policy: SeatTickPolicy;
  /** This project's own tick settings, with their expiry already applied
      (#1275). A project nobody has configured reads the defaults, which are
      exactly the behaviour that shipped before the settings existed. */
  settings: EffectiveSeatTickSettings;
}

/** A card the check owes the board, identified by its `monitor-ref:` value so a
    second check re-finds it instead of minting a twin. */
export interface SeatTickCard {
  ref: string;
  kind: "no-seat" | "retry-guard" | "tick-settings" | "source-unreadable";
  detail: string;
  /**
   * Whether the condition still holds.
   *
   * `open` is the default and the only thing every kind but `tick-settings`
   * ever says: they describe something that happened, and an operator closes
   * the card. A source that cannot be read (#1298) is one of those — it is
   * raised once per outage and stays until someone has seen it, because an
   * outage that healed itself is still an outage the operator was blind to.
   * Tick settings are a STANDING state rather than an event (#1275) — a project
   * whose tick is off or slowed carries the card while that is true — so the
   * check that reads the settings back at their default resolves the card
   * instead of leaving the board claiming a quiet tick that is ticking again.
   */
  state?: "open" | "resolved";
  /** What the card is describing, for its body. Present only on
      `tick-settings`, and stamped with when the SETTING was recorded rather
      than when the check ran, so a card that has not changed is not rewritten
      on every check. */
  settings?: Pick<EffectiveSeatTickSettings, "reason" | "until" | "setBy" | "updatedAt">;
  /**
   * What distinguishes this OCCURRENCE of the condition from the last one, for
   * the create receipt (#1298).
   *
   * The `ref` is the condition and is deliberately stable, because it is what
   * re-finds a standing card instead of minting a twin. That made every outage
   * of one source share a create id: once the first card was completed, the
   * second outage replayed the first one's receipt, created nothing, and left a
   * board that says the source is fine. A per-occurrence component — the
   * outage's own start instant — makes the next outage its own card while the
   * `ref` still collapses the checks within one.
   *
   * Absent means the condition is its own occurrence: a project has one seat,
   * one tick-settings state, and one guard per reason kind.
   */
  instance?: string;
}

export interface SeatTickDecision {
  verdict: SeatTickVerdict;
  /** The row to persist for this check, whatever the delivery does next. */
  state: SeatTickProjectState;
  cards: SeatTickCard[];
  /**
   * The source-gap row to persist INSTEAD, once the operator report in
   * {@link SeatTickDecision.cards} is a fact rather than an intention (#1298).
   *
   * `reported` is the tick's memory of having told the operator, and it is the
   * whole reason the outage is raised once. Writing it beside a decision made
   * it a memory of having INTENDED to: the controller catches a failed card
   * write, the row still said reported, and the report the state exists to
   * guarantee was suppressed for the rest of the outage. So it travels apart
   * from {@link SeatTickDecision.state} and is written only after the card
   * reached the board — a check whose write fails leaves the row unreported and
   * the next check raises the same card again.
   */
  reportedSourceGap?: SeatTickSourceGap | null;
}

/** What one check recorded. Five kinds are journal-only: `refused` is a sweep
    or a second clock refused for want of authority, and the other four are
    what became of a retained wake — it was taken back from a seat that had
    already been replaced (`revoked`), the layer holding it delivered it after
    all (`landed`), that layer settled it having PROVED it never delivered it
    (`dropped`), or it ended the send without proving arrival either way
    (`uncertain`, #1465): bounded without credit, so the interval starts and
    nothing the wake carried is acknowledged. */
export type SeatTickVerdictKind =
  | SeatTickVerdict["kind"]
  /** A check that threw outright, which the decision never gets to see. The
      decision has its own `error` above, for a check that ran and could not
      establish what is owed; both are read the same way off the journal. */
  | "error"
  | "refused"
  | "revoked"
  | "landed"
  | "dropped"
  | "uncertain";

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
    pullRequestGap: null,
    harvestedChildren: [],
  };
}
