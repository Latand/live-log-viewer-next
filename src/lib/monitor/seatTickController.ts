import { deliverConversationMessage, type DeliveryOutcome } from "@/lib/delivery";
import { canonicalOrchestratorProject } from "@/lib/orchestrator/seats";
import { createTask, patchTask } from "@/lib/tasks/commands";
import { mutateTasksFile } from "@/lib/tasks/store";

import {
  monitorClientRequestId,
  monitorRefIn,
  orchestratorAlertCardText,
  seatTickRetryGuardCardText,
  seatTickSettingsCardText,
} from "./cards";
import { openIssuesForProposal, type ProposalIssue } from "./githubEvidence";
import { appendSeatTickRecord } from "./journalStore";
import { redactMonitorText } from "./redact";
import { seatTickProposalMessage, seatTickWakeMessage } from "./report";
import { seatTickDecision, seatTickPolicy, seatTickWakeCommit, seatTickWakeCommitPlan } from "./seatTick";
import { defaultSeatTickSettings, writeSeatTickSettings } from "./seatTickSettings";
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
  SeatTickVerdictKind,
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
 *   kept (held behind a migration, queued with a runtime host) is remembered as
 *   outstanding, because a retained payload outlives the check that made it,
 *   and every later check asks the layer HOLDING it what became of it: still
 *   waiting, delivered after all, or settled unsent. That one question answers
 *   both halves of the tick's accounting — when a stamp may move, and what a
 *   revocation has to reach — so the two cannot drift apart.
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
  /** Persists a tick setting that reached its expiry (#1275). The reading is
      already correct without it — the expiry is applied wherever the record is
      read — so this only makes the record on disk say what the tick is
      already doing. */
  writeSettings?: typeof writeSeatTickSettings;
  appendRecord?: typeof appendSeatTickRecord;
  deliver?: typeof deliverConversationMessage;
  ensureCard?: (project: string, card: SeatTickCard, at: string) => void;
  proposalIssues?: (project: string, sources: SeatTickSources) => Promise<ProposalIssue[]>;
  /** Whether this release still owns viewer traffic, re-asked per sweep. */
  ownsTraffic?: () => boolean | Promise<boolean>;
}

function cardText(project: string, card: SeatTickCard, at: string): string {
  if (card.kind === "no-seat") return orchestratorAlertCardText(card.detail, at);
  if (card.kind === "tick-settings") {
    return seatTickSettingsCardText({
      project,
      detail: card.detail,
      reason: card.settings?.reason ?? null,
      until: card.settings?.until ?? null,
      setBy: card.settings?.setBy ?? null,
      updatedAt: card.settings?.updatedAt ?? null,
    });
  }
  return seatTickRetryGuardCardText(project, card.detail, card.ref, at);
}

/**
 * One board card per condition, found by its `monitor-ref:` line rather than by
 * a receipt — so the idempotency survives a restart, and an operator who edits
 * the text above the marker keeps it.
 *
 * Two kinds of card meet here. A condition that HAPPENED (no seat, a wake
 * reason the guard stopped) is written once and left for the operator to
 * close. A STANDING state — a project's tick settings (#1275) — is instead
 * kept in step with the state it describes: its text is rewritten when the
 * setting changes, and the card is closed by the first check that reads the
 * project back on its defaults, so the board never claims a quiet tick that is
 * ticking again. The card body is stamped with when the SETTING was recorded,
 * so a settled state rewrites nothing check after check.
 */
function ensureSeatTickCard(project: string, card: SeatTickCard, at: string): void {
  mutateTasksFile<void>((state) => {
    const existing = state.tasks.find((task) =>
      canonicalOrchestratorProject(task.project) === project
      && task.status !== "done"
      && monitorRefIn(task.text) === card.ref);
    if (card.state === "resolved") {
      if (!existing) return { state: undefined, result: undefined };
      const closed = patchTask(state.tasks, existing.id, { status: "done" });
      return closed.ok
        ? { state: { tasks: closed.tasks, recentCreates: state.recentCreates }, result: undefined }
        : { state: undefined, result: undefined };
    }
    const text = cardText(project, card, at);
    if (existing) {
      /* A card for something that HAPPENED is left exactly as it stands: its
         body carries the instant it was observed, so rewriting it would churn
         the board once per check for as long as the condition holds. Only a
         card that tracks a standing state — the one kind that declares its
         `state` — is kept in step with what it describes. */
      if (card.state !== "open") return { state: undefined, result: undefined };
      if (existing.text === text) return { state: undefined, result: undefined };
      const updated = patchTask(state.tasks, existing.id, { text });
      return updated.ok
        ? { state: { tasks: updated.tasks, recentCreates: state.recentCreates }, result: undefined }
        : { state: undefined, result: undefined };
    }
    const created = createTask(state.tasks, {
      project,
      text,
      placement: "unplaced",
      clientRequestId: monitorClientRequestId(card.ref),
    }, state.recentCreates);
    if (!created.ok || created.replay) return { state: undefined, result: undefined };
    return { state: { tasks: created.tasks, recentCreates: created.recentCreates }, result: undefined };
  });
}

