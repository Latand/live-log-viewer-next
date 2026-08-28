import { isTerminalHighSignalEvent } from "@/lib/lifecycle/vocabulary";
import { ORCHESTRATOR_ALERT_REF } from "@/lib/monitor/cards";
import { evidenceStallReason } from "@/lib/monitor/classify";

import {
  SEAT_TICK_WAKE_REASON_KINDS,
  type SeatTickCard,
  type SeatTickCheckInput,
  type SeatTickDecision,
  type SeatTickItem,
  type SeatTickPipelineInput,
  type SeatTickPolicy,
  type SeatTickProjectState,
  type SeatTickTaskInput,
  type SeatTickVerdict,
  type SeatTickWakeReason,
  type SeatTickWakeReasonKind,
} from "./types";

/**
 * The seat tick's pre-check (issue #1245) — a pure decision over durable state.
 *
 * The whole point of the tick is that the expensive half runs rarely. This
 * function is the cheap half: no model call, no transcript scan, no network. It
 * reads the seat, the open lanes, the board, the lifecycle events since the
 * last check and the Viewer's own signals, and answers one of five things.
 *
 * Three rules are load-bearing and easy to lose:
 *
 * - **A stale tick is dropped, never queued.** A seat mid-turn is `skipped`,
 *   and a skipped check remembers nothing: the stall memory and the digest
 *   cursor stay where they were so the next check decides on fresh evidence.
 *   The session-scheduled monitor this replaces queued its fires instead, and
 *   five of its seventy-six ticks were empty turns landing a fraction of a
 *   second behind the tick before them.
 * - **A standing condition waits out the wake interval; a terminal lane event
 *   does not.** "Roughly hourly" is a floor on wakes the tick raises by itself.
 *   An event the seat cannot make its next decision without — a parked stage, a
 *   verdict, a deploy outcome — reaches it at the very next check.
 * - **Nothing here creates or wakes anything.** The decision names what is
 *   owed; the controller sends it, and re-reads the seat epoch before it does.
 */

const MINUTE_MS = 60_000;

export const DEFAULT_SEAT_TICK_POLICY: SeatTickPolicy = {
  checkIntervalMs: 5 * MINUTE_MS,
  wakeIntervalMs: 60 * MINUTE_MS,
  stallAfterMs: 40 * MINUTE_MS,
  proposalIntervalMs: 24 * 60 * MINUTE_MS,
  itemsPerWake: 5,
  retryGuard: 2,
};

function positive(raw: string | undefined, fallback: number, scale: number): number {
  const value = Number(raw?.trim());
  return Number.isFinite(value) && value > 0 ? value * scale : fallback;
}

/**
 * The policy for this process: constants with env overrides, in the
 * `LLV_HOST_RETIREMENT_*` shape. There is deliberately no settings panel, no
 * cadence UI and no per-project opt-in — the requirement is that the tick works
 * from the start with no configuration by the operator.
 *
 * Null is the off switch, spelled the way retirement spells its own:
 * `LLV_SEAT_TICK_CHECK_MINUTES=0` means no checks at all.
 */
export function seatTickPolicy(env: Readonly<Record<string, string | undefined>> = process.env): SeatTickPolicy | null {
  const checkRaw = env.LLV_SEAT_TICK_CHECK_MINUTES?.trim();
  if (checkRaw && Number(checkRaw) === 0) return null;
  return {
    checkIntervalMs: positive(checkRaw, DEFAULT_SEAT_TICK_POLICY.checkIntervalMs, MINUTE_MS),
    wakeIntervalMs: positive(env.LLV_SEAT_TICK_WAKE_MINUTES, DEFAULT_SEAT_TICK_POLICY.wakeIntervalMs, MINUTE_MS),
    stallAfterMs: positive(env.LLV_SEAT_TICK_STALL_MINUTES, DEFAULT_SEAT_TICK_POLICY.stallAfterMs, MINUTE_MS),
    proposalIntervalMs: positive(env.LLV_SEAT_TICK_PROPOSAL_HOURS, DEFAULT_SEAT_TICK_POLICY.proposalIntervalMs, 60 * MINUTE_MS),
    itemsPerWake: Math.floor(positive(env.LLV_SEAT_TICK_ITEMS, DEFAULT_SEAT_TICK_POLICY.itemsPerWake, 1)),
    retryGuard: Math.floor(positive(env.LLV_SEAT_TICK_RETRY_GUARD, DEFAULT_SEAT_TICK_POLICY.retryGuard, 1)),
  };
}

/** The ref of the card raised when a wake reason has stopped producing change. */
export const seatTickRetryGuardRef = (kind: SeatTickWakeReasonKind): string => `seat-tick-stuck-${kind}`;

function isOpenLane(pipeline: SeatTickPipelineInput): boolean {
  return pipeline.state !== "terminal";
}

function isUnstarted(task: SeatTickTaskInput): boolean {
  return task.status === "assigned" && !task.owned;
}

/** Work the seat could still carry: an open lane, or a board card that is
    neither blocked (a recorded stop) nor done. */
