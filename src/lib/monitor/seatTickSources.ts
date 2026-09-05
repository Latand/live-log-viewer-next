import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SeatTickAccounting, type AccountingChild, type AccountingOwner } from "./seatTickAccounting";
import { readChildLedger } from "./seatTickChildLedger";

import {
  agentRegistry,
  readOnlyConversationLookupFromSnapshot,
  SPAWN_STARTING_ADMISSION_LEASE_MS,
  type AgentRegistryEntry,
  type RegistryFile,
  type SpawnLineageEdge,
  type SpawnReceipt,
} from "@/lib/agent/registry";
import { sessionKeyFromTranscript, sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";
import { statePath } from "@/lib/configDir";
import { pageFromEvents, readLifecycleJournal } from "@/lib/lifecycle/journal";
import { agentLivenessSnapshot, productionLivenessSources, type AgentLivenessRecord } from "@/lib/lifecycle/liveness";
import { canonicalOrchestratorProject, activeOrchestratorSeats, orchestratorSeatFor } from "@/lib/orchestrator/seats";
import { loadArchivedPipelines, loadPipelinesForList } from "@/lib/pipelines/store";
import { projectTaskPipelineIds } from "@/lib/pipelines/taskBinding";
import type { Pipeline } from "@/lib/pipelines/types";
import { runtimeHostClient, type RuntimeHostClient } from "@/lib/runtime/client";
import { latestLedgerDeployment } from "@/lib/runtime/deploymentLedger";
import {
  resolveOriginalSend,
  resolveSendReceipt,
  type OriginalSendBinding,
  type OriginalSendEvidence,
  type SendReceipt,
} from "@/lib/runtime/sendSettlement";
import { resolveProjectAttribution } from "@/lib/session/projectResolution";
import type { StructuredHostRetirementReport } from "@/lib/runtime/structuredHostRetirement";
import { loadTasks } from "@/lib/tasks/store";
import type { BoardTask } from "@/lib/tasks/types";

import { evidenceFromPipelines, evidenceFromTasks } from "./evidence";
import { openPullRequestsForRepo, type OpenPullRequestsResult } from "./githubEvidence";
import { redactBounded } from "./redact";
import {
  FINGERPRINT_UNREAD,
  SEAT_TICK_WAKE_INTERVAL_MS,
  seatTickSourceGapAfterFailure,
  seatTickSourceRetryDue,
  seatTickWakeDue,
  seatTurnProgressing,
} from "./seatTick";
import { effectiveSeatTickSettings, readSeatTickSettings, type SeatTickSettings } from "./seatTickSettings";
import type { PipelineSummary, TaskSummary } from "./viewerApi";
import {
  type SeatTickActivity,
  type SeatTickCheckInput,
  type SeatTickChildInput,
  type SeatTickChildrenGap,
  type SeatTickEventInput,
  type SeatTickOutstandingWake,
  type SeatTickPipelineInput,
  type SeatTickPolicy,
  type SeatTickProjectState,
  type SeatTickPullRequestGap,
  type SeatTickPullRequestInput,
  type SeatTickSeatInput,
  type SeatTickSignalInput,
  type SeatTickSourceGap,
  type SeatTickTaskInput,
} from "./types";

/**
 * Everything the pre-check reads (issue #1245), and nothing else.
 *
 * Every source here is durable and already written by the Viewer: the seat
 * store, the pipeline store, the board, the lifecycle journal, the liveness
 * plane, the deployment ledger and the host retirement report. No transcript is
 * scanned by this module and no model is called — the one transcript read in
 * the whole check belongs to `agent_activity`'s own bounded evidence pass,
 * which is where the answer to "is this turn still moving?" already lives.
 */

/** How much of the lifecycle journal one check carries. A backlog can no longer
    bury a live event behind this bound: the history in front of it is sealed
    away by the check that read it (#1285), so the pages advance at the check
    interval and cost nothing, rather than at one paid wake apiece. */
const EVENT_PAGE = 200;
/** Open pull requests one check reads. Bounds the `gh` answer, not the lanes:
    a project with more open pull requests than this has other problems. */
const PULL_REQUEST_LIMIT = 60;
/** Bounded pull request title carried into a wake item. */
const PULL_REQUEST_TITLE_LIMIT = 120;
/** Liveness rows one project's check asks for. */
const LIVENESS_LIMIT = 60;
/** Bounded child title carried into a wake item. */
const CHILD_TITLE_LIMIT = 120;

/**
 * What became of a wake the delivery layer accepted and kept.
 *
 * Asked of whichever layer is actually holding it, never of a mirror of that
 * layer. `retained` means it is still the holder's to deliver, so no stamp of
 * the tick's may move; `landed` means the seat has it; `dropped` means the
 * holder settled it without ever delivering it, so the next check may raise it
 * again; `unknown` means the holder could not be asked, which is not evidence
 * of anything and leaves the wake outstanding.
 *
 * `uncertain` (#1465) is the answer the holder gives when it ENDED the send
 * without proving arrival either way — a host that took the message and died,
 * a settlement deadline that passed with no journal to ask. It is not a drop:
 * the seat may have the message, so raising it again under a new key could
 * wake the seat twice. And it is not a landing: nothing the wake carried may
 * be acknowledged on it. The controller bounds it without crediting it.
 */
export type SeatTickWakeState = "retained" | "landed" | "dropped" | "unknown" | "uncertain";

/**
 * What taking a retained wake back achieved.
 *
 * `too-late` is the answer this whole mechanism has to be able to give: the
 * holder had already let the payload go, so the replaced seat may have received
 * it. Reporting it as a revocation would be the silent version of the defect
 * the tick exists to prevent, so it is named instead.
 */
export type SeatTickWithdrawal = "withdrawn" | "too-late" | "unknown";

/** Runtime receipt statuses the host has not finished with. `delivering` and
    `applying` are the drain's own in-flight window: still not landed, and no
    longer safe to take back. */
const RUNTIME_QUEUED: ReadonlySet<string> = new Set(["pending", "queued"]);
const RUNTIME_IN_FLIGHT: ReadonlySet<string> = new Set(["delivering", "applying"]);
const RUNTIME_LANDED: ReadonlySet<string> = new Set(["delivered", "applied", "answered"]);

/** The delivery the Viewer registry is holding under this wake's idempotency
    key. The key is the tick's own and carries the project, the seat epoch and
    the state fingerprint, so it identifies one wake across the whole file. */
function registryDeliveryFor(wake: SeatTickOutstandingWake): { id: string; state: string } | null {
  const found = Object.values(agentRegistry().readOnlySnapshot().heldDeliveries)
    .find((delivery) => delivery.clientMessageId === wake.clientMessageId);
  return found ? { id: found.id, state: found.state } : null;
}

/**
 * The runtime host's own verdict on the operation carrying this wake.
 *
 * `currentRetryLeaf` follows a retried send to the operation that is actually
 * live, because a retry leaves the parent terminal and the leaf is the one the
 * drain will deliver.
 *
 * An operation the host has no record of is `unknown` (#1465), never a drop:
 * absence is an observation about the journal, and a journal that was rotated,
 * replaced or never reached is not proof that nothing was delivered. The
 * durable delivery record is what proves a loss, and {@link wakeStateFromRecord}
 * asks it first. `interrupted` and the terminal-but-unverified `uncertain` are
 * exactly that — a send ended without proof either way.
 */
export async function runtimeWakeState(operationId: string, client: RuntimeHostClient): Promise<SeatTickWakeState> {
  const current = await client.operationStatus(operationId, { currentRetryLeaf: true });
  if (!current) return "unknown";
  const status = current.receipt.status;
  if (RUNTIME_QUEUED.has(status) || RUNTIME_IN_FLIGHT.has(status)) return "retained";
  if (RUNTIME_LANDED.has(status)) return "landed";
  if (status === "failed" || status === "rejected") return "dropped";
  return "uncertain";
}

/**
 * What the durable delivery record says became of the wake, read under the
 * idempotency key the tick itself bound before the send (#1465, on the #1490
 * contract).
 *
 * The record is asked before any journal: a reservation that the settlement
 * ended is the answer whatever the journal remembers, and the resend guidance
 * it carries is the only thing that distinguishes a PROVEN loss (`safe`, the
 * fenced disposition) from a send that merely could not be verified
 * (`verify-first`). A send still in flight is ended by the settlement itself
 * — this operation is the tick's own, so the tick is the caller entitled to
 * end it — and that answer is classified the same way; inside the settlement
 * window it comes back unchanged, which is `retained`.
 *
 * Absence under the key is not a loss either. A wake the record never held
 * but the runtime queued (a legacy row, a mirror that was compacted) is asked
 * of the runtime; with nothing to ask, the answer is `unknown` and the wake
 * stays outstanding.
 */
export async function wakeStateFromRecord(
  wake: SeatTickOutstandingWake,
  ports: {
    lookup: (binding: OriginalSendBinding) => Promise<OriginalSendEvidence>;
    /** Ends an in-flight send of the tick's own, or reports it still in flight. */
    settle: (operationId: string) => Promise<SendReceipt | null>;
    runtime: (operationId: string) => Promise<SeatTickWakeState>;
  },
): Promise<SeatTickWakeState> {
  const evidence = await ports.lookup({ conversationId: wake.conversationId, clientMessageId: wake.clientMessageId });
  if (evidence.kind === "absent") return wake.operationId ? ports.runtime(wake.operationId) : "unknown";
  if (evidence.kind !== "found") return "unknown";
  if (!evidence.current.readable) return "unknown";
  const current = evidence.current.value;
  if (current.state !== "in-flight") return receiptWakeState(current);
  const settled = await ports.settle(evidence.operationId);
  if (!settled) return "unknown";
  return settled.state === "in-flight" ? "retained" : receiptWakeState(settled);
}

function receiptWakeState(receipt: SendReceipt): SeatTickWakeState {
  if (receipt.state === "delivered") return "landed";
  if (receipt.state === "in-flight") return "retained";
  /* `safe` is the fenced, proven non-delivery and the only failure that
     licenses raising the wake again; everything else ended without proof. */
  return receipt.resend === "safe" ? "dropped" : "uncertain";
}

/**
 * Take the wake out of the runtime host's queue.
 *
 * This is the same operation transition the delivery drain itself issues to
 * abandon an effect: it settles the receipt and completes the outbox row inside
 * one immediate transaction, so the drain cannot pick the effect up afterwards.
 * Marking the Viewer's registry mirror instead would leave the host's queue
 * untouched and the wake would still be delivered.
 *
 * An operation already in the drain's hands is deliberately NOT transitioned.
 * The engine write may have happened, and failing the receipt underneath a
 * drain that is about to settle it would break that drain for a claim the tick
 * cannot honestly make anyway.
 */
export async function withdrawRuntimeWake(
  operationId: string,
  reason: string,
  client: RuntimeHostClient,
): Promise<SeatTickWithdrawal> {
  const current = await client.operationStatus(operationId, { currentRetryLeaf: true });
  if (!current) return "unknown";
  const status = current.receipt.status;
  if (RUNTIME_LANDED.has(status) || RUNTIME_IN_FLIGHT.has(status)) return "too-late";
  if (status === "failed" || status === "rejected") return "withdrawn";
  if (!RUNTIME_QUEUED.has(status)) return "unknown";
  try {
    const settled = await client.transitionOperation(current.operationId, "failed", { reason });
    return settled.receipt.status === "failed" ? "withdrawn" : "too-late";
  } catch {
    /* The host refuses the transition exactly when the operation left the queue
       between the read and the write — which is the drain taking it. */
    const after = await client.operationStatus(current.operationId, { currentRetryLeaf: true });
    return after && RUNTIME_LANDED.has(after.receipt.status) ? "too-late" : "unknown";
  }
}

export interface SeatTickSources {
  seatFor: typeof orchestratorSeatFor;
  /** Projects that currently hold an active seat. */
  activeSeats: () => string[];
  pipelines: () => readonly Pipeline[];
  /** Settled lanes the hot store has already let go of (#1289). Cold storage,
      so it is read only once a check has decided it would pay for a `gh`
      subprocess anyway — and it has to be read at all because the obligation a
      finished lane leaves behind outlives the lane's three days of residence. */
  archivedPipelines: () => readonly Pipeline[];
  tasks: () => BoardTask[];
  registry: () => ReturnType<typeof agentRegistry>;
  /** The registry's own activity verdict — `agent_activity`'s answer, which is
      the only thing this module is allowed to call a stall. */
  liveness: (request: { project?: string; conversationId?: string; stallAfterMs: number; limit: number }) => Promise<AgentLivenessRecord[]>;
  /** The lifecycle journal, read whole and paged in-process, so the tick's own
      cursor decides what is unread rather than a cursor that advanced at poll
      time. */
  lifecycleJournal: typeof readLifecycleJournal;
  /** The most recently started deployment, read in recency order rather than
      sliced off an ordering that has nothing to do with time. */
  latestDeployment: typeof latestLedgerDeployment;
  retirementReport: () => StructuredHostRetirementReport | null;
  /** The project's own tick settings (#1275), read fresh per check so a change
      an agent just recorded takes effect at the very next check rather than at
      the next deploy. A project nobody configured reads the defaults. */
  settings: (project: string) => SeatTickSettings;
  /** Open pull requests in the project's repository (#1289), through the same
      `gh` seam as the proposal source. Read at most once per wake interval, and
      only for a project that has a finished lane to attribute one to: a
      subprocess per project per five-minute check would be a cost the tick's
      whole design is arranged to avoid. Answers with a result rather than a
      list, because "no pull request is open" and "nobody could be asked" are
      the two facts this reason must never confuse. */
  openPullRequests: (options: { cwd: string; limit: number }) => Promise<OpenPullRequestsResult>;
  /** Whether the layer holding a retained wake still has it, and whether the
      seat ever got it. The tick's stamps move on this answer and nothing else. */
  wakeState: (wake: SeatTickOutstandingWake) => Promise<SeatTickWakeState>;
  /** The durable delivery record under a key the tick bound before a send
      (#1465), for the send whose outcome never came back at all. Read-only.
      Absent means the production lookup over the process registry. */
  originalSend?: (binding: OriginalSendBinding) => Promise<OriginalSendEvidence>;
  /** Take a retained wake back from that same layer, before it can reach a seat
      that has been replaced. The reason is stored where the payload is. */
  withdrawWake: (wake: SeatTickOutstandingWake, reason: string) => Promise<SeatTickWithdrawal>;
  now: () => number;
}

export function defaultSeatTickSources(): SeatTickSources {
  return {
    seatFor: orchestratorSeatFor,
    activeSeats: () => activeOrchestratorSeats().map((seat) => seat.project),
    pipelines: () => loadPipelinesForList(),
    archivedPipelines: () => loadArchivedPipelines(),
    tasks: () => loadTasks(),
    registry: () => agentRegistry(),
    liveness: async (request) => {
      const snapshot = await agentLivenessSnapshot({
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
        ...(request.project ? { project: request.project, liveOnly: true } : {}),
        stallAfterMs: request.stallAfterMs,
        limit: request.limit,
      }, productionLivenessSources());
      return snapshot.conversations;
    },
    lifecycleJournal: readLifecycleJournal,
    latestDeployment: latestLedgerDeployment,
    retirementReport: () => {
      try {
        return JSON.parse(fs.readFileSync(statePath("host-retirement-report.json"), "utf8")) as StructuredHostRetirementReport;
      } catch {
        return null;
      }
    },
    settings: (project) => readSeatTickSettings(project),
    openPullRequests: (options) => openPullRequestsForRepo(options),
    /* One rule for both halves: ask, and act on, the layer that is actually
       holding the payload. A send the runtime host queued belongs to the runtime
       host — the registry row beside it is a mirror, and settling a mirror stops
       nothing. A send parked behind an account migration never reached a host at
       all, and there the registry reservation IS the retention. */
    wakeState: async (wake) => wakeStateFromRecord(wake, {
      lookup: (binding) => resolveOriginalSend(binding),
      settle: (operationId) => resolveSendReceipt(operationId),
      runtime: async (operationId) => {
        const client = runtimeHostClient();
        return client ? runtimeWakeState(operationId, client) : "unknown";
      },
    }),
    originalSend: (binding) => resolveOriginalSend(binding),
    withdrawWake: async (wake, reason) => {
      if (wake.operationId) {
        const client = runtimeHostClient();
        return client ? withdrawRuntimeWake(wake.operationId, reason, client) : "unknown";
      }
      const delivery = registryDeliveryFor(wake);
      if (!delivery) return "unknown";
      if (delivery.state === "delivered") return "too-late";
      if (delivery.state !== "held") return "unknown";
      agentRegistry().terminalizeHeldDelivery(delivery.id, reason);
      return "withdrawn";
    },
    now: () => Date.now(),
  };
}

/**
 * A lane the seat could still act on.
 *
 * `hiddenAt` is part of the predicate because hiding something and then
 * reporting it as work is a contradiction on its own terms (#1274). A draft the
 * operator discarded before this fix landed carries `hiddenAt` with `state:
 * "draft"` and `closedAt: null`, and read as open it was parked by the stall
 * rule at every check — an hourly wake carrying a lane whose only exit verb was
 * the one the operator had just refused to press. Records written from now on
 * settle properly (`discardDraft`); this clause is what retires the ones
 * already on disk.
 */
function isOpen(pipeline: Pipeline): boolean {
  return !pipeline.closedAt && !pipeline.hiddenAt && pipeline.state !== "completed" && pipeline.state !== "closed";
}

/**
 * A lane that RAN and reached the end, which is the only kind whose pull
 * request is an obligation (#1289).
 *
 * A hidden record is excluded on the same reasoning as {@link isOpen}: a
 * discarded draft never ran, so nothing it names was ever published and there
 * is nothing for it to have left behind.
 */
function isFinished(pipeline: Pipeline): boolean {
  return !pipeline.hiddenAt && (!!pipeline.closedAt || pipeline.state === "completed" || pipeline.state === "closed");
}

/** The projection `evidence.ts` correlates on, built in-process rather than
    fetched over HTTP: movement is attempt-level, never `createdAt`. */
function pipelineSummary(pipeline: Pipeline): PipelineSummary {
  const activityAt = [
    pipeline.pausedAt,
    pipeline.resumedAt,
    ...pipeline.runs.flatMap((run) => run.attempts.flatMap((attempt) => [attempt.startedAt, attempt.completedAt])),
  ].filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)));
  return {
    id: pipeline.id,
    task: pipeline.task,
    project: pipeline.project,
    state: pipeline.state,
    createdAt: pipeline.createdAt,
    closedAt: pipeline.closedAt,
    ...(pipeline.spec ? { spec: pipeline.spec } : {}),
    activityAt,
  };
}

