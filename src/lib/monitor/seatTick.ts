import { isTerminalHighSignalEvent } from "@/lib/lifecycle/vocabulary";

import { seatTickRetryGuardRef, ORCHESTRATOR_ALERT_REF } from "./cards";
import { evidenceStallReason } from "./classify";
import {
  SEAT_TICK_WAKE_REASON_KINDS,
  type SeatTickCard,
  type SeatTickCheckInput,
  type SeatTickDecision,
  type SeatTickEventInput,
  type SeatTickItem,
  type SeatTickPipelineInput,
  type SeatTickPolicy,
  type SeatTickProjectState,
  type SeatTickSeatInput,
  type SeatTickTaskInput,
  type SeatTickVerdict,
  type SeatTickWakeCommit,
  type SeatTickWakeReason,
  type SeatTickWakeReasonKind,
} from "./types";

/**
 * The seat tick's pre-check (issue #1245) — a pure decision over durable state.
 *
 * The whole point of the tick is that the expensive half runs rarely. This is
 * the cheap half: no model call, no transcript scan, no network. It reads the
 * seat, the open lanes, the board, the lifecycle events past the seat's own
 * cursor and the Viewer's own signals, and answers one of five things.
 *
 * Four rules are load-bearing and easy to lose:
 *
 * - **A stale tick is dropped, never queued.** A seat whose turn is genuinely
 *   progressing is `skipped`, and a skipped check remembers nothing: the stall
 *   memory and the event cursor stay where they were so the next check decides
 *   on fresh evidence. The session-scheduled monitor this replaces queued its
 *   fires instead, and five of its seventy-six ticks were empty turns landing a
 *   fraction of a second behind the tick before them.
 * - **The skip terminates.** Only a verdict that says the turn is moving earns
 *   one. A turn the registry reports stalled or gone — and a turn the liveness
 *   plane cannot answer for at all — is not a turn the tick may wait behind
 *   forever, because the seat's own dead host is exactly the condition a wake
 *   exists to clear.
 * - **Every wake waits out the wake interval.** One project-scoped hour, with
 *   no exception and no override: a terminal lane event is the FIRST thing the
 *   next wake carries, never a reason to raise one early. The bound is what the
 *   ADR's cost argument rests on — one resume per project per interval — so a
 *   reason allowed to jump it would make the ADR describe a different system.
 * - **Nothing here creates, wakes or acknowledges anything.** The decision names
 *   what is owed; the controller sends it, re-reads the seat epoch before it
 *   does, and only a delivered send advances a stamp or a cursor.
 */

const MINUTE_MS = 60_000;

/**
 * The bound, and the only one that is not a policy field.
 *
 * A project is woken at most once an hour while work is open. That is the
 * commitment in `docs/adr/0001-seat-tick-wake-resumes-a-dead-seat-host.md`,
 * and the whole cost argument for reversing #741's delivery rule rests on it:
 * a wake may resume a host the retirement sweep reclaimed, so "how often can
 * the two trade a host" is answered by this number and nothing else. An
 * environment override, an exempt reason kind or a stamp a rotation cleared
 * would each turn that answer into "it depends", so there is no override, no
 * exemption, and the stamp belongs to the project rather than to the seat.
 */
export const SEAT_TICK_WAKE_INTERVAL_MS = 60 * MINUTE_MS;

