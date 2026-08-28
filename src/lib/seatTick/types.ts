import type { LifecycleEventType } from "@/lib/lifecycle/vocabulary";

/**
 * The seat tick's vocabulary (issue #1245).
 *
 * The tick is the Viewer's own clock over a project's seat: deterministic code
 * answers "is anything owed to this seat right now?" every few minutes at zero
 * model cost, and the model runs only when the answer is yes. Everything a
 * check may conclude is in {@link SeatTickVerdict}; everything it needs to
 * conclude it is in {@link SeatTickCheckInput}, so the decision is a pure
 * function of durable state and the controller owns nothing but the reading,
 * the sending and the journal line.
 */

/** Why a wake is owed. Kinds are stable strings: they are journaled, counted
    against the retry guard, and named in the message the seat receives. */
export type SeatTickWakeReasonKind =
  /** A terminal, high-signal lane event since the last check (#1105). */
  | "lane-event"
  /** A parked or silent lane that persisted across two consecutive checks. */
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
  /** One bounded, operator-safe clause naming what produced the reason. */
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
  /** The seat is mid-turn. A tick that landed after it would be stale by
      construction, so it is dropped rather than queued or held. */
  | { kind: "skipped"; reason: "seat-busy" }
  /** Nothing owed. One journal line, nothing else — the default. */
  | { kind: "quiet"; detail: string }
  | { kind: "wake"; reasons: SeatTickWakeReason[]; items: SeatTickItem[]; deferred: number }
  /** No work, and the proposal slot is due. */
  | { kind: "proactive"; detail: string };

/** The active seat as the check sees it: durable identity plus the registry's
    turn state for its conversation. */
export interface SeatTickSeatInput {
  conversationId: string;
  seatEpoch: number;
  path: string | null;
  turn: "busy" | "idle" | "terminal" | "unknown";
}

/**
 * One open pipeline, projected through the monitor's evidence vocabulary
 * (`evidence.ts`) plus the one thing evidence cannot see: whether the running
 * stage's transcript has stopped growing under an open turn.
 */
export interface SeatTickPipelineInput {
  id: string;
  title: string;
  /** `terminal` closed or completed, `inert` parked, `active` otherwise. */
  state: "active" | "inert" | "terminal";
  /** Newest movement instant; null when nothing recorded movement, which the
      stall rule treats as unknown rather than as stale. */
  updatedAt: string | null;
  /** How long the running stage's transcript has been silent under an open
      turn. Null when no stage is running, or the transcript could not be read
      — an unread transcript is not a silent one. */
  silentForMs: number | null;
  stageId: string | null;
}

export interface SeatTickTaskInput {
  id: string;
  title: string;
  status: "inbox" | "assigned" | "blocked" | "done";
  /** A linked pipeline or a live assignment already owns it. */
  owned: boolean;
}

export interface SeatTickEventInput {
  at: string;
  type: LifecycleEventType;
  /** Bounded summary the journal already stored; never raw transcript text. */
  summary: string;
  pipelineId: string | null;
}

/** A durable log line the Viewer already writes: a deploy outcome, the host
    retirement report, a seat host that died under an open turn. */
export interface SeatTickSignalInput {
  id: string;
  label: string;
}

export interface SeatTickPolicy {
  checkIntervalMs: number;
  wakeIntervalMs: number;
  stallAfterMs: number;
  proposalIntervalMs: number;
  itemsPerWake: number;
  retryGuard: number;
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
  /** Board and pipeline movement digest at the last wake. Equal fingerprints
      across two wakes is what "the wake changed nothing" means. */
  lastWakeFingerprint: string | null;
  /** Lifecycle journal seq the last check consumed through. */
  digestThrough: number;
}

export interface SeatTickCheckInput {
  project: string;
  now: number;
  seat: SeatTickSeatInput | null;
  pipelines: readonly SeatTickPipelineInput[];
  tasks: readonly SeatTickTaskInput[];
  events: readonly SeatTickEventInput[];
  signals: readonly SeatTickSignalInput[];
  /** Digest of everything the seat could act on. Compared against the previous
      wake's, never interpreted. */
  changeFingerprint: string;
  digestThrough: number;
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
    digestThrough: 0,
  };
}
