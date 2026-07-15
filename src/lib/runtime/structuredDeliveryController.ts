import crypto from "node:crypto";

import { agentRegistry, type AgentRegistry, type AgentRegistryEntry } from "@/lib/agent/registry";
import { sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";

import { runtimeHostClient, type RuntimeHostClient } from "./client";
import type { EngineHost, HostState } from "./engineHost";
import { runtimeClientDeliveryPort, StructuredDeliveryQueue } from "./structuredDeliveryQueue";
import { projectEngineHostEvent } from "./engineHostEvents";
import { setStructuredDeliveryKick } from "./structuredDeliverySignal";

type ObservableEngineHost = EngineHost & { onStateChange(listener: (state: HostState) => void): () => void };
export interface StructuredDeliveryHost {
  key: SessionKey;
  host: ObservableEngineHost;
}

const DELIVERY_DRAIN_COALESCE_MS = 25;
const DELIVERY_DRAIN_MAX_BACKOFF_MS = 1_000;

/* Next standalone bundles instrumentation and route handlers separately, so a
   module-level `let` written by startup adoption is invisible to routes. The
   controller registration must live on `globalThis`, like every other
   cross-bundle singleton in this codebase (see scanner/caches.ts). */
interface ControllerState {
  activeQueue: StructuredDeliveryQueue | null;
  activeHosts: Map<string, EngineHost> | null;
  registerActiveHost: ((item: StructuredDeliveryHost) => Promise<() => Promise<void>>) | null;
  releaseActiveHost: ((key: SessionKey) => Promise<boolean>) | null;
  terminateActiveHost: ((key: SessionKey) => Promise<boolean>) | null;
  stopActive: () => void;
}
const controllerStore = globalThis as typeof globalThis & { __llvStructuredDeliveryController?: ControllerState };
const state: ControllerState = controllerStore.__llvStructuredDeliveryController ??= {
  activeQueue: null,
  activeHosts: null,
  registerActiveHost: null,
  releaseActiveHost: null,
  terminateActiveHost: null,
  stopActive: () => {},
};

function entryForHost(registry: AgentRegistry, adopted: StructuredDeliveryHost): AgentRegistryEntry | null {
  return registry.snapshot().entries[sessionKeyId(adopted.key)] ?? null;
}

function conversationIdForEntry(registry: AgentRegistry, entry: AgentRegistryEntry): string | null {
  return registry.conversationForPath(entry.artifactPath)?.id ?? null;
}

function deliveryStateKey(state: HostState): string {
  return JSON.stringify([state.status, state.activeTurnRef]);
}

function hostProjectionKey(state: HostState): string {
  return JSON.stringify([state.status, state.activeTurnRef, state.pendingAttention]);
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
  state.stopActive();
  state.stopActive = () => {};
  state.activeQueue = null;
  state.activeHosts = null;
  state.registerActiveHost = null;
  state.releaseActiveHost = null;
  state.terminateActiveHost = null;
  setStructuredDeliveryKick(null);
  const client = dependencies.client === undefined ? runtimeHostClient() : dependencies.client;
  if (!client) return;
  const registry = dependencies.registry ?? agentRegistry();
  const hosts = new Map<string, EngineHost>();
  const queue = new StructuredDeliveryQueue(
    runtimeClientDeliveryPort(client),
    hostResolver(registry, hosts),
    async (conversationId, expectedKey) => {
      if (await state.terminateActiveHost?.(expectedKey)) return true;
      const terminated = registry.terminateInactiveStructuredHost(
        conversationId as `conversation_${string}`,
        expectedKey,
      );
      if (!terminated) return false;
      if (terminated === "current") await refreshCurrentProjection(conversationId);
      return true;
    },
  );
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  let drainBackoffMs = DELIVERY_DRAIN_COALESCE_MS;
  let stopped = false;
  const scheduleDrain = (delayMs = DELIVERY_DRAIN_COALESCE_MS): boolean => {
    if (stopped || drainTimer) return false;
    drainTimer = setTimeout(() => {
      drainTimer = null;
      if (stopped) return;
      void drainWithRetry();
    }, delayMs);
    drainTimer.unref?.();
    return true;
  };
  const drainWithRetry = async (): Promise<void> => {
    try {
      await queue.drain();
      drainBackoffMs = DELIVERY_DRAIN_COALESCE_MS;
    } catch (error) {
      if (stopped) return;
      const retryMs = drainBackoffMs;
      const retryScheduled = scheduleDrain(retryMs);
      if (retryScheduled) {
        drainBackoffMs = Math.min(retryMs * 2, DELIVERY_DRAIN_MAX_BACKOFF_MS);
      }
      console.error(
        retryScheduled
          ? "[structured delivery] queue drain failed; retry scheduled"
          : "[structured delivery] queue drain failed; retry already pending",
        error,
      );
    }
  };
  const requestDrain = () => {
    if (state.activeQueue === queue) scheduleDrain();
  };
  const registrations = new Map<string, { key: SessionKey; host: ObservableEngineHost; unsubscribe: () => void; stopEvents: () => Promise<void> }>();
  const publishChains = new Map<string, Promise<void>>();
  const projectionEpoch = crypto.randomUUID();
  let projectionRevision = 0;
  const republishCurrentHosts = async (): Promise<Set<string>> => {
    const republished = new Set<string>();
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
      republished.add(conversationId);
    }
    return republished;
  };
  const publishCurrentFallback = async (conversationId: string): Promise<void> => {
    const conversation = registry.conversation(conversationId as `conversation_${string}`);
    const generation = conversation?.generations.at(-1);
    if (!conversation || !generation) return;
    const key = { engine: conversation.engine, sessionId: generation.id } as const;
    const entry = registry.snapshot().entries[sessionKeyId(key)] ?? null;
    const legacy = entry?.host?.kind === "tmux";
    const host = entry?.status === "dead"
      ? "dead"
      : legacy && entry?.status !== "unhosted"
        ? "hosted"
        : "unhosted";
    const turn = entry?.status === "live" ? "running" : entry?.status === "idle" ? "idle" : "unknown";
    projectionRevision += 1;
    await client.append({
      scope: { type: "session", id: conversationId },
      kind: "session-status",
      producer: {
        kind: entry?.structuredHost?.kind ?? "structured-delivery-controller",
        eventKey: `projection:${projectionEpoch}:${projectionRevision}`,
      },
      payload: {
        conversationId,
        sessionKey: key,
        hostKind: entry?.structuredHost?.kind ?? (legacy ? "tmux-legacy" : "unhosted"),
        host: entry?.structuredHost && entry.status === "dead" ? "dead" : host,
        turn,
        provenance: entry?.structuredHost ? "structured" : "derived",
        accountId: entry?.accountId ?? generation.accountId,
        parentConversationId: generation.launchProfile.parentConversationId,
        cwd: entry?.cwd ?? generation.launchProfile.cwd,
        artifactPath: generation.path,
        capabilities: entry?.structuredHost
          ? { steer: entry.structuredHost.kind === "codex-app-server", structuredAttention: true }
          : { steer: false, structuredAttention: false },
        activeTurnId: null,
      },
    });
  };
  const refreshCurrentProjection = async (conversationId: string | null): Promise<void> => {
    const republished = await republishCurrentHosts();
    if (conversationId && !republished.has(conversationId)) await publishCurrentFallback(conversationId);
  };
  const unregisterHost = async (key: string, host: EngineHost): Promise<void> => {
    const registered = registrations.get(key);
    if (registered?.host !== host) return;
    const discardedEntry = entryForHost(registry, registered);
    const conversationId = discardedEntry ? conversationIdForEntry(registry, discardedEntry) : null;
    registered.unsubscribe();
    await registered.stopEvents();
    registrations.delete(key);
    hosts.delete(key);
    const pendingPublications = publishChains.get(key);
    if (pendingPublications) {
      await pendingPublications;
      if (publishChains.get(key) === pendingPublications) publishChains.delete(key);
    }
    await refreshCurrentProjection(conversationId);
  };
  const register = async (item: StructuredDeliveryHost): Promise<() => Promise<void>> => {
    const key = sessionKeyId(item.key);
    const current = registrations.get(key);
    if (current?.host === item.host) return async () => {};
    if (current) await unregisterHost(key, current.host);
    const initialState = await item.host.health();
    await publishHostState(client, registry, item, initialState);
    hosts.set(key, item.host);
    requestDrain();
    const observable = item.host as ObservableEngineHost;
    let deliveryState = deliveryStateKey(initialState);
    let projectedState = hostProjectionKey(initialState);
    const unsubscribe = observable.onStateChange((state) => {
      const nextDeliveryState = deliveryStateKey(state);
      const nextProjectedState = hostProjectionKey(state);
      const previous = publishChains.get(key) ?? Promise.resolve();
      const next = previous
        .then(async () => {
          if (nextProjectedState !== projectedState) {
            await publishHostState(client, registry, item, state);
            projectedState = nextProjectedState;
          }
          if (nextDeliveryState === deliveryState) return;
          deliveryState = nextDeliveryState;
          requestDrain();
        })
        .catch(() => { console.error("[structured delivery] host state sync failed"); });
      publishChains.set(key, next);
    });
    const entry = entryForHost(registry, item);
    const conversationId = entry ? conversationIdForEntry(registry, entry) : null;
    let acknowledgedEventCursor = 0;
    if (conversationId) {
      /* Runtime-host producer receipts advance after the projected event commits.
         Registry cursors track the engine ledger and can lead this acknowledgement
         during a crash, so they cannot safely skip replay here. */
      try {
        acknowledgedEventCursor = await client.producerCursor(
          item.key.engine === "codex" ? "codex-app-server" : "claude-broker",
          `engine-host:${key}:`,
        );
      } catch {
        console.error("[structured delivery] producer cursor unavailable; replaying host events");
      }
    }
    const events = item.host.attach(acknowledgedEventCursor)[Symbol.asyncIterator]();
    let eventsStopped = false;
    void (async () => {
      if (!conversationId) return;
      while (!eventsStopped) {
        const next = await events.next();
        if (next.done) return;
        const projected = projectEngineHostEvent(conversationId, key, next.value);
        if (!projected) continue;
        while (!eventsStopped) {
          try {
            await client.append(projected);
            break;
          } catch {
            await new Promise<void>((resolve) => setTimeout(resolve, 100));
          }
        }
      }
    })().catch(() => {
      if (!eventsStopped) console.error("[structured delivery] engine event sync failed");
    });
    const stopEvents = async () => {
      if (eventsStopped) return;
      eventsStopped = true;
      void events.return?.().catch(() => {});
    };
    registrations.set(key, { key: item.key, host: item.host, unsubscribe, stopEvents });
    return () => unregisterHost(key, item.host);
  };
  state.activeHosts = hosts;
  state.registerActiveHost = register;
  state.releaseActiveHost = async (key) => {
    const id = sessionKeyId(key);
    const registered = registrations.get(id);
    if (!registered) {
      const discardedEntry = registry.snapshot().entries[id] ?? null;
      await refreshCurrentProjection(discardedEntry ? conversationIdForEntry(registry, discardedEntry) : null);
      return false;
    }
    try {
      await unregisterHost(id, registered.host);
    } finally {
      await registered.host.release();
    }
    return true;
  };
  state.terminateActiveHost = async (key) => {
    const id = sessionKeyId(key);
    const registered = registrations.get(id);
    if (!registered) return false;
    await registered.host.release();
    registry.terminateStructuredHost(key);
    await unregisterHost(id, registered.host);
    return true;
  };
  for (const item of adopted) {
    await register(item);
  }
  const startupSnapshot = registry.snapshot();
  for (const conversation of Object.values(startupSnapshot.conversations)) {
    const generation = conversation.generations.at(-1);
    if (!generation) continue;
    const id = sessionKeyId({ engine: conversation.engine, sessionId: generation.id });
    if (registrations.has(id)) continue;
    const entry = startupSnapshot.entries[id];
    if (!entry?.structuredHost && entry?.host?.kind !== "tmux") continue;
    await publishCurrentFallback(conversation.id);
  }
  state.activeQueue = queue;
  setStructuredDeliveryKick(() => {
    if (stopped) return;
    if (drainTimer) clearTimeout(drainTimer);
    drainTimer = null;
    return drainWithRetry();
  });
  state.stopActive = () => {
    stopped = true;
    if (drainTimer) clearTimeout(drainTimer);
    drainTimer = null;
    for (const registration of registrations.values()) {
      registration.unsubscribe();
      void registration.stopEvents();
    }
    registrations.clear();
    hosts.clear();
    if (state.activeQueue === queue) {
      state.activeQueue = null;
      state.activeHosts = null;
      state.registerActiveHost = null;
      state.releaseActiveHost = null;
      state.terminateActiveHost = null;
      setStructuredDeliveryKick(null);
    }
  };
  await queue.drain();
}

export function hasStructuredDeliveryHost(key: SessionKey): boolean {
  return state.activeHosts?.has(sessionKeyId(key)) ?? false;
}

export async function publishStructuredDeliveryHost(item: StructuredDeliveryHost): Promise<() => Promise<void>> {
  if (!state.registerActiveHost) throw new Error("structured delivery controller is unavailable");
  return state.registerActiveHost(item);
}

export async function releaseStructuredDeliveryHost(key: SessionKey): Promise<boolean> {
  return await state.releaseActiveHost?.(key) ?? false;
}
