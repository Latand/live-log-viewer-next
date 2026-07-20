import { accountManager } from "@/lib/accounts/manager";
import { claudeSettingsPath } from "@/lib/accounts/claude";
import { turnStateFromRecords } from "@/lib/accounts/migration/turnState";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { agentRegistry, type AgentRegistry, type AgentRegistryEntry, type RegistryFile } from "@/lib/agent/registry";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import { VIEWER_SPAWN_CAPABILITY_ENV } from "@/lib/agent/spawnPolicy";
import { assertDarwinStructuredRuntime } from "@/lib/proc/darwinIdentity";
import { readStableTailRecords } from "@/lib/scanner/activity";
import { withoutWakatimeCredential } from "@/lib/wakatime/credential";

import {
  adoptClaudeRegistryHosts,
  adoptCodexRegistryHosts,
  demoteSkippedStructuredRegistryHosts,
  type AdoptedClaudeHost,
  type AdoptedCodexHost,
  type StructuredHostAdoptionFilter,
} from "./registry";
import { runtimeHostClient, type RuntimeHostClient } from "./client";
import type { RuntimeOperationResult } from "./contracts";
import { bindStructuredDeliveryQueue } from "./structuredDeliveryController";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { recoverPendingStructuredSpawns } from "./structuredSpawn";

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
): boolean {
  const key = sessionKeyId(item.key);
  const entry = snapshot.entries[key];
  if (!entry?.structuredHost || entry.status === "dead" || entry.status === "unhosted") return false;
  const conversation = Object.values(snapshot.conversations).find((candidate) =>
    candidate.engine === item.key.engine
      && candidate.generations.at(-1)?.id === item.key.sessionId);
  return Boolean(conversation
    && conversation.turn.state !== "terminal"
    && !conversation.supersededBy);
}

