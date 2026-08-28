import { deliverConversationMessage, type DeliveryOutcome } from "@/lib/delivery";
import { canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import { createTask } from "@/lib/tasks/commands";
import { mutateTasksFile } from "@/lib/tasks/store";

import {
  monitorClientRequestId,
  monitorRefIn,
  orchestratorAlertCardText,
  seatTickRetryGuardCardText,
} from "./cards";
import { openIssuesForProposal, type ProposalIssue } from "./githubEvidence";
import { appendSeatTickRecord } from "./journalStore";
import { redactMonitorText } from "./redact";
import { seatTickProposalMessage, seatTickWakeMessage } from "./report";
import { seatTickDecision, seatTickPolicy, seatTickWakeCommit } from "./seatTick";
import { readSeatTickState, seatTickStateForEpoch, writeSeatTickState } from "./seatTickState";
import {
  defaultSeatTickSources,
  gatherSeatTickInput,
  repoDirForProject,
  seatTickProjects,
  type SeatTickSources,
} from "./seatTickSources";
import type { SeatTickCard, SeatTickPolicy, SeatTickRunRecord, SeatTickVerdict } from "./types";

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
 * - It queued its fires and then double-fired into a finished turn. Here a seat
 *   whose turn is genuinely progressing is skipped and the tick is dropped;
 *   nothing is ever held.
 * - Its empty log was equally consistent with perfect operation and with total
 *   failure. Here every check leaves a line, including a check that threw.
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

function cardText(project: string, card: SeatTickCard, at: string): string {
  return card.kind === "no-seat"
    ? orchestratorAlertCardText(card.detail, at)
    : seatTickRetryGuardCardText(project, card.detail, card.ref, at);
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

/**
 * Whether the seat actually has the message.
 *
 * A send the delivery layer accepted is not the same as a wake the seat
 * received. `held` parks it behind an account migration, `queued` and
 * `delivering` leave it with the runtime and not the audience, and `pending`
 * has not reached a host at all. Recording any of those as a wake starts the
 * hourly clock on a message nobody read, and — worse — acknowledges the
 * lifecycle events that produced it, which are then never offered again.
 */
export function wakeReached(outcome: DeliveryOutcome): boolean {
  if (!outcome.ok) return false;
  switch (outcome.outcome) {
    case "held":
    case "queued":
    case "delivering":
    case "pending":
      return false;
    default:
      return true;
  }
}

function deliveryOutcomeLabel(outcome: DeliveryOutcome): string {
  return outcome.ok ? outcome.outcome ?? "delivered" : "failed";
}

function verdictDetail(verdict: SeatTickVerdict): string | null {
  if (verdict.kind === "skipped") return "the seat's turn is progressing; the tick is dropped, never queued";
  if (verdict.kind === "wake") return verdict.reasons.map((reason) => reason.detail).join("; ");
  return verdict.detail;
}

/**
 * The wake's identity, and with it its idempotency.
 *
 * `clientMessageId` is the delivery layer's idempotency key, so this decides
 * which two sends are the same message. Both halves matter:
 *
 * - What the wake SAYS — the seat epoch, the reasons, the state fingerprint
 *   they were raised against — so a wake that never landed is re-raised at the
 *   next check under the same key and replays instead of stacking a second
 *   copy of a message the seat may still receive.
 * - WHICH wake it is — the stamp of the last delivered one, which only a
 *   landed send advances. Without it the hourly wake on an unchanged board
 *   would carry the previous hour's key and be swallowed as a replay: silence
 *   the seat could not tell from a healthy board.
 */
function wakeClientMessageId(
  project: string,
  seatEpoch: number,
  verdict: SeatTickVerdict,
  context: { fingerprint: string; lastWakeAt: string | null },
): string {
  const shape = verdict.kind === "wake"
    ? verdict.reasons.map((reason) => reason.kind).sort().join(",")
    : "proposal";
  return `seat-tick:${project}:${seatEpoch}:${context.lastWakeAt ?? "first"}:${shape}:${context.fingerprint}`;
}

/**
 * One check of one project: read, decide, maybe wake, journal.
 *
 * Returns the journal line it wrote, so a caller — a test, or a future status
 * surface — reads exactly what was recorded rather than a parallel summary. It
 * throws only if the journal append itself fails; every other failure becomes
 * an `error` line, because a check that vanished silently is the ambiguity this
 * journal exists to remove.
 */
export async function runSeatTickCheck(
  project: string,
  dependencies: SeatTickControllerDependencies = {},
): Promise<SeatTickRunRecord | null> {
  const policy = dependencies.policy === undefined ? seatTickPolicy() : dependencies.policy;
  if (!policy) return null;
  const appendRecord = dependencies.appendRecord ?? appendSeatTickRecord;
  /* Canonical before the read, because the write below is keyed by the
     canonical name: an alias read against a canonical write would find an empty
     row every check, and an empty row has never been woken, so the tick would
     wake on every check instead of hourly. */
  const canonical = canonicalOrchestratorProject(project);

  try {
    return await check(canonical, policy, dependencies, appendRecord);
  } catch (error) {
    const record: SeatTickRunRecord = {
      schemaVersion: 1,
      at: new Date().toISOString(),
      project: canonical,
      seatEpoch: null,
      verdict: "error",
      reasons: [],
      items: 0,
      deferred: 0,
      eventsThrough: 0,
      delivery: null,
      detail: `the check failed: ${redactMonitorText(error instanceof Error ? error.message : "unknown error")}`,
    };
    appendRecord(record);
    return record;
  }
}

async function check(
  canonical: string,
  policy: SeatTickPolicy,
  dependencies: SeatTickControllerDependencies,
  appendRecord: typeof appendSeatTickRecord,
): Promise<SeatTickRunRecord> {
  const sources = dependencies.sources ?? defaultSeatTickSources();
  const readState = dependencies.readState ?? readSeatTickState;
  const writeState = dependencies.writeState ?? writeSeatTickState;
  const deliver = dependencies.deliver ?? deliverConversationMessage;
  const ensureCard = dependencies.ensureCard ?? ensureSeatTickCard;

  const gathered = await gatherSeatTickInput(canonical, readState(canonical), policy, sources);
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
    const clientMessageId = wakeClientMessageId(input.project, input.seat.seatEpoch, verdict, {
      fingerprint: input.changeFingerprint,
      lastWakeAt: input.state.lastWakeAt,
    });
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
      /* Only a wake the seat actually has is recorded as one. A refusal, a
         failure, a migration hold or a runtime queue leaves the wake stamp and
         the event cursor exactly where they were, so the next check re-raises
         the same wake under the same id rather than waiting out an hour for a
         message nobody read.

         The cursor then moves past everything this check READ, not only what
         the message listed: the terminal events are the ones carried, and the
         routine progress between them is what the seat is deliberately not
         told about one line at a time. Anything the page bound left behind
         keeps its place and is offered again. */
      if (wakeReached(outcome)) {
        const eventsThrough = input.events.at(-1)?.seq ?? state.eventsThrough;
        state = seatTickWakeCommit(state, verdict, { fingerprint: input.changeFingerprint, eventsThrough, now: input.now });
      }
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
    eventsThrough: state.eventsThrough,
    delivery,
    detail: verdictDetail(verdict),
  };
  appendRecord(record);
  return record;
}

async function defaultProposalIssues(project: string, sources: SeatTickSources): Promise<ProposalIssue[]> {
  const cwd = repoDirForProject(project, sources);
  return cwd ? openIssuesForProposal({ cwd }) : [];
}

/** Every project the tick has an opinion about, checked once. One project's
    failure never stops the others: this is a sweep, not a transaction — and
    each project's own failure is a journal line of its own, written by
    {@link runSeatTickCheck}. */
export async function reconcileSeatTick(dependencies: SeatTickControllerDependencies = {}): Promise<SeatTickRunRecord[]> {
  const sources = dependencies.sources ?? defaultSeatTickSources();
  const records: SeatTickRunRecord[] = [];
  for (const project of seatTickProjects(sources)) {
    try {
      const record = await runSeatTickCheck(project, { ...dependencies, sources });
      if (record) records.push(record);
    } catch (error) {
      /* Only an unwritable journal reaches here; the check itself records its
         own failures. */
      console.error("[seat tick] check could not be journaled", error instanceof Error ? error.name : "unknown");
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
 * project is a defect to make visible, and a silent early return is how a
 * predecessor's schedule went on firing for hours next to its successor with
 * nothing anywhere saying so. So a second start is logged AND journaled — the
 * journal being the artifact that outlives both processes, which is the whole
 * reason it exists.
 *
 * There is deliberately no cross-process lock behind this. Exactly one process
 * owns traffic (`viewerReleaseOwnsTraffic`), a deployment candidate does not
 * start controllers at all, and adding a lock would put a second, weaker answer
 * beside that one.
 */
export function startSeatTick(ports: {
  scheduleInterval?: (callback: () => void, delayMs: number) => ReturnType<typeof setInterval>;
  sweep?: () => Promise<unknown>;
  policy?: SeatTickPolicy | null;
  log?: (line: string) => void;
  appendRecord?: typeof appendSeatTickRecord;
} = {}): boolean {
  const log = ports.log ?? ((line: string) => console.error(line));
  if (tickHost.__llvSeatTickTimer) {
    const refusal = "this process already holds the seat tick — exactly one ticker per seat";
    log(`[seat tick] refused: ${refusal}`);
    try {
      (ports.appendRecord ?? appendSeatTickRecord)({
        schemaVersion: 1,
        at: new Date().toISOString(),
        project: "",
        seatEpoch: null,
        verdict: "refused",
        reasons: [],
        items: 0,
        deferred: 0,
        eventsThrough: 0,
        delivery: null,
        detail: `a second seat tick start was refused: ${refusal}`,
      });
    } catch {
      /* The log line above already carries the refusal; an unwritable journal
         must not turn a refusal into a crash. */
    }
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