/**
 * Whether the seat actually has the message, judged at the moment of the send.
 *
 * A send the delivery layer accepted is not the same as a wake the seat
 * received. `held` parks it behind an account migration, `queued` and
 * `delivering` leave it with the runtime host and not the audience, and
 * `pending` has not reached a host at all. Recording any of those as a wake
 * starts the hourly clock on a message nobody read, and — worse — acknowledges
 * the lifecycle events that produced it, which are then never offered again.
 *
 * `queued` is the one worth spelling out, because a structured host admits
 * EVERY send as queued whether it is idle or mid-turn: the answer here is not
 * "the host is busy", it is "the runtime host has this and the seat does not
 * yet". Which is exactly why a false is not the end of the story. The wake is
 * recorded against the operation the runtime host queued it under, and
 * {@link reconcileOutstandingWake} asks that host what became of it — so the
 * message the host does deliver is credited at the next check instead of being
 * disbelieved for ever, and the message it has not delivered yet can still be
 * taken back out of its queue.
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

/** Which layer is holding a retained wake, in the one field that says so. A
    structured send names the runtime host operation it was queued under; a
    migration hold and a legacy send name nothing, and the Viewer registry's own
    reservation is then the retention. */
function retainedOperationId(outcome: DeliveryOutcome): string | null {
  return outcome.ok ? outcome.operationId ?? null : null;
}

const REVOKED_WAKE_REASON = "the seat tick revoked a wake raised for a seat that has since been replaced";

/** What the reconcile concluded: the journal line it owes, and what the row
    does with the wake — credit it, forget it, or keep it for the next check.
    Null is the answer that settles nothing and is worth no line of its own. */
interface WakeSettlement {
  verdict: SeatTickVerdictKind;
  outcome: string;
  detail: string;
  row: "commit" | "clear" | "keep";
}

/**
 * Settle a retained wake by asking the layer that is actually holding it.
 *
 * Two questions used to be answered in two places, from two different pictures
 * of where the wake was, and they disagreed. They are one question here:
 *
 * - **Did it land?** A send the layer merely accepted advances no stamp and
 *   acknowledges no lifecycle event, and a structured host accepts every send
 *   the same way whether it is idle or busy — so the answer cannot be read off
 *   the send at all. It is read off the holder afterwards, and the wake it did
 *   deliver is credited then, with the plan the raising check wrote down.
 * - **Can it still be taken back?** This is the half of the epoch check the
 *   re-read before the send cannot do. A send is refused when the seat moved
 *   BEFORE it; this covers the seat moving after it, while the payload is still
 *   waiting somewhere. A predecessor woken that way is precisely the failure
 *   this issue was filed about.
 *
 * Both go to the same holder — the runtime host for a send it queued, the
 * Viewer registry for a hold that never reached a host — because a revocation
 * aimed anywhere else is a revocation the delivery path ignores. And when the
 * holder has already let the payload go, that is said out loud (`too-late`)
 * rather than reported as a successful revocation.
 *
 * The seat that is still the same seat keeps a wake still in flight: that one
 * is the replay the next check re-raises under the same `clientMessageId`.
 *
 * A landing credited here is stamped at the instant it was OBSERVED rather than
 * the instant it happened, so the hourly bound starts up to one check interval
 * late. That is the safe direction: the bound is a floor on how often a seat is
 * woken, and erring late never lets a wake jump it.
 */
async function reconcileOutstandingWake(context: {
  project: string;
  state: SeatTickProjectState;
  /** The seat as it stands NOW. A seat row with no conversation id is nobody
      the wake could have been addressed to, so it reads as a replacement. */
  seat: { conversationId: string | null; seatEpoch: number } | null;
  sources: SeatTickSources;
  appendRecord: typeof appendSeatTickRecord;
  at: string;
  now: number;
}): Promise<SeatTickProjectState> {
  const outstanding = context.state.outstandingWake;
  if (!outstanding) return context.state;
  const replaced = !context.seat
    || context.seat.conversationId !== outstanding.conversationId
    || context.seat.seatEpoch !== outstanding.seatEpoch;

  let settlement: WakeSettlement | null;
  try {
    settlement = replaced
      ? withdrawal(await context.sources.withdrawWake(outstanding, REVOKED_WAKE_REASON))
      : landing(await context.sources.wakeState(outstanding));
  } catch (error) {
    const reason = redactMonitorText(error instanceof Error ? error.message : "unknown error");
    /* A holder that cannot answer must not take the check down with it, and it
       is not evidence either way: the wake stays outstanding, so the next check
       asks again rather than crediting or discarding it on a failed read. */
    settlement = replaced
      ? { verdict: "revoked", outcome: "unknown", row: "keep", detail: `the wake raised for the replaced seat could not be revoked: ${reason}` }
      : null;
  }
  if (!settlement) return context.state;

  const next: SeatTickProjectState = settlement.row === "commit"
    ? seatTickWakeCommit(context.state, outstanding.commit, context.now)
    : settlement.row === "clear"
      ? { ...context.state, outstandingWake: null }
      /* An unreachable holder leaves the payload exactly where it was, so the
         row keeps it: a later check is the one that takes it back. */
      : context.state;

  context.appendRecord({
    schemaVersion: 1,
    at: context.at,
    project: context.project,
    seatEpoch: outstanding.seatEpoch,
    verdict: settlement.verdict,
    reasons: [],
    items: 0,
    deferred: 0,
    eventsThrough: next.eventsThrough ?? 0,
    delivery: { clientMessageId: outstanding.clientMessageId, outcome: settlement.outcome },
    detail: settlement.detail,
  });
  return next;
}

