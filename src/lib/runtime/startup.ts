import crypto from "node:crypto";
import path from "node:path";

import { accountManager } from "@/lib/accounts/manager";
import { claudeSettingsPath } from "@/lib/accounts/claude";
import { turnStateFromRecords } from "@/lib/accounts/migration/turnState";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { agentRegistry, type AgentRegistry, type AgentRegistryEntry, type RegistryFile } from "@/lib/agent/registry";
import { effectiveClaudePermissionMode } from "@/lib/agent/cli";
import { sessionKeyId } from "@/lib/agent/sessionKey";
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
} from "./structuredDeliveryController";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { enqueueStructuredMessage } from "./structuredMessageDelivery";
import { materializeStructuredHostAccess, recoverPendingStructuredSpawns } from "./structuredSpawn";
import { markStructuredHostStartupProgress, type StructuredHostStartupPhase } from "./startupStatus";

type AdoptedStructuredHost = AdoptedCodexHost | AdoptedClaudeHost;
let adoptedHosts: AdoptedStructuredHost[] = [];
let retryAdoptedHosts: AdoptedStructuredHost[] = [];

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
const ORCHESTRATOR_RESTART_RECOVERY_TEXT = "Viewer restarted and severed your structured host. You were re-hosted automatically. Resume your checkpoint loop and re-arm any scheduled work.";
/* One module lifetime is one Viewer Node boot. Startup retries reuse this key;
   a successor process mints a fresh recovery operation for the next restart. */
const STRUCTURED_STARTUP_BOOT_ID = crypto.randomUUID();

interface OrchestratorRestartRecoveryTarget {
  project: string;
  conversationId: ViewerConversationId;
  path: string;
  seatEpoch: number;
  hostKey: string;
}

let retryOrchestratorRecoveries: OrchestratorRestartRecoveryTarget[] = [];

function mergeOrchestratorRestartRecoveries(
  retained: readonly OrchestratorRestartRecoveryTarget[],
  captured: readonly OrchestratorRestartRecoveryTarget[],
): OrchestratorRestartRecoveryTarget[] {
  const targets = new Map<string, OrchestratorRestartRecoveryTarget>();
  for (const target of [...retained, ...captured]) {
    targets.set(`${target.project}\0${target.seatEpoch}\0${target.hostKey}`, target);
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

function orchestratorRestartRecoveryTargets(
  registry: AgentRegistry,
  seats = activeOrchestratorSeats(),
  snapshot: RegistryFile = registry.readOnlySnapshot(),
): OrchestratorRestartRecoveryTarget[] {
  return seats.flatMap((seat) => {
    if (!seat.conversationId?.startsWith("conversation_")) return [];
    const conversationId = registry.canonicalConversationId(seat.conversationId as ViewerConversationId);
    const conversation = snapshot.conversations[conversationId];
    const generation = conversation?.generations.at(-1);
    if (!conversation || !generation || conversation.supersededBy) return [];
    const hostKey = sessionKeyId({ engine: conversation.engine, sessionId: generation.id });
    const entry = snapshot.entries[hostKey];
    const wasHosted = Boolean(entry?.structuredHost
      && entry.host === null
      && (entry.status === "live" || entry.status === "idle"));
    return wasHosted
      ? [{ project: seat.project, conversationId, path: generation.path, seatEpoch: seat.seatEpoch, hostKey }]
      : [];
  });
}

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
      text: ORCHESTRATOR_RESTART_RECOVERY_TEXT,
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

function interruptedCodexContinuationOperationId(sessionId: string, claimEpoch: number): string {
  return `${INTERRUPTED_CODEX_CONTINUATION_OPERATION_PREFIX}-${sessionId}-${claimEpoch}`;
}

function interruptedCodexConversations(
  registry: AgentRegistry,
  shouldAdopt: StructuredHostAdoptionFilter,
  runtimeRunningConversationIds: ReadonlySet<string>,
  snapshot: RegistryFile = registry.readOnlySnapshot(),
): ReadonlyMap<string, ViewerConversationId> {
  return new Map(Object.values(snapshot.conversations).flatMap((conversation) => {
    const generation = conversation.generations.at(-1);
    if (conversation.engine !== "codex" || !generation) return [];
    const key = { engine: "codex" as const, sessionId: generation.id };
    const entry = snapshot.entries[sessionKeyId(key)];
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

async function refreshStructuredTranscriptState(registry: AgentRegistry): Promise<void> {
  const snapshot = registry.readOnlySnapshot();
  const observedAt = new Date().toISOString();
  const candidates = Object.values(snapshot.conversations).flatMap((conversation) => {
    const generation = conversation.generations.at(-1);
    if (!generation) return [];
    const entry = snapshot.entries[sessionKeyId({ engine: conversation.engine, sessionId: generation.id })];
    return entry?.structuredHost && entry.status === "live" && !conversation.supersededBy
      ? [{ conversation, generation }]
      : [];
  });
  const observations: Parameters<AgentRegistry["reconcileConversations"]>[0] = [];
  let nextCandidate = 0;
  const workers = Array.from(
    { length: Math.min(TRANSCRIPT_REFRESH_CONCURRENCY, candidates.length) },
    async () => {
      while (nextCandidate < candidates.length) {
        const candidate = candidates[nextCandidate++];
        if (!candidate) continue;
        const { conversation, generation } = candidate;
        const tail = await readStableTailRecords(generation.path);
        if (tail.integrity !== "complete") continue;
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
      || signals.pendingOperationConversationIds.has(conversationId);
    if (hasPendingWork) return true;
    if (conversation.turn.state === "terminal") return false;
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
  orchestratorSeats?: typeof activeOrchestratorSeats;
  refreshTranscriptState?: (registry: AgentRegistry) => Promise<void>;
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
    orchestratorRestartRecoveryTargets(registry, orchestratorSeats()),
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
  await (dependencies.refreshTranscriptState ?? refreshStructuredTranscriptState)(registry);
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
  );
  const adoptionCandidates = Object.values(registry.readOnlySnapshot().entries).filter((entry) =>
    entry.structuredHost && shouldAdopt(entry));
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
    candidateHostKeys.has(sessionKeyId(entry.key)) || shouldAdopt(entry);
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
  );
  const finalHostKeys = new Set(nextAdoptedHosts.map((item) => sessionKeyId(item.key)));
  const shouldPublish: StructuredHostAdoptionFilter = (entry) =>
    finalHostKeys.has(sessionKeyId(entry.key)) || finalShouldAdopt(entry);
  const interruptedCodex = interruptedCodexConversations(
    registry,
    shouldPublish,
    signals.hostedRunningConversationIds,
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
  if (controllerBoundEarly) await completeStructuredDeliveryQueueStartup(nextAdoptedHosts);
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