function hasOpenWork(input: SeatTickCheckInput): boolean {
  return input.pipelines.some(isOpenLane)
    || input.tasks.some((task) => task.status === "inbox" || task.status === "assigned");
}

/**
 * The lanes that are not moving, by the shared stall rule plus the one thing
 * evidence cannot see: a running stage whose transcript stopped growing under
 * an open turn. That is the registry's 180-second `stalled` verdict read at the
 * tick's own threshold.
 */
function stalledLanes(input: SeatTickCheckInput): { pipeline: SeatTickPipelineInput; reason: string }[] {
  const options = { now: new Date(input.now), stallAfterMs: input.policy.stallAfterMs };
  const found: { pipeline: SeatTickPipelineInput; reason: string }[] = [];
  for (const pipeline of input.pipelines) {
    if (!isOpenLane(pipeline)) continue;
    const reason = evidenceStallReason({ kind: "pipeline", id: pipeline.id, state: pipeline.state, updatedAt: pipeline.updatedAt }, options);
    if (reason) {
      found.push({ pipeline, reason });
      continue;
    }
    if (pipeline.silentForMs !== null && pipeline.silentForMs >= input.policy.stallAfterMs) {
      const stage = pipeline.stageId ? ` stage ${pipeline.stageId}` : "";
      found.push({ pipeline, reason: `pipeline ${pipeline.id}${stage} holds an open turn whose transcript stopped growing` });
    }
  }
  return found;
}

function elapsed(since: string | null, now: number, window: number): boolean {
  if (!since) return true;
  const at = Date.parse(since);
  return !Number.isFinite(at) || now - at >= window;
}

/** The retry-guard count that applies right now: a fingerprint that moved since
    the last wake means the board changed, so nothing is being re-sent. */
function guardCount(state: SeatTickProjectState, kind: SeatTickWakeReasonKind, fingerprint: string): number {
  if (state.lastWakeFingerprint !== fingerprint) return 0;
  return state.wakesWithoutChange[kind] ?? 0;
}

export function seatTickDecision(input: SeatTickCheckInput): SeatTickDecision {
  const at = new Date(input.now).toISOString();
  const unchanged = { ...input.state, lastCheckAt: at };

  if (!input.seat) {
    return {
      verdict: { kind: "no-seat", detail: "the project has open work and no active orchestrator seat" },
      state: { ...unchanged, seatEpoch: null, digestThrough: input.digestThrough },
      cards: [{
        /* The same ref the conversation monitor raises this condition under, so
           the two mechanisms cannot double-card one missing orchestrator. */
        ref: ORCHESTRATOR_ALERT_REF,
        kind: "no-seat",
        detail: "No active orchestrator seat holds this project, so the tick has nothing to wake",
      }],
    };
  }

  /* A tick that landed after the current turn would be acting on evidence the
     turn has already superseded. Drop it: no delivery, no cursor advance, no
     stall memory, and the next check re-reads everything. */
  if (input.seat.turn === "busy") {
    return { verdict: { kind: "skipped", reason: "seat-busy" }, state: unchanged, cards: [] };
  }

  const base: SeatTickProjectState = { ...unchanged, seatEpoch: input.seat.seatEpoch, digestThrough: input.digestThrough };
  const stalled = stalledLanes(input);
  const stalledNow = stalled.map((entry) => entry.pipeline.id);
  /* A stall is only reported once it survived a second check, so a lane between
     two attempts is never called stuck. */
  const persistedStalls = stalled.filter((entry) => input.state.stalledSeen.includes(entry.pipeline.id));
  const laneEvents = input.events.filter((event) => isTerminalHighSignalEvent(event.type));
  const unstarted = input.tasks.filter(isUnstarted);
  const openWork = hasOpenWork(input);
  const wakeDue = elapsed(input.state.lastWakeAt, input.now, input.policy.wakeIntervalMs);

  const state: SeatTickProjectState = { ...base, stalledSeen: stalledNow };

  const candidates: SeatTickWakeReason[] = [];
  if (laneEvents.length > 0) {
    const first = laneEvents[0]!;
    const more = laneEvents.length > 1 ? ` and ${laneEvents.length - 1} more` : "";
    candidates.push({ kind: "lane-event", detail: `${first.type} since the last check${more}` });
  }
  if (wakeDue && persistedStalls.length > 0) {
    candidates.push({ kind: "stalled", detail: persistedStalls[0]!.reason });
  }
  if (wakeDue && unstarted.length > 0) {
    candidates.push({ kind: "unstarted-task", detail: `${unstarted.length} assigned board task(s) nothing has started` });
  }
  /* The interval is a floor on wakes, never a licence to speak with nothing to
     say. Reaching here with no candidate means no lane event, no persisted
     stall and no unstarted task, so an interval wake would carry exactly the
     open lanes and the signals. A board whose only open work is an inbox card —
     open work, but work the seat is told not to touch, because the operator's
     move to assigned is what starts it — leaves that agenda empty, and an
     hourly wake with an empty agenda is the burnt-quota tick this replaces. */
  const intervalAgenda = input.pipelines.some(isOpenLane) || input.signals.length > 0;
  if (wakeDue && openWork && intervalAgenda && candidates.length === 0) {
    candidates.push({ kind: "interval", detail: "the wake interval elapsed while work is open" });
  }

  const cards: SeatTickCard[] = [];
  const reasons: SeatTickWakeReason[] = [];
  for (const reason of candidates) {
    if (guardCount(input.state, reason.kind, input.changeFingerprint) >= input.policy.retryGuard) {
      cards.push({
        ref: seatTickRetryGuardRef(reason.kind),
        kind: "retry-guard",
        detail: `Wakes for "${reason.kind}" stopped producing any board or pipeline change; the tick has stopped re-sending it until state moves`,
      });
      continue;
    }
    reasons.push(reason);
  }

  if (reasons.length > 0) {
    const all = wakeItems({ input, stalled: persistedStalls, laneEvents, unstarted });
    return {
      verdict: {
        kind: "wake",
        reasons,
        items: all.slice(0, input.policy.itemsPerWake),
        deferred: Math.max(0, all.length - input.policy.itemsPerWake),
      },
      state,
      cards,
    };
  }

  if (cards.length > 0) {
    return { verdict: { kind: "quiet", detail: "every wake reason is held by the retry guard" }, state: quiet(state, at), cards };
  }

  if (!openWork) {
    const idle = { ...quiet(state, at), idleSince: input.state.idleSince ?? at };
    if (elapsed(input.state.lastProposalAt, input.now, input.policy.proposalIntervalMs)) {
      return {
        verdict: { kind: "proactive", detail: "no open lane, no unblocked task, and the proposal slot is due" },
        state: idle,
        cards: [],
      };
    }
    return { verdict: { kind: "quiet", detail: "the board is done and the proposal slot is not due" }, state: idle, cards: [] };
  }

  return { verdict: { kind: "quiet", detail: "nothing owed" }, state: { ...quiet(state, at), idleSince: null }, cards: [] };
}