function taskSummary(task: BoardTask & { pipelineIds: string[] }): TaskSummary {
  return {
    id: task.id,
    project: task.project,
    status: task.status,
    text: task.text,
    updatedAt: task.updatedAt,
    assignments: task.assignments?.map((assignment) => ({ state: assignment.state, path: assignment.path, conversationId: assignment.conversationId ?? null })) ?? [],
    pipelineIds: task.pipelineIds,
  };
}

function activityOf(record: AgentLivenessRecord | undefined): SeatTickActivity | null {
  /* The row's own turn state travels with its verdict. Reading the verdict
     without it is how a settled turn that had simply gone quiet was reported as
     the seat's stall (#1262): the threshold measures silence, not an open
     turn. */
  return record ? { lifecycle: record.lifecycle, reason: record.reason, turnState: record.turnState } : null;
}

/**
 * The liveness rows for a project, indexed by the pipeline each one is running.
 *
 * A liveness read that cannot answer answers with nothing. It never says
 * "dead", and a lane with no row is a lane the tick has no stall evidence
 * about — which the decision reads as "still in flight", never as "stuck".
 */
async function laneActivity(project: string, policy: SeatTickPolicy, sources: SeatTickSources): Promise<Map<string, SeatTickActivity>> {
  const byPipeline = new Map<string, SeatTickActivity>();
  let rows: AgentLivenessRecord[];
  try {
    rows = await sources.liveness({ project, stallAfterMs: policy.stallAfterMs, limit: LIVENESS_LIMIT });
  } catch {
    return byPipeline;
  }
  for (const row of rows) {
    const pipelineId = row.pipeline?.pipelineId;
    if (!pipelineId || byPipeline.has(pipelineId)) continue;
    const activity = activityOf(row);
    if (activity) byPipeline.set(pipelineId, activity);
  }
  return byPipeline;
}

