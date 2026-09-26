import crypto from "node:crypto";

import { accountManager } from "@/lib/accounts/manager";
import { turnStateFromRecords } from "@/lib/accounts/migration/turnState";
import { launchProfileEngineReadOnly, type ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { agentRegistry, resolveConversationAlias, type AgentRegistry, type AgentRegistryEntry, type ProcessIdentity, type RegistryFile, type SpawnReceipt } from "@/lib/agent/registry";
import { effectiveClaudePermissionMode } from "@/lib/agent/cli";
import { sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";
import { activeOrchestratorSeats, type OrchestratorSeat } from "@/lib/orchestrator/seats";
import { captureProcessIdentity, processIdentityMayOwn, processIdentityStatus } from "@/lib/processIdentity";
import { assertDarwinStructuredRuntime } from "@/lib/proc/darwinIdentity";
import { readStableTailRecords } from "@/lib/scanner/activity";
import { withoutWakatimeCredential } from "@/lib/wakatime/credential";
import { loadPipelinesForStartup, withPipelineStartupAdmission } from "@/lib/pipelines/store";

import {
  adoptClaudeRegistryHosts,
  adoptCodexRegistryHosts,
  demoteSkippedStructuredRegistryHosts,
  reconcileDeadStructuredRegistryHosts,
  type AdoptedClaudeHost,
  type AdoptedCodexHost,
  type StructuredHostAdoptionFilter,
} from "./registry";
import { RuntimeHostUnavailableError, runtimeHostClient, type RuntimeHostClient } from "./client";
import { forEachStartupBatch } from "./startupWork";
import type { RuntimeSession } from "./contracts";
import type { RuntimeOperationResult } from "./contracts";
import {
  bindStructuredDeliveryQueue,
  completeStructuredDeliveryQueueStartup,
  hasStructuredDeliveryController,
  hasStructuredDeliveryHost,
  recordDemotionInterruption,
  releaseStructuredDeliveryHostsForDemotion,
  type DemotionInterruptionOptions,
} from "./structuredDeliveryController";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { enqueueStructuredMessage } from "./structuredMessageDelivery";
import { INTERRUPTED_CODEX_CONTINUATION_TEXT, RECOVERY_NOTICE_ORIGIN } from "./recoveryNotices";
import { claudeHostLaunchPaths, materializeStructuredHostAccess, recoverPendingStructuredSpawns, structuredHostAccessPolicy } from "./structuredSpawn";
import { conversationTurnLiveness, readTranscriptEvidence, transcriptEvidenceFromRecords, type TranscriptEventKind, type TurnLivenessDependencies } from "./liveness";
import { markStructuredHostStartupProgress, type StructuredHostStartupPhase } from "./startupStatus";
import { startupDiagnostic } from "../startupDiagnostics";
import {
  interruptionContinuationText,
  interruptionObligationDirectory,
  interruptionObligationStore,
  interruptionObligationUnresolved,
  submittedContinuationOutcome,
  type InterruptionObligation,
  type InterruptionObligationStore,
} from "./interruptionObligations";

type AdoptedStructuredHost = AdoptedCodexHost | AdoptedClaudeHost;
let adoptedHosts: AdoptedStructuredHost[] = [];
let retryAdoptedHosts: AdoptedStructuredHost[] = [];
/* The retry runner logs each failure; this diagnostic names the deferred work once. */
let deferredAdoptionLogged = false;
const STARTUP_READ_TIMEOUT_MS = 30_000;
type StartupPassState = {
  generation?: string | null;
  retained?: AdoptedStructuredHost[];
  recoveries?: OrchestratorRestartRecoveryTarget[];
  pending?: Promise<AdoptedStructuredHost[]>;
  ready?: AdoptedStructuredHost[];
};
// Instrumentation and routes can load separate module instances in standalone.
const processStartup = process as typeof process & {
  __llvStructuredStartupPasses?: WeakMap<AgentRegistry, StartupPassState>;
};
const startupPasses = processStartup.__llvStructuredStartupPasses ??= new WeakMap<AgentRegistry, StartupPassState>();

/** Rows a completed pass left exactly as they were because their pipeline's
    evidence (an alive or unverifiable survivor, an unreadable record) does not
    yet admit a replacement. The pass itself is complete: the boot is ready,
    every unrelated host is published and pending-spawn recovery has run. What
    remains is a re-probe of this evidence alone, on a bounded backoff, and the
    adoption pass runs again only when that evidence has changed. */
interface DeferredStructuredStartup {
  hostKeys: readonly string[];
  conversationIds: ReadonlySet<string>;
  fencedReceipts: number;
  message: string;
  delayMs: number;
}
const DEFERRED_STARTUP_REPROBE_INITIAL_MS = 1_000;
const DEFERRED_STARTUP_REPROBE_MAX_MS = 30_000;
let deferredStartup: DeferredStructuredStartup | null = null;

export function structuredStartupDeferral(): {
  hostKeys: readonly string[];
  fencedReceipts: number;
  message: string;
  nextProbeMs: number;
} | null {
  if (!deferredStartup) return null;
  const { hostKeys, fencedReceipts, message, delayMs } = deferredStartup;
  return { hostKeys, fencedReceipts, message, nextProbeMs: delayMs };
}

function retainAdoptedHosts(
  retained: readonly AdoptedStructuredHost[],
  adopted: readonly AdoptedStructuredHost[],
): AdoptedStructuredHost[] {
  const hosts = new Map(retained.map((item) => [sessionKeyId(item.key), item]));
  for (const item of adopted) {
    const key = sessionKeyId(item.key);
    if (!hosts.has(key)) hosts.set(key, item);
  }
  return [...hosts.values()];
}

function retainedStartupHostIsCurrent(
  snapshot: RegistryFile,
  item: AdoptedStructuredHost,
  retainedTerminalHostKeys: ReadonlySet<string> = new Set(),
): boolean {
  const key = sessionKeyId(item.key);
  const entry = snapshot.entries[key];
  if (!entry?.structuredHost || entry.status === "dead" || entry.status === "unhosted") return false;
  const conversation = Object.values(snapshot.conversations).find((candidate) =>
    candidate.engine === item.key.engine
      && candidate.generations.at(-1)?.id === item.key.sessionId);
  return Boolean(conversation
    && !conversation.supersededBy
    && (conversation.turn.state !== "terminal" || retainedTerminalHostKeys.has(key)));
}

async function revalidateRetainedStartupHosts(
  registry: AgentRegistry,
  retained: readonly AdoptedStructuredHost[],
  snapshot: RegistryFile = registry.readOnlySnapshot(),
  retainedTerminalHostKeys: ReadonlySet<string> = new Set(),
): Promise<AdoptedStructuredHost[]> {
  const current: AdoptedStructuredHost[] = [];
  await forEachStartupBatch(retained, async (item) => {
    if (retainedStartupHostIsCurrent(snapshot, item, retainedTerminalHostKeys)) current.push(item);
    else await item.host.release();
  });
  return current;
}

const RUNTIME_EFFECT_PAGE_SIZE = 100;
const STRUCTURED_HOST_OPERATION_EFFECT_KINDS = [
  "runtime.send",
  "runtime.steer",
  /* #1560. Startup already re-hosts a conversation holding a pending injection
     through the `recentOperations` status filter, which admits any kind but
     `kill`; this list is the other source and only diverges once an operation
     has aged out of that window. Keeping the two consistent is the point. */
  "runtime.inject",
  "runtime.interrupt",
  "runtime.answer",
  "runtime.spawn",
  "runtime.reconfigure",
  "runtime.compact",
] as const;

interface StructuredStartupSignals {
  hostedRunningConversationIds: ReadonlySet<string>;
  pendingOperationConversationIds: ReadonlySet<string>;
  pendingCodexContinuationConversationIds: ReadonlySet<string>;
  /** Every send or steer the runtime admitted, by canonical conversation: what
      tells an interruption obligation that someone else already resumed it. */
  admittedMessages: ReadonlyMap<string, readonly { idempotencyKey: string; at: number }[]>;
}

const TRANSCRIPT_REFRESH_CONCURRENCY = 16;
const INTERRUPTED_CODEX_CONTINUATION_OPERATION_PREFIX = "recovery-continuation";
/** Owed continuations older than this are retired unsent: a turn cut that
    long ago has been looked at by someone, and a paid turn resuming it now
    would act on a stale picture. */
const INTERRUPTION_OBLIGATION_MAX_AGE_MS = 24 * 3_600_000;

/** The turn a restart cut off, as the transcript recorded it. Captured once at
    boot and carried across startup retries so the message a seat receives never
    changes underneath its own delivery reservation. */
interface SeveredTurnEvidence {
  kind: TranscriptEventKind | null;
  at: number | null;
  /** The liveness decision's own words, for the startup log. */
  reason: string;
}

interface OrchestratorRestartRecoveryTarget {
  project: string;
  conversationId: ViewerConversationId;
  path: string;
  seatEpoch: number;
  hostKey: string;
  /** The process the registry recorded as owning the severed turn, and its
      turn: with the evidence below, the identity of the cut (#1835). */
  owner: ProcessIdentity | null;
  turnRef: string | null;
  claimEpoch: number;
  severed: SeveredTurnEvidence;
}

let retryOrchestratorRecoveries: OrchestratorRestartRecoveryTarget[] = [];

function mergeOrchestratorRestartRecoveries(
  retained: readonly OrchestratorRestartRecoveryTarget[],
  captured: readonly OrchestratorRestartRecoveryTarget[],
): OrchestratorRestartRecoveryTarget[] {
  const targets = new Map<string, OrchestratorRestartRecoveryTarget>();
  for (const target of [...retained, ...captured]) {
    const key = `${target.project}\0${target.seatEpoch}\0${target.hostKey}`;
    const previous = targets.get(key);
    /* The recapture wins on identity — a path can be rekeyed between passes —
       but the evidence stays the one that was captured before this boot's own
       host was adopted. It is what the message says, and a message whose text
       moved between retries would collide with its own delivery reservation. */
    targets.set(key, previous ? { ...target, severed: previous.severed } : target);
  }
  return [...targets.values()];
}

function rememberStructuredStartupRetry(
  registry: AgentRegistry,
  hosts: AdoptedStructuredHost[],
  recoveries: readonly OrchestratorRestartRecoveryTarget[],
): void {
  retryAdoptedHosts = hosts;
  const retainedHostKeys = new Set(hosts.map((item) => sessionKeyId(item.key)));
  retryOrchestratorRecoveries = recoveries.filter((target) => retainedHostKeys.has(target.hostKey));
  const pass = startupPasses.get(registry);
  if (pass) { pass.retained = hosts; pass.recoveries = retryOrchestratorRecoveries; }
}

/**
 * The seats a restart actually owes a message (#1276).
 *
 * The predicate used to be `structuredHost && host === null && (status ===
 * "live" || status === "idle")`, which is a status word twice over: `idle`
 * named a seat with nothing in flight, so every dormant project was re-hosted
 * and spent a paid turn answering "no change" on every redeploy. Neither word
 * is evidence, so this asks the evidence instead (#1281): the process the
 * registry recorded as owning the turn is gone, and the transcript leaves a
 * turn open — a turn that was genuinely in flight when the restart cut it off.
 * A seat whose transcript ends on a settled turn is owed nothing, gets no
 * message, and is not adopted, so no host is started for it either.
 */
async function orchestratorRestartRecoveryTargets(
  registry: AgentRegistry,
  seats = activeOrchestratorSeats(),
  snapshot: RegistryFile = registry.readOnlySnapshot(),
  dependencies: TurnLivenessDependencies = {},
): Promise<OrchestratorRestartRecoveryTarget[]> {
  const targets: OrchestratorRestartRecoveryTarget[] = [];
  for (const seat of seats) {
    if (!seat.conversationId?.startsWith("conversation_")) continue;
    const conversationId = registry.canonicalConversationId(seat.conversationId as ViewerConversationId);
    const conversation = snapshot.conversations[conversationId];
    const generation = conversation?.generations.at(-1);
    if (!conversation || !generation || conversation.supersededBy) continue;
    const hostKey = sessionKeyId({ engine: conversation.engine, sessionId: generation.id });
    const entry = snapshot.entries[hostKey];
    /* A pane-hosted seat is somebody else's transport; only a structured seat
       has a host this Viewer severed by restarting. */
    if (!entry?.structuredHost || entry.host !== null) continue;
    const liveness = await conversationTurnLiveness(registry, conversationId, { ...dependencies, snapshot });
    if (liveness?.state !== "severed" || liveness.turn !== "busy") continue;
    /* One line per seat this boot decided to resume, carrying the evidence it
       decided on: a nudge is a paid turn, so what bought it stays readable. */
    console.error("[structured hosts] resuming an orchestrator seat whose turn was severed", {
      project: seat.project,
      conversationId,
      evidence: liveness.reason,
    });
    targets.push({
      project: seat.project,
      conversationId,
      path: generation.path,
      seatEpoch: seat.seatEpoch,
      hostKey,
      owner: entry.structuredHost.process ? { ...entry.structuredHost.process } : null,
      turnRef: entry.structuredHost.activeTurnRef ?? null,
      claimEpoch: entry.claimEpoch,
      severed: { kind: liveness.lastEvent.kind, at: liveness.lastEvent.at, reason: liveness.reason },
    });
  }
  return targets;
}

/**
 * Whether a captured target still names the same seat, conversation, generation
 * and host row.
 *
 * Identity only: the severed judgement was made once, at boot, against the
 * evidence the restart left behind, and it cannot be re-asked here — this pass
 * adopts the host itself, so by the time it runs again the process is alive,
 * fresh, and would answer `unknown` on its own liveness. What must stay true is
 * that the target still points at what it was captured for.
 */
function orchestratorRestartRecoveryTargetIsCurrent(
  registry: AgentRegistry,
  target: OrchestratorRestartRecoveryTarget,
  seats: readonly OrchestratorSeat[],
  snapshot: RegistryFile = registry.readOnlySnapshot(),
): boolean {
  const seat = seats.find((candidate) => candidate.project === target.project);
  if (!seat
    || seat.state !== "active"
    || seat.seatEpoch !== target.seatEpoch
    || !seat.conversationId?.startsWith("conversation_")
    || registry.canonicalConversationId(seat.conversationId as ViewerConversationId) !== target.conversationId) return false;
  const conversation = snapshot.conversations[target.conversationId];
  const generation = conversation?.generations.at(-1);
  if (!conversation
    || !generation
    || conversation.supersededBy
    || generation.path !== target.path
    || sessionKeyId({ engine: conversation.engine, sessionId: generation.id }) !== target.hostKey) return false;
  const entry = snapshot.entries[target.hostKey];
  return Boolean(entry?.structuredHost
    && entry.host === null
    && (entry.status === "live" || entry.status === "idle"));
}

function currentOrchestratorRestartRecoveryHostKeys(
  registry: AgentRegistry,
  targets: readonly OrchestratorRestartRecoveryTarget[],
  seats: readonly OrchestratorSeat[],
  snapshot: RegistryFile = registry.readOnlySnapshot(),
): Set<string> {
  return new Set(targets
    .filter((target) => orchestratorRestartRecoveryTargetIsCurrent(registry, target, seats, snapshot))
    .map((target) => target.hostKey));
}

function orchestratorRestartRecoveriesByHostKey(
  targets: readonly OrchestratorRestartRecoveryTarget[],
): Map<string, OrchestratorRestartRecoveryTarget[]> {
  const byHostKey = new Map<string, OrchestratorRestartRecoveryTarget[]>();
  for (const target of targets) {
    const existing = byHostKey.get(target.hostKey) ?? [];
    existing.push(target);
    byHostKey.set(target.hostKey, existing);
  }
  return byHostKey;
}

/** A seat this boot found severed is owed the same durable continuation a
    release records (#1835): keyed by the cut itself, so a successor boot that
    finds the same severed turn lands on the same record and the same delivery
    key, and a cut the release already recorded is not recorded twice. */
function recordOrchestratorRestartObligations(
  store: InterruptionObligationStore,
  targets: readonly OrchestratorRestartRecoveryTarget[],
): void {
  for (const target of targets) {
    store.record({
      conversationId: target.conversationId,
      engine: target.hostKey.startsWith("claude:") ? "claude" : "codex",
      hostKey: target.hostKey,
      path: target.path,
      owner: target.owner ? { pid: target.owner.pid, startIdentity: target.owner.startIdentity } : null,
      claimEpoch: target.claimEpoch,
      turnRef: target.turnRef,
      boundary: `viewer-restart:${target.severed.at ?? "unrecorded"}`,
      reason: "viewer-restart",
      checkpoint: { lastEventKind: target.severed.kind, lastEventAt: target.severed.at },
      seat: { project: target.project, seatEpoch: target.seatEpoch },
    });
  }
}

/**
 * Why an unresolved obligation is no longer owed, or null while it still is.
 *
 * Identity first: the conversation, its generation's host row and — for a
 * seat — the seat itself must still be what was cut. Then evidence that the
 * turn was already taken up: a message admitted for the conversation after the
 * cut, by an operator or a controller, resumed it, so a continuation now would
 * be a second prompt. Provider bookkeeping written into the transcript on
 * resume (a replayed continuation, a synthetic no-response) is not admitted
 * work and is never read here.
 */
function interruptionObligationDischarge(
  registry: AgentRegistry,
  obligation: InterruptionObligation,
  snapshot: RegistryFile,
  seats: readonly OrchestratorSeat[],
  admittedMessages: StructuredStartupSignals["admittedMessages"],
  settledStageConversationIds: ReadonlySet<string>,
  now = Date.now(),
): string | null {
  const conversationId = registry.canonicalConversationId(obligation.conversationId);
  const conversation = snapshot.conversations[conversationId];
  const generation = conversation?.generations.at(-1);
  if (!conversation || !generation) return "the conversation no longer exists";
  if (conversation.supersededBy) return "the conversation was superseded";
  if (sessionKeyId({ engine: conversation.engine, sessionId: generation.id }) !== obligation.hostKey) {
    return "the conversation moved to another generation";
  }
  if (obligation.seat) {
    const seat = seats.find((candidate) => candidate.project === obligation.seat!.project);
    if (!seat
      || seat.state !== "active"
      || seat.seatEpoch !== obligation.seat.seatEpoch
      || !seat.conversationId?.startsWith("conversation_")
      || registry.canonicalConversationId(seat.conversationId as ViewerConversationId) !== conversationId) {
      return "the orchestrator seat was rotated";
    }
  }
  if (settledStageConversationIds.has(conversationId)) return "its pipeline stage is already settled";
  const recordedAt = Date.parse(obligation.recordedAt);
  if (now - recordedAt > INTERRUPTION_OBLIGATION_MAX_AGE_MS) return "the interruption is too old to resume unattended";
  /* An admitted continuation is replayed under its own key until it reports
     arrival; a later message cannot un-send it. */
  if (obligation.state !== "owed") return null;
  const newerHeld = Object.values(snapshot.heldDeliveries).some((delivery) =>
    registry.canonicalConversationId(delivery.conversationId) === conversationId
      && delivery.clientMessageId !== obligation.id
      && Date.parse(delivery.createdAt) > recordedAt);
  const newerAdmitted = (admittedMessages.get(conversationId) ?? []).some((message) =>
    message.idempotencyKey !== obligation.id && message.at > recordedAt);
  return newerHeld || newerAdmitted ? "a newer message already resumed the conversation" : null;
}

/**
 * Settles each `submitted` obligation from the delivery its continuation was
 * admitted as: arrival or refusal of that reservation is the obligation's own.
 *
 * The queue reports a first admission as queued; nothing in that send comes
 * back to say it arrived, so a later boot is where it is read. A reservation
 * whose row is gone was compacted after it settled — compaction drops only
 * settled rows — so the continuation went out and is never sent again: a
 * replay under its key would find no reservation to answer it and mint a
 * second one. Returns what stays unresolved.
 */
function settleSubmittedInterruptionObligations(
  registry: AgentRegistry,
  store: InterruptionObligationStore,
  obligations: readonly InterruptionObligation[],
): InterruptionObligation[] {
  const snapshot = registry.readOnlySnapshot();
  const unresolved: InterruptionObligation[] = [];
  for (const obligation of obligations) {
    const outcome = obligation.state === "submitted"
      ? submittedContinuationOutcome(obligation, snapshot, (id) => registry.canonicalConversationId(id))
      : null;
    if (!outcome) {
      unresolved.push(obligation);
      continue;
    }
    store.update(obligation.id, { state: outcome.state, resolvedAt: outcome.at ?? new Date().toISOString(), resolution: outcome.resolution });
  }
  return unresolved;
}

function dischargeInterruptionObligations(
  registry: AgentRegistry,
  store: InterruptionObligationStore,
  obligations: readonly InterruptionObligation[],
  seats: readonly OrchestratorSeat[],
  admittedMessages: StructuredStartupSignals["admittedMessages"],
  settledStageConversationIds: ReadonlySet<string>,
): InterruptionObligation[] {
  const snapshot = registry.readOnlySnapshot();
  const owed: InterruptionObligation[] = [];
  for (const obligation of obligations) {
    const reason = interruptionObligationDischarge(
      registry, obligation, snapshot, seats, admittedMessages, settledStageConversationIds,
    );
    if (reason === null) {
      owed.push(obligation);
      continue;
    }
    store.update(obligation.id, { state: "discharged", resolvedAt: new Date().toISOString(), resolution: reason });
    console.error("[structured hosts] interrupted turn needs no continuation", {
      conversationId: obligation.conversationId, obligation: obligation.id, reason,
    });
  }
  return owed;
}

/**
 * Delivers the one continuation each still-owed obligation is owed (#1835).
 *
 * Only through a host this pass published, and only once the process that
 * owned the cut turn no longer owns the row: a survivor the release could not
 * stop keeps the obligation owed until adoption has taken the row from it.
 * The obligation id is the delivery's client message id, so a retry, a
 * replay after an unknown outcome, and a successor boot all converge on one
 * reservation; the queue answers a repeat with the delivery it already made.
 */
async function deliverInterruptionContinuations(
  registry: AgentRegistry,
  client: RuntimeHostClient,
  store: InterruptionObligationStore,
  obligations: readonly InterruptionObligation[],
  publishedHostKeys: ReadonlySet<string>,
): Promise<string[]> {
  const failures: string[] = [];
  for (const obligation of obligations) {
    if (!publishedHostKeys.has(obligation.hostKey)) continue;
    const snapshot = registry.readOnlySnapshot();
    const recorded = snapshot.entries[obligation.hostKey]?.structuredHost?.process ?? null;
    if (obligation.owner && recorded
      && recorded.pid === obligation.owner.pid
      && recorded.startIdentity === obligation.owner.startIdentity) continue;
    const conversation = snapshot.conversations[registry.canonicalConversationId(obligation.conversationId)];
    const generation = conversation?.generations.at(-1);
    if (!conversation || !generation) continue;
    const result = await enqueueStructuredMessage({
      path: generation.path,
      conversationId: conversation.id,
      clientMessageId: obligation.id,
      text: interruptionContinuationText(obligation),
      images: [],
      origin: RECOVERY_NOTICE_ORIGIN,
    }, {
      enabled: () => true,
      client: () => client,
      registry: () => registry,
      interruptionContinuation: true,
    });
    if (result?.ok) {
      store.update(obligation.id, {
        state: result.outcome === "delivered" ? "delivered" : "submitted",
        operationId: result.operationId,
        attempts: obligation.attempts + 1,
        ...(result.outcome === "delivered" ? { resolvedAt: new Date().toISOString(), resolution: "delivered" } : {}),
      });
      continue;
    }
    const error = result?.error ?? "structured delivery unavailable";
    const status = result?.status ?? 503;
    console.error("[structured hosts] interrupted turn continuation was not admitted", {
      conversationId: obligation.conversationId, obligation: obligation.id, status, error,
    });
    /* A refusal the queue will repeat for this key forever is final; anything
       else — an unavailable host, an outcome nobody saw — keeps the obligation
       owed under the same key for the next pass. */
    if (status === 409 && !result?.transportUncertain) {
      store.update(obligation.id, {
        state: "failed", attempts: obligation.attempts + 1, resolvedAt: new Date().toISOString(), resolution: error,
      });
      continue;
    }
    store.update(obligation.id, { attempts: obligation.attempts + 1 });
    failures.push(`${obligation.conversationId}: ${error}`);
  }
  return failures;
}

/**
 * Every host this pass started has to be resolvable before the pass reports
 * success (#1282).
 *
 * A launch that nothing claims is the worst shape this file can produce: the
 * process exists, holds its stdin and its memory, and reads `live` to every
 * consumer, while no owner can ever write a turn into it. Publication runs over
 * the runtime-host socket, so a control-plane seam — a successor generation
 * between the predecessor's last byte and its own listener — can leave a
 * registration uncommitted. Throwing here keeps the hosts in the startup retry
 * set, which re-registers them on the next pass; the alternative is the silence
 * that produced a host parked in `epoll_wait` for half an hour.
 */
function assertAdoptedHostsAreClaimed(
  adopted: readonly AdoptedStructuredHost[],
  claimed: (key: SessionKey) => boolean = hasStructuredDeliveryHost,
): void {
  const unclaimed = adopted.filter((item) => !claimed(item.key));
  if (unclaimed.length === 0) return;
  const keys = unclaimed.map((item) => sessionKeyId(item.key));
  console.error("[structured hosts] adopted hosts were left unclaimed by the delivery controller", { keys });
  throw Object.assign(new RuntimeHostUnavailableError(
    `structured delivery controller did not claim ${unclaimed.length} adopted host(s): ${keys.join(", ")}`,
  ), { hostKey: keys[0] });
}

/** Every row selected before adoption must end the pass with a host published
    by this Viewer or cease to be eligible. The durable target appoints the
    candidate before the incumbent's demotion poll releases its engines. A
    candidate that reaches adoption in that window sees the old live process
    and must retry until demotion records and completes the handoff (#1296).

    Only a live recorded engine process argues that window is open. A row whose
    process is gone or already released has nothing left to hand over — its
    adoption attempt ran this pass and produced nothing, and rows with
    permanently pending work (a held delivery for a dead session) stay in that
    shape forever. Failing the pass for them replays full startup every minute
    without end (#1364); their work waits for on-demand hosting instead. */
function assertEligibleHostsResolved(
  registry: AgentRegistry,
  shouldAdopt: StructuredHostAdoptionFilter,
  adopted: readonly AdoptedStructuredHost[],
  productionAdopter: (key: SessionKey) => boolean,
  claimed: (key: SessionKey) => boolean = hasStructuredDeliveryHost,
  processAlive: (identity: ProcessIdentity) => boolean = processIdentityMayOwn,
): void {
  const adoptedKeys = new Set(adopted.map((item) => sessionKeyId(item.key)));
  const unresolved = Object.values(registry.readOnlySnapshot().entries).filter((entry) =>
    entry.structuredHost
      && productionAdopter(entry.key)
      && shouldAdopt(entry)
      && !adoptedKeys.has(sessionKeyId(entry.key))
      && !claimed(entry.key));
  if (unresolved.length === 0) return;
  const contested = unresolved.filter((entry) => {
    const process = entry.structuredHost?.process;
    return Boolean(process && processAlive(process));
  });
  const abandoned = unresolved.filter((entry) => !contested.includes(entry));
  if (abandoned.length > 0) {
    console.error("[structured hosts] eligible hosts have no live engine process to hand over; leaving them to on-demand hosting", {
      keys: abandoned.map((entry) => sessionKeyId(entry.key)),
    });
  }
  if (contested.length === 0) return;
  const keys = contested.map((entry) => sessionKeyId(entry.key));
  console.error("[structured hosts] eligible hosts remain owned by the incumbent Viewer; retrying startup", { keys });
  throw Object.assign(new RuntimeHostUnavailableError(
    `structured startup left ${keys.length} eligible host(s) owned by the incumbent Viewer: ${keys.join(", ")}`,
  ), { hostKey: keys[0] });
}

function interruptedCodexContinuationOperationId(sessionId: string, claimEpoch: number): string {
  return `${INTERRUPTED_CODEX_CONTINUATION_OPERATION_PREFIX}-${sessionId}-${claimEpoch}`;
}

function interruptedCodexConversations(
  registry: AgentRegistry,
  shouldAdopt: StructuredHostAdoptionFilter,
  runtimeRunningConversationIds: ReadonlySet<string>,
  unreadableTranscriptHostKeys: ReadonlySet<string>,
  snapshot: RegistryFile = registry.readOnlySnapshot(),
): ReadonlyMap<string, ViewerConversationId> {
  return new Map(Object.values(snapshot.conversations).flatMap((conversation) => {
    const generation = conversation.generations.at(-1);
    if (conversation.engine !== "codex" || !generation) return [];
    const key = { engine: "codex" as const, sessionId: generation.id };
    const entry = snapshot.entries[sessionKeyId(key)];
    /* A continuation is a paid turn spent telling a seat to resume something.
       When this boot could not read the transcript at all, the word on the row
       is the only thing left saying there is anything to resume — and it is
       inherited from whoever wrote it last, so it says that just as loudly for
       a turn that ended hours ago (#1281). No current evidence, no nudge. */
    if (unreadableTranscriptHostKeys.has(sessionKeyId(key))) return [];
    const interrupted = conversation.turn.state === "busy"
      || (conversation.turn.state === "unknown"
        && (Boolean(entry?.structuredHost?.activeTurnRef)
          || runtimeRunningConversationIds.has(registry.canonicalConversationId(conversation.id))));
    return interrupted && entry?.structuredHost && shouldAdopt(entry)
      ? [[sessionKeyId(key), conversation.id] as const]
      : [];
  }));
}

async function enqueueInterruptedCodexContinuations(
  registry: AgentRegistry,
  client: RuntimeHostClient,
  adopted: readonly AdoptedCodexHost[],
  interrupted: ReadonlyMap<string, ViewerConversationId>,
  existingByKey: ReadonlyMap<string, RuntimeOperationResult>,
  pendingContinuationConversationIds: ReadonlySet<string>,
): Promise<void> {
  for (const item of adopted) {
    const key = sessionKeyId(item.key);
    const conversationId = interrupted.get(key);
    if (!conversationId) continue;
    if (pendingContinuationConversationIds.has(conversationId)) continue;
    const entry = registry.readOnlySnapshot().entries[key];
    if (!entry) throw new Error(`adopted Codex registry row disappeared: ${key}`);
    const operationId = interruptedCodexContinuationOperationId(item.key.sessionId, entry.claimEpoch);
    const existing = existingByKey.get(key);
    if (existing) {
      if (existing.receipt.status === "failed" || existing.receipt.status === "rejected") {
        if (!existing.receipt.retryOfOperationId) {
          await client.retryOperation(
            existing.operationId,
            `${existing.receipt.idempotencyKey}-retry-1`,
            { requireHostedConversationId: conversationId },
          );
        }
        continue;
      }
      if (existing.operationId === operationId
        || existing.receipt.status !== "delivered"
        || existing.receipt.retryOfOperationId) continue;
    }
    await client.command({
      kind: "send",
      operationId,
      idempotencyKey: operationId,
      conversationId,
      text: INTERRUPTED_CODEX_CONTINUATION_TEXT,
      policy: "queue",
      turnId: null,
      origin: RECOVERY_NOTICE_ORIGIN,
    });
  }
}

async function interruptedCodexContinuations(
  registry: AgentRegistry,
  client: RuntimeHostClient,
  adopted: readonly AdoptedCodexHost[],
): Promise<ReadonlyMap<string, RuntimeOperationResult>> {
  const existingByKey = new Map<string, RuntimeOperationResult>();
  await forEachStartupBatch(adopted, async (item) => {
    const key = sessionKeyId(item.key);
    const entry = registry.readOnlySnapshot().entries[key];
    if (!entry) return;
    const current = await client.operationStatus(
      interruptedCodexContinuationOperationId(item.key.sessionId, entry.claimEpoch),
      { currentRetryLeaf: true },
    );
    if (current) {
      existingByKey.set(key, current);
      return;
    }
    if (entry.claimEpoch <= 0) return;
    const previous = await client.operationStatus(
      interruptedCodexContinuationOperationId(item.key.sessionId, entry.claimEpoch - 1),
      { currentRetryLeaf: true },
    );
    if (previous) existingByKey.set(key, previous);
  });
  return existingByKey;
}

function persistedTurnState(
  records: Record<string, unknown>[],
  engine: "codex" | "claude" | "copilot",
  prefixTruncated: boolean,
) {
  if (engine === "claude" || engine === "copilot") return turnStateFromRecords(records, engine);
  if (!prefixTruncated) return turnStateFromRecords(records, "codex", true);

  const turnStartIndex = records.findLastIndex((record) => {
    const payload = record.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const type = (payload as Record<string, unknown>).type;
    return type === "task_started" || type === "turn_started" || type === "user_message";
  });
  if (turnStartIndex < 0) {
    const turn = turnStateFromRecords(records, "codex", true);
    return turn.state === "terminal"
      ? { state: "unknown" as const, source: "empty" as const, terminalAt: null }
      : turn;
  }
  return turnStateFromRecords(records.slice(turnStartIndex), "codex", true);
}

/**
 * Reconciles what the transcripts on disk currently say, and reports the live
 * conversations whose transcript this boot could not read.
 *
 * The second half is load-bearing (#1281). A tail read that comes back
 * `uncertain` — corrupt JSON, a record truncated mid-write, a file that grew
 * under the read, a path that is missing or unreadable — makes no observation,
 * so the conversation keeps whatever turn word the last writer left on the row.
 * That word then decided both whether to launch a host for the row and whether
 * to tell it to continue, which is a status word deciding a paid turn on a
 * transcript nobody in this process has managed to read.
 */
async function refreshStructuredTranscriptState(
  registry: AgentRegistry,
  assertActive: () => void = () => {},
  lastEventByHost: Map<string, number | null> = new Map(),
  hostKeys: ReadonlySet<string> | null = null,
): Promise<ReadonlySet<string>> {
  const snapshot = registry.readOnlySnapshot();
  const observedAt = new Date().toISOString();
  const candidates = Object.values(snapshot.conversations).flatMap((conversation) => {
    const generation = conversation.generations.at(-1);
    if (!generation) return [];
    const hostKey = sessionKeyId({ engine: conversation.engine, sessionId: generation.id });
    const entry = snapshot.entries[hostKey];
    return (!hostKeys || hostKeys.has(hostKey)) && entry?.structuredHost && entry.status === "live" && !conversation.supersededBy
      ? [{ conversation, generation, hostKey }]
      : [];
  });
  const observations: Parameters<AgentRegistry["reconcileConversations"]>[0] = [];
  const unreadable = new Set<string>();
  let nextCandidate = 0;
  const workers = Array.from(
    { length: Math.min(TRANSCRIPT_REFRESH_CONCURRENCY, candidates.length) },
    async () => {
      while (nextCandidate < candidates.length) {
        const candidate = candidates[nextCandidate++];
        if (!candidate) continue;
        const { conversation, generation, hostKey } = candidate;
        const tail = await readStableTailRecords(generation.path);
        lastEventByHost.set(hostKey, tail.integrity === "complete"
          ? transcriptEvidenceFromRecords(tail.records, conversation.engine, null).lastEventAt
          : null);
        if (tail.integrity !== "complete") {
          unreadable.add(hostKey);
          continue;
        }
        const turn = persistedTurnState(tail.records, conversation.engine, tail.prefixTruncated);
        if (turn.state !== "busy" && turn.state !== "terminal") continue;
        observations.push({
          engine: conversation.engine,
          path: generation.path,
          accountId: generation.accountId,
          launchProfile: generation.launchProfile,
          turn,
          expectedTurnObservedAt: conversation.turn.observedAt,
          observedAt,
        });
      }
    },
  );
  await Promise.all(workers);
  assertActive();
  if (observations.length > 0) registry.reconcileConversations(observations);
  return unreadable;
}

function canonicalConversationId(registry: AgentRegistry, conversationId: string): string {
  return conversationId.startsWith("conversation_")
    ? registry.canonicalConversationId(conversationId as ViewerConversationId)
    : conversationId;
}

/** Every send or steer the runtime snapshot shows admitted, by canonical
    conversation. */
function admittedRuntimeMessages(
  registry: AgentRegistry,
  runtime: Pick<Awaited<ReturnType<RuntimeHostClient["snapshot"]>>, "sessions" | "recentOperations">,
): StructuredStartupSignals["admittedMessages"] {
  const admittedMessages = new Map<string, { idempotencyKey: string; at: number }[]>();
  for (const receipt of [...runtime.recentOperations, ...runtime.sessions.flatMap((session) => session.recentReceipts ?? [])]) {
    if (receipt.kind !== "send" && receipt.kind !== "steer") continue;
    const at = Date.parse(receipt.admittedAt ?? receipt.at);
    if (!Number.isFinite(at)) continue;
    const conversationId = canonicalConversationId(registry, receipt.conversationId);
    const messages = admittedMessages.get(conversationId) ?? [];
    messages.push({ idempotencyKey: receipt.idempotencyKey, at });
    admittedMessages.set(conversationId, messages);
  }
  return admittedMessages;
}

/** The conversations whose runtime evidence a startup decision can read. The
    signals gate only a row whose current entry has a structured host, and
    admitted messages settle only the obligations this pass holds; every
    registry spelling of such a conversation is read, because receipts are
    matched by canonical id. The rest of the retained history is a read per
    conversation that no decision consumes. */
function startupRuntimeConversationIds(
  registry: AgentRegistry,
  owedConversationIds: ReadonlySet<string>,
  snapshot: RegistryFile = registry.readOnlySnapshot(),
): string[] {
  return Object.values(snapshot.conversations).flatMap((conversation) => {
    // Resolved against the snapshot in hand: one keyed transaction per retained conversation is the cost avoided here.
    const canonicalId = resolveConversationAlias(snapshot, conversation.id);
    if (owedConversationIds.has(canonicalId)) return [conversation.id];
    const canonical = snapshot.conversations[canonicalId] ?? conversation;
    const generation = canonical.generations.at(-1);
    return generation && snapshot.entries[sessionKeyId({ engine: canonical.engine, sessionId: generation.id })]?.structuredHost
      ? [conversation.id]
      : [];
  });
}

async function readStartupRuntime(
  registry: AgentRegistry,
  client: RuntimeHostClient,
  conversationIds: readonly string[],
): Promise<Pick<Awaited<ReturnType<RuntimeHostClient["snapshot"]>>, "sessions" | "recentOperations">> {
  // Compatibility with older embedders; the production client has session-read.
  if (!client.readSession) return client.snapshot(undefined, { timeoutMs: STARTUP_READ_TIMEOUT_MS });
  const sessions: RuntimeSession[] = [];
  await forEachStartupBatch(conversationIds, async (conversationId) => {
    const session = await client.readSession!({ conversationId }, { timeoutMs: STARTUP_READ_TIMEOUT_MS });
    if (session) sessions.push(session);
  });
  return { sessions, recentOperations: sessions.flatMap((session) => session.recentReceipts ?? []) };
}

async function structuredStartupSignals(
  registry: AgentRegistry,
  client: RuntimeHostClient | null,
  owedConversationIds: ReadonlySet<string> = new Set(),
): Promise<StructuredStartupSignals> {
  if (!client) {
    return {
      hostedRunningConversationIds: new Set(),
      pendingOperationConversationIds: new Set(),
      pendingCodexContinuationConversationIds: new Set(),
      admittedMessages: new Map(),
    };
  }
  const runtime = await readStartupRuntime(registry, client, startupRuntimeConversationIds(registry, owedConversationIds));
  /* #1846: an account pick waits for the conversation's next engagement, so on its own it is no work that
     needs a host at startup. Its message, once there is one, is. */
  const waitingSwitches = new Set<string>();
  const hostedRunningConversationIds = new Set(runtime.sessions
    .filter((session) => session.host === "hosted"
      && (session.turn === "running" || session.turn === "interrupt_requested"))
    .map((session) => canonicalConversationId(registry, session.conversationId)));
  const pendingOperationConversationIds = new Set<string>();
  const pendingCodexContinuationConversationIds = new Set<string>();
  const admittedMessages = admittedRuntimeMessages(registry, runtime);
  let afterEventSeq = 0;
  while (true) {
    const batch = await client.effectBatch(STRUCTURED_HOST_OPERATION_EFFECT_KINDS, afterEventSeq);
    for (const effect of batch) {
      const conversationId = effect.payload.conversationId;
      if (effect.kind === "runtime.reconfigure"
        && typeof effect.payload.accountId === "string"
        && typeof effect.payload.operationId === "string") {
        waitingSwitches.add(effect.payload.operationId);
        continue;
      }
      if (typeof conversationId === "string") {
        const canonicalId = canonicalConversationId(registry, conversationId);
        pendingOperationConversationIds.add(canonicalId);
        if (effect.kind === "runtime.send"
          && typeof effect.payload.operationId === "string"
          && effect.payload.operationId.startsWith(`${INTERRUPTED_CODEX_CONTINUATION_OPERATION_PREFIX}-`)) {
          pendingCodexContinuationConversationIds.add(canonicalId);
        }
      }
    }
    if (batch.length < RUNTIME_EFFECT_PAGE_SIZE) break;
    const next = Math.max(...batch.map((effect) => effect.eventSeq));
    if (!Number.isSafeInteger(next) || next <= afterEventSeq) {
      throw new Error("structured startup operation page did not advance");
    }
    afterEventSeq = next;
  }
  for (const receipt of runtime.recentOperations) {
    if (receipt.status !== "pending" && receipt.status !== "queued" && receipt.status !== "delivering" && receipt.status !== "applying") continue;
    if (receipt.kind === "kill") continue;
    if (receipt.kind === "reconfigure" && receipt.status !== "applying" && waitingSwitches.has(receipt.operationId)) continue;
    pendingOperationConversationIds.add(canonicalConversationId(registry, receipt.conversationId));
  }
  return {
    hostedRunningConversationIds,
    pendingOperationConversationIds,
    pendingCodexContinuationConversationIds,
    admittedMessages,
  };
}

/** Like LLV_HOST_RETIREMENT_IDLE_HOURS, this bounds speculative host residency.
    Owed work and severed seats bypass this window. Invalid values use six hours. */
function startupTurnMaxAgeMs(): number {
  const hours = Number(process.env.LLV_HOST_ADOPTION_MAX_TURN_AGE_HOURS ?? 6);
  return (Number.isFinite(hours) && hours > 0 ? hours : 6) * 3_600_000;
}

async function structuredStartupAdoptionFilter(
  registry: AgentRegistry,
  signals: StructuredStartupSignals,
  snapshot: RegistryFile = registry.readOnlySnapshot(),
  orchestratorRecoveries: ReadonlyMap<string, readonly OrchestratorRestartRecoveryTarget[]> = new Map(),
  orchestratorSeats: () => OrchestratorSeat[] = activeOrchestratorSeats,
  unreadableTranscriptHostKeys: ReadonlySet<string> = new Set(),
  settledStageConversationIds: ReadonlySet<string> = new Set(),
  deferredStageConversationIds: ReadonlySet<string> = new Set(),
  lastEventByHost: Map<string, number | null> = new Map(),
  interruptedHostKeys: ReadonlySet<string> = new Set(),
): Promise<StructuredHostAdoptionFilter> {
  const conversationsByCurrentEntry = new Map(Object.values(snapshot.conversations).flatMap((conversation) => {
    const generation = conversation.generations.at(-1);
    return generation
      ? [[sessionKeyId({ engine: conversation.engine, sessionId: generation.id }), conversation] as const]
      : [];
  }));
  const pendingDeliveryConversationIds = new Set(Object.values(snapshot.heldDeliveries)
    .filter((delivery) => delivery.state === "held"
      || delivery.state === "assigned"
      || delivery.state === "delivery-uncertain")
    .map((delivery) => registry.canonicalConversationId(delivery.conversationId)));
  // Reuse the refresh's bounded read across both adoption and publication.
  // An injected refresh or a newly registered host may not have supplied it.
  for (const [key, conversation] of conversationsByCurrentEntry) {
    const entry = snapshot.entries[key];
    if (entry?.status !== "live" || !entry.structuredHost || conversation.supersededBy || lastEventByHost.has(key)) continue;
    const evidence = await readTranscriptEvidence(conversation.engine, conversation.generations.at(-1)!.path);
    lastEventByHost.set(key, evidence.lastEventAt);
  }
  const now = Date.now();
  const maxAgeMs = startupTurnMaxAgeMs();
  const loggedRefusals = new Set<string>();
  return (entry) => {
    const conversation = conversationsByCurrentEntry.get(sessionKeyId(entry.key));
    if (!conversation) return false;
    /* A superseded conversation is terminal (issue #383): a boot can never
       revive a retired round, held work or not — the successor owns it. */
    if (conversation.supersededBy) return false;
    if (deferredStageConversationIds.has(registry.canonicalConversationId(conversation.id))) return false;
    /* A turn a release or restart cut is owed its continuation whatever the
       transcript now reads: provider bookkeeping written on the way down can
       close the turn on disk without anyone having resumed it (#1835). */
    if (interruptedHostKeys.has(sessionKeyId(entry.key))
      && (entry.status === "live" || entry.status === "idle")) return true;
    const orchestratorRecoveryTargets = orchestratorRecoveries.get(sessionKeyId(entry.key));
    if (orchestratorRecoveryTargets?.some((target) =>
      orchestratorRestartRecoveryTargetIsCurrent(registry, target, orchestratorSeats()))) {
      return true;
    }
    const conversationId = registry.canonicalConversationId(conversation.id);
    const hasPendingWork = pendingDeliveryConversationIds.has(conversationId)
      || signals.pendingOperationConversationIds.has(conversationId)
      || entry.pendingAction === "handoff";
    if (hasPendingWork) return true;
    if (conversation.turn.state === "terminal") return false;
    /* A stage attempt the pipeline has already settled has no controller
       left to drive it: no verdict will be accepted and no next stage will
       spawn, so re-hosting it on the strength of its turn claim alone starts
       an agent the product runs but will not listen to (#1501). Work owed to
       it — a held delivery, a pending operation — was answered above and
       still hosts it; the turn claim by itself does not. */
    if (settledStageConversationIds.has(conversationId)) return false;
    /* Past this point the only thing left arguing for a launch is the turn the
       row claims is unfinished. When this boot could not read the transcript,
       that claim rests on a word nothing has confirmed since the last writer
       left it, so it starts a CLI process — and, for Codex, a continuation
       nudge — for a turn that may have ended long ago (#1281). Work that is
       actually owed still wins: a held delivery or a pending operation is
       evidence in its own right, and both were answered above. Refusing the
       launch is the whole of it: the row itself is held out of the demotion
       below, so unreadable evidence retires nothing either. */
    if (unreadableTranscriptHostKeys.has(sessionKeyId(entry.key))) return false;
    const runtimeHostedRunning = signals.hostedRunningConversationIds.has(conversationId);
    const unfinishedTurn = conversation.turn.state === "busy"
      || Boolean(entry.structuredHost?.activeTurnRef)
      || (entry.status === "live" && runtimeHostedRunning);
    /* Runtime snapshots survive host epochs. A stale hosted/running row cannot
       resurrect an idle or dead registry host by itself; the registry's live
       process evidence remains the startup liveness gate. */
    const liveHost = entry.status === "live";
    if (!liveHost || !unfinishedTurn) return false;
    const key = sessionKeyId(entry.key);
    const lastEventAt = lastEventByHost.get(key) ?? null;
    const ageMs = lastEventAt === null ? null : Math.max(0, now - lastEventAt);
    if (ageMs !== null && ageMs <= maxAgeMs) return true;
    if (!loggedRefusals.has(key)) {
      console.warn("[structured hosts] refusing stale turn-claim adoption", { key, ageMs, maxAgeMs });
      loggedRefusals.add(key);
    }
    return false;
  };
}

const SETTLED_STAGE_ATTEMPT_STATES = new Set(["passed", "failed", "needs_decision", "skipped"]);

interface PipelineStartupEvidence {
  settled: ReadonlySet<string>;
  deferred: ReadonlySet<string>;
}

/** Pipeline attempts and frozen close hosts determine whether startup may create another writer.
    A failed read retains pipeline members without launch or demotion; a
    captured survivor blocks even pending work until its identity is dead. */
function pipelineStartupEvidence(registry: AgentRegistry, available = true): PipelineStartupEvidence {
  const settled = new Set<string>();
  const deferred = new Set<string>();
  let pipelines;
  try {
    if (!available) throw new Error("pipeline admission authority is unavailable");
    pipelines = loadPipelinesForStartup();
  } catch (error) {
    console.error("[structured hosts] pipeline registry unreadable; deferring pipeline adoption", {
      error: error instanceof Error ? error.message : String(error),
    });
    for (const [id, memberships] of Object.entries(registry.readOnlySnapshot().memberships)) {
      if (memberships.some((membership) => membership.kind === "pipeline")) {
        deferred.add(registry.canonicalConversationId(id as ViewerConversationId));
      }
    }
    return { settled, deferred };
  }
  const memberships = registry.readOnlySnapshot().memberships;
  for (const pipeline of pipelines) {
    const attempts = pipeline.runs.flatMap((run) => run.attempts);
    const evidence = [...attempts, ...(pipeline.closeTeardown?.hosts ?? []).map((host) => host.evidence)];
    const blocked = evidence.some((host) => host.unresolvedTermination?.survivors
      .some((identity) => processIdentityStatus(identity) !== "dead"));
    // Reviewer synchronization can move survivors off the current attempt
    // into frozen close custody. Either record fences every pipeline writer.
    // Memberships also retain conversations absent from an older attempt row.
    if (blocked) {
      for (const [id, entries] of Object.entries(memberships)) {
        if (entries.some((entry) => entry.kind === "pipeline" && entry.containerId === pipeline.id)) {
          deferred.add(registry.canonicalConversationId(id as ViewerConversationId));
        }
      }
    }
    for (const run of pipeline.runs) {
      for (const attempt of run.attempts) {
        if (!attempt.conversationId?.startsWith("conversation_")) continue;
        const id = registry.canonicalConversationId(attempt.conversationId as ViewerConversationId);
        if (SETTLED_STAGE_ATTEMPT_STATES.has(attempt.state)) settled.add(id);
        if (blocked) {
          deferred.add(id);
        }
      }
    }
  }
  return { settled, deferred };
}

export interface StructuredStartupDependencies {
  /** Release retirement stops at awaited phase boundaries. */
  assertActive?: () => void;
  registry?: AgentRegistry;
  client?: RuntimeHostClient | null;
  /** Observe complete lease holds, including state loading and release. */
  observeLeaseHold?: (heldMs: number) => void;
  /** Process and transcript readers behind the restart-recovery evidence. */
  liveness?: TurnLivenessDependencies;
  /** Whether the delivery controller resolves a host this pass adopted. */
  hostClaimed?: (key: SessionKey) => boolean;
  /** Settled stages and conversations deferred by unavailable pipeline state
      or unresolved survivors. Defaults to reading active and archived records. */
  pipelineEvidence?: (registry: AgentRegistry) => PipelineStartupEvidence;
  /** Timer behind the deferred-evidence re-probe. Defaults to an unref'd
      setTimeout, so the re-probe never holds a Viewer that is shutting down. */
  schedule?: (callback: () => void, delayMs: number) => { unref?(): void };
  orchestratorSeats?: typeof activeOrchestratorSeats;
  /** Durable interruption obligations (#1835). Defaults to the directory
      beside the registry file. */
  interruptions?: InterruptionObligationStore;
  /** Reconciles transcript state, answering which conversations it could not
      read. A stub that answers nothing reports nothing unreadable. */
  refreshTranscriptState?: (registry: AgentRegistry) => Promise<ReadonlySet<string> | void>;
  adopt?: typeof adoptCodexRegistryHosts;
  adoptClaude?: typeof adoptClaudeRegistryHosts;
  resolveCodexOwner?: (entry: AgentRegistryEntry) => { home: string; kind: "legacy" | "managed" } | null;
  resolveClaudeOwner?: (entry: AgentRegistryEntry) => ClaudeStartupOwner | null;
}

/** The account a boot re-host resumes one Claude row under. */
export type ClaudeStartupOwner = {
  home: string;
  kind: "legacy" | "managed";
  transcriptRoot: string;
  env: NodeJS.ProcessEnv;
  claudeProvider?: { baseUrl: string; model: string; smallFastModel: string | null };
};

/**
 * The launch options a boot re-host hands the Claude broker for one row.
 *
 * Exported because the guarantee lives here rather than in the adopter. The
 * #1346 fix asserted the relaunched viewer connector against a hand-written
 * option object, so nothing ever ran this builder, and the managed-only
 * `claudeConfigDir` it used to answer went unseen until a legacy-owned seat
 * re-hosted across its own deploy came back with every `mcp__viewer__*` tool
 * retracted as `not_configured` (#1732). An owner of any kind now answers the
 * same launch paths a fresh spawn of that account would use.
 */
export function claudeStartupHostOptions(
  entry: AgentRegistryEntry,
  owner: ClaudeStartupOwner | null,
  capability: string | null,
  startupEnvironment: NodeJS.ProcessEnv,
) {
  const access = materializeStructuredHostAccess(
    structuredHostAccessPolicy(entry.launchProfile),
    withoutWakatimeCredential(owner?.env ?? startupEnvironment),
    capability,
  );
  /* No owner means no account answered for this transcript, so there is no
     home to read a server definition out of and none is invented here. */
  const launchPaths = owner ? claudeHostLaunchPaths(owner) : null;
  return {
    cwd: entry.cwd,
    claudeConfigDir: launchPaths?.claudeConfigDir,
    claudeProjectsDir: owner?.transcriptRoot,
    providerAccount: Boolean(owner?.claudeProvider),
    spawnPolicyBaseSettingsPath: launchPaths?.spawnPolicyBaseSettingsPath ?? null,
    allowSubagents: entry.launchProfile?.allowSubagents ?? false,
    mcpServers: entry.launchProfile?.mcpServers ?? ["viewer"],
    mcpStatePath: launchPaths?.mcpStatePath,
    readOnly: launchProfileEngineReadOnly(entry.launchProfile),
    restricted: entry.launchProfile?.sandbox === "restricted",
    env: access.env,
    ...access.host,
    model: owner?.claudeProvider
      ? entry.launchProfile?.model === "haiku" && owner.claudeProvider.smallFastModel
        ? owner.claudeProvider.smallFastModel
        : owner.claudeProvider.model
      : entry.launchProfile?.model ?? undefined,
    effort: entry.launchProfile?.effort ?? undefined,
    permissionMode: effectiveClaudePermissionMode(entry.launchProfile ?? {}),
  };
}

/** Called once by Next instrumentation before the Node server accepts requests. */
export async function adoptStructuredHostsAtStartup(
  dependencies: StructuredStartupDependencies = {},
): Promise<AdoptedStructuredHost[]> {
  return startStructuredHostPass(dependencies);
}

function startStructuredHostPass(
  dependencies: StructuredStartupDependencies,
  resumeDeferred: ReadonlySet<string> | null = null,
): Promise<AdoptedStructuredHost[]> {
  dependencies.assertActive?.();
  const registry = dependencies.registry ?? agentRegistry();
  let state = startupPasses.get(registry);
  if (!state) {
    state = {};
    startupPasses.set(registry, state);
  }
  if (state.pending) return state.pending;
  const current = state;
  // Install before the generation read, which can itself await a host on Windows.
  current.pending = Promise.resolve().then(async () => {
    const client = dependencies.client === undefined ? runtimeHostClient() : dependencies.client;
    const generation = await client?.startupGeneration?.() ?? null;
    const replaced = Boolean(current.ready && generation && current.generation && generation !== current.generation);
    if (current.ready && !resumeDeferred && !replaced) return current.ready;
    startupDiagnostic("error", "[structured hosts] startup pass admitted", {
      trigger: replaced ? "runtime-host-replaced" : resumeDeferred ? "deferred-evidence-changed" : "startup-retry",
      completed: Boolean(current.ready), generationChanged: replaced,
    });
    if (replaced && client) await bindStructuredDeliveryQueue([], { registry, client, deferStartupWork: true });
    const scope = resumeDeferred ?? (replaced ? new Set(Object.keys(registry.readOnlySnapshot().entries)
      .filter((key) => !current.ready!.some((item) => sessionKeyId(item.key) === key))) : null);
    const hosts = await adoptStructuredHostsPass({ ...dependencies, registry, client }, scope);
    current.generation = generation;
    current.ready = hosts;
    return hosts;
  }).finally(() => { current.pending = undefined; });
  return current.pending;
}

async function adoptStructuredHostsPass(
  dependencies: StructuredStartupDependencies,
  resumeDeferred: ReadonlySet<string> | null = null,
): Promise<AdoptedStructuredHost[]> {
  const assertActive = dependencies.assertActive ?? (() => {});
  const admitState = <T>(admit: (available: boolean) => Promise<T>, phase = "startup evidence") =>
    withPipelineStartupAdmission(admit, phase, dependencies.observeLeaseHold);
  assertActive();
  assertDarwinStructuredRuntime();
  const registry = dependencies.registry ?? agentRegistry();
  const client = dependencies.client === undefined ? runtimeHostClient() : dependencies.client;
  const orchestratorSeats = dependencies.orchestratorSeats ?? activeOrchestratorSeats;
  /* Capture hosted seat ownership before any awaited startup work can refresh
     a terminal transcript or reconcile away the predecessor host wrapper. */
  const orchestratorRecoveries = mergeOrchestratorRestartRecoveries(
    startupPasses.get(registry)?.recoveries ?? [],
    await orchestratorRestartRecoveryTargets(
      registry,
      orchestratorSeats(),
      registry.readOnlySnapshot(),
      dependencies.liveness ?? {},
    ),
  );
  const orchestratorRecoveriesByHostKey = orchestratorRestartRecoveriesByHostKey(orchestratorRecoveries);
  const interruptions = dependencies.interruptions
    ?? interruptionObligationStore(interruptionObligationDirectory(registry.filename));
  recordOrchestratorRestartObligations(interruptions, orchestratorRecoveries);
  const controllerBoundEarly = client !== null;
  if (client && !hasStructuredDeliveryController(registry)) {
    await bindStructuredDeliveryQueue([], {
      registry,
      client,
      deferStartupWork: true,
    });
  }
  if (!resumeDeferred) markStructuredHostStartupProgress({
    phase: "refreshing transcripts",
    completedHosts: 0,
    totalHosts: null,
  });
  const lastEventByHost = new Map<string, number | null>();
  const unreadableTranscripts = await (dependencies.refreshTranscriptState && !resumeDeferred
    ? dependencies.refreshTranscriptState(registry)
    : refreshStructuredTranscriptState(registry, assertActive, lastEventByHost, resumeDeferred))
    ?? new Set<string>();
  // Read under the existing lease, then release before any host or transcript I/O.
  // Each writer claim below re-resolves pipeline evidence in its own short hold.
  assertActive();
  const readEvidence = () => (dependencies.pipelineEvidence ?? pipelineStartupEvidence)(registry);
  let pipelineEvidence = await admitState(async (available) =>
    available ? readEvidence() : pipelineStartupEvidence(registry, false));
  {
    assertActive();
    const deferredHostKeys = new Set(Object.values(registry.readOnlySnapshot().conversations)
      .filter((conversation) => pipelineEvidence.deferred.has(registry.canonicalConversationId(conversation.id)))
      .flatMap((conversation) => conversation.generations.map((generation) => sessionKeyId({ engine: conversation.engine, sessionId: generation.id }))));
    let orchestratorHostKeys = currentOrchestratorRestartRecoveryHostKeys(
      registry,
      orchestratorRecoveries,
      orchestratorSeats(),
    );
    /* Every unresolved obligation keeps its row out of the generic Codex nudge
       and out of dead-wrapper cleanup, including one this pass discharges: a
       turn somebody else already resumed is owed nothing more by anyone. */
    const unresolvedInterruptions = settleSubmittedInterruptionObligations(
      registry,
      interruptions,
      interruptions.list().filter(interruptionObligationUnresolved),
    );
    const interruptionHostKeys = new Set(unresolvedInterruptions.map((obligation) => obligation.hostKey));
    let interruptedHostKeys: ReadonlySet<string> = interruptionHostKeys;
    const retainedRecoveryHostKeys = () => new Set([...orchestratorHostKeys, ...interruptedHostKeys]);
    let nextAdoptedHosts = await revalidateRetainedStartupHosts(
      registry,
      retainAdoptedHosts(startupPasses.get(registry)?.ready ?? [], startupPasses.get(registry)?.retained ?? []),
      registry.readOnlySnapshot(),
      retainedRecoveryHostKeys(),
    );
    rememberStructuredStartupRetry(registry, nextAdoptedHosts, orchestratorRecoveries);
    registry.drainDeadSupersededHeldDeliveries();
    /* Pending work makes a terminal conversation adoption-eligible. Clear any
       provably dead wrapper before that decision so its stale writer fence
       cannot block the startup recovery path. */
    reconcileDeadStructuredRegistryHosts(registry, (entry) => orchestratorHostKeys.has(sessionKeyId(entry.key))
      || interruptionHostKeys.has(sessionKeyId(entry.key))
      || (resumeDeferred !== null && !resumeDeferred.has(sessionKeyId(entry.key)))
      || deferredHostKeys.has(sessionKeyId(entry.key)));
    const signals = await structuredStartupSignals(
      registry,
      client,
      new Set(unresolvedInterruptions.map((obligation) => canonicalConversationId(registry, obligation.conversationId))),
    );
    pipelineEvidence = await admitState(async (available) =>
      available ? readEvidence() : pipelineStartupEvidence(registry, false), "reading startup signals");
    /* Only a continuation not yet admitted forces its row's adoption. One the
       queue holds is pending work of its own, which makes the row eligible for
       as long as it stays unsettled. */
    interruptedHostKeys = new Set(dischargeInterruptionObligations(
      registry,
      interruptions,
      unresolvedInterruptions,
      orchestratorSeats(),
      signals.admittedMessages,
      pipelineEvidence.settled,
    ).filter((obligation) => obligation.state === "owed").map((obligation) => obligation.hostKey));
    const eligible = await structuredStartupAdoptionFilter(
      registry,
      signals,
      registry.readOnlySnapshot(),
      orchestratorRecoveriesByHostKey,
      orchestratorSeats,
      unreadableTranscripts,
      pipelineEvidence.settled,
      pipelineEvidence.deferred,
      lastEventByHost,
      interruptedHostKeys,
    );
    const retainedHostKeys = new Set(nextAdoptedHosts.map((item) => sessionKeyId(item.key)));
    const skippedHostKeys = new Set<string>();
    const shouldAdopt: StructuredHostAdoptionFilter = (entry) => {
      // Let an adopter return the handles it already created. Throwing from
      // its per-row progress callback would discard that partial result.
      try { assertActive(); } catch { return false; }
      return (!resumeDeferred || resumeDeferred.has(sessionKeyId(entry.key)))
        && !retainedHostKeys.has(sessionKeyId(entry.key))
        && !skippedHostKeys.has(sessionKeyId(entry.key)) && eligible(entry);
    };
    const adoptionCandidates = Object.values(registry.readOnlySnapshot().entries).filter((entry) =>
      entry.structuredHost && shouldAdopt(entry));
    /* Nothing is launched that this pass cannot hand to a delivery controller.
       `controllerBoundEarly` is exactly "this pass has a runtime client", and it
       is also the condition on the claim assertion below — so without one, the
       loops that follow would start CLI processes, no publication would claim
       them, and the pass would still answer "adopted" because the only check that
       would have caught it is behind the same condition (#1282). So this pass
       defers its adoption: nothing is launched, the boot's own recovery evidence
       and retained hosts are kept for the next attempt, and the startup retry
       loop runs the pass again once a client exists. */
    if (!controllerBoundEarly && adoptionCandidates.length > 0) {
      retryAdoptedHosts = nextAdoptedHosts;
      retryOrchestratorRecoveries = [...orchestratorRecoveries];
      const keys = adoptionCandidates.map((entry) => sessionKeyId(entry.key));
      if (!deferredAdoptionLogged) {
        deferredAdoptionLogged = true;
        console.error("[structured hosts] deferring adoption until a delivery controller can claim it", { keys });
      }
      throw Object.assign(new RuntimeHostUnavailableError(
        `structured delivery controller is unavailable; deferred adoption of ${keys.length} host(s): ${keys.join(", ")}`,
      ), { hostKey: keys[0] });
    }
    const claimHost = (entry: AgentRegistryEntry, owner: ProcessIdentity) =>
      admitState(async (available) => {
        assertActive();
        const evidence = available ? readEvidence() : pipelineStartupEvidence(registry, false);
        const conversation = registry.conversationForPath(entry.artifactPath);
        const id = conversation && registry.canonicalConversationId(conversation.id);
        // Selection deliberately admits owed work on already-settled stages.
        // Only a new settlement invalidates that selection. A new survivor or
        // unreadable authority always defers it, including owed work.
        if (id && (evidence.deferred.has(id)
          || (evidence.settled.has(id) && !pipelineEvidence.settled.has(id)))) {
          const key = sessionKeyId(entry.key);
          skippedHostKeys.add(key);
          if (evidence.deferred.has(id)) deferredHostKeys.add(key);
          return null;
        }
        const current = registry.readOnlySnapshot().entries[sessionKeyId(entry.key)];
        if (!current || !shouldAdopt(current)) return null;
        return registry.claimStructuredHost(entry.key, owner, { allowUnhosted: true });
      }, "claiming startup host");
    const codexCandidateCount = adoptionCandidates.filter((entry) => entry.key.engine === "codex").length;
    const claudeCandidateCount = adoptionCandidates.length - codexCandidateCount;
    let totalHosts = adoptionCandidates.length;
    let completedHosts = 0;
    const reportProgress = (phase: StructuredHostStartupPhase) => {
      assertActive();
      if (!resumeDeferred) markStructuredHostStartupProgress({ phase, completedHosts, totalHosts });
    };
    // A later row may throw after earlier hosts have launched and acquired
    // writer claims. Keep each handle before the batch can reject, so the
    // retry can publish it instead of waiting on its own engine forever.
    const onAdopted = (item: AdoptedStructuredHost) => {
      nextAdoptedHosts = retainAdoptedHosts(nextAdoptedHosts, [item]);
      rememberStructuredStartupRetry(registry, nextAdoptedHosts, orchestratorRecoveries);
    };
    reportProgress("adopting Codex hosts");
    const resolveCodexOwner = dependencies.resolveCodexOwner ?? ((entry: AgentRegistryEntry) =>
      accountManager.resolveTranscriptOwner("codex", entry.artifactPath));
    const resolveClaudeOwner = dependencies.resolveClaudeOwner ?? ((entry: AgentRegistryEntry) =>
      accountManager.resolveTranscriptOwner("claude", entry.artifactPath));
    const startupEnvironment = withoutWakatimeCredential(process.env);
    const codex = resumeDeferred && codexCandidateCount === 0 ? [] : await (dependencies.adopt ?? adoptCodexRegistryHosts)(
      registry,
      (entry) => {
        const owner = resolveCodexOwner(entry);
        const capability = registry.rotateSpawnCapabilityForPath(entry.artifactPath);
        const access = materializeStructuredHostAccess(
          structuredHostAccessPolicy(entry.launchProfile),
          startupEnvironment,
          capability,
        );
        return {
          cwd: entry.cwd,
          codexHome: owner?.home,
          fileAuthCredentials: owner?.kind === "managed",
          model: entry.launchProfile?.model ?? undefined,
          effort: entry.launchProfile?.effort ?? undefined,
          allowSubagents: entry.launchProfile?.allowSubagents ?? false,
          mcpServers: entry.launchProfile?.mcpServers ?? ["viewer"],
          /* Re-adoption replays the durable grant (issue #687) — a session never
             gains or loses Computer Use by being picked up again at startup. */
          plugins: entry.launchProfile?.plugins ?? [],
          ...access.codex,
          ...access.host,
          env: access.env,
        };
      },
      startupEnvironment,
      shouldAdopt,
      () => {
        completedHosts += 1;
        totalHosts = Math.max(totalHosts, completedHosts);
        if (!resumeDeferred) markStructuredHostStartupProgress({ phase: "adopting Codex hosts", completedHosts, totalHosts });
      },
      { onAdopted, claimHost },
    );
    completedHosts = Math.max(completedHosts, codexCandidateCount);
    nextAdoptedHosts = retainAdoptedHosts(nextAdoptedHosts, codex);
    rememberStructuredStartupRetry(registry, nextAdoptedHosts, orchestratorRecoveries);
    reportProgress("adopting Claude hosts");
    const claude = resumeDeferred && claudeCandidateCount === 0 ? [] : await (dependencies.adoptClaude ?? adoptClaudeRegistryHosts)(
      registry,
      (entry) => {
        const options = claudeStartupHostOptions(
          entry,
          resolveClaudeOwner(entry),
          registry.rotateSpawnCapabilityForPath(entry.artifactPath),
          startupEnvironment,
        );
        /* A transcript no live account answers for — a retired account's rows,
           say — gets no config dir, so no `--mcp-config` is written and the
           grant it carries is dropped. Inventing a home would be worse than
           dropping it, but the session only finds out a turn later, when its
           tools are already gone. Say it here instead (#1732). */
        if (!options.claudeConfigDir && options.mcpServers.length > 0) {
          console.error("[structured hosts] resuming a Claude row without the MCP grant it carries", {
            host: sessionKeyId(entry.key),
            mcpServers: options.mcpServers,
            reason: "no Claude account owns this transcript",
          });
        }
        return options;
      },
      startupEnvironment,
      shouldAdopt,
      () => {
        completedHosts += 1;
        totalHosts = Math.max(totalHosts, completedHosts);
        if (!resumeDeferred) markStructuredHostStartupProgress({ phase: "adopting Claude hosts", completedHosts, totalHosts });
      },
      { onAdopted, claimHost },
    );
    completedHosts = Math.max(completedHosts, codexCandidateCount + claudeCandidateCount);
    nextAdoptedHosts = retainAdoptedHosts(nextAdoptedHosts, claude);
    rememberStructuredStartupRetry(registry, nextAdoptedHosts, orchestratorRecoveries);
    assertEligibleHostsResolved(
      registry,
      shouldAdopt,
      nextAdoptedHosts,
      /* Boot adopts Codex and Claude hosts. A Copilot host is never adopted at
         boot (slice 1): its next message resumes it on demand, so it can never
         hold startup waiting for a hand-over. */
      (key) => key.engine === "codex" ? dependencies.adopt === undefined
        : key.engine === "claude" ? dependencies.adoptClaude === undefined
          : false,
      dependencies.hostClaimed,
    );
    reportProgress("reconciling structured hosts");
    orchestratorHostKeys = currentOrchestratorRestartRecoveryHostKeys(
      registry,
      orchestratorRecoveries,
      orchestratorSeats(),
    );
    nextAdoptedHosts = await revalidateRetainedStartupHosts(
      registry,
      nextAdoptedHosts,
      registry.readOnlySnapshot(),
      retainedRecoveryHostKeys(),
    );
    rememberStructuredStartupRetry(registry, nextAdoptedHosts, orchestratorRecoveries);
    const candidateHostKeys = new Set(nextAdoptedHosts.map((item) => sessionKeyId(item.key)));
    const shouldRetainCandidateOrAdopt: StructuredHostAdoptionFilter = (entry) =>
      candidateHostKeys.has(sessionKeyId(entry.key))
      /* A row this boot could not read a transcript for is left exactly as it
         was. The demotion below retires a skipped row — it releases the endpoint,
         clears the active turn and can signal an unclaimable Claude orphan — and
         an unreadable tail is no more grounds for that than it is for a launch
         (#1281). Whatever can read the artifact next decides. */
      || (resumeDeferred !== null && !resumeDeferred.has(sessionKeyId(entry.key)))
      || deferredHostKeys.has(sessionKeyId(entry.key))
      || skippedHostKeys.has(sessionKeyId(entry.key))
      || unreadableTranscripts.has(sessionKeyId(entry.key))
      || shouldAdopt(entry);
    const candidateCodexHosts = nextAdoptedHosts.filter(
      (item): item is AdoptedCodexHost => item.key.engine === "codex"
        && !orchestratorHostKeys.has(sessionKeyId(item.key))
        && !interruptionHostKeys.has(sessionKeyId(item.key)),
    );
    const existingCodexContinuations = client
      ? await interruptedCodexContinuations(registry, client, candidateCodexHosts)
      : new Map<string, RuntimeOperationResult>();
    await demoteSkippedStructuredRegistryHosts(registry, shouldRetainCandidateOrAdopt, (entry, mutation) =>
      admitState(async (available) => {
        assertActive();
        const evidence = available ? readEvidence() : pipelineStartupEvidence(registry, false);
        const conversation = registry.conversationForPath(entry.artifactPath);
        if (conversation && evidence.deferred.has(registry.canonicalConversationId(conversation.id))) {
          deferredHostKeys.add(sessionKeyId(entry.key));
          skippedHostKeys.add(sessionKeyId(entry.key));
          return;
        }
        return mutation();
      }, "reconciling structured hosts"));
    const publicationSnapshot = registry.readOnlySnapshot();
    orchestratorHostKeys = currentOrchestratorRestartRecoveryHostKeys(
      registry,
      orchestratorRecoveries,
      orchestratorSeats(),
      publicationSnapshot,
    );
    nextAdoptedHosts = await revalidateRetainedStartupHosts(
      registry,
      nextAdoptedHosts,
      publicationSnapshot,
      retainedRecoveryHostKeys(),
    );
    rememberStructuredStartupRetry(registry, nextAdoptedHosts, orchestratorRecoveries);
    const finalShouldAdopt = await structuredStartupAdoptionFilter(
      registry,
      signals,
      publicationSnapshot,
      orchestratorRecoveriesByHostKey,
      orchestratorSeats,
      unreadableTranscripts,
      pipelineEvidence.settled,
      pipelineEvidence.deferred,
      lastEventByHost,
      interruptedHostKeys,
    );
    assertActive();
    const finalHostKeys = new Set(nextAdoptedHosts.map((item) => sessionKeyId(item.key)));
    const shouldPublish: StructuredHostAdoptionFilter = (entry) =>
      finalHostKeys.has(sessionKeyId(entry.key))
      || (!skippedHostKeys.has(sessionKeyId(entry.key)) && finalShouldAdopt(entry));
    const interruptedCodex = interruptedCodexConversations(
      registry,
      shouldPublish,
      signals.hostedRunningConversationIds,
      unreadableTranscripts,
      publicationSnapshot,
    );
    const finalCodexHosts = nextAdoptedHosts.filter(
      (item): item is AdoptedCodexHost => item.key.engine === "codex"
        && !orchestratorHostKeys.has(sessionKeyId(item.key))
        && !interruptionHostKeys.has(sessionKeyId(item.key)),
    );
    reportProgress("finalizing structured delivery");
    /* `controllerBoundEarly` is exactly "this pass has a runtime client", so the
       only way past it is a viewer that cannot host at all. Rebinding there would
       retire a publication this pass has no client to replace — and every spawn
       in the process would fail until some later pass rebound it (#1191). */
    if (controllerBoundEarly) {
      await completeStructuredDeliveryQueueStartup(nextAdoptedHosts, reportProgress, assertActive);
      assertAdoptedHostsAreClaimed(nextAdoptedHosts, dependencies.hostClaimed);
    }
    if (client) {
      reportProgress("recovering orchestrator deliveries");
      /* Re-read: identity, a seat rotation or a message admitted while this
         pass adopted can each discharge an obligation it adopted for. The
         runtime's receipts are read again too — adoption can take tens of
         seconds, and a send it admitted in that time is not in `signals`. A
         pass with nothing owed skips that snapshot. */
      const unresolvedAfterAdoption = interruptions.list().filter((obligation) =>
        interruptionObligationUnresolved(obligation)
          && interruptedHostKeys.has(obligation.hostKey)
          && !deferredHostKeys.has(obligation.hostKey));
      const owedInterruptions = unresolvedAfterAdoption.length === 0 ? [] : dischargeInterruptionObligations(
        registry,
        interruptions,
        unresolvedAfterAdoption,
        orchestratorSeats(),
        admittedRuntimeMessages(registry, await readStartupRuntime(registry, client, [...new Set(unresolvedAfterAdoption.map((item) => item.conversationId))])),
        pipelineEvidence.settled,
      );
      const continuationFailures = await deliverInterruptionContinuations(
        registry, client, interruptions, owedInterruptions, finalHostKeys,
      );
      reportProgress("recovering interrupted deliveries");
      await enqueueInterruptedCodexContinuations(
        registry,
        client,
        finalCodexHosts,
        interruptedCodex,
        existingCodexContinuations,
        signals.pendingCodexContinuationConversationIds,
      );
      reportProgress("kicking recovered deliveries");
      await kickStructuredDeliveryQueue();
      /* The pass retries until every owed continuation is admitted; each retry
         replays the same key, so a slow admission never becomes a second one. */
      if (continuationFailures.length > 0) {
        throw new RuntimeHostUnavailableError(
          `interrupted turn continuation admission failed: ${continuationFailures.join("; ")}`,
        );
      }
    }
    /* A pending launch receipt reserved for a fenced pipeline conversation is
       provisioning for that pipeline: replaying it would seat a writer beside
       the survivor, and settling it would move the attempt's evidence. Recovery
       is the one place that does either, so while such a receipt exists the
       whole of it waits for the re-probe; without one it runs now, so an
       unrelated lane's queued or superseded launch is reconciled by this boot
       whatever another pipeline's survivor is doing. */
    pipelineEvidence = await admitState(async (available) =>
      available ? readEvidence() : pipelineStartupEvidence(registry, false), "recovering pending spawns");
    const fencedReceipts = fencedPendingSpawnReceipts(registry, pipelineEvidence.deferred);
    if (client && fencedReceipts.length === 0) {
      reportProgress("recovering pending spawns");
      await recoverPendingStructuredSpawns(registry, client, { assertActive });
    }
    assertActive();
    adoptedHosts = nextAdoptedHosts;
    if (deferredHostKeys.size > 0 || fencedReceipts.length > 0) {
      /* The rows are retained exactly as a retry would retain them: the next
         pass continues through the hosts this one published. The pass itself
         completes — throwing here made the boot's retry loop rerun the whole
         adoption every second for as long as one stray process lived, kept the
         startup axis failed and never reached pending-spawn recovery. */
      retryAdoptedHosts = nextAdoptedHosts;
      retryOrchestratorRecoveries = [...orchestratorRecoveries];
      rememberDeferredStructuredStartup(dependencies, registry, [...deferredHostKeys], pipelineEvidence.deferred, fencedReceipts.length);
      return adoptedHosts;
    }
    retryAdoptedHosts = [];
    retryOrchestratorRecoveries = [];
    if (deferredStartup) {
      console.error("[structured hosts] deferred pipeline rows admitted", { hosts: deferredStartup.hostKeys });
      deferredStartup = null;
    }
    return adoptedHosts;
  }
}

/** Launch receipts still on their way to a host whose reserved conversation
    the pipeline evidence fences. Settled, failed and conflicted receipts are
    history; everything else is provisioning the fence covers. */
function fencedPendingSpawnReceipts(registry: AgentRegistry, deferred: ReadonlySet<string>): SpawnReceipt[] {
  if (deferred.size === 0) return [];
  return Object.values(registry.readOnlySnapshot().receipts).filter((receipt) =>
    receipt.state !== "completed"
    && receipt.state !== "failed"
    && receipt.state !== "conflicted"
    && deferred.has(registry.canonicalConversationId(receipt.conversationId)));
}

function rememberDeferredStructuredStartup(
  dependencies: StructuredStartupDependencies,
  registry: AgentRegistry,
  hostKeys: readonly string[],
  conversationIds: ReadonlySet<string>,
  fencedReceipts: number,
): void {
  const message = `pipeline startup evidence is unresolved; deferred ${hostKeys.length} host(s)`
    + (fencedReceipts > 0 ? ` and ${fencedReceipts} pending launch receipt(s)` : "");
  const previous = deferredStartup;
  /* Unchanged evidence keeps growing the backoff; evidence that moved (a row
     admitted, another fenced) starts the cadence over for what is left. */
  const sameEvidence = previous !== null
    && previous.conversationIds.size === conversationIds.size
    && [...conversationIds].every((id) => previous.conversationIds.has(id))
    && previous.fencedReceipts === fencedReceipts;
  const delayMs = sameEvidence
    ? Math.min(previous.delayMs * 2, DEFERRED_STARTUP_REPROBE_MAX_MS)
    : DEFERRED_STARTUP_REPROBE_INITIAL_MS;
  const state: DeferredStructuredStartup = {
    hostKeys, conversationIds: new Set(conversationIds), fencedReceipts, message, delayMs,
  };
  deferredStartup = state;
  if (!sameEvidence) console.error(`[structured hosts] ${message}; re-probing the evidence`, { hosts: hostKeys, nextProbeMs: delayMs });
  scheduleDeferredStartupReprobe(dependencies, registry, state);
}

function scheduleDeferredStartupReprobe(
  dependencies: StructuredStartupDependencies,
  registry: AgentRegistry,
  state: DeferredStructuredStartup,
): void {
  const schedule = dependencies.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  schedule(() => {
    /* A later pass replaced this deferral; its own timer carries it. */
    if (deferredStartup !== state) return;
    try { dependencies.assertActive?.(); } catch { return; }
    void reprobeDeferredStructuredStartup(dependencies, registry, state);
  }, state.delayMs).unref?.();
}

/** The re-probe reads the pipeline evidence alone — the survivor identities
    and the record — and reruns the adoption pass only when that evidence no
    longer fences everything it fenced before. Nothing else about the boot is
    repeated while a stray process merely stays alive. */
async function reprobeDeferredStructuredStartup(
  dependencies: StructuredStartupDependencies,
  registry: AgentRegistry,
  state: DeferredStructuredStartup,
): Promise<void> {
  let unchanged = true;
  try {
    const evidence = (dependencies.pipelineEvidence ?? pipelineStartupEvidence)(registry);
    unchanged = [...state.conversationIds].every((id) => evidence.deferred.has(id))
      && fencedPendingSpawnReceipts(registry, evidence.deferred).length >= state.fencedReceipts;
  } catch (error) {
    console.error("[structured hosts] deferred pipeline evidence probe failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (unchanged) {
    state.delayMs = Math.min(state.delayMs * 2, DEFERRED_STARTUP_REPROBE_MAX_MS);
    scheduleDeferredStartupReprobe(dependencies, registry, state);
    return;
  }
  try {
    await startStructuredHostPass(dependencies, new Set(state.hostKeys));
  } catch (error) {
    console.error("[structured hosts] deferred pipeline adoption pass failed; re-probing", {
      error: error instanceof Error ? error.message : String(error),
    });
    if (deferredStartup === state) {
      state.delayMs = Math.min(state.delayMs * 2, DEFERRED_STARTUP_REPROBE_MAX_MS);
      scheduleDeferredStartupReprobe(dependencies, registry, state);
    }
  }
}

export function structuredStartupHosts(): readonly AdoptedStructuredHost[] {
  return adoptedHosts;
}

/** Quiesced startup may have created hosts before reaching controller
 * registration. They belong to this boot and must also cross the release
 * boundary before its mirror acknowledgement. External workers never enter
 * these retained handle sets.
 *
 * Such a host can be running a turn — its engine outlived the previous Viewer
 * — so the release records the continuation it owes first, exactly as the
 * published path does (#1835). A host whose record fails is left running and
 * the failure is reported. */
export async function releaseUnpublishedStartupHostsForDemotion(
  options: DemotionInterruptionOptions = {},
): Promise<void> {
  const registry = agentRegistry();
  const unpublished = retainAdoptedHosts(adoptedHosts, retryAdoptedHosts)
    .filter((item) => !hasStructuredDeliveryHost(item.key));
  const released = new Set<string>();
  const outcomes = await Promise.allSettled(unpublished.map(async ({ key, host }) => {
    const state = await host.health();
    if ((state.status !== "active" && state.status !== "attention")
      || state.pid === null || state.processStartIdentity === null) return;
    const identity = captureProcessIdentity(state.pid, undefined, state.processStartIdentity);
    if (!registry.markStructuredHostHandoff(key, identity)) {
      throw new Error("unpublished startup host changed before release handover");
    }
    try {
      await recordDemotionInterruption(registry, key, state, options);
    } catch (error) {
      console.error("[viewer release] interrupted turn could not be recorded; leaving its unpublished host running", {
        hostKey: sessionKeyId(key), error,
      });
      throw error;
    }
    await host.release();
    released.add(sessionKeyId(key));
  }));
  /* A released handle is gone for good: no later pass in this process may
     retain or publish it. */
  const kept = (item: AdoptedStructuredHost) => !released.has(sessionKeyId(item.key));
  adoptedHosts = adoptedHosts.filter(kept);
  retryAdoptedHosts = retryAdoptedHosts.filter(kept);
  const failures = outcomes.flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : []);
  if (failures.length) throw new AggregateError(failures, "unpublished startup hosts did not quiesce");
}

/** Every structured host this Viewer holds crosses the release boundary:
 * the ones startup adopted but had not published, then the published ones.
 * Both steps always run. A host the first step could not hand over must not
 * keep the published hosts from recording what they are owed and being
 * released — left running, the successor's adoption would end their engines
 * as orphans with no obligation on record (#1835). */
export async function releaseStructuredHostsForViewerDemotion(
  options: DemotionInterruptionOptions = {},
): Promise<void> {
  const failures: unknown[] = [];
  for (const step of [releaseUnpublishedStartupHostsForDemotion, releaseStructuredDeliveryHostsForDemotion]) {
    try {
      await step(options);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "structured hosts did not all cross the release boundary");
  startupPasses.delete(agentRegistry());
}
