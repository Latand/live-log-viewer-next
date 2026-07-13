import { agentRegistry, type AgentRegistry, type AgentRegistryEntry } from "@/lib/agent/registry";
import { sessionKeyId } from "@/lib/agent/sessionKey";

import { runtimeHostClient, type RuntimeHostClient } from "./client";
import type { EngineHost, HostState } from "./engineHost";
import type { AdoptedClaudeHost, AdoptedCodexHost } from "./registry";
import { runtimeClientDeliveryPort, StructuredDeliveryQueue } from "./structuredDeliveryQueue";
import { setStructuredDeliveryKick } from "./structuredDeliverySignal";

type AdoptedStructuredHost = AdoptedCodexHost | AdoptedClaudeHost;
type ObservableEngineHost = EngineHost & { onStateChange(listener: (state: HostState) => void): () => void };

let activeQueue: StructuredDeliveryQueue | null = null;
let stopActive = () => {};

function entryForHost(registry: AgentRegistry, adopted: AdoptedStructuredHost): AgentRegistryEntry | null {
  return registry.snapshot().entries[sessionKeyId(adopted.key)] ?? null;
}

function conversationIdForEntry(registry: AgentRegistry, entry: AgentRegistryEntry): string | null {
  return registry.conversationForPath(entry.artifactPath)?.id ?? null;
}

function hostResolver(
  registry: AgentRegistry,
  adopted: readonly AdoptedStructuredHost[],
): (conversationId: string) => EngineHost | null {
  const hosts = new Map(adopted.map((item) => [sessionKeyId(item.key), item.host]));
  return (conversationId) => {
    const conversation = registry.conversation(conversationId as `conversation_${string}`);
    const generation = conversation?.generations.at(-1);
    if (!conversation || !generation) return null;
    const entry = Object.values(registry.snapshot().entries).find((candidate) =>
      candidate.artifactPath === generation.path && candidate.structuredHost !== null && candidate.structuredHost !== undefined);
    return entry ? hosts.get(sessionKeyId(entry.key)) ?? null : null;
  };
}

async function publishHostState(
  client: RuntimeHostClient,
  registry: AgentRegistry,
  adopted: AdoptedStructuredHost,
  state: HostState,
): Promise<void> {
  const entry = entryForHost(registry, adopted);
  if (!entry) return;
  const conversationId = conversationIdForEntry(registry, entry);
  if (!conversationId) return;
  const host = state.status === "dead" ? "dead" : state.status === "unhosted" ? "unhosted" : "hosted";
  const turn = state.activeTurnRef ? "running" : "idle";
  await client.append({
    scope: { type: "session", id: conversationId },
    kind: "session-status",
    producer: {
      kind: adopted.key.engine === "codex" ? "codex-app-server" : "claude-broker",
      eventKey: [
        "structured-host",
        sessionKeyId(adopted.key),
        entry.claimEpoch,
        state.eventCursor,
        state.status,
        state.activeTurnRef ?? "idle",
        state.pendingAttention.join(","),
      ].join(":"),
    },
    payload: {
      conversationId,
      sessionKey: adopted.key,
      hostKind: adopted.key.engine === "codex" ? "codex-app-server" : "claude-broker",
      host,
      turn,
      provenance: "structured",
      accountId: entry.accountId,
      parentConversationId: entry.launchProfile?.parentConversationId ?? null,
      cwd: entry.cwd,
      artifactPath: entry.artifactPath,
      capabilities: { steer: adopted.key.engine === "codex", structuredAttention: true },
      activeTurnId: state.activeTurnRef,
    },
  });
}

export async function bindStructuredDeliveryQueue(
  adopted: readonly AdoptedStructuredHost[],
  dependencies: { registry?: AgentRegistry; client?: RuntimeHostClient | null } = {},
): Promise<void> {
  stopActive();
  stopActive = () => {};
  activeQueue = null;
  setStructuredDeliveryKick(null);
  const client = dependencies.client === undefined ? runtimeHostClient() : dependencies.client;
  if (!client) return;
  const registry = dependencies.registry ?? agentRegistry();
  const queue = new StructuredDeliveryQueue(runtimeClientDeliveryPort(client), hostResolver(registry, adopted));
  const unsubscribers: Array<() => void> = [];
  const publishChains = new Map<string, Promise<void>>();
  for (const item of adopted) {
    const key = sessionKeyId(item.key);
    await publishHostState(client, registry, item, await item.host.health());
    const observable = item.host as ObservableEngineHost;
    unsubscribers.push(observable.onStateChange((state) => {
      const previous = publishChains.get(key) ?? Promise.resolve();
      const next = previous
        .then(() => publishHostState(client, registry, item, state))
        .then(() => queue.drain())
        .catch(() => { console.error("[structured delivery] host state sync failed"); });
      publishChains.set(key, next);
    }));
  }
  activeQueue = queue;
  setStructuredDeliveryKick(() => {
    void queue.drain().catch(() => { console.error("[structured delivery] queue drain failed"); });
  });
  stopActive = () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    if (activeQueue === queue) {
      activeQueue = null;
      setStructuredDeliveryKick(null);
    }
  };
  await queue.drain();
}