/**
 * The seat, with the registry's verdict on the turn it is holding.
 *
 * The verdict is only asked for when the registry says the turn is open, which
 * is the only case anything reads it: a settled turn is never skipped and never
 * signalled. Targeted by conversation id, the way `get_orchestrator` asks it —
 * the targeted branch resolves one transcript and never sweeps the catalog.
 */
async function seatInput(project: string, policy: SeatTickPolicy, sources: SeatTickSources): Promise<SeatTickSeatInput | null> {
  const seat = sources.seatFor(project).active;
  if (!seat?.conversationId) return null;
  const conversation = sources.registry().seatTickConversation(seat.conversationId);
  const turn = conversation?.turn.state ?? "unknown";
  let activity: SeatTickActivity | null = null;
  if (turn === "busy") {
    try {
      const rows = await sources.liveness({ conversationId: seat.conversationId, stallAfterMs: policy.stallAfterMs, limit: 1 });
      activity = activityOf(rows[0]);
    } catch {
      /* An unanswerable liveness read says nothing. The decision treats an
         absent verdict as "not provably progressing", so the tick keeps working
         rather than waiting behind a turn it cannot see. */
      activity = null;
    }
  }
  return { conversationId: seat.conversationId, seatEpoch: seat.seatEpoch, path: seat.path, turn, activity };
}

