import { accountManager } from "@/lib/accounts/manager";
import { claudeSettingsPath } from "@/lib/accounts/claude";
import { turnStateFromRecords } from "@/lib/accounts/migration/turnState";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { agentRegistry, type AgentRegistry, type AgentRegistryEntry } from "@/lib/agent/registry";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import { VIEWER_SPAWN_CAPABILITY_ENV } from "@/lib/agent/spawnPolicy";
import { readStableTailRecords } from "@/lib/scanner/activity";

import {
  adoptClaudeRegistryHosts,
  adoptCodexRegistryHosts,
  demoteSkippedStructuredRegistryHosts,
  type AdoptedClaudeHost,
  type AdoptedCodexHost,
  type StructuredHostAdoptionFilter,
} from "./registry";
import { runtimeHostClient, type RuntimeHostClient } from "./client";
import { bindStructuredDeliveryQueue } from "./structuredDeliveryController";
import { recoverPendingStructuredSpawns } from "./structuredSpawn";

type AdoptedStructuredHost = AdoptedCodexHost | AdoptedClaudeHost;
let adoptedHosts: AdoptedStructuredHost[] = [];

const RUNTIME_EFFECT_PAGE_SIZE = 100;
const STRUCTURED_HOST_OPERATION_EFFECT_KINDS = [
  "runtime.send",
  "runtime.steer",
  "runtime.interrupt",
  "runtime.answer",
  "runtime.spawn",
] as const;

interface StructuredStartupSignals {
  hostedRunningConversationIds: ReadonlySet<string>;
  pendingOperationConversationIds: ReadonlySet<string>;
}

const TRANSCRIPT_REFRESH_CONCURRENCY = 16;

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
      || receipt.status === "delivering")
    .filter((receipt) => receipt.kind !== "kill")
    .map((receipt) => canonicalConversationId(registry, receipt.conversationId)));
  let afterEventSeq = 0;
  while (true) {
    const batch = await client.effectBatch(STRUCTURED_HOST_OPERATION_EFFECT_KINDS, afterEventSeq);
    for (const effect of batch) {
      const conversationId = effect.payload.conversationId;
      if (typeof conversationId === "string") {
        pendingOperationConversationIds.add(canonicalConversationId(registry, conversationId));
      }
    }
    if (batch.length < RUNTIME_EFFECT_PAGE_SIZE) break;
    const next = Math.max(...batch.map((effect) => effect.eventSeq));
    if (!Number.isSafeInteger(next) || next <= afterEventSeq) {
      throw new Error("structured startup operation page did not advance");
    }
    afterEventSeq = next;
  }
  return { hostedRunningConversationIds, pendingOperationConversationIds };
}

function structuredStartupAdoptionFilter(
  registry: AgentRegistry,
  signals: StructuredStartupSignals,
): StructuredHostAdoptionFilter {
  const snapshot = registry.snapshot();
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
  const registry = dependencies.registry ?? agentRegistry();
  await refreshStructuredTranscriptState(registry);
  const client = dependencies.client === undefined ? runtimeHostClient() : dependencies.client;
  const signals = await structuredStartupSignals(registry, client);
  const shouldAdopt = structuredStartupAdoptionFilter(registry, signals);
  const resolveCodexOwner = dependencies.resolveCodexOwner ?? ((entry: AgentRegistryEntry) =>
    accountManager.resolveTranscriptOwner("codex", entry.artifactPath));
  const resolveClaudeOwner = dependencies.resolveClaudeOwner ?? ((entry: AgentRegistryEntry) =>
    accountManager.resolveTranscriptOwner("claude", entry.artifactPath));
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
        ...(capability ? { env: { ...process.env, [VIEWER_SPAWN_CAPABILITY_ENV]: capability } } : {}),
      };
    },
    process.env,
    shouldAdopt,
  );
  const claude = await (dependencies.adoptClaude ?? adoptClaudeRegistryHosts)(
    registry,
    (entry) => {
      const owner = resolveClaudeOwner(entry);
      const capability = registry.rotateSpawnCapabilityForPath(entry.artifactPath);
      const env: NodeJS.ProcessEnv | undefined = capability
        ? Object.assign({} as NodeJS.ProcessEnv, owner?.env, { [VIEWER_SPAWN_CAPABILITY_ENV]: capability })
        : owner?.env;
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
    process.env,
    shouldAdopt,
  );
  adoptedHosts = [...codex, ...claude];
  await demoteSkippedStructuredRegistryHosts(registry, shouldAdopt);
  await bindStructuredDeliveryQueue(adoptedHosts, { registry: dependencies.registry, client });
  if (client) await recoverPendingStructuredSpawns(registry, client);
  return adoptedHosts;
}

export function structuredStartupHosts(): readonly AdoptedStructuredHost[] {
  return adoptedHosts;
}