function withdrawal(result: Awaited<ReturnType<SeatTickSources["withdrawWake"]>>): WakeSettlement {
  if (result === "withdrawn") {
    return {
      verdict: "revoked",
      outcome: "withdrawn",
      row: "clear",
      detail: "a wake the delivery layer had accepted but not landed was taken out of its queue before it could reach the replaced seat",
    };
  }
  if (result === "too-late") {
    return {
      verdict: "revoked",
      outcome: "too-late",
      row: "clear",
      detail: "the wake raised for the replaced seat could not be taken back: the layer holding it had already let it go, so the replaced seat may have received it",
    };
  }
  return {
    verdict: "revoked",
    outcome: "unknown",
    row: "keep",
    detail: "the wake raised for the replaced seat could not be revoked: the layer holding it did not answer",
  };
}

function landing(result: Awaited<ReturnType<SeatTickSources["wakeState"]>>): WakeSettlement | null {
  if (result === "landed") {
    return {
      verdict: "landed",
      outcome: "landed",
      row: "commit",
      detail: "a wake the delivery layer had kept reached the seat; the wake stamp and the event cursor move now, on the plan the check that raised it wrote down",
    };
  }
  if (result === "dropped") {
    return {
      verdict: "dropped",
      outcome: "dropped",
      row: "clear",
      detail: "the layer holding the wake settled it without delivering it, so no stamp moves and the next check may raise it again",
    };
  }
  /* `retained` is the steady state between two checks and `unknown` is a read
     that failed; neither settles anything, and neither is worth a line of its
     own beside the check's. */
  return null;
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

  /* Before anything is READ, let alone decided: settle the wake this project
     left outstanding. It has to come first because both of its answers change
     what the rest of this check may conclude — a landing moves the event cursor
     the gather pages from and starts the hourly bound, and a rotation means
     taking the payload back out of the queue the row carried it across the
     rotation for. */
  const opening = sources.now();
  const openingSeat = sources.seatFor(canonical).active ?? null;
  const settled = await reconcileOutstandingWake({
    project: canonical,
    state: seatTickStateForEpoch(readState(canonical), openingSeat?.seatEpoch ?? null),
    seat: openingSeat,
    sources,
    appendRecord,
    at: new Date(opening).toISOString(),
    now: opening,
  });

  const gathered = await gatherSeatTickInput(canonical, settled, policy, sources);
  const at = new Date(gathered.now).toISOString();
  /* The gather's own row, not the one it was handed: a first check seals the
     event cursor at the journal head while reading it, and re-deriving the row
     from `settled` here would drop the seal and read the whole journal as
     unread again at the next check. */
  const input = { ...gathered, state: seatTickStateForEpoch(gathered.state, gathered.seat?.seatEpoch ?? null) };
  const decision = seatTickDecision(input);

  /* An expiry that passed is already reflected in everything above — the
     reading applies it wherever the record is read — so this write changes no
     behaviour. What it changes is the RECORD: a row that still says "off"
     beside a tick that is ticking is the kind of disagreement someone reads
     off the board at the worst possible moment. */
  if (input.settings.lapsed) {
    try {
      (dependencies.writeSettings ?? writeSeatTickSettings)(input.project, defaultSeatTickSettings(input.project));
    } catch (error) {
      console.error("[seat tick] lapsed settings could not be persisted", error instanceof Error ? error.name : "unknown");
    }
  }

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
      const commit = seatTickWakeCommitPlan(verdict, {
        fingerprint: input.changeFingerprint,
        eventsThrough: input.events.at(-1)?.seq ?? state.eventsThrough ?? 0,
      });
      if (commit && wakeReached(outcome)) {
        state = seatTickWakeCommit(state, commit, input.now);
      } else if (commit && wakeRetained(outcome)) {
        /* Accepted and kept. The payload now outlives this check, so it is
           written down with the handle of whichever layer kept it and the
           commit this wake would earn — then reconciled at once, because the
           rotation that matters most is the one that landed while the send was
           in flight, and because a fast drain may already have delivered it. */
        state = {
          ...state,
          outstandingWake: {
            clientMessageId,
            /* The seat the rotation check just proved `current` still is, in
               the one form that is typed as an addressable conversation. */
            conversationId: input.seat.conversationId,
            seatEpoch: input.seat.seatEpoch,
            operationId: retainedOperationId(outcome),
            commit,
          },
        };
        state = await reconcileOutstandingWake({
          project: input.project,
          state,
          seat: sources.seatFor(input.project).active ?? null,
          sources,
          appendRecord,
          at,
          now: input.now,
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
    eventsThrough: state.eventsThrough ?? 0,
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