function signals(project: string, seat: SeatTickSeatInput | null, sources: SeatTickSources): SeatTickSignalInput[] {
  const found: SeatTickSignalInput[] = [];
  /* The LATEST deployment, asked for as such. The ledger's default ordering is
     by entity id — a random UUID — so taking an element out of a one-row "tail"
     reported a rolled-back deploy from earlier in the day while the four newest
     had all succeeded (#1262). A signal that says production rolled back is one
     an orchestrator acts on, so it has to be about the deployment that actually
     happened last. */
  const latest = sources.latestDeployment();
  const last = latest.state === "ok" ? latest.value : null;
  if (last && last.terminal && last.phase !== "succeeded") {
    found.push({ id: "deploy", label: `the last deployment ended ${last.phase}` });
  }
  const report = sources.retirementReport();
  const undetermined = report?.refused.filter((refusal) => refusal.undetermined).length ?? 0;
  if (report && (report.failed.length > 0 || undetermined > 0)) {
    found.push({ id: "host-retirement", label: `host retirement: ${report.failed.length} failed, ${undetermined} undetermined` });
  }
  /* The one signal that is about the seat itself: its own turn has stopped
     progressing. The tick's wake is what brings such a seat back, which is the
     reversal recorded in this PR's ADR — and, because this is a signal, it is
     agenda enough for the hourly interval to carry it. */
  const seatActivity = seat?.activity;
  if (seat && seat.turn === "busy" && seatActivity && seatStalled(seatActivity)) {
    found.push({ id: "seat-host", label: `the seat's own turn is ${seatActivity.lifecycle} in ${project} (${seatActivity.reason})` });
  }
  return found;
}

/**
 * Whether the seat's own turn has stopped, in the sense the signal claims.
 *
 * `gone` is the host: it is dead whatever the turn was doing, and resuming it
 * is what the wake is for. `stalled` is the one that needed narrowing. It has
 * two roots — a dead host or an expired launch under an OPEN turn, and a
 * transcript silent past the threshold — and the second fires on silence alone,
 * so a seat that finished its turn cleanly and sat quiet for forty minutes was
 * reported stalled to itself (#1262). The transcript's own turn state, which is
 * what the verdict was computed from, is what tells the two apart; the
 * registry's turn record is a different fact and is stale in exactly this case.
 */
function seatStalled(activity: SeatTickActivity): boolean {
  if (activity.lifecycle === "gone") return true;
  return activity.lifecycle === "stalled" && activity.turnState === "busy";
}

/** The repository a project's `gh` reads run in: the newest pipeline that named
    one. Null when nothing ever did, and the proposal then ranks the board alone. */
export function repoDirForProject(
  project: string,
  sources: SeatTickSources,
  /** Lanes the caller has already read out of cold storage. A project whose
      every lane has been archived still has a repository, and asking `gh`
      nothing because the hot store happens to be empty is the same silence
      read off a different shelf (#1289). Never read here on its own: the
      caller pays for the archive when it has already decided to. */
  archived: readonly Pipeline[] = [],
): string | null {
  const canonical = canonicalOrchestratorProject(project);
  const named = [...sources.pipelines(), ...archived]
    .filter((pipeline) => pipeline.repoDir && canonicalOrchestratorProject(pipeline.project) === canonical)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  return named[0]?.repoDir ?? null;
}

/**
 * A digest of everything a wake could change. Two equal fingerprints across two
 * wakes is exactly what "that wake changed nothing" means.
 *
 * Every field a wake reason is decided from has to be in here, because this
 * digest is also what identifies a retry-guard entry: a guard keyed on less
 * than the condition it guards outlives that condition. A card's `updatedAt` is
 * the case #1262 produced — it decides whether the card is an unstarted task or
 * backlog, so moving a stale card is precisely the act that should bring the
 * reason back, and while it was missing from here the guard held the reason
 * suppressed with the card's movement invisible to it.
 */
function changeFingerprint(
  pipelines: readonly SeatTickPipelineInput[],
  tasks: readonly SeatTickTaskInput[],
  children: readonly SeatTickChildInput[],
  pullRequests: readonly SeatTickPullRequestInput[],
  pullRequestsUnavailable: SeatTickPullRequestGap | null,
): string {
  /* A child's status and outcome instant decide two wake reasons (#1465), so
     they are in the half the guard reads: a child finishing, or a harvested one
     leaving the projection, is the movement that resets the guard. A source
     that could not be read contributes nothing here — the children list is
     empty then, and the gap beside it keeps the check from concluding quiet. */
  const board = [
    ...pipelines.map((pipeline) => `p:${pipeline.id}:${pipeline.state}:${pipeline.updatedAt ?? ""}`),
    ...tasks.map((task) => `t:${task.id}:${task.status}:${task.owned}:${task.updatedAt ?? ""}`),
    ...children.map((child) => `c:${child.conversationId}:${child.outcomeId ?? ""}:${child.status}:${child.terminalAt ?? ""}`),
  ].sort();
  /* The set of unmerged pull requests, for the same reason the card's movement
     instant is in the half above: it decides a wake reason, so a guard keyed on
     less than it would hold the reason suppressed while a SECOND pull request
     went unmerged behind the first. A merge or a close removes the row, which is
     what lets the guard reset the moment the seat acts.

     Its own half, because a read that FAILED contributes the same nothing a
     merge does and the guard must not read one as the other (#1298). An
     unreadable source says `unread` here and the guard declines to conclude
     anything from this half at all. */
  const open = pullRequests.map((pullRequest) => `pr:${pullRequest.number}:${pullRequest.pipelineId}`).sort();
  return `${digest(board)}.${pullRequestsUnavailable ? FINGERPRINT_UNREAD : digest(open)}`;
}

