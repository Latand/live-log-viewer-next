import crypto from "node:crypto";
import path from "node:path";

import { accountManager } from "@/lib/accounts/manager";
import { claudeSettingsPath } from "@/lib/accounts/claude";
import { turnStateFromRecords } from "@/lib/accounts/migration/turnState";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { agentRegistry, type AgentRegistry, type AgentRegistryEntry, type RegistryFile } from "@/lib/agent/registry";
import { effectiveClaudePermissionMode } from "@/lib/agent/cli";
import { sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";
import { activeOrchestratorSeats, type OrchestratorSeat } from "@/lib/orchestrator/seats";
import { assertDarwinStructuredRuntime } from "@/lib/proc/darwinIdentity";
import { readStableTailRecords } from "@/lib/scanner/activity";
import { withoutWakatimeCredential } from "@/lib/wakatime/credential";

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
import type { RuntimeOperationResult } from "./contracts";
import {
  bindStructuredDeliveryQueue,
  completeStructuredDeliveryQueueStartup,
  hasStructuredDeliveryController,
  hasStructuredDeliveryHost,
} from "./structuredDeliveryController";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { enqueueStructuredMessage } from "./structuredMessageDelivery";
import { materializeStructuredHostAccess, recoverPendingStructuredSpawns } from "./structuredSpawn";
import { conversationTurnLiveness, type TranscriptEventKind, type TurnLivenessDependencies } from "./liveness";
import { markStructuredHostStartupProgress, type StructuredHostStartupPhase } from "./startupStatus";

type AdoptedStructuredHost = AdoptedCodexHost | AdoptedClaudeHost;
let adoptedHosts: AdoptedStructuredHost[] = [];
let retryAdoptedHosts: AdoptedStructuredHost[] = [];
/* The startup retry loop re-enters every second at its ceiling, and a Viewer
   with no runtime socket defers on every pass; one line per boot says it. */
let deferredAdoptionLogged = false;

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
  for (const item of retained) {
    if (retainedStartupHostIsCurrent(snapshot, item, retainedTerminalHostKeys)) current.push(item);
    else await item.host.release();
  }
  return current;
}

const RUNTIME_EFFECT_PAGE_SIZE = 100;
const STRUCTURED_HOST_OPERATION_EFFECT_KINDS = [
  "runtime.send",
  "runtime.steer",
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
}

const TRANSCRIPT_REFRESH_CONCURRENCY = 16;
const INTERRUPTED_CODEX_CONTINUATION_OPERATION_PREFIX = "recovery-continuation";
const INTERRUPTED_CODEX_CONTINUATION_TEXT = "Continue the interrupted turn from the transcript.";
const ORCHESTRATOR_RESTART_RECOVERY_PREFIX = "orchestrator-restart-recovery";

/**
 * What the surviving restart nudge says (#1276).
 *
 * It names the turn it is talking about, because that is the only thing this
 * message is for: a seat whose own turn was cut off mid-flight, which nothing
 * else will ever answer. It no longer asks the seat to "re-arm any scheduled
 * work" — since #1245/#1261 the Viewer owns the clock, the tick's state is
 * durable across restarts, and a seat has no lever to arm a schedule of its
 * own. That sentence comes back only when #1280 gives it one, pointed at that
 * record rather than at a session-held schedule.
 */
function orchestratorRestartRecoveryText(severed: SeveredTurnEvidence): string {
  const at = severed.at === null ? "an unrecorded time" : new Date(severed.at).toISOString();
  return "Viewer restarted and severed your structured host mid-turn."
    + ` The severed turn is the one whose last transcript event is ${severed.kind ?? "a record"} at ${at},`
    + " which nothing answered. You were re-hosted automatically; resume that turn.";
}
/* One module lifetime is one Viewer Node boot. Startup retries reuse this key;
   a successor process mints a fresh recovery operation for the next restart. */
