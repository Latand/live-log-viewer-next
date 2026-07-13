import crypto from "node:crypto";

import { agentRegistry, type AgentRegistry, type AgentRegistryEntry } from "@/lib/agent/registry";
import { sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";

import { runtimeHostClient, type RuntimeHostClient } from "./client";
import type { EngineHost, HostState } from "./engineHost";
import { runtimeClientDeliveryPort, StructuredDeliveryQueue } from "./structuredDeliveryQueue";
import { setStructuredDeliveryKick } from "./structuredDeliverySignal";

type ObservableEngineHost = EngineHost & { onStateChange(listener: (state: HostState) => void): () => void };
export interface StructuredDeliveryHost {
  key: SessionKey;
  host: ObservableEngineHost;
}

let activeQueue: StructuredDeliveryQueue | null = null;
let activeHosts: Map<string, EngineHost> | null = null;
let registerActiveHost: ((item: StructuredDeliveryHost) => Promise<() => Promise<void>>) | null = null;
let releaseActiveHost: ((key: SessionKey) => Promise<boolean>) | null = null;
let stopActive = () => {};

function entryForHost(registry: AgentRegistry, adopted: StructuredDeliveryHost): AgentRegistryEntry | null {
  return registry.snapshot().entries[sessionKeyId(adopted.key)] ?? null;
}

function conversationIdForEntry(registry: AgentRegistry, entry: AgentRegistryEntry): string | null {
  return registry.conversationForPath(entry.artifactPath)?.id ?? null;
}

function hostResolver(
  registry: AgentRegistry,
  hosts: ReadonlyMap<string, EngineHost>,
): (conversationId: string) => EngineHost | null {
  return (conversationId) => {
    const conversation = registry.conversation(conversationId as `conversation_${string}`);
    const generation = conversation?.generations.at(-1);
    if (!conversation || !generation) return null;
    return hosts.get(sessionKeyId({ engine: conversation.engine, sessionId: generation.id })) ?? null;
  };
}

async function publishHostState(
  client: RuntimeHostClient,
  registry: AgentRegistry,
  adopted: StructuredDeliveryHost,
  state: HostState,
  projectionKey?: string,
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
        ...(projectionKey ? [projectionKey] : []),
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
  adopted: readonly StructuredDeliveryHost[],
  dependencies: { registry?: AgentRegistry; client?: RuntimeHostClient | null } = {},
): Promise<void> {
  stopActive();
  stopActive = () => {};
  activeQueue = null;
  activeHosts = null;
  registerActiveHost = null;
  releaseActiveHost = null;
  setStructuredDeliveryKick(null);
  const client = dependencies.client === undefined ? runtimeHostClient() : dependencies.client;
  if (!client) return;
  const registry = dependencies.registry ?? agentRegistry();
  const hosts = new Map<string, EngineHost>();
  const queue = new StructuredDeliveryQueue(runtimeClientDeliveryPort(client), hostResolver(registry, hosts));
  const registrations = new Map<string, { key: SessionKey; host: ObservableEngineHost; unsubscribe: () => void }>();
  const publishChains = new Map<string, Promise<void>>();
  const projectionEpoch = crypto.randomUUID();
  let projectionRevision = 0;
  const republishCurrentHosts = async (): Promise<void> => {
    for (const registration of registrations.values()) {
      const entry = entryForHost(registry, registration);
      if (!entry) continue;
      const conversationId = conversationIdForEntry(registry, entry);
      if (!conversationId) continue;
      const conversation = registry.conversation(conversationId as `conversation_${string}`);
      const generation = conversation?.generations.at(-1);
      if (!conversation || !generation) continue;
      if (sessionKeyId({ engine: conversation.engine, sessionId: generation.id }) !== sessionKeyId(registration.key)) continue;
      projectionRevision += 1;
      await publishHostState(
        client,
        registry,
        registration,
        await registration.host.health(),
        `projection:${projectionEpoch}:${projectionRevision}`,
      );
    }
  };
  const unregisterHost = async (key: string, host: EngineHost): Promise<void> => {
    const registered = registrations.get(key);
    if (registered?.host !== host) return;
    registered.unsubscribe();
    registrations.delete(key);
    hosts.delete(key);
    const pendingPublications = publishChains.get(key);
    if (pendingPublications) {
      await pendingPublications;
      if (publishChains.get(key) === pendingPublications) publishChains.delete(key);
    }
    await republishCurrentHosts();
  };
  const register = async (item: StructuredDeliveryHost): Promise<() => Promise<void>> => {
    const key = sessionKeyId(item.key);
    const current = registrations.get(key);
    if (current?.host === item.host) return async () => {};
    const state = await item.host.health();
    await publishHostState(client, registry, item, state);
    current?.unsubscribe();
    registrations.delete(key);
    hosts.set(key, item.host);
    const observable = item.host as ObservableEngineHost;
    const unsubscribe = observable.onStateChange((state) => {
      const previous = publishChains.get(key) ?? Promise.resolve();
      const next = previous
        .then(() => publishHostState(client, registry, item, state))
        .then(() => queue.drain())
        .catch(() => { console.error("[structured delivery] host state sync failed"); });
      publishChains.set(key, next);
    });
    registrations.set(key, { key: item.key, host: item.host, unsubscribe });
    return () => unregisterHost(key, item.host);
  };
  activeHosts = hosts;
  registerActiveHost = register;
  releaseActiveHost = async (key) => {
    const id = sessionKeyId(key);
    const registered = registrations.get(id);
    if (!registered) {
      await republishCurrentHosts();
      return false;
    }
    try {
      await unregisterHost(id, registered.host);
    } finally {
      await registered.host.release();
    }
    return true;
  };
  for (const item of adopted) {
    await register(item);
  }
  activeQueue = queue;
  setStructuredDeliveryKick(() => queue.drain().catch(() => {
    console.error("[structured delivery] queue drain failed");
  }));
  stopActive = () => {
    for (const registration of registrations.values()) registration.unsubscribe();
    registrations.clear();
    hosts.clear();
    if (activeQueue === queue) {
      activeQueue = null;
      activeHosts = null;
      registerActiveHost = null;
      releaseActiveHost = null;
      setStructuredDeliveryKick(null);
    }
  };
  await queue.drain();
}

export function hasStructuredDeliveryHost(key: SessionKey): boolean {
  return activeHosts?.has(sessionKeyId(key)) ?? false;
}

export async function publishStructuredDeliveryHost(item: StructuredDeliveryHost): Promise<() => Promise<void>> {
  if (!registerActiveHost) throw new Error("structured delivery controller is unavailable");
  return registerActiveHost(item);
}

export async function releaseStructuredDeliveryHost(key: SessionKey): Promise<boolean> {
  return await releaseActiveHost?.(key) ?? false;
}