function digest(parts: readonly string[]): string {
  return crypto.createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 32);
}

/** Projects worth checking: everyone with a seat, plus everyone with work and
    nobody to do it. A project with neither is not a project the tick has an
    opinion about. */
export function seatTickProjects(sources: SeatTickSources): string[] {
  const projects = new Set(sources.activeSeats().map(canonicalOrchestratorProject));
  for (const pipeline of sources.pipelines()) {
    if (isOpen(pipeline) && pipeline.project) projects.add(canonicalOrchestratorProject(pipeline.project));
  }
  for (const task of sources.tasks()) {
    if ((task.status === "inbox" || task.status === "assigned") && task.project) projects.add(canonicalOrchestratorProject(task.project));
  }
  return [...projects].sort();
}

/**
 * Everything past the seat's own event cursor.
 *
 * The lifecycle digest's per-subscriber cursor is not used here, and the reason
 * is the one rule this whole file is arranged around: that cursor advances when
 * the relay is READ, and an acknowledged event is never offered again. A wake
 * that is then refused at the seat epoch, held by a migration, or queued behind
 * a host that never takes it would leave the seat permanently unaware of the
 * lane event that produced it. So the tick keeps its own cursor in its own row
 * and moves it only when a wake actually landed — and, exactly as the digest
 * does, it asks about a pending terminal event over the whole range rather than
 * one page of it.
 */
function eventsSince(
  project: string,
  cursor: number | null,
  openPipelineIds: ReadonlySet<string>,
  sources: SeatTickSources,
): { events: SeatTickEventInput[]; cursor: number } {
  const journal = sources.lifecycleJournal();
  /* `lastSeq` is the head the journal maintains; the newest event's seq is the
     same number written a second way, and taking the larger keeps a head that
     somehow lagged its own events from replaying them as new. */
  const head = Math.max(journal.lastSeq, journal.events.at(-1)?.seq ?? 0);
  /* The first check for a project SEALS the cursor at the head instead of
     reading from zero. A first run has no backlog to catch up on: everything
     already in the journal happened before the tick existed for this seat, and
     handing it over as the seat's instruction for the turn is what #1262
     records — four-day-old merges listed as work, with ninety-three more items
     held back. The seal is written once and only once; from then on the cursor
     is the seat's, and it moves only when a wake lands. */
  if (cursor === null) return { events: [], cursor: head };
  const page = pageFromEvents(journal, { project, afterSeq: cursor, limit: EVENT_PAGE });
  return {
    events: page.events.map((event) => ({
      seq: event.seq,
      at: event.at,
      type: event.type,
      summary: event.summary,
      pipelineId: event.pipelineId,
      /* An open lane is always in the hot store; the archive only ever takes
         SETTLED records. So a pipeline id the store no longer lists names a
         lane that ended long enough ago to have been archived, and reading it
         as terminal is the same answer arrived at from the other side. An event
         that names no pipeline is never terminal here — nothing about a deploy
         outcome or a held delivery has finished (#1285). */
      pipelineTerminal: event.pipelineId !== null && !openPipelineIds.has(event.pipelineId),
    })),
    cursor,
  };
}

/**
 * Pull requests the project's finished lanes left open (#1289).
 *
 * The correlation is the lane's own branch against the pull request's head
 * ref — durable on both sides, and the only tie that survives the lane being
 * closed, its worktree being removed and its host being reaped.
 *
 * The bounds keep it cheap and keep it from becoming a route around the hourly
 * wake. It is read only when a wake could actually be raised from it — the tick
 * is on for this project, the interval has elapsed, there is a seat to wake and
 * its turn is not already moving — only when the project has a finished lane to
 * attribute one to, and only when some pipeline named a repository to ask in.
 * Each of those is an answer: this check would raise no wake from this reason
 * whatever GitHub said. A read that FAILED is not an answer, and leaves with
 * {@link SeatTickPullRequestGap} rather than an empty list.
 *
 * One more bound joined them (#1298): a source that has been failing for longer
 * than a whole wake interval is asked once per interval rather than once per
 * check. That one saves a subprocess and nothing else — the failure it already
 * established is replayed on every check in between, so no check between two
 * attempts is entitled to a conclusion the attempt would have denied it. The
 * bound covers BOTH reads below, because either of them can be the one that is
 * permanently broken; where each is gated is decided in the body, by what a
 * fresh read of that source on that check would have produced.
 *
 * The lanes come from the hot store AND the archive, because the obligation is
 * the pull request still being open and that outlives the lane's three days of
 * residence. Reading only the hot store made the reason decay on a timer: a
 * tick switched off, a seat busy for days, or a `gh` unreachable until the lane
 * settled out all arrive at the first eligible check with nothing to attribute
 * a pull request to, and report quiet over one still sitting open — the same
 * twelve-hour silence #1289 exists to end, taken slowly. The retry guard does
 * not cover the gap either: it counts wakes that changed nothing, and a wake
 * that was never sent has nothing to count. The archive is cold storage, so it
 * is read only after every cheap gate above has passed, at which point the
 * check has already committed to a `gh` subprocess and a snapshot read is the
 * cheaper half of the pair.
 */
interface PullRequestEvidence {
  pullRequests: SeatTickPullRequestInput[];
  /** Null means the question was answered — including answered with nothing
      open, which is what the tick is entitled to go quiet on. */
  unavailable: SeatTickPullRequestGap | null;
  /** The source's run of failures as this check leaves it (#1298). Carried on
      the row so the next check knows whether this is weather or configuration,
      and so a standing outage is reported once rather than every five minutes. */
  gap: SeatTickSourceGap | null;
}

