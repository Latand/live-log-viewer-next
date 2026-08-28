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
import type {
  SeatTickCard,
  SeatTickPolicy,
  SeatTickProjectState,
  SeatTickRunRecord,
  SeatTickVerdict,
} from "./types";

/**
 * The seat tick controller (issue #1245).
 *
 * One in-process clock, started by the release that owns traffic beside the
 * flow pipeline controller, the Telegram scheduler and the host retirement
 * sweep. There is no scheduler service, no cron entry, no timer unit, no
 * external process and no cross-process lock. "Exactly one active ticker per
 * seat" rests on two refusals instead, because one process is not one process
 * for ever — a deploy promotes a successor beside the incumbent:
 *
 * - A second start inside THIS process is refused out loud rather than
 *   silently ignored.
 * - Every sweep re-asks whether this release still owns traffic, and a release
 *   that has been replaced refuses the sweep, says so in the journal and stops
 *   its own clock. Authority is durable and re-readable, so it answers across
 *   processes what a process-local flag cannot answer at all.
 *
 * What the thing this replaces got wrong, and what this does instead:
 *
 * - It lived in a session, so every rotation dropped it and the successor could
 *   not tell. Here the clock is the Viewer's and the state is on disk, so a
 *   rotation is a new epoch on a row that already exists.
 * - It could act under a seat that had been revoked minutes earlier. Here the
 *   seat epoch is re-read immediately before the send, and a seat that moved in
 *   between is refused — the wake is journaled as refused, and nothing about it
 *   is recorded as a wake the successor received. A send the layer accepted but
 *   kept (held behind a migration, queued with a runtime) is remembered as
 *   outstanding and revoked the moment the epoch under it moves, because a
 *   retained payload outlives the check that made it.
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
  /** Whether this release still owns viewer traffic, re-asked per sweep. */
  ownsTraffic?: () => boolean | Promise<boolean>;
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
 * Whether the layer accepted the wake and kept it.
 *
 * The complement of {@link wakeReached} over an accepted send: the payload is
 * durably retained against the conversation it was addressed to, and it will
 * be delivered when whatever is blocking it clears — which may be after this
 * seat has been replaced.
 */
function wakeRetained(outcome: DeliveryOutcome): boolean {
  return outcome.ok && !wakeReached(outcome);
}

const REVOKED_WAKE_REASON = "the seat tick revoked a wake raised for a seat that has since been replaced";

/**
 * Bind a retained wake to the epoch it was raised for.
 *
 * This is the half of the epoch check the re-read before the send cannot do. A
 * send is refused when the seat moved BEFORE it; this covers the seat moving
 * after it, while the payload is still waiting somewhere — the layer keeps a
 * `held` or `queued` message durably, so "the send was refused at the epoch"
 * stops being true the moment the epoch moves under a message already in the
 * runtime's hands. A predecessor woken that way is precisely the failure this
 * issue was filed about, so the wake is taken back rather than allowed to land.
 *
 * The seat that is still the same seat keeps its outstanding wake: that one is
 * the replay the next check re-raises under the same `clientMessageId`.
 */
