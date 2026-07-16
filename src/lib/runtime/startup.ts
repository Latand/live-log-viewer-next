import { accountManager } from "@/lib/accounts/manager";
import { claudeSettingsPath } from "@/lib/accounts/claude";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { agentRegistry, type AgentRegistry, type AgentRegistryEntry } from "@/lib/agent/registry";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import { VIEWER_SPAWN_CAPABILITY_ENV } from "@/lib/agent/spawnPolicy";
import { assertDarwinStructuredRuntime } from "@/lib/proc/darwinIdentity";

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
  "runtime.kill",
  "runtime.spawn",
] as const;

interface StructuredStartupSignals {
  hostedRunningConversationIds: ReadonlySet<string>;
  pendingOperationConversationIds: ReadonlySet<string>;
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
  assertDarwinStructuredRuntime();
  const registry = dependencies.registry ?? agentRegistry();
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