async function unmergedPullRequests(context: {
  project: string;
  seat: SeatTickSeatInput | null;
  wakeDue: boolean;
  enabled: boolean;
  now: number;
  wakeIntervalMs: number;
  /** What the previous checks made of this source. */
  gap: SeatTickSourceGap | null;
  sources: SeatTickSources;
}): Promise<PullRequestEvidence> {
  /* Nothing was asked, so nothing is concluded — and the run of failures is
     left exactly as it stands. A gate is a statement about this check, never
     about whether the source can be read. */
  const unasked: PullRequestEvidence = { pullRequests: [], unavailable: null, gap: context.gap };
  if (!context.wakeDue || !context.enabled) return unasked;
  /* The other two ways a check can be unable to raise any reason at all: a
     project with nobody to wake ends in `no-seat`, and a seat whose turn is
     genuinely moving ends in `skipped`, both before a wake reason is composed.
     Without this clause a seat that stays busy for hours pays a `gh` subprocess
     every five minutes for the whole turn, to answer a question that check was
     never going to ask. */
  if (!context.seat || seatTurnProgressing(context.seat)) return unasked;

  const at = new Date(context.now).toISOString();
  const failed = (kind: SeatTickPullRequestGap): PullRequestEvidence => ({
    pullRequests: [],
    unavailable: kind,
    gap: seatTickSourceGapAfterFailure(context.gap, kind, at),
  });

  /* The archive is an evidence source too, and a permanent failure of it has to
     be bounded by the same backoff (#1298). A lane store that can never be read
     — the snapshot is corrupt, its directory is gone — failed on every check
     five minutes apart for as long as no delivered wake moved the hourly stamp,
     which is exactly the unbounded retry the backoff below exists to stop.
     Standing failures of this class are asked at the wake interval, and the
     fresh failures inside the first interval still retry at every check.

     Its gate is HERE rather than beside the one below, and the difference is
     what a fresh read would have produced. The gates in between say this check
     had nothing to ask — no finished lane, no repository — and are themselves
     read out of the archive, so a check that cannot enumerate the lanes cannot
     reach any of them: a fresh read fails on this very line and reports the gap
     unconditionally. Replaying it above them is therefore the same verdict, not
     a gap outliving its question. */
  const standing = context.gap;
  if (standing?.gap === "lanes-unreadable" && !seatTickSourceRetryDue(standing, context.now, context.wakeIntervalMs)) {
    return { pullRequests: [], unavailable: standing.gap, gap: standing };
  }

  let archived: readonly Pipeline[];
  try {
    archived = context.sources.archivedPipelines();
  } catch {
    /* Lanes half-read are obligations half-seen, and an obligation that cannot
       be seen is exactly what gets reported as quiet. */
    return failed("lanes-unreadable");
  }
  const finished = [...context.sources.pipelines(), ...archived]
    .filter((pipeline) => canonicalOrchestratorProject(pipeline.project) === context.project && isFinished(pipeline));
  if (finished.length === 0) return unasked;
  const cwd = repoDirForProject(context.project, context.sources, archived);
  if (!cwd) return unasked;

  /* The same bound for the `gh` read: a source that has been unreadable for
     longer than a whole wake interval is asked at that interval and no faster
     (#1298). The gap it already produced is replayed in between, so every check
     still refuses to call this quiet — what the backoff saves is the `gh`
     subprocess, never a conclusion.

     It sits BELOW the two gates above, because a replayed gap must not outlive
     the question it answers. Each of those gates is this check finding there is
     nothing to ask: no finished lane left anything open, or the project has no
     repository to ask about. A fresh read on such a check reports no gap at all,
     so replaying one above them would name an unreadable source for the rest of
     the backoff window on a check that would have succeeded trivially, and would
     refuse a quiet the evidence allows. Everything between the gates and here is
     a local read; the subprocess below is the only thing THIS gate saves. */
  if (context.gap && !seatTickSourceRetryDue(context.gap, context.now, context.wakeIntervalMs)) {
    return { pullRequests: [], unavailable: context.gap.gap, gap: context.gap };
  }

  let result: OpenPullRequestsResult;
  try {
    /* The seam answers with a result; a seam that throws instead is the same
       fact arriving by exception, and neither is an empty list. */
    result = await context.sources.openPullRequests({ cwd, limit: PULL_REQUEST_LIMIT });
  } catch {
    result = { ok: false, unavailable: "command-failed" };
  }
  if (!result.ok) return failed(result.unavailable);
  const open = result.pullRequests;
  const byBranch = new Map<string, Pipeline>();
  for (const pipeline of finished) {
    if (!pipeline.branch) continue;
    /* Two lanes on one branch is a relaunch: the newest is the one whose
       finishing left the pull request open. */
    const held = byBranch.get(pipeline.branch);
    if (!held || Date.parse(pipeline.createdAt) > Date.parse(held.createdAt)) byBranch.set(pipeline.branch, pipeline);
  }
  const found: SeatTickPullRequestInput[] = [];
  for (const pullRequest of open) {
    const lane = byBranch.get(pullRequest.headRefName);
    if (!lane) continue;
    found.push({
      number: pullRequest.number,
      title: redactBounded(pullRequest.title, PULL_REQUEST_TITLE_LIMIT),
      pipelineId: lane.id,
      pipelineTitle: redactBounded(lane.task.split("\n")[0] ?? "", PULL_REQUEST_TITLE_LIMIT),
      updatedAt: pullRequest.updatedAt,
    });
  }
  /* An answer, so the run of failures is over: the source spoke, whatever it
     said. This is the only thing that clears the row, which is what makes the
     next outage a fresh run with its own report. */
  return { pullRequests: found.sort((left, right) => left.number - right.number), unavailable: null, gap: null };
}


/* Standalone child discovery uses indexed lineage pages. Persistent FIFO
 * tickets poll proven child generations and retain owed outcomes until landing.
 * Running activity and terminal ledger evidence are separate projections. */

const LIVE_CHILD_RECEIPT_STATES: ReadonlySet<SpawnReceipt["state"]> = new Set(["starting", "pane-bound", "host-verified", "prompt-delivered", "path-pending"]);
const LIVE_CHILD_HOST_STATES: ReadonlySet<AgentRegistryEntry["status"]> = new Set(["starting", "live", "idle", "handoff"]);
const CONTAINER_MEMBERSHIPS: ReadonlySet<string> = new Set(["pipeline", "flow", "orchestrator"]);

/** The registry entries that could be hosting this child, by every session key
    the records tie to it. */
function childHostEntries(file: RegistryFile, edge: SpawnLineageEdge, receipt: SpawnReceipt | null, transcriptKey: SessionKey | null): AgentRegistryEntry[] {
  const keys = [receipt?.key, edge.childSessionKey, transcriptKey].filter((key): key is SessionKey => Boolean(key));
  return [...new Set(keys.map(sessionKeyId))].flatMap((key) => (file.entries[key] ? [file.entries[key]!] : []));
}

/** Whether anything is still running this child: a host entry in a live state,
    or a launch receipt the spawn path has not finished with. A `starting`
    receipt past its admission lease is a launch that never got anywhere, and
    is no evidence of a host. */
function childHosted(receipt: SpawnReceipt | null, entries: readonly AgentRegistryEntry[], now: number): boolean {
  if (entries.some((entry) => LIVE_CHILD_HOST_STATES.has(entry.status))) return true;
  if (!receipt || !LIVE_CHILD_RECEIPT_STATES.has(receipt.state)) return false;
  if (receipt.state !== "starting") return true;
  const createdAt = Date.parse(receipt.createdAt);
  return Number.isFinite(createdAt) && now - createdAt <= SPAWN_STARTING_ADMISSION_LEASE_MS;
}