function quiet(state: SeatTickProjectState, at: string): SeatTickProjectState {
  return { ...state, quietSince: state.quietSince ?? at };
}

function wakeItems(context: {
  input: SeatTickCheckInput;
  stalled: { pipeline: SeatTickPipelineInput; reason: string }[];
  laneEvents: SeatTickCheckInput["events"];
  unstarted: SeatTickTaskInput[];
}): SeatTickItem[] {
  const { input } = context;
  const items: SeatTickItem[] = [];
  for (const event of context.laneEvents) {
    items.push({ kind: "event", id: event.pipelineId ?? event.type, label: `${event.type}: ${event.summary}` });
  }
  for (const entry of context.stalled) {
    items.push({ kind: "pipeline", id: entry.pipeline.id, label: `${entry.pipeline.title} — ${entry.reason}` });
  }
  for (const task of context.unstarted) {
    items.push({ kind: "task", id: task.id, label: `${task.title} — assigned, nothing started it` });
  }
  /* On an interval wake the open lanes are the agenda; they carry no reason of
     their own, so they come last and only when nothing sharper displaced them. */
  for (const pipeline of input.pipelines) {
    if (!isOpenLane(pipeline)) continue;
    if (items.some((item) => item.id === pipeline.id)) continue;
    items.push({ kind: "pipeline", id: pipeline.id, label: `${pipeline.title} — open` });
  }
  for (const signal of input.signals) {
    items.push({ kind: "signal", id: signal.id, label: signal.label });
  }
  return items;
}

/**
 * The half of the state transition that only a delivered wake earns.
 *
 * Kept apart from {@link seatTickDecision} on purpose: a wake whose seat epoch
 * moved between the decision and the send is refused at the send, and must not
 * leave a record saying the seat was woken. Only the controller, holding the
 * delivery outcome, may apply this.
 */
export function seatTickWakeCommit(
  state: SeatTickProjectState,
  verdict: SeatTickVerdict,
  fingerprint: string,
  now: number,
): SeatTickProjectState {
  const at = new Date(now).toISOString();
  if (verdict.kind === "proactive") {
    return { ...state, lastWakeAt: at, lastProposalAt: at, lastWakeReasons: [], lastWakeFingerprint: fingerprint, quietSince: null };
  }
  if (verdict.kind !== "wake") return state;

  const carried = verdict.reasons.map((reason) => reason.kind);
  const fruitless = state.lastWakeFingerprint === fingerprint;
  const wakesWithoutChange: Partial<Record<SeatTickWakeReasonKind, number>> = {};
  for (const kind of SEAT_TICK_WAKE_REASON_KINDS) {
    if (!carried.includes(kind)) continue;
    wakesWithoutChange[kind] = fruitless ? (state.wakesWithoutChange[kind] ?? 0) + 1 : 0;
  }
  return {
    ...state,
    lastWakeAt: at,
    lastWakeReasons: carried,
    lastWakeFingerprint: fingerprint,
    wakesWithoutChange,
    quietSince: null,
    idleSince: null,
  };
}