export const DEFAULT_SEAT_TICK_POLICY: SeatTickPolicy = {
  checkIntervalMs: 5 * MINUTE_MS,
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
 * The wake interval is NOT among these. It is the bound the ADR commits to, so
 * it is {@link SEAT_TICK_WAKE_INTERVAL_MS} and nothing can set it.
 *
 * Null is the off switch, spelled the way retirement spells its own:
 * `LLV_SEAT_TICK_CHECK_MINUTES=0` means no checks at all.
 */
export function seatTickPolicy(env: Readonly<Record<string, string | undefined>> = process.env): SeatTickPolicy | null {
  const checkRaw = env.LLV_SEAT_TICK_CHECK_MINUTES?.trim();
  if (checkRaw && Number(checkRaw) === 0) return null;
  return {
    checkIntervalMs: positive(checkRaw, DEFAULT_SEAT_TICK_POLICY.checkIntervalMs, MINUTE_MS),
    stallAfterMs: positive(env.LLV_SEAT_TICK_STALL_MINUTES, DEFAULT_SEAT_TICK_POLICY.stallAfterMs, MINUTE_MS),
    proposalIntervalMs: positive(env.LLV_SEAT_TICK_PROPOSAL_HOURS, DEFAULT_SEAT_TICK_POLICY.proposalIntervalMs, 60 * MINUTE_MS),
    itemsPerWake: Math.floor(positive(env.LLV_SEAT_TICK_ITEMS, DEFAULT_SEAT_TICK_POLICY.itemsPerWake, 1)),
    retryGuard: Math.floor(positive(env.LLV_SEAT_TICK_RETRY_GUARD, DEFAULT_SEAT_TICK_POLICY.retryGuard, 1)),
  };
}

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
 * Whether the seat's turn is genuinely progressing, which is the only thing
 * that earns a dropped tick.
 *
 * The dead-host-over-an-open-turn case is why this is a positive test rather
 * than `turn === "busy"`. A seat whose host died mid-turn keeps a `busy` turn
 * on the registry forever, so a plain busy check skipped that seat at every
 * five-minute check for as long as the record stood — a permanent silence
 * produced by exactly the condition the wake exists to clear. Here the registry
 * decides: `running`, `waiting` (idle or a provider retry deadline) and
 * `starting` (inside the launch grace, which expires into `stalled` or `gone`
 * on its own) are progress; everything else, absent verdicts included, is not.
 */
export function seatTurnProgressing(seat: SeatTickSeatInput): boolean {
  if (seat.turn !== "busy") return false;
  const lifecycle = seat.activity?.lifecycle;
  return lifecycle === "running" || lifecycle === "waiting" || lifecycle === "starting";
}

/**
 * The lanes that are not moving, and the clause that says so.
 *
 * Two sources, neither of them arithmetic over attempt timestamps. Parked is
 * the durable pipeline state, read through the monitor's one stall rule
 * (`evidenceStallReason`). Silence under an open turn is the registry's own
 * activity verdict for the conversation running the stage — the same answer
 * `agent_activity` gives, already reconciled with host death. Subtracting the
 * newest attempt instant from the clock would instead call a long-running stage
 * stalled while its host was writing to the transcript.
 */
function stalledLanes(input: SeatTickCheckInput): { pipeline: SeatTickPipelineInput; reason: string }[] {
  const options = { now: new Date(input.now), stallAfterMs: null };
  const found: { pipeline: SeatTickPipelineInput; reason: string }[] = [];
  for (const pipeline of input.pipelines) {
    if (!isOpenLane(pipeline)) continue;
    const parked = evidenceStallReason({ kind: "pipeline", id: pipeline.id, state: pipeline.state, updatedAt: pipeline.updatedAt }, options);
    if (parked) {
      found.push({ pipeline, reason: parked });
      continue;
    }
    const activity = pipeline.stageActivity;
    if (activity && (activity.lifecycle === "stalled" || activity.lifecycle === "gone")) {
      const stage = pipeline.stageId ? ` stage ${pipeline.stageId}` : "";
      found.push({
        pipeline,
        reason: `pipeline ${pipeline.id}${stage} runs a turn the registry reports ${activity.lifecycle} (${activity.reason})`,
      });
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
      state: { ...unchanged, seatEpoch: null },
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
  if (seatTurnProgressing(input.seat)) {
    return { verdict: { kind: "skipped", reason: "seat-busy" }, state: unchanged, cards: [] };
  }

  const base: SeatTickProjectState = { ...unchanged, seatEpoch: input.seat.seatEpoch };
  const stalled = stalledLanes(input);
  const stalledNow = stalled.map((entry) => entry.pipeline.id);
  /* A stall is only reported once it survived a second check, so a lane between
     two attempts is never called stuck. */
  const persistedStalls = stalled.filter((entry) => input.state.stalledSeen.includes(entry.pipeline.id));
  const unstarted = input.tasks.filter(isUnstarted);
  const openWork = hasOpenWork(input);
  /* The one gate every wake passes. It reads `lastWakeAt`, which the project
     keeps across a rotation, so an incoming seat inherits the bound rather than
     a clean slate the predecessor's wake is missing from. */
  const wakeDue = elapsed(input.state.lastWakeAt, input.now, SEAT_TICK_WAKE_INTERVAL_MS);

  const state: SeatTickProjectState = { ...base, stalledSeen: stalledNow };

  const laneEvents = input.events.filter((event) => isTerminalHighSignalEvent(event.type));
  const candidates: SeatTickWakeReason[] = [];
  if (wakeDue) {
    /* Terminal events are counted over the WHOLE pending range, not just the
       page this check carries: a verdict sitting behind a backlog is as
       decision-blocking as one at the front, and a page-sized answer is how it
       gets buried. It leads the wake for that reason — and it waits for the
       wake like everything else. Routine progress never wakes on its own. */
    if (input.terminalPending) {
      const first = laneEvents[0];
      const more = laneEvents.length > 1 ? ` and ${laneEvents.length - 1} more` : "";
      candidates.push({
        kind: "lane-event",
        detail: first
          ? `${first.type} since the last delivered wake${more}`
          : "a terminal lane event is waiting further down the journal than this check reads",
      });
    }
    if (persistedStalls.length > 0) {
      candidates.push({ kind: "stalled", detail: persistedStalls[0]!.reason });
    }
    if (unstarted.length > 0) {
      candidates.push({ kind: "unstarted-task", detail: `${unstarted.length} assigned board task(s) nothing has started` });
    }
    /* The interval is a floor on wakes, never a licence to speak with nothing
       to say. Reaching here with no candidate means no lane event, no persisted
       stall and no unstarted task, so an interval wake would carry exactly the
       open lanes and the signals. A board whose only open work is an inbox card
       — open work, but work the seat is told not to touch, because the
       operator's move to assigned is what starts it — leaves that agenda empty,
       and an hourly wake with an empty agenda is the burnt-quota tick this
       replaces. */
    const intervalAgenda = input.pipelines.some(isOpenLane) || input.signals.length > 0;
    if (openWork && intervalAgenda && candidates.length === 0) {
      candidates.push({ kind: "interval", detail: "the wake interval elapsed while work is open" });
    }
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
    /* The proposal is a wake too — it resumes a host and spends a turn — so it
       waits out the same hour on top of its own 24-hour slot. */
    if (wakeDue && elapsed(input.state.lastProposalAt, input.now, input.policy.proposalIntervalMs)) {
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
  laneEvents: readonly SeatTickEventInput[];
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
 * Everything a wake will change if — and only if — it lands.
 *
 * Separated from the commit itself because the two can happen in different
 * checks. A send the delivery layer accepted but kept lands later, at the
 * holder's pace, and the check that observes the landing has its own decision
 * about its own board. Committing that check's fingerprint and cursor for a
 * message raised minutes earlier would credit the seat with the wrong wake, so
 * the raising check writes the plan down and the landing applies it verbatim.
 */
export function seatTickWakeCommitPlan(
  verdict: SeatTickVerdict,
  context: { fingerprint: string; eventsThrough: number },
): SeatTickWakeCommit | null {
  if (verdict.kind === "proactive") return { proposal: true, reasons: [], ...context };
  if (verdict.kind !== "wake") return null;
  return { proposal: false, reasons: verdict.reasons.map((reason) => reason.kind), ...context };
}

/**
 * The half of the state transition that only a LANDED wake earns.
 *
 * Kept apart from {@link seatTickDecision} on purpose, and it is the reason the
 * two halves exist at all. A wake whose seat epoch moved between the decision
 * and the send is refused at the send; a wake the delivery layer held or queued
 * is somewhere other than the seat, and stays that way until the layer holding
 * it says otherwise. Neither may leave a record saying the seat was woken, and
 * neither may advance the event cursor — an acknowledged event is never offered
 * again, so acking one before it landed is how a rotation loses the lane event
 * its successor needed.
 *
 * Landing is also what settles the outstanding wake: a message the seat has is
 * no longer a payload waiting somewhere for a seat that may be replaced before
 * it arrives.
 */
export function seatTickWakeCommit(
  state: SeatTickProjectState,
  commit: SeatTickWakeCommit,
  now: number,
): SeatTickProjectState {
  const at = new Date(now).toISOString();
  const eventsThrough = Math.max(state.eventsThrough, commit.eventsThrough);
  if (commit.proposal) {
    return {
      ...state,
      lastWakeAt: at,
      lastProposalAt: at,
      lastWakeReasons: [],
      lastWakeFingerprint: commit.fingerprint,
      quietSince: null,
      eventsThrough,
      outstandingWake: null,
    };
  }

  const carried = commit.reasons;
  const fruitless = state.lastWakeFingerprint === commit.fingerprint;
  const wakesWithoutChange: Partial<Record<SeatTickWakeReasonKind, number>> = {};
  for (const kind of SEAT_TICK_WAKE_REASON_KINDS) {
    if (!carried.includes(kind)) continue;
    wakesWithoutChange[kind] = fruitless ? (state.wakesWithoutChange[kind] ?? 0) + 1 : 0;
  }
  return {
    ...state,
    lastWakeAt: at,
    lastWakeReasons: carried,
    lastWakeFingerprint: commit.fingerprint,
    wakesWithoutChange,
    quietSince: null,
    idleSince: null,
    eventsThrough,
    outstandingWake: null,
  };
}