interface ProjectedChild {
  input: SeatTickChildInput;
  /** The registry's turn record, for deciding whether to ask the liveness plane. */
  turn: "busy" | "idle" | "terminal" | "unknown";
  hosted: boolean;
  createdAt: string;
}

/** One child, classified from the snapshot alone. Null for a child that is
    not this seat's to see. */
function projectChild(
  file: RegistryFile,
  lookup: ReturnType<typeof readOnlyConversationLookupFromSnapshot>,
  edge: SpawnLineageEdge,
  project: string,
  now: number,
): ProjectedChild | null {
  if (edge.source !== "viewer-spawn") return null;
  const childId = lookup.canonicalConversationId(edge.childConversationId);
  if ((file.memberships[childId] ?? []).some((membership) => CONTAINER_MEMBERSHIPS.has(membership.kind))) return null;
  const receipt = edge.evidence.launchId ? file.receipts[edge.evidence.launchId] ?? null : null;
  const conversation = lookup.conversation(childId);
  const generation = conversation?.generations.at(-1) ?? null;
  const transcriptKey = conversation && generation ? sessionKeyFromTranscript(conversation.engine, generation.path) : null;
  const entries = childHostEntries(file, edge, receipt, transcriptKey);
  const attributed = resolveProjectAttribution({
    projectOwnership: conversation?.projectOwnership ?? null,
    cwd: receipt?.cwd ?? entries[0]?.cwd ?? null,
    launchProfileProject: receipt?.launchProfile.project ?? generation?.launchProfile.project ?? null,
  }).project;
  if (!attributed || canonicalOrchestratorProject(attributed) !== project) return null;

  const title = redactBounded(
    receipt?.launchProfile.title ?? generation?.launchProfile.title ?? edge.role ?? "spawned child",
    CHILD_TITLE_LIMIT,
  );
  const hosted = childHosted(receipt, entries, now);
  const turn = conversation?.turn.state ?? "unknown";
  const base = { conversationId: childId, title, activity: null };
  const createdAt = edge.createdAt;
  /* A launch that failed or conflicted before it ran: terminal, outcome
     failed. The receipt is the whole record of it. */
  if (receipt && (receipt.rejection || receipt.state === "failed" || receipt.state === "conflicted")) {
    return { input: { ...base, status: "terminal", outcome: "failed", terminalAt: receipt.rejection?.rejectedAt ?? receipt.createdAt }, turn, hosted, createdAt };
  }
  if (!conversation) return { input: { ...base, status: "unknown", outcome: null, terminalAt: null }, turn, hosted, createdAt };
  if (turn === "terminal") {
    return { input: { ...base, status: "terminal", outcome: "finished", terminalAt: conversation.turn.terminalAt ?? conversation.turn.observedAt ?? conversation.updatedAt }, turn, hosted, createdAt };
  }
  if (hosted) return { input: { ...base, status: "running", outcome: null, terminalAt: null }, turn, hosted, createdAt };
  /* No host anywhere. A settled turn with nothing running it is a worker that
     finished and whose host was released — the seat's to harvest. An OPEN turn
     with nothing running it is a stall the registry can see on its own, and
     it is reported as such, never as finished. A turn the registry never
     observed is unknown, and stays unknown. */
  if (turn === "idle") {
    return { input: { ...base, status: "terminal", outcome: "finished", terminalAt: conversation.turn.observedAt ?? conversation.updatedAt }, turn, hosted, createdAt };
  }
  if (turn === "busy") {
    return {
      input: { ...base, status: "running", outcome: null, terminalAt: null, activity: { lifecycle: "gone", reason: "host_gone_turn_open", turnState: "busy" } },
      turn,
      hosted,
      createdAt,
    };
  }
  return { input: { ...base, status: "unknown", outcome: null, terminalAt: null }, turn, hosted, createdAt };
}

interface ChildEvidence {
  children: SeatTickChildInput[];
  unavailable: SeatTickChildrenGap | null;
}

async function childWork(
  project: string,
  seat: SeatTickSeatInput | null,
  state: SeatTickProjectState,
  policy: SeatTickPolicy,
  sources: SeatTickSources,
): Promise<ChildEvidence> {
  if (!seat) return { children: [], unavailable: null };
  if (!state.accounting) return { children: [], unavailable: "registry-unreadable" };
  const accounting = new SeatTickAccounting(state.accounting.filename, project);
  const registry = sources.registry();
  const now = sources.now();
  let gap = state.accounting.gap !== null;
  const children: SeatTickChildInput[] = [];
  const classify = (page: NonNullable<ReturnType<typeof registry.pageSeatChildren>>, id: string) => {
    const edge = page.file.lineageEdges[id];
    if (!edge) return null;
    return projectChild(page.file, readOnlyConversationLookupFromSnapshot(page.file), edge, project, now);
  };
  try {
    accounting.owner(seat.conversationId, seat.seatEpoch);
    const ownersIncomplete = accounting.discoverRevokedOwners(statePath("orchestrator-seats.json"), (ownerProject) => canonicalOrchestratorProject(ownerProject) === project);
    gap ||= ownersIncomplete;
    const ownerTicket = accounting.page("owner-poll", 1)[0];
    if (ownerTicket?.kind === "owner-poll") {
      const owner = accounting.get(ownerTicket.target);
      if (!owner || owner.kind !== "owner") throw new Error("missing owner provenance");
      const page = registry.pageSeatChildren(owner.conversationId, owner.after, owner.through, 20);
      if (!page) throw new Error("registry backend cannot page children");
      const discovered: AccountingChild[] = [];
      for (const id of page.keys) {
        const edge = page.file.lineageEdges[id]!;
        const child = classify(page, id);
        if (child && edge.evidence.launchId) discovered.push(accounting.child(id, owner.conversationId, edge.evidence.launchId, child.input));
      }
      const nextOwner: AccountingOwner = { ...owner, after: page.complete ? "" : page.nextKey, through: page.complete ? null : page.throughKey };
      accounting.discovery(ownerTicket, nextOwner, discovered);
      gap ||= page.evidenceGap || !page.complete;
    }
    let bytesLeft = 262144;
    let recordsLeft = 200;
    for (const ticket of accounting.page("poll", 8)) {
      if (ticket.kind !== "poll") throw new Error("invalid poll ticket");
      const child = accounting.get(ticket.target);
      if (!child || child.kind !== "child") throw new Error("missing child provenance");
      const page = registry.pageSeatChildren(child.owner, "", "", 1, [child.rowKey]);
      if (!page) throw new Error("registry backend cannot project child");
      const projected = classify(page, child.rowKey);
      const edge = page.file.lineageEdges[child.rowKey];
      if (!projected || !edge || edge.parentConversationId !== child.owner || edge.evidence.launchId !== child.launchId) {
        accounting.ingest(ticket, { ...child, input: { ...child.input, status: "unknown", outcome: null } }, null, []);
        gap = true;
        continue;
      }
      child.input = projected.input;
      if (child.input.status === "unknown") { children.push(child.input); gap = true; }
      const lookup = readOnlyConversationLookupFromSnapshot(page.file);
      const conversation = lookup.conversation(edge.childConversationId);
      const generations = conversation?.generations ?? [];
      const generation = generations[child.generationIndex % Math.max(1, generations.length)];
      const receipt = page.file.receipts[child.launchId];
      // A failed receipt after materialization cannot establish pre-execution failure.
      const failure = receipt?.state === "failed" && receipt.key === null && receipt.artifactPath === null && generations.length === 0;
      if (generation && bytesLeft > 0 && recordsLeft > 0) {
        const source = accounting.source(child, conversation!.engine, generation.id);
        const read = readChildLedger(path.join(statePath("structured-host-events"), `${encodeURIComponent(generation.id)}.jsonl`), source.cursor, Math.min(bytesLeft, 32768), recordsLeft);
        source.cursor = read.cursor;
        if (read.cursor.atEnd && read.cursor.activeTurn === null && read.cursor.settledThrough > 0
          && (projected.turn === "idle" || projected.turn === "terminal")) {
          child.input = { ...child.input, status: "terminal", outcome: "finished" };
        }
        bytesLeft -= read.bytes; recordsLeft -= read.records;
        gap ||= source.cursor.gap !== null;
        child.generationIndex = (child.generationIndex + 1) % generations.length;
        accounting.ingest(ticket, child, source, read.outcomes);
      } else accounting.ingest(ticket, child, null, [], failure);
    }
    for (const ticket of accounting.page("running", 8)) {
      if (ticket.kind !== "running") continue;
      const child = accounting.get(ticket.target);
      if (!child || child.kind !== "child") throw new Error("missing running child");
      const page = registry.pageSeatChildren(child.owner, "", "", 1, [child.rowKey]);
      const projected = page && classify(page, child.rowKey);
      if (!projected || projected.input.status !== "running") { gap = true; continue; }
      let input = projected.input;
      if (projected.turn === "busy" && projected.hosted) {
        try { input = { ...input, activity: activityOf((await sources.liveness({ conversationId: input.conversationId, stallAfterMs: policy.stallAfterMs, limit: 1 }))[0]) }; }
        catch { input = { ...input, activity: null }; }
      }
      children.push(input);
    }
    for (const outcome of accounting.ready(20)) {
      const child = accounting.get(outcome.child);
      if (!child || child.kind !== "child") throw new Error("missing ready child");
      const page = registry.pageSeatChildren(child.owner, "", "", 1, [child.rowKey]);
      if (!page || !classify(page, child.rowKey) || page.file.lineageEdges[child.rowKey]?.parentConversationId !== child.owner) { accounting.defer(outcome); gap = true; continue; }
      children.push(outcome.input);
    }
  } catch { gap = true; }
  return { children, unavailable: gap ? "registry-unreadable" : null };
}