const STRUCTURED_STARTUP_BOOT_ID = crypto.randomUUID();

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
  hosts: AdoptedStructuredHost[],
  recoveries: readonly OrchestratorRestartRecoveryTarget[],
): void {
  retryAdoptedHosts = hosts;
  const retainedHostKeys = new Set(hosts.map((item) => sessionKeyId(item.key)));
  retryOrchestratorRecoveries = recoveries.filter((target) => retainedHostKeys.has(target.hostKey));
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

async function enqueueOrchestratorRestartRecoveries(
  registry: AgentRegistry,
  client: RuntimeHostClient | null,
  targets: readonly OrchestratorRestartRecoveryTarget[],
  publishedHostKeys: ReadonlySet<string>,
  orchestratorSeats: () => OrchestratorSeat[],
): Promise<void> {
  for (const target of targets) {
    if (!publishedHostKeys.has(target.hostKey)
      || !orchestratorRestartRecoveryTargetIsCurrent(registry, target, orchestratorSeats())) continue;
    const clientMessageId = `${ORCHESTRATOR_RESTART_RECOVERY_PREFIX}-${STRUCTURED_STARTUP_BOOT_ID}-${target.seatEpoch}`;
    const result = await enqueueStructuredMessage({
      path: target.path,
      conversationId: target.conversationId,
      clientMessageId,
      text: orchestratorRestartRecoveryText(target.severed),
      images: [],
    }, {
      enabled: () => true,
      client: () => client,
      registry: () => registry,
    });
    if (result?.ok) continue;
    console.error("[structured hosts] orchestrator restart recovery delivery failed", {
      conversationId: target.conversationId,
      status: result?.status ?? 503,
      error: result?.error ?? "structured delivery unavailable",
    });
    throw new RuntimeHostUnavailableError(
      result?.error ?? "orchestrator restart recovery delivery admission failed",
    );
  }
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
  throw new RuntimeHostUnavailableError(
    `structured delivery controller did not claim ${unclaimed.length} adopted host(s): ${keys.join(", ")}`,
  );
}

/** Every row selected before adoption must end the pass with a host published
    by this Viewer or cease to be eligible. The durable target appoints the
    candidate before the incumbent's demotion poll releases its engines. A
    candidate that reaches adoption in that window sees the old live process
    and must retry until demotion records and completes the handoff (#1296). */
function assertEligibleHostsResolved(
  registry: AgentRegistry,
  shouldAdopt: StructuredHostAdoptionFilter,
  adopted: readonly AdoptedStructuredHost[],
  productionAdopter: (key: SessionKey) => boolean,
  claimed: (key: SessionKey) => boolean = hasStructuredDeliveryHost,
): void {
  const adoptedKeys = new Set(adopted.map((item) => sessionKeyId(item.key)));
  const unresolved = Object.values(registry.readOnlySnapshot().entries).filter((entry) =>
    entry.structuredHost
      && productionAdopter(entry.key)
      && shouldAdopt(entry)
      && !adoptedKeys.has(sessionKeyId(entry.key))
      && !claimed(entry.key));
  if (unresolved.length === 0) return;
  const keys = unresolved.map((entry) => sessionKeyId(entry.key));
  console.error("[structured hosts] eligible hosts remain owned by the incumbent Viewer; retrying startup", { keys });
  throw new RuntimeHostUnavailableError(
    `structured startup left ${keys.length} eligible host(s) owned by the incumbent Viewer: ${keys.join(", ")}`,
  );
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
    });
  }
}