async function revalidateRetainedStartupHosts(
  registry: AgentRegistry,
  retained: readonly AdoptedStructuredHost[],
  snapshot: RegistryFile = registry.snapshot(),
): Promise<AdoptedStructuredHost[]> {
  const current: AdoptedStructuredHost[] = [];
  for (const item of retained) {
    if (retainedStartupHostIsCurrent(snapshot, item)) current.push(item);
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
] as const;

interface StructuredStartupSignals {
  hostedRunningConversationIds: ReadonlySet<string>;
  pendingOperationConversationIds: ReadonlySet<string>;
  pendingCodexContinuationConversationIds: ReadonlySet<string>;
}

const TRANSCRIPT_REFRESH_CONCURRENCY = 16;
const INTERRUPTED_CODEX_CONTINUATION_OPERATION_PREFIX = "recovery-continuation";
const INTERRUPTED_CODEX_CONTINUATION_TEXT = "Continue the interrupted turn from the transcript.";

function interruptedCodexContinuationOperationId(sessionId: string, claimEpoch: number): string {
  return `${INTERRUPTED_CODEX_CONTINUATION_OPERATION_PREFIX}-${sessionId}-${claimEpoch}`;
}

function interruptedCodexConversations(
  registry: AgentRegistry,
  shouldAdopt: StructuredHostAdoptionFilter,
  runtimeRunningConversationIds: ReadonlySet<string>,
  snapshot: RegistryFile = registry.snapshot(),
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
    const entry = registry.snapshot().entries[key];
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
    const entry = registry.snapshot().entries[key];
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
  if (engine === "claude") return turnStateFromRecords(records, false);
  if (!prefixTruncated) return turnStateFromRecords(records, true, true);

  const turnStartIndex = records.findLastIndex((record) => {
    const payload = record.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    const type = (payload as Record<string, unknown>).type;
    return type === "task_started" || type === "turn_started" || type === "user_message";
  });
  if (turnStartIndex < 0) {
    const turn = turnStateFromRecords(records, true, true);
    return turn.state === "terminal"
      ? { state: "unknown" as const, source: "empty" as const, terminalAt: null }
      : turn;
  }
  return turnStateFromRecords(records.slice(turnStartIndex), true, true);
}

async function refreshStructuredTranscriptState(registry: AgentRegistry): Promise<void> {
  const snapshot = registry.snapshot();
  const observedAt = new Date().toISOString();
  const candidates = Object.values(snapshot.conversations).flatMap((conversation) => {
    const generation = conversation.generations.at(-1);
    if (!generation) return [];
    const entry = snapshot.entries[sessionKeyId({ engine: conversation.engine, sessionId: generation.id })];
    return entry?.structuredHost ? [{ conversation, generation }] : [];
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
  snapshot: RegistryFile = registry.snapshot(),
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
    const conversationId = registry.canonicalConversationId(conversation.id);
    const hasPendingWork = pendingDeliveryConversationIds.has(conversationId)
      || signals.pendingOperationConversationIds.has(conversationId);
    if (hasPendingWork) return true;
    if (conversation.turn.state === "terminal") return false;
    const runtimeHostedRunning = signals.hostedRunningConversationIds.has(conversationId);
    const unfinishedTurn = conversation.turn.state === "busy"
      || Boolean(entry.structuredHost?.activeTurnRef)
      || runtimeHostedRunning;
    const liveHost = entry.status === "live" || runtimeHostedRunning;
    return liveHost && unfinishedTurn;
  };
}

export interface StructuredStartupDependencies {
  registry?: AgentRegistry;
  client?: RuntimeHostClient | null;
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
  await refreshStructuredTranscriptState(registry);
  let nextAdoptedHosts = await revalidateRetainedStartupHosts(registry, retryAdoptedHosts);
  retryAdoptedHosts = nextAdoptedHosts;
  const client = dependencies.client === undefined ? runtimeHostClient() : dependencies.client;
  const signals = await structuredStartupSignals(registry, client);
  const shouldAdopt = structuredStartupAdoptionFilter(registry, signals);
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
      return {
        cwd: entry.cwd,
        codexHome: owner?.home,
        fileAuthCredentials: owner?.kind === "managed",
        model: entry.launchProfile?.model ?? undefined,
        effort: entry.launchProfile?.effort ?? undefined,
        env: {
          ...startupEnvironment,
          ...(capability ? { [VIEWER_SPAWN_CAPABILITY_ENV]: capability } : {}),
        },
      };
    },
    startupEnvironment,
    shouldAdopt,
  );
  nextAdoptedHosts = retainAdoptedHosts(nextAdoptedHosts, codex);
  retryAdoptedHosts = nextAdoptedHosts;
  const claude = await (dependencies.adoptClaude ?? adoptClaudeRegistryHosts)(
    registry,
    (entry) => {
      const owner = resolveClaudeOwner(entry);
      const capability = registry.rotateSpawnCapabilityForPath(entry.artifactPath);
      const env = withoutWakatimeCredential(owner?.env ?? startupEnvironment);
      if (capability) env[VIEWER_SPAWN_CAPABILITY_ENV] = capability;
      return {
        cwd: entry.cwd,
        claudeConfigDir: owner?.kind === "managed" ? owner.home : undefined,
        claudeProjectsDir: owner?.transcriptRoot,
        spawnPolicyBaseSettingsPath: owner?.kind === "managed" ? claudeSettingsPath() : null,
        allowSubagents: entry.launchProfile?.allowSubagents ?? false,
        env,
        model: entry.launchProfile?.model ?? undefined,
        effort: entry.launchProfile?.effort ?? undefined,
        permissionMode: entry.launchProfile?.permissionMode ?? undefined,
      };
    },
    startupEnvironment,
    shouldAdopt,
  );
  nextAdoptedHosts = retainAdoptedHosts(nextAdoptedHosts, claude);
  retryAdoptedHosts = nextAdoptedHosts;
  const candidateHostKeys = new Set(nextAdoptedHosts.map((item) => sessionKeyId(item.key)));
  const shouldRetainCandidateOrAdopt: StructuredHostAdoptionFilter = (entry) =>
    candidateHostKeys.has(sessionKeyId(entry.key)) || shouldAdopt(entry);
  const candidateCodexHosts = nextAdoptedHosts.filter(
    (item): item is AdoptedCodexHost => item.key.engine === "codex",
  );
  const existingCodexContinuations = client
    ? await interruptedCodexContinuations(registry, client, candidateCodexHosts)
    : new Map<string, RuntimeOperationResult>();
  await demoteSkippedStructuredRegistryHosts(registry, shouldRetainCandidateOrAdopt);
  const publicationSnapshot = registry.snapshot();
  nextAdoptedHosts = await revalidateRetainedStartupHosts(registry, nextAdoptedHosts, publicationSnapshot);
  retryAdoptedHosts = nextAdoptedHosts;
  const finalShouldAdopt = structuredStartupAdoptionFilter(registry, signals, publicationSnapshot);
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
    (item): item is AdoptedCodexHost => item.key.engine === "codex",
  );
  await bindStructuredDeliveryQueue(nextAdoptedHosts, { registry: dependencies.registry, client });
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
  return adoptedHosts;
}

export function structuredStartupHosts(): readonly AdoptedStructuredHost[] {
  return adoptedHosts;
}