export async function gatherSeatTickInput(
  project: string,
  state: SeatTickProjectState,
  policy: SeatTickPolicy,
  sources: SeatTickSources,
): Promise<SeatTickCheckInput> {
  const now = sources.now();
  const canonical = canonicalOrchestratorProject(project);
  const settings = effectiveSeatTickSettings(sources.settings(canonical), now, SEAT_TICK_WAKE_INTERVAL_MS);
  const seat = await seatInput(canonical, policy, sources);

  const openLanes = sources.pipelines().filter((pipeline) => isOpen(pipeline) && canonicalOrchestratorProject(pipeline.project) === canonical);
  const evidence = evidenceFromPipelines(openLanes.map(pipelineSummary));
  const activity = openLanes.length > 0 ? await laneActivity(canonical, policy, sources) : new Map<string, SeatTickActivity>();
  const pipelines: SeatTickPipelineInput[] = openLanes.map((pipeline, index) => ({
    id: pipeline.id,
    title: evidence[index]!.title,
    state: evidence[index]!.state,
    updatedAt: evidence[index]!.updatedAt,
    stageActivity: activity.get(pipeline.id) ?? null,
    stageId: pipeline.cursor?.stageId ?? null,
  }));

  /* Pipeline membership is the read model the board itself uses, so "owned"
     means the same thing here as it does on the card. */
  const board = projectTaskPipelineIds(sources.tasks(), [...sources.pipelines()])
    .filter((task) => canonicalOrchestratorProject(task.project) === canonical);
  const taskEvidence = evidenceFromTasks(board.map(taskSummary));
  const tasks: SeatTickTaskInput[] = board.map((task, index) => ({
    id: task.id,
    title: taskEvidence[index]!.title,
    status: task.status,
    owned: taskEvidence[index]!.owner !== null,
    updatedAt: task.updatedAt ?? null,
  }));

  /* The open set spans EVERY project, not this one's lanes: an event is history
     because its own lane finished, and reading a lane from another project as
     terminal because it is not in this project's slice would be the same claim
     made about the wrong pipeline. */
  const openPipelineIds = new Set(sources.pipelines().filter(isOpen).map((pipeline) => pipeline.id));
  const { events, cursor } = eventsSince(canonical, state.eventsThrough, openPipelineIds, sources);
  const { children, unavailable: childrenUnavailable } = await childWork(canonical, seat, state, policy, sources);
  const harvestedChildren = state.harvestedChildren;
  const { pullRequests, unavailable: pullRequestsUnavailable, gap: pullRequestGap } = await unmergedPullRequests({
    project: canonical,
    seat,
    /* The same clause the decision applies, asked here because the read behind
       it is a subprocess: a reason that cannot be raised this check is a reason
       whose evidence is not worth fetching. The decision applies the bound
       again on its own terms — this is a cost gate, never the bound itself. */
    wakeDue: seatTickWakeDue(state.lastWakeAt, now, settings.wakeIntervalMs),
    enabled: settings.enabled,
    now,
    wakeIntervalMs: settings.wakeIntervalMs,
    gap: state.pullRequestGap,
    sources,
  });

  return {
    project: canonical,
    now,
    seat,
    pipelines,
    tasks,
    events,
    pullRequests,
    pullRequestsUnavailable,
    signals: signals(canonical, seat, sources),
    children,
    childrenUnavailable,
    changeFingerprint: changeFingerprint(pipelines, tasks, children, pullRequests, pullRequestsUnavailable),
    /* The sealed cursor travels on the state the decision carries forward, so a
       check of any verdict — a skip included, which remembers nothing else —
       persists where the journal stood when the tick first saw this project.
       The source's run of failures rides out the same way (#1298): the gather
       is what attempted the read, so the gather is what records what became of
       it, and the decision reads that row to know whether this is the outage
       worth putting on the board. */
    state: { ...state, eventsThrough: cursor, pullRequestGap, harvestedChildren, accounting: state.accounting ? new SeatTickAccounting(state.accounting.filename, canonical).readState().accounting : undefined },
    policy,
    settings,
  };
}