async function interruptedCodexContinuations(
  registry: AgentRegistry,
  client: RuntimeHostClient,
  adopted: readonly AdoptedCodexHost[],
): Promise<ReadonlyMap<string, RuntimeOperationResult>> {
  const existingByKey = new Map<string, RuntimeOperationResult>();
  for (const item of adopted) {
    const key = sessionKeyId(item.key);
    const entry = registry.readOnlySnapshot().entries[key];
    if (!entry) continue;
    const current = await client.operationStatus(
      interruptedCodexContinuationOperationId(item.key.sessionId, entry.claimEpoch),
      { currentRetryLeaf: true },
    );
    if (current) {
      existingByKey.set(key, current);
      continue;
    }
    if (entry.claimEpoch <= 0) continue;
    const previous = await client.operationStatus(
      interruptedCodexContinuationOperationId(item.key.sessionId, entry.claimEpoch - 1),
      { currentRetryLeaf: true },
    );
    if (previous) existingByKey.set(key, previous);
  }
  return existingByKey;
}

function persistedTurnState(
  records: Record<string, unknown>[],
  engine: "codex" | "claude",
  prefixTruncated: boolean,
) {
  if (engine === "claude") return turnStateFromRecords(records, "claude");
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
async function refreshStructuredTranscriptState(registry: AgentRegistry): Promise<ReadonlySet<string>> {
  const snapshot = registry.readOnlySnapshot();
  const observedAt = new Date().toISOString();
  const candidates = Object.values(snapshot.conversations).flatMap((conversation) => {
    const generation = conversation.generations.at(-1);
    if (!generation) return [];
    const hostKey = sessionKeyId({ engine: conversation.engine, sessionId: generation.id });
    const entry = snapshot.entries[hostKey];
    return entry?.structuredHost && entry.status === "live" && !conversation.supersededBy
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
  if (observations.length > 0) registry.reconcileConversations(observations);
  return unreadable;
}

function canonicalConversationId(registry: AgentRegistry, conversationId: string): string {
  return conversationId.startsWith("conversation_")
    ? registry.canonicalConversationId(conversationId as ViewerConversationId)
    : conversationId;
}

async function structuredStartupSignals(
  registry: AgentRegistry,
  client: RuntimeHostClient | null,
): Promise<StructuredStartupSignals> {
  if (!client) {
    return {
      hostedRunningConversationIds: new Set(),
      pendingOperationConversationIds: new Set(),
      pendingCodexContinuationConversationIds: new Set(),
    };
  }
  const runtime = await client.snapshot();
  const hostedRunningConversationIds = new Set(runtime.sessions
    .filter((session) => session.host === "hosted"
      && (session.turn === "running" || session.turn === "interrupt_requested"))
    .map((session) => canonicalConversationId(registry, session.conversationId)));
  const pendingOperationConversationIds = new Set(runtime.recentOperations
    .filter((receipt) => receipt.status === "pending"
      || receipt.status === "queued"
      || receipt.status === "delivering"
      || receipt.status === "applying")
    .filter((receipt) => receipt.kind !== "kill")
    .map((receipt) => canonicalConversationId(registry, receipt.conversationId)));
  const pendingCodexContinuationConversationIds = new Set<string>();
  let afterEventSeq = 0;
  while (true) {
    const batch = await client.effectBatch(STRUCTURED_HOST_OPERATION_EFFECT_KINDS, afterEventSeq);
    for (const effect of batch) {
      const conversationId = effect.payload.conversationId;
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
  return {
    hostedRunningConversationIds,
    pendingOperationConversationIds,
    pendingCodexContinuationConversationIds,
  };
}

function structuredStartupAdoptionFilter(
  registry: AgentRegistry,
  signals: StructuredStartupSignals,
  snapshot: RegistryFile = registry.readOnlySnapshot(),
  orchestratorRecoveries: ReadonlyMap<string, readonly OrchestratorRestartRecoveryTarget[]> = new Map(),
  orchestratorSeats: () => OrchestratorSeat[] = activeOrchestratorSeats,
  unreadableTranscriptHostKeys: ReadonlySet<string> = new Set(),
): StructuredHostAdoptionFilter {
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
  return (entry) => {
    const conversation = conversationsByCurrentEntry.get(sessionKeyId(entry.key));
    if (!conversation) return false;
    /* A superseded conversation is terminal (issue #383): a boot can never
       revive a retired round, held work or not — the successor owns it. */
    if (conversation.supersededBy) return false;
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
    return liveHost && unfinishedTurn;
  };
}

export interface StructuredStartupDependencies {
  registry?: AgentRegistry;
  client?: RuntimeHostClient | null;
  /** Process and transcript readers behind the restart-recovery evidence. */
  liveness?: TurnLivenessDependencies;
  /** Whether the delivery controller resolves a host this pass adopted. */
  hostClaimed?: (key: SessionKey) => boolean;
  orchestratorSeats?: typeof activeOrchestratorSeats;
  /** Reconciles transcript state, answering which conversations it could not
      read. A stub that answers nothing reports nothing unreadable. */
  refreshTranscriptState?: (registry: AgentRegistry) => Promise<ReadonlySet<string> | void>;
  adopt?: typeof adoptCodexRegistryHosts;
  adoptClaude?: typeof adoptClaudeRegistryHosts;
  resolveCodexOwner?: (entry: AgentRegistryEntry) => { home: string; kind: "legacy" | "managed" } | null;
  resolveClaudeOwner?: (entry: AgentRegistryEntry) => {
    home: string;
    kind: "legacy" | "managed";
    transcriptRoot: string;
    env: NodeJS.ProcessEnv;
  } | null;
}

/** Called once by Next instrumentation before the Node server accepts requests. */
export async function adoptStructuredHostsAtStartup(
  dependencies: StructuredStartupDependencies = {},
): Promise<AdoptedStructuredHost[]> {
  assertDarwinStructuredRuntime();
  const registry = dependencies.registry ?? agentRegistry();
  const client = dependencies.client === undefined ? runtimeHostClient() : dependencies.client;
  const orchestratorSeats = dependencies.orchestratorSeats ?? activeOrchestratorSeats;
  /* Capture hosted seat ownership before any awaited startup work can refresh
     a terminal transcript or reconcile away the predecessor host wrapper. */
  const orchestratorRecoveries = mergeOrchestratorRestartRecoveries(
    retryOrchestratorRecoveries,
    await orchestratorRestartRecoveryTargets(
      registry,
      orchestratorSeats(),
      registry.readOnlySnapshot(),
      dependencies.liveness ?? {},
    ),
  );
  const orchestratorRecoveriesByHostKey = orchestratorRestartRecoveriesByHostKey(orchestratorRecoveries);
  const controllerBoundEarly = client !== null;
  if (client && !hasStructuredDeliveryController(registry)) {
    await bindStructuredDeliveryQueue([], {
      registry,
      client,
      deferStartupWork: true,
    });
  }
  markStructuredHostStartupProgress({
    phase: "refreshing transcripts",
    completedHosts: 0,
    totalHosts: null,
  });
  const unreadableTranscripts = await (dependencies.refreshTranscriptState ?? refreshStructuredTranscriptState)(registry)
    ?? new Set<string>();
  let orchestratorHostKeys = currentOrchestratorRestartRecoveryHostKeys(
    registry,
    orchestratorRecoveries,
    orchestratorSeats(),
  );
  let nextAdoptedHosts = await revalidateRetainedStartupHosts(
    registry,
    retryAdoptedHosts,
    registry.readOnlySnapshot(),
    orchestratorHostKeys,
  );
  rememberStructuredStartupRetry(nextAdoptedHosts, orchestratorRecoveries);
  /* Pending work makes a terminal conversation adoption-eligible. Clear any
     provably dead wrapper before that decision so its stale writer fence
     cannot block the startup recovery path. */
  reconcileDeadStructuredRegistryHosts(registry, (entry) => orchestratorHostKeys.has(sessionKeyId(entry.key)));
  const signals = await structuredStartupSignals(registry, client);
  const shouldAdopt = structuredStartupAdoptionFilter(
    registry,
    signals,
    registry.readOnlySnapshot(),
    orchestratorRecoveriesByHostKey,
    orchestratorSeats,
    unreadableTranscripts,
  );
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
    throw new RuntimeHostUnavailableError(
      `structured delivery controller is unavailable; deferred adoption of ${keys.length} host(s): ${keys.join(", ")}`,
    );
  }
  const codexCandidateCount = adoptionCandidates.filter((entry) => entry.key.engine === "codex").length;
  const claudeCandidateCount = adoptionCandidates.length - codexCandidateCount;
  let totalHosts = adoptionCandidates.length;
  let completedHosts = 0;
  const reportProgress = (phase: StructuredHostStartupPhase) => {
    markStructuredHostStartupProgress({ phase, completedHosts, totalHosts });
  };
  reportProgress("adopting Codex hosts");
  const resolveCodexOwner = dependencies.resolveCodexOwner ?? ((entry: AgentRegistryEntry) =>
    accountManager.resolveTranscriptOwner("codex", entry.artifactPath));
  const resolveClaudeOwner = dependencies.resolveClaudeOwner ?? ((entry: AgentRegistryEntry) =>
    accountManager.resolveTranscriptOwner("claude", entry.artifactPath));
  const startupEnvironment = withoutWakatimeCredential(process.env);
  const codex = await (dependencies.adopt ?? adoptCodexRegistryHosts)(
    registry,
    (entry) => {
      const owner = resolveCodexOwner(entry);
      const capability = registry.rotateSpawnCapabilityForPath(entry.artifactPath);
      const access = materializeStructuredHostAccess(
        entry.launchProfile?.readOnly === true,
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
      reportProgress("adopting Codex hosts");
    },
  );
  completedHosts = Math.max(completedHosts, codexCandidateCount);
  nextAdoptedHosts = retainAdoptedHosts(nextAdoptedHosts, codex);
  rememberStructuredStartupRetry(nextAdoptedHosts, orchestratorRecoveries);
  reportProgress("adopting Claude hosts");
  const claude = await (dependencies.adoptClaude ?? adoptClaudeRegistryHosts)(
    registry,
    (entry) => {
      const owner = resolveClaudeOwner(entry);
      const capability = registry.rotateSpawnCapabilityForPath(entry.artifactPath);
      const env = withoutWakatimeCredential(owner?.env ?? startupEnvironment);
      const access = materializeStructuredHostAccess(
        entry.launchProfile?.readOnly === true,
        env,
        capability,
      );
      return {
        cwd: entry.cwd,
        claudeConfigDir: owner?.kind === "managed" ? owner.home : undefined,
        claudeProjectsDir: owner?.transcriptRoot,
        spawnPolicyBaseSettingsPath: owner?.kind === "managed" ? claudeSettingsPath() : null,
        allowSubagents: entry.launchProfile?.allowSubagents ?? false,
        mcpServers: entry.launchProfile?.mcpServers ?? ["viewer"],
        mcpStatePath: owner?.kind === "managed"
          ? path.join(owner.home, ".claude.json")
          : owner ? path.join(path.dirname(owner.home), ".claude.json") : undefined,
        readOnly: entry.launchProfile?.readOnly === true,
        env: access.env,
        ...access.host,
        model: entry.launchProfile?.model ?? undefined,
        effort: entry.launchProfile?.effort ?? undefined,
        permissionMode: effectiveClaudePermissionMode(entry.launchProfile ?? {}),
      };
    },
    startupEnvironment,
    shouldAdopt,
    () => {
      completedHosts += 1;
      totalHosts = Math.max(totalHosts, completedHosts);
      reportProgress("adopting Claude hosts");
    },
  );
  completedHosts = Math.max(completedHosts, codexCandidateCount + claudeCandidateCount);
  nextAdoptedHosts = retainAdoptedHosts(nextAdoptedHosts, claude);
  rememberStructuredStartupRetry(nextAdoptedHosts, orchestratorRecoveries);
  assertEligibleHostsResolved(
    registry,
    shouldAdopt,
    nextAdoptedHosts,
    (key) => key.engine === "codex" ? dependencies.adopt === undefined : dependencies.adoptClaude === undefined,
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
    orchestratorHostKeys,
  );
  rememberStructuredStartupRetry(nextAdoptedHosts, orchestratorRecoveries);
  const candidateHostKeys = new Set(nextAdoptedHosts.map((item) => sessionKeyId(item.key)));
  const shouldRetainCandidateOrAdopt: StructuredHostAdoptionFilter = (entry) =>
    candidateHostKeys.has(sessionKeyId(entry.key))
    /* A row this boot could not read a transcript for is left exactly as it
       was. The demotion below retires a skipped row — it releases the endpoint,
       clears the active turn and can signal an unclaimable Claude orphan — and
       an unreadable tail is no more grounds for that than it is for a launch
       (#1281). Whatever can read the artifact next decides. */
    || unreadableTranscripts.has(sessionKeyId(entry.key))
    || shouldAdopt(entry);
  const candidateCodexHosts = nextAdoptedHosts.filter(
    (item): item is AdoptedCodexHost => item.key.engine === "codex"
      && !orchestratorHostKeys.has(sessionKeyId(item.key)),
  );
  const existingCodexContinuations = client
    ? await interruptedCodexContinuations(registry, client, candidateCodexHosts)
    : new Map<string, RuntimeOperationResult>();
  await demoteSkippedStructuredRegistryHosts(registry, shouldRetainCandidateOrAdopt);
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
    orchestratorHostKeys,
  );
  rememberStructuredStartupRetry(nextAdoptedHosts, orchestratorRecoveries);
  const finalShouldAdopt = structuredStartupAdoptionFilter(
    registry,
    signals,
    publicationSnapshot,
    orchestratorRecoveriesByHostKey,
    orchestratorSeats,
    unreadableTranscripts,
  );
  const finalHostKeys = new Set(nextAdoptedHosts.map((item) => sessionKeyId(item.key)));
  const shouldPublish: StructuredHostAdoptionFilter = (entry) =>
    finalHostKeys.has(sessionKeyId(entry.key)) || finalShouldAdopt(entry);
  const interruptedCodex = interruptedCodexConversations(
    registry,
    shouldPublish,
    signals.hostedRunningConversationIds,
    unreadableTranscripts,
    publicationSnapshot,
  );
  const finalCodexHosts = nextAdoptedHosts.filter(
    (item): item is AdoptedCodexHost => item.key.engine === "codex"
      && !orchestratorHostKeys.has(sessionKeyId(item.key)),
  );
  reportProgress("finalizing structured delivery");
  /* `controllerBoundEarly` is exactly "this pass has a runtime client", so the
     only way past it is a viewer that cannot host at all. Rebinding there would
     retire a publication this pass has no client to replace — and every spawn
     in the process would fail until some later pass rebound it (#1191). */
  if (controllerBoundEarly) {
    await completeStructuredDeliveryQueueStartup(nextAdoptedHosts);
    assertAdoptedHostsAreClaimed(nextAdoptedHosts, dependencies.hostClaimed);
  }
  await enqueueOrchestratorRestartRecoveries(
    registry,
    client,
    orchestratorRecoveries,
    finalHostKeys,
    orchestratorSeats,
  );
  if (client) {
    await enqueueInterruptedCodexContinuations(
      registry,
      client,
      finalCodexHosts,
      interruptedCodex,
      existingCodexContinuations,
      signals.pendingCodexContinuationConversationIds,
    );
    await kickStructuredDeliveryQueue();
  }
  if (client) await recoverPendingStructuredSpawns(registry, client);
  adoptedHosts = nextAdoptedHosts;
  retryAdoptedHosts = [];
  retryOrchestratorRecoveries = [];
  return adoptedHosts;
}

export function structuredStartupHosts(): readonly AdoptedStructuredHost[] {
  return adoptedHosts;
}