function revokeOutstandingWake(context: {
  project: string;
  state: SeatTickProjectState;
  /** The seat as it stands NOW. A seat row with no conversation id is nobody
      the wake could have been addressed to, so it reads as a replacement. */
  seat: { conversationId: string | null; seatEpoch: number } | null;
  sources: SeatTickSources;
  appendRecord: typeof appendSeatTickRecord;
  at: string;
}): SeatTickProjectState {
  const outstanding = context.state.outstandingWake;
  if (!outstanding) return context.state;
  if (context.seat
    && context.seat.conversationId === outstanding.conversationId
    && context.seat.seatEpoch === outstanding.seatEpoch) return context.state;

  let revoked = 0;
  let detail = "";
  try {
    for (const delivery of context.sources.pendingDeliveries(outstanding.conversationId)) {
      if (delivery.clientMessageId !== outstanding.clientMessageId) continue;
      if (delivery.state === "delivered" || delivery.state === "failed") continue;
      context.sources.revokeDelivery(delivery.id, REVOKED_WAKE_REASON);
      revoked += 1;
    }
    detail = revoked > 0
      ? `a wake the delivery layer had accepted but not landed was revoked before it could reach the replaced seat (${revoked} retained payload(s))`
      : "the wake raised for the replaced seat was already settled; nothing was left to revoke";
  } catch (error) {
    /* A registry that cannot answer must not take the check down with it: the
       wake stamp did not move for this send either, so the worst case is the
       predecessor receiving one message the successor will not be told about. */
    detail = `the wake raised for the replaced seat could not be revoked: ${redactMonitorText(error instanceof Error ? error.message : "unknown error")}`;
  }

  context.appendRecord({
    schemaVersion: 1,
    at: context.at,
    project: context.project,
    seatEpoch: outstanding.seatEpoch,
    verdict: "revoked",
    reasons: [],
    items: 0,
    deferred: 0,
    eventsThrough: context.state.eventsThrough,
    delivery: { clientMessageId: outstanding.clientMessageId, outcome: revoked > 0 ? "revoked" : "already-settled" },
    detail,
  });
  return { ...context.state, outstandingWake: null };
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
  const at = new Date(gathered.now).toISOString();
  /* Before anything is decided: a wake this project left outstanding under a
     seat that has since been replaced is taken back. The row carried it across
     the rotation for exactly this moment. */
  const reconciled = revokeOutstandingWake({
    project: gathered.project,
    state: seatTickStateForEpoch(gathered.state, gathered.seat?.seatEpoch ?? null),
    seat: gathered.seat,
    sources,
    appendRecord,
    at,
  });
  const input = { ...gathered, state: reconciled };
  const decision = seatTickDecision(input);

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
      } else if (wakeRetained(outcome)) {
        /* Accepted and kept. The payload now outlives this check, so it is
           written down against the epoch it was raised for — and re-checked at
           once, because the rotation that matters most is the one that landed
           while the send was in flight. */
        state = {
          ...state,
          /* The seat the rotation check just proved `current` still is, in the
             one form that is typed as an addressable conversation. */
          outstandingWake: { clientMessageId, conversationId: input.seat.conversationId, seatEpoch: input.seat.seatEpoch },
        };
        state = revokeOutstandingWake({
          project: input.project,
          state,
          seat: sources.seatFor(input.project).active ?? null,
          sources,
          appendRecord,
          at,
        });
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

/**
 * Whether this release still owns viewer traffic.
 *
 * Imported lazily: the module that answers this is the Viewer's node-side
 * startup runtime, and pulling its dependency graph into the tick's static
 * imports would put node: builtins on a path that has no business carrying
 * them. An answer that cannot be read at all is read as "yes", the same way the
 * authority check itself treats a missing target — a tick that silently stopped
 * because an import hiccuped is a worse failure than the one being guarded.
 */
async function releaseOwnsTraffic(): Promise<boolean> {
  try {
    const { viewerReleaseOwnsTraffic } = await import("@/lib/viewerInstrumentation");
    return viewerReleaseOwnsTraffic();
  } catch (error) {
    console.error("[seat tick] traffic authority is unreadable", error instanceof Error ? error.name : "unknown");
    return true;
  }
}

/**
 * Every project the tick has an opinion about, checked once.
 *
 * The sweep opens by re-asking whether this release still owns traffic, and
 * that question is the duplicate refusal that survives process replacement. The
 * process-local flag behind {@link startSeatTick} cannot see a promoted
 * successor at all: a deploy leaves the predecessor running with its timer
 * armed, and both would sweep the same seats. The durable authority target is
 * the one fact both processes can read, so the replaced release refuses, says
 * so where the refusal outlives it, and stops its own clock — no lock, and no
 * second answer to "who owns this seat".
 *
 * After that, one project's failure never stops the others: this is a sweep,
 * not a transaction — and each project's own failure is a journal line of its
 * own, written by {@link runSeatTickCheck}.
 */
export async function reconcileSeatTick(dependencies: SeatTickControllerDependencies = {}): Promise<SeatTickRunRecord[]> {
  const sources = dependencies.sources ?? defaultSeatTickSources();
  const appendRecord = dependencies.appendRecord ?? appendSeatTickRecord;
  if (!await (dependencies.ownsTraffic ?? releaseOwnsTraffic)()) {
    const refusal = "this release no longer owns viewer traffic, so the seats belong to the promoted one";
    console.error(`[seat tick] refused: ${refusal}`);
    try {
      appendRecord({
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
        detail: `the seat tick sweep was refused and this process's clock stopped: ${refusal}`,
      });
    } catch {
      /* The log line above already carries the refusal; an unwritable journal
         must not turn a refusal into a crash. */
    }
    stopSeatTick();
    return [];
  }
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
 * This refusal only covers a second start inside one process. The one that
 * covers a second PROCESS is in {@link reconcileSeatTick}, which re-reads the
 * durable traffic authority every sweep — a deployment candidate never starts
 * controllers, and a release that has been promoted past stops sweeping the
 * moment it notices. There is deliberately no cross-process lock behind either:
 * a lock would be a second, weaker answer beside the authority both processes
 * already read.
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
