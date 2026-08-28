import { deliverConversationMessage, type DeliveryOutcome } from "@/lib/delivery";
import { canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import { monitorClientRequestId, monitorRefIn, orchestratorAlertCardText, MONITOR_REF_PREFIX } from "@/lib/monitor/cards";
import { redactBounded } from "@/lib/monitor/redact";
import { createTask } from "@/lib/tasks/commands";
import { mutateTasksFile } from "@/lib/tasks/store";

import { openIssuesForProposal, type ProposalIssue } from "./githubProposal";
import { appendSeatTickRecord, type SeatTickRunRecord } from "./journal";
import { seatTickProposalMessage, seatTickWakeMessage } from "./message";
import { seatTickDecision, seatTickPolicy, seatTickWakeCommit } from "./precheck";
import { readSeatTickState, seatTickStateForEpoch, writeSeatTickState } from "./state";
import {
  defaultSeatTickSources,
  gatherSeatTickInput,
  repoDirForProject,
  seatTickProjects,
  type SeatTickSources,
} from "./sources";
import type { SeatTickCard, SeatTickPolicy, SeatTickProjectState } from "./types";

/**
 * The seat tick controller (issue #1245).
 *
 * One in-process clock, started by the release that owns traffic beside the
 * flow pipeline controller, the Telegram scheduler and the host retirement
 * sweep. There is no scheduler service, no cron entry, no timer unit, no
 * external process and no cross-process lock: the mechanism for "exactly one
 * active ticker per seat" is that there is one clock, in one process, and a
 * second start is refused out loud rather than silently ignored.
 *
 * What the thing this replaces got wrong, and what this does instead:
 *
 * - It lived in a session, so every rotation dropped it and the successor could
 *   not tell. Here the clock is the Viewer's and the state is on disk, so a
 *   rotation is a new epoch on a row that already exists.
 * - It could act under a seat that had been revoked minutes earlier. Here the
 *   seat epoch is re-read immediately before the send, and a seat that moved in
 *   between is refused — the wake is journaled as refused, and nothing about it
 *   is recorded as a wake the successor received.
 * - It queued its fires and then double-fired into a finished turn. Here a busy
 *   seat is skipped and the tick is dropped; nothing is ever held.
 */

export interface SeatTickControllerDependencies {
  sources?: SeatTickSources;
  policy?: SeatTickPolicy | null;
  readState?: typeof readSeatTickState;
  writeState?: typeof writeSeatTickState;
  appendRecord?: typeof appendSeatTickRecord;
  deliver?: typeof deliverConversationMessage;
  ensureCard?: (project: string, card: SeatTickCard, at: string) => void;
  proposalIssues?: (project: string, sources: SeatTickSources) => Promise<ProposalIssue[]>;
}

const CARD_TEXT_LIMIT = 5_000;

/** The card raised when a wake reason has stopped producing any change. The
    tick then stops re-prompting the same failure; the operator has the record. */
export function retryGuardCardText(project: string, card: SeatTickCard, at: string): string {
  return redactBounded(
    [
      "Seat tick stopped re-sending a wake reason",
      "",
      `${card.detail}.`,
      `Project ${project}. Observed ${at.slice(0, 16).replace("T", " ")} UTC.`,
      "The tick resumes this reason on its own once the board or a pipeline moves.",
      "",
      `${MONITOR_REF_PREFIX} ${card.ref}`,
    ].join("\n"),
    CARD_TEXT_LIMIT,
  );
}

function cardText(project: string, card: SeatTickCard, at: string): string {
  return card.kind === "no-seat"
    ? orchestratorAlertCardText(card.detail, at)
    : retryGuardCardText(project, card, at);
}

/**
 * One board card per condition, found by its `monitor-ref:` line rather than by
 * a receipt — so the idempotency survives a restart, and an operator who edits
 * the text above the marker keeps it.
 */
function ensureSeatTickCard(project: string, card: SeatTickCard, at: string): void {
  mutateTasksFile<void>((state) => {
    const existing = state.tasks.find((task) =>
      canonicalOrchestratorProject(task.project) === project
      && task.status !== "done"
      && monitorRefIn(task.text) === card.ref);
    if (existing) return { state: undefined, result: undefined };
    const created = createTask(state.tasks, {
      project,
      text: cardText(project, card, at),
      placement: "unplaced",
      clientRequestId: monitorClientRequestId(card.ref),
    }, state.recentCreates);
    if (!created.ok || created.replay) return { state: undefined, result: undefined };
    return { state: { tasks: created.tasks, recentCreates: created.recentCreates }, result: undefined };
  });
}

function deliveryOutcomeLabel(outcome: DeliveryOutcome): string {
  return outcome.ok ? outcome.outcome ?? "delivered" : "failed";
}

/**
 * One check of one project: read, decide, maybe wake, journal.
 *
 * Returns the journal line it wrote, so a caller — a test, or a future status
 * surface — reads exactly what was recorded rather than a parallel summary.
 */
export async function runSeatTickCheck(
  project: string,
  dependencies: SeatTickControllerDependencies = {},
): Promise<SeatTickRunRecord | null> {
  const policy = dependencies.policy === undefined ? seatTickPolicy() : dependencies.policy;
  if (!policy) return null;
  const sources = dependencies.sources ?? defaultSeatTickSources();
  const readState = dependencies.readState ?? readSeatTickState;
  const writeState = dependencies.writeState ?? writeSeatTickState;
  const appendRecord = dependencies.appendRecord ?? appendSeatTickRecord;
  const deliver = dependencies.deliver ?? deliverConversationMessage;
  const ensureCard = dependencies.ensureCard ?? ensureSeatTickCard;

  const gathered = gatherSeatTickInput(project, readState(project), policy, sources);
  const input = { ...gathered, state: seatTickStateForEpoch(gathered.state, gathered.seat?.seatEpoch ?? null) };
  const decision = seatTickDecision(input);
  const at = new Date(input.now).toISOString();

  for (const card of decision.cards) {
    try {
      ensureCard(input.project, card, at);
    } catch (error) {
      console.error("[seat tick] card write failed", error instanceof Error ? error.name : "unknown");
    }
  }

  let state = decision.state;
  let delivery: SeatTickRunRecord["delivery"] = null;
  const verdict = decision.verdict;

  if ((verdict.kind === "wake" || verdict.kind === "proactive") && input.seat) {
    const slot = Math.floor(input.now / policy.checkIntervalMs);
    const clientMessageId = `seat-tick:${input.project}:${input.seat.seatEpoch}:${slot}`;
    const text = verdict.kind === "wake"
      ? seatTickWakeMessage({
        project: input.project,
        reasons: verdict.reasons,
        items: verdict.items,
        deferred: verdict.deferred,
        signals: input.signals,
      })
      : seatTickProposalMessage({
        project: input.project,
        issues: await (dependencies.proposalIssues ?? defaultProposalIssues)(input.project, sources),
        signals: input.signals,
        items: policy.itemsPerWake,
        slot: String(Math.floor(input.now / policy.proposalIntervalMs)),
      });

    /* The seat epoch is re-read here, one step before the send, for the same
       reason the retirement sweep re-checks: a rotation that landed while this
       check was gathering must not have its predecessor woken. */
    const current = sources.seatFor(input.project).active;
    const rotated = !current
      || current.seatEpoch !== input.seat.seatEpoch
      || current.conversationId !== input.seat.conversationId;
    if (rotated) {
      delivery = { clientMessageId, outcome: "seat-rotated" };
    } else {
      const outcome = await deliver({
        pid: null,
        path: current.path ?? input.seat.path ?? "",
        conversationId: current.conversationId,
        clientMessageId,
        text,
        images: [],
        origin: { kind: "agent", role: "seat-tick" },
      });
      delivery = { clientMessageId, outcome: deliveryOutcomeLabel(outcome) };
      /* Only a delivered wake is recorded as one: a refused or failed send must
         not advance the wake stamp, or the next check would wait out an hour
         for a message the seat never got. */
      if (outcome.ok) state = seatTickWakeCommit(state, verdict, input.changeFingerprint, input.now);
    }
  }

  writeState(input.project, state);
  const record: SeatTickRunRecord = {
    schemaVersion: 1,
    at,
    project: input.project,
    seatEpoch: input.seat?.seatEpoch ?? null,
    verdict: verdict.kind,
    reasons: verdict.kind === "wake" ? verdict.reasons.map((reason) => reason.kind) : [],
    items: verdict.kind === "wake" ? verdict.items.length : 0,
    deferred: verdict.kind === "wake" ? verdict.deferred : 0,
    digestThrough: state.digestThrough,
    delivery,
    detail: verdictDetail(verdict),
  };
  appendRecord(record);
  return record;
}

function verdictDetail(verdict: ReturnType<typeof seatTickDecision>["verdict"]): string | null {
  if (verdict.kind === "skipped") return "the seat is mid-turn; the tick is dropped, never queued";
  if (verdict.kind === "wake") return verdict.reasons.map((reason) => reason.detail).join("; ");
  return verdict.detail;
}

async function defaultProposalIssues(project: string, sources: SeatTickSources): Promise<ProposalIssue[]> {
  const cwd = repoDirForProject(project, sources);
  return cwd ? openIssuesForProposal({ cwd }) : [];
}

/** Every project the tick has an opinion about, checked once. One project's
    failure never stops the others: this is a sweep, not a transaction. */
export async function reconcileSeatTick(dependencies: SeatTickControllerDependencies = {}): Promise<SeatTickRunRecord[]> {
  const sources = dependencies.sources ?? defaultSeatTickSources();
  const records: SeatTickRunRecord[] = [];
  for (const project of seatTickProjects(sources)) {
    try {
      const record = await runSeatTickCheck(project, { ...dependencies, sources });
      if (record) records.push(record);
    } catch (error) {
      console.error("[seat tick] check failed", error instanceof Error ? error.name : "unknown");
    }
  }
  return records;
}

const tickHost = globalThis as typeof globalThis & {
  __llvSeatTickTimer?: ReturnType<typeof setInterval>;
  __llvSeatTickRunning?: boolean;
};

/**
 * Start the clock, or refuse out loud.
 *
 * The refusal is the requirement, not a nicety: two orchestrators ticking one
 * project is a defect to make visible, and a silent early return is how the
 * predecessor's schedule went on firing for hours next to its successor with
 * nothing anywhere saying so.
 */
export function startSeatTick(ports: {
  scheduleInterval?: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>;
  sweep?: () => Promise<unknown>;
  policy?: SeatTickPolicy | null;
  log?: (line: string) => void;
} = {}): boolean {
  const log = ports.log ?? ((line: string) => console.error(line));
  if (tickHost.__llvSeatTickTimer) {
    log("[seat tick] refused: this process already holds the seat tick — exactly one ticker per seat");
    return false;
  }
  const policy = ports.policy === undefined ? seatTickPolicy() : ports.policy;
  if (!policy) {
    log("[seat tick] not started: LLV_SEAT_TICK_CHECK_MINUTES=0 turns the tick off");
    return false;
  }
  const schedule = ports.scheduleInterval ?? ((callback, delayMs) => setInterval(callback, delayMs));
  const sweep = ports.sweep ?? (() => reconcileSeatTick());
  const timer = schedule(() => {
    /* A check that outran its interval drops the next one rather than stacking
       it. A tick that would land behind the one before it is stale by
       construction, and staleness is the whole reason nothing is queued. */
    if (tickHost.__llvSeatTickRunning) return;
    tickHost.__llvSeatTickRunning = true;
    void Promise.resolve(sweep())
      .catch((error) => console.error("[seat tick] sweep failed", error instanceof Error ? error.name : "unknown"))
      .finally(() => { tickHost.__llvSeatTickRunning = false; });
  }, policy.checkIntervalMs);
  timer.unref?.();
  tickHost.__llvSeatTickTimer = timer;
  return true;
}

/** Test seam: the timer is process-global, so a suite must be able to start
    from an unstarted one without reaching into module internals. */
export function stopSeatTick(): void {
  const timer = tickHost.__llvSeatTickTimer;
  if (timer) clearInterval(timer);
  tickHost.__llvSeatTickTimer = undefined;
  tickHost.__llvSeatTickRunning = false;
}
