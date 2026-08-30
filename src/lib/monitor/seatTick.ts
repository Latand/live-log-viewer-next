import { isTerminalHighSignalEvent } from "@/lib/lifecycle/vocabulary";

import { seatTickRetryGuardRef, seatTickSourceGapRef, ORCHESTRATOR_ALERT_REF, SEAT_TICK_SETTINGS_REF } from "./cards";
import { evidenceStallReason } from "./classify";
import {
  SEAT_TICK_WAKE_REASON_KINDS,
  type SeatTickCard,
  type SeatTickCheckInput,
  type SeatTickDecision,
  type SeatTickEventInput,
  type SeatTickEvidenceGap,
  type SeatTickItem,
  type SeatTickPipelineInput,
  type SeatTickPolicy,
  type SeatTickProjectState,
  type SeatTickPullRequestGap,
  type SeatTickSeatInput,
  type SeatTickSourceGap,
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
 * Five rules are load-bearing and easy to lose:
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
 * - **Every wake waits out the project's wake interval.** One hour by default,
 *   with no exception and no reason allowed to jump it: a terminal lane event
 *   is the FIRST thing the next wake carries, never a reason to raise one
 *   early. The bound is what the ADR's cost argument rests on — one resume per
 *   project per interval. What sets the interval is the project's own recorded
 *   settings (#1275, and the ADR amendment it carries): the seat governs its
 *   own tick, deliberately and with the reason on the record, and a project
 *   nobody configured runs on the default hour exactly as before.
 * - **Nothing here creates or wakes anything.** The decision names what is
 *   owed; the controller sends it, re-reads the seat epoch before it does, and
 *   only a delivered send advances a stamp. The one thing a check may settle on
 *   its own is the history in front of the cursor: an event nothing is owed on
 *   is discharged by the look that established that, never by a wake (#1285).
 * - **A wake names what is owed NOW, and silence means nothing is.** Both
 *   directions of that are here. An event about a lane that has itself finished
 *   is not an obligation, however far the cursor has fallen behind; a lane that
 *   finished and left its pull request unmerged IS one, however quiet the board
 *   otherwise looks (#1289). Where the two pull against each other the rarer,
 *   truer wake wins over the earlier one.
 * - **A failed evidence source degrades ITSELF and nothing else** (#1298). The
 *   rule above bought its truthfulness by refusing to conclude anything from a
 *   read that failed — and then refused to conclude anything at all, so a
 *   `gh` that could not authenticate withdrew a parked lane's wake as surely as
 *   it withdrew the pull request's. Twenty-three consecutive checks reported
 *   `error` while two lanes stood parked, which from the seat's side and the
 *   operator's is the silence the refusal exists to prevent. So the reasons
 *   that rest on the failed source are withheld, every other reason still wakes
 *   the seat, and the wake names the evidence it could not see. Only when
 *   nothing else stands is the check an `error` — quiet remains a conclusion
 *   nobody may draw from a read that failed.
 */

const MINUTE_MS = 60_000;

/**
 * The default bound, and the only one that is not a policy field.
 *
 * A project is woken at most once an hour while work is open. That is the
 * commitment in `docs/adr/0001-seat-tick-wake-resumes-a-dead-seat-host.md`,
 * and the whole cost argument for reversing #741's delivery rule rests on it:
 * a wake may resume a host the retirement sweep reclaimed, so "how often can
 * the two trade a host" is answered by this number.
 *
 * There is still no environment override, no exempt reason kind and no reset
 * when the seat rotates — the three ways the answer would silently become "it
 * depends". What #1275 added is the one deliberate way: a project's own
 * settings row, written by an explicit act with a reason on it and shown on
 * the board while it stands. A project nobody has configured is woken on this
 * number, and every project was, before anyone chose otherwise.
 */
export const SEAT_TICK_WAKE_INTERVAL_MS = 60 * MINUTE_MS;

export const DEFAULT_SEAT_TICK_POLICY: SeatTickPolicy = {
  checkIntervalMs: 5 * MINUTE_MS,
  stallAfterMs: 40 * MINUTE_MS,
  proposalIntervalMs: 24 * 60 * MINUTE_MS,
  itemsPerWake: 5,
  retryGuard: 2,
  backlogAfterMs: 3 * 24 * 60 * MINUTE_MS,
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
    backlogAfterMs: positive(env.LLV_SEAT_TICK_BACKLOG_DAYS, DEFAULT_SEAT_TICK_POLICY.backlogAfterMs, 24 * 60 * MINUTE_MS),
  };
}

function isOpenLane(pipeline: SeatTickPipelineInput): boolean {
  return pipeline.state !== "terminal";
}

/**
 * An assigned card nobody started — and only while that is a fact about NOW.
 *
 * "Assigned with no pipeline" accumulates. A board carrying historical status
 * notes parked in `assigned` months ago makes the condition permanently true,
 * so the reason fires on every interval for ever, carrying the same items, and
 * the first thing the tick teaches a seat is to ignore one of its own wake
 * reasons (#1262). The bound is the card's own movement: past
 * {@link SeatTickPolicy.backlogAfterMs} untouched it is backlog, not work
 * waiting to start.
 *
 * That is also what discharges it, without a second mechanism for silencing a
 * signal: the seat already moves, edits, blocks or closes a card, and any of
 * those makes it recent again — a card the seat judged not to be work drops
 * out on its own once nobody touches it.
 */
function isUnstarted(task: SeatTickTaskInput, now: number, backlogAfterMs: number): boolean {
  if (task.status !== "assigned" || task.owned) return false;
  const movedAt = task.updatedAt ? Date.parse(task.updatedAt) : Number.NaN;
  /* A card with no readable movement instant cannot be shown to be recent, and
     the whole failure being fixed here is a reason that can never stop being
     true, so the unprovable case is backlog. */
  return Number.isFinite(movedAt) && now - movedAt < backlogAfterMs;
}

/**
 * Work the seat could still carry: an open lane, a board card that is neither
 * blocked (a recorded stop) nor done, or a pull request a finished lane left
 * open.
 *
 * The third clause is #1289. Counting only lanes and cards made "the work
 * finished" and "the work finished and left three approved pull requests
 * unmerged" the same answer, and the tick said `quiet — nothing owed` to the
 * second one every five minutes for twelve hours. A finished lane's open pull
 * request is the obligation that finishing created, so it is open work.
 */
function hasOpenWork(input: SeatTickCheckInput): boolean {
  return input.pipelines.some(isOpenLane)
    || input.tasks.some((task) => task.status === "inbox" || task.status === "assigned")
    || input.pullRequests.length > 0;
}

/**
 * A pending event that is still a present obligation.
 *
 * Two filters, and the second is the one #1285 adds: the event has to be
 * terminal and high-signal (routine progress has never woken anyone on its
 * own), and the lane it names must not have reached a terminal state itself.
 * A `stage_completed` for a pipeline that closed yesterday is a fact about the
 * past — nothing is owed on it, and a wake that carries it spends a resumed
 * host and a paid turn establishing exactly that.
 */
function isOwedEvent(event: SeatTickEventInput): boolean {
  return isTerminalHighSignalEvent(event.type) && !event.pipelineTerminal;
}

/**
 * How far this check may move the cursor with no wake at all.
 *
 * The page is walked oldest-first and stops at the first event that is still
 * owed, so the seal covers exactly the history in front of it: routine progress
 * and terminal events whose lanes have finished. Null means the very first
 * pending event is owed and the cursor stays where it is.
 *
 * This is what stops a backlog from costing one resume per page. The bound that
 * makes a wake cheap — {@link SeatTickPolicy.itemsPerWake} items, once per
 * project per interval — turned into a ten-hour tail the moment the cursor fell
 * behind, because every page of history had to be carried to a seat before the
 * next one could be read. A page of history is discharged by one look instead,
 * and a check costs nothing.
 */
function dischargedThrough(events: readonly SeatTickEventInput[], cursor: number | null): number | null {
  let sealed = cursor;
  for (const event of events) {
    if (isOwedEvent(event)) break;
    /* A floor, never a subtraction: the cursor may only ever move forwards,
       whatever order a page reaches this. */
    sealed = Math.max(sealed ?? event.seq, event.seq);
  }
  return sealed;
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
 * decides: `running`, `waiting` under a turn the transcript still shows open (a
 * provider retry deadline) and `starting` (inside the launch grace, which
 * expires into `stalled` or `gone` on its own) are progress; everything else,
 * absent verdicts included, is not.
 */
export function seatTurnProgressing(seat: SeatTickSeatInput): boolean {
  if (seat.turn !== "busy") return false;
  const activity = seat.activity;
  if (!activity) return false;
  /* `waiting` covers two different seats. One is a turn held open by a provider
     retry deadline, which is progress. The other is `host_alive_turn_idle`: the
     transcript says the turn SETTLED and only the registry's record still calls
     it open — a seat sitting available, which the tick then skipped at every
     check for as long as the stale record stood (#1262). The evidence the
     verdict came from decides between them. */
  if (activity.lifecycle === "waiting") return activity.turnState === "busy";
  return activity.lifecycle === "running" || activity.lifecycle === "starting";
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

/**
 * The one gate every wake passes, exported so the gather can apply the SAME
 * clause rather than a second copy of it.
 *
 * It reads `lastWakeAt`, which the project keeps across a rotation, so an
 * incoming seat inherits the bound rather than a clean slate the predecessor's
 * wake is missing from — and the interval is the project's own (#1275), which
 * is the default hour until someone records something else.
 */
export function seatTickWakeDue(lastWakeAt: string | null, now: number, wakeIntervalMs: number): boolean {
  return elapsed(lastWakeAt, now, wakeIntervalMs);
}

/**
 * Whether an evidence source is failing rather than blipping (#1298).
 *
 * "Cannot be read at all" is a claim about a RUN of failures. `gh` refusing
 * once is a rate limit or a flaky network, and putting a card on the board for
 * that would teach the operator to ignore the card. A run that has
 * outlived a whole wake interval is the other thing — the credential is missing,
 * the command is not installed, the host config points nowhere — and that is
 * worth saying once, out loud.
 *
 * The project's own interval is the threshold rather than a number of checks,
 * because the check cadence is not what "how long has this been broken" means,
 * and because the same predicate then bounds the retry: past this point the
 * source is asked at the rate its answer could possibly change a wake, and no
 * faster.
 */
export function seatTickSourceGapStanding(gap: SeatTickSourceGap | null, now: number, wakeIntervalMs: number): boolean {
  if (!gap) return false;
  const since = Date.parse(gap.since);
  /* A run whose start cannot be read is not a run anything may be concluded
     from, so it is treated as freshly failing: it keeps the fast retry and
     raises no card. */
  return Number.isFinite(since) && now - since >= wakeIntervalMs;
}

/**
 * Whether the source is asked again on this check.
 *
 * Inside the first interval of a run, every check asks — a transient failure
 * must recover at the check interval, not an hour later. Once the run stands
 * (above), the subprocess is paid for at most once per wake interval: the
 * answer cannot raise a wake more often than that anyway, and a source that
 * has been dead all day should not cost one process per project every five
 * minutes for ever.
 *
 * Slowing the read can never slow a decision, because a check that does not
 * ask replays the gap it already knows about — see
 * {@link SeatTickCheckInput.pullRequestsUnavailable}. Every verdict in between
 * is the verdict a fresh failed read would have produced.
 */
export function seatTickSourceRetryDue(gap: SeatTickSourceGap | null, now: number, wakeIntervalMs: number): boolean {
  if (!gap || !seatTickSourceGapStanding(gap, now, wakeIntervalMs)) return true;
  const attempted = Date.parse(gap.lastAttemptAt);
  return !Number.isFinite(attempted) || now - attempted >= wakeIntervalMs;
}

/** The run of failures after one attempt failed: a new one, or the standing one
    advanced. `since` and `reported` belong to the RUN, so neither is reset by a
    later failure inside it — only an answer clears the row. */
export function seatTickSourceGapAfterFailure(
  gap: SeatTickSourceGap | null,
  kind: SeatTickPullRequestGap,
  at: string,
): SeatTickSourceGap {
  if (!gap) return { gap: kind, since: at, lastAttemptAt: at, attempts: 1, reported: false };
  return { ...gap, gap: kind, lastAttemptAt: at, attempts: gap.attempts + 1 };
}

/** The token the pull-request half carries when the source could not be read
    (#1298). Shared with the composer, so the two halves cannot drift apart. */
export const FINGERPRINT_UNREAD = "unread";

/**
 * Whether the board moved between two checks — the question the retry guard is
 * an answer to, and the one place a fingerprint is interpreted rather than
 * compared.
 *
 * Plain inequality answered it until one of the sources behind the digest
 * could go missing (#1298). An unreadable pull-request source contributes no
 * rows, which is byte-for-byte what a merged pull request contributes, so a
 * source failing every other check made the digest alternate between two
 * values and every wake looked like it had landed on a changed board. The
 * guard would never have reached its count, and the gap that is supposed to
 * cost nothing would have bought an unbounded wake for every reason on it.
 *
 * So the unreadable half says nothing instead of saying "empty": it can
 * neither invent movement nor claim stillness, and the answer rests on the
 * evidence both checks actually read. A digest from before this shape is
 * compared whole, which reads as one movement on the first check after it
 * changes and settles from there.
 */
export function seatTickBoardMoved(previous: string | null, current: string): boolean {
  if (previous === null) return true;
  const before = splitFingerprint(previous);
  const now = splitFingerprint(current);
  if (!before || !now) return previous !== current;
  if (before.board !== now.board) return true;
  /* The board part matched, so whatever moved has to have moved in the part one
     of these two checks could not read. Neither of them knows that it did. */
  if (before.pullRequests === FINGERPRINT_UNREAD || now.pullRequests === FINGERPRINT_UNREAD) return false;
  return before.pullRequests !== now.pullRequests;
}

function splitFingerprint(fingerprint: string): { board: string; pullRequests: string } | null {
  const cut = fingerprint.indexOf(".");
  if (cut <= 0 || cut === fingerprint.length - 1) return null;
  return { board: fingerprint.slice(0, cut), pullRequests: fingerprint.slice(cut + 1) };
}

/** The retry-guard count that applies right now: a board that moved since the
    last wake means nothing is being re-sent. */
function guardCount(state: SeatTickProjectState, kind: SeatTickWakeReasonKind, fingerprint: string): number {
  if (seatTickBoardMoved(state.lastWakeFingerprint, fingerprint)) return 0;
  return state.wakesWithoutChange[kind] ?? 0;
}

/**
 * The board card that says a project's tick is deliberately off or slowed
 * (#1275), or that it is back on the default.
 *
 * A tick that has gone quiet with nothing anywhere saying why is
 * indistinguishable from a tick that broke, and that is the worse failure of
 * the two. So while the settings depart from the default the board carries the
 * setting, its reason and who set it; when they are back at the default the
 * same card is resolved rather than left standing over a tick that is ticking.
 *
 * A project nobody has ever configured emits nothing at all — no card to raise
 * and none to resolve — so it costs exactly what it cost before this existed.
 */
function settingsCards(input: SeatTickCheckInput): SeatTickCard[] {
  const settings = input.settings;
  if (!settings.configured) return [];
  const context = { reason: settings.reason, until: settings.until, setBy: settings.setBy, updatedAt: settings.updatedAt };
  if (settings.isDefault) {
    return [{
      ref: SEAT_TICK_SETTINGS_REF,
      kind: "tick-settings",
      state: "resolved",
      settings: context,
      detail: settings.lapsed
        ? "the recorded tick setting reached its expiry, so this project is back on the default wake interval"
        : "this project is on the default tick settings",
    }];
  }
  return [{
    ref: SEAT_TICK_SETTINGS_REF,
    kind: "tick-settings",
    state: "open",
    settings: context,
    detail: settings.enabled
      ? `wakes for this project are set to one every ${Math.round(settings.wakeIntervalMs / MINUTE_MS)} minute(s)`
      : "ticking is off for this project: no wake will be sent until it is turned back on",
  }];
}

/**
 * What this check could not read, in the form the wake carries it (#1298).
 *
 * One entry per source, and today the pull-request read is the only source that
 * can fail without failing the whole check. The clause is written for the seat:
 * it says which evidence is missing and which obligation therefore cannot be
 * named, so a seat acting on the rest of the wake knows what is NOT in it.
 */
function evidenceGaps(input: SeatTickCheckInput): SeatTickEvidenceGap[] {
  const gap = input.pullRequestsUnavailable;
  if (!gap) return [];
  return [{
    source: "pull-requests",
    gap,
    detail: `the open pull requests of this project's finished lanes could not be read (${gap}), `
      + "so a pull request a finished lane left unmerged cannot be named in this wake",
  }];
}

/**
 * The board card for a source that cannot be read at all, raised once per
 * outage (#1298).
 *
 * The journal already carried every failure, and the whole failure was that
 * nobody reads a journal: a `gh` that could not authenticate failed on every
 * check from the day the feature shipped, and the first person to notice was
 * the operator asking why the seat had been quiet for four hours. So a run of
 * failures that outlives the wake interval — long enough that this is
 * configuration rather than weather — is put where an operator looks.
 *
 * Once, and only once: {@link SeatTickSourceGap.reported} is the tick's own
 * memory of having said it, so closing the card does not summon it again five
 * minutes later. The row clears when the source answers, which is what makes
 * the next outage a new card rather than a silent one.
 */
function sourceGapReport(
  input: SeatTickCheckInput,
  gaps: readonly SeatTickEvidenceGap[],
): { card: SeatTickCard; gap: SeatTickSourceGap } | null {
  const gap = input.state.pullRequestGap;
  if (gaps.length === 0 || !gap || gap.reported) return null;
  if (!seatTickSourceGapStanding(gap, input.now, input.settings.wakeIntervalMs)) return null;
  return {
    card: {
      ref: seatTickSourceGapRef("pull-requests"),
      kind: "source-unreadable",
      detail: `The open pull requests of this project's finished lanes have not been readable since `
        + `${gap.since.slice(0, 16).replace("T", " ")} UTC (${gap.gap}, ${gap.attempts} attempt(s))`,
    },
    gap: { ...gap, reported: true },
  };
}

/**
 * One check's decision, plus the standing tick-settings card.
 *
 * The card is composed here rather than inside each branch because it is not a
 * conclusion about the board at all: it is what the settings say, and it is
 * owed identically whether the check woke the seat, skipped it or found
 * nothing.
 */
export function seatTickDecision(input: SeatTickCheckInput): SeatTickDecision {
  const decision = decide(input);
  return { ...decision, cards: [...decision.cards, ...settingsCards(input)] };
}

function decide(input: SeatTickCheckInput): SeatTickDecision {
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

  /* The seal (#1285) rides on every verdict from here down, a skipped check
     excepted — that one returns above and remembers nothing, deliberately. It
     is not a record of anything having been sent: it says this check looked at
     the history in front of the cursor and found nothing owed in it, which is
     a conclusion a quiet check is as entitled to as a wake. */
  const base: SeatTickProjectState = {
    ...unchanged,
    seatEpoch: input.seat.seatEpoch,
    eventsThrough: dischargedThrough(input.events, unchanged.eventsThrough),
  };
  const stalled = stalledLanes(input);
  const stalledNow = stalled.map((entry) => entry.pipeline.id);
  /* A stall is only reported once it survived a second check, so a lane between
     two attempts is never called stuck. */
  const persistedStalls = stalled.filter((entry) => input.state.stalledSeen.includes(entry.pipeline.id));
  const unstarted = input.tasks.filter((task) => isUnstarted(task, input.now, input.policy.backlogAfterMs));
  const backlog = input.tasks.filter((task) => task.status === "assigned" && !task.owned).length - unstarted.length;
  const openWork = hasOpenWork(input);
  const wakeDue = seatTickWakeDue(input.state.lastWakeAt, input.now, input.settings.wakeIntervalMs);

  const observed: SeatTickProjectState = { ...base, stalledSeen: stalledNow };

  /* Ticking is off for this project, so no wake and no proposal — and the
     check still runs, still reads the board and still writes its journal line.
     That is the difference the operator has to be able to see: a tick that is
     off keeps saying so every check, while a tick that broke says nothing at
     all. The stall memory above is kept fresh for the same reason: when the
     tick is turned back on it decides from what it has been watching rather
     than from a blank row. */
  if (!input.settings.enabled) {
    return {
      verdict: {
        kind: "quiet",
        detail: input.settings.reason
          ? `ticking is off for this project: ${input.settings.reason}`
          : "ticking is off for this project",
      },
      state: quiet(observed, at),
      cards: [],
    };
  }

  const laneEvents = input.events.filter(isOwedEvent);
  const candidates: SeatTickWakeReason[] = [];
  if (wakeDue) {
    /* A verdict the seat cannot decide without leads the wake — and waits for
       the wake like everything else. Routine progress never wakes on its own,
       and neither does an event whose lane has finished.

       The count beside it is what the seat reads as "how much is there", so it
       counts what is owed and nothing else (#1285): "and 18 more" over a page
       that was almost entirely closed lanes described a queue that did not
       exist. A live event further down the journal than this check reads is
       NOT announced here; the pages of history in front of it are sealed away
       by the check itself at no cost, and the check that reaches it names it.
       A wake that says only "something is waiting further down" is the empty
       agenda this whole mechanism exists to stop sending. */
    if (laneEvents.length > 0) {
      const first = laneEvents[0]!;
      const more = laneEvents.length > 1 ? ` and ${laneEvents.length - 1} more` : "";
      candidates.push({ kind: "lane-event", detail: `${first.type} since the last delivered wake${more}` });
    }
    /* The mirror image (#1289), and it is a wake reason rather than a silence
       for one reason: a lane that finished with its pull request unmerged is
       the seat's next obligation, and the tick could not see one. It takes no
       shortcut around the bound — same interval above, same retry guard below —
       and it clears itself when the pull request merges or closes.

       This is the ONE reason a pull-request gap withholds, and it withholds it
       by having nothing to name: an unreadable source carries no rows, so the
       clause below is simply false (#1298). Every other candidate is composed
       from evidence this check did read. */
    if (input.pullRequests.length > 0) {
      const first = input.pullRequests[0]!;
      const more = input.pullRequests.length > 1 ? ` and ${input.pullRequests.length - 1} more` : "";
      candidates.push({
        kind: "unmerged-pr",
        detail: `pull request #${first.number}${more} left open by a lane that finished`,
      });
    }
    if (persistedStalls.length > 0) {
      candidates.push({ kind: "stalled", detail: persistedStalls[0]!.reason });
    }
    if (unstarted.length > 0) {
      /* The excluded count travels with the reason so a seat reading "2" beside
         a board showing twenty-nine assigned cards can see why, rather than
         concluding the tick cannot count. */
      const held = backlog > 0 ? `, and ${backlog} older than the backlog bound the wake no longer names` : "";
      candidates.push({ kind: "unstarted-task", detail: `${unstarted.length} assigned board task(s) nothing has started${held}` });
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
  let guardHeld = 0;
  for (const reason of candidates) {
    if (guardCount(input.state, reason.kind, input.changeFingerprint) >= input.policy.retryGuard) {
      guardHeld += 1;
      cards.push({
        ref: seatTickRetryGuardRef(reason.kind),
        kind: "retry-guard",
        detail: `Wakes for "${reason.kind}" stopped producing any board or pipeline change; the tick has stopped re-sending it until state moves`,
      });
      continue;
    }
    reasons.push(reason);
  }

  /* What this check could not read, said once on the board and on every wake
     that goes out while it stands (#1298). The card is the "once": a source
     that has been failing since before the wake interval is not a blip, and
     twenty-three journal lines nobody was reading is what the operator got
     instead of being told. */
  const gaps = evidenceGaps(input);
  const gapReport = sourceGapReport(input, gaps);
  if (gapReport) cards.push(gapReport.card);
  const state = gapReport ? { ...observed, pullRequestGap: gapReport.gap } : observed;

  /* The wake goes FIRST, and it goes out while a source is unreadable (#1298).
     Every reason it carries was decided from evidence this check did read, and
     the gaps beside them say what it could not — so the hour a delivered wake
     buys is bought by a wake that named real work and named its own blind
     spot. The trade the previous shape refused was a different one: a wake
     with nothing but the failed read behind it. That one is still refused,
     because the reason resting on the failed source is never composed at all.

     The guard and the interval are untouched by any of it: the reasons here
     passed both, and a gap adds none. */
  if (reasons.length > 0) {
    const all = wakeItems({ input, stalled: persistedStalls, laneEvents, unstarted });
    return {
      verdict: {
        kind: "wake",
        reasons,
        items: all.slice(0, input.policy.itemsPerWake),
        deferred: Math.max(0, all.length - input.policy.itemsPerWake),
        gaps,
      },
      state,
      cards,
    };
  }

  /* Nothing else was owed, so the unreadable source is the whole story — and
     quiet is a conclusion this check cannot draw. It ends as an error that
     costs nothing: no delivery, no wake stamp, no retry-guard count, no claim
     of quiet in the row. The hourly bound belongs to wakes that were actually
     sent, and a failed read still cannot spend it. It stays ahead of every
     verdict below, each of which says nothing is owed. */
  if (gaps.length > 0) {
    return {
      verdict: {
        kind: "error",
        detail: `the open pull requests of this project's finished lanes could not be read (${gaps[0]!.gap}), so nothing owed is not established`,
      },
      state,
      cards,
    };
  }

  /* Nothing left to wake on, and every outcome below this line is a statement
     that nothing is owed — each of them resting on evidence the check above
     has already shown it could read. */
  if (guardHeld > 0) {
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
  /* Named, not merely counted (#1289). The twelve hours were spent because the
     seat had no way to know a pull request was waiting; a wake that says one is
     and leaves the seat to rediscover which would have cost most of the same
     turn. The lane that produced it travels with it for the same reason. */
  for (const pullRequest of input.pullRequests) {
    items.push({
      kind: "pull-request",
      id: `#${pullRequest.number}`,
      label: `${pullRequest.title} — open pull request from ${pullRequest.pipelineTitle}, unmerged since that lane finished`,
    });
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
  const eventsThrough = Math.max(state.eventsThrough ?? 0, commit.eventsThrough);
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
  /* A wake that changed nothing, counted the same way the guard reads it — an
     hour whose pull-request half was unreadable is an hour that showed no
     movement, so it accrues rather than resetting (#1298). A blind source
     cannot postpone the guard any more than it can walk around it. */
  const fruitless = !seatTickBoardMoved(state.lastWakeFingerprint, commit.fingerprint);
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
