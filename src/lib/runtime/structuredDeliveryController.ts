import crypto from "node:crypto";

import { requestAccountMigrationTick } from "@/lib/accounts/migration/controllerSignal";
import { agentRegistry, type AgentRegistry, type AgentRegistryEntry, type ProcessIdentity } from "@/lib/agent/registry";
import { sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";

import { isRuntimeHostTransportFailure, runtimeHostClient, type RuntimeHostClient } from "./client";
import { runtimeSettingsCapability, type RuntimeEventInput, type RuntimeSession } from "./contracts";
import type { EngineHost, HostState } from "./engineHost";
import { StructuredDeliveryQueue } from "./structuredDeliveryQueue";
import { applyStructuredReconfigure } from "./structuredReconfigure";
import { projectEngineHostEvent } from "./engineHostEvents";
import { publishFilesRevision } from "./filesRevision";
import { setStructuredDeliveryKick } from "./structuredDeliverySignal";
import { runtimeImageCapability } from "./runtimeImageStore";
import { STRUCTURED_IMAGE_CAPABILITY } from "./structuredContent";

type ObservableEngineHost = EngineHost & { onStateChange(listener: (state: HostState) => void): () => void };
type IdentityBoundEngineHost = ObservableEngineHost & {
  releaseIfOwned?(expected: Readonly<ProcessIdentity>): Promise<boolean>;
};
type StructuredConversationRecovery = typeof import("./structuredRecovery")["recoverDeadStructuredConversation"];
export interface StructuredDeliveryHost {
  key: SessionKey;
  host: ObservableEngineHost;
}

interface HostAttachment {
  unsubscribe: () => void;
  stopEvents: () => Promise<void>;
}

/* One lifecycle per host (#1191). The seat a delivery resolves the host from
   and the registration that owns its state subscription, event pump and
   projection are the same record. A host carried over from the predecessor
   takes its seat with `attachment` still null: resolvable from the instant the
   successor goes live, and filled in by the registration that follows. Giving
   the seat up sets `cancelled`, which that registration can no longer commit
   past — so a host released or terminated mid-registration stays gone. */
interface HostRegistration {
  key: SessionKey;
  host: ObservableEngineHost;
  attachment: HostAttachment | null;
  cancelled: boolean;
}

const DELIVERY_DRAIN_COALESCE_MS = 25;
const DELIVERY_DRAIN_MAX_BACKOFF_MS = 1_000;
const TERMINAL_RECONCILIATION_PAGE_SIZE = 16;
const TERMINAL_RECONCILIATION_SETTLEMENT_BATCH_SIZE = 256;

/* Next standalone can evaluate instrumentation and route handlers in separate
   bundle realms inside one Node process. Realm-local globals cannot carry the
   controller registration between those bundles. The injected `process`
   object is shared by the realms, so it owns the process-scoped controller. */
interface ControllerState {
  activeQueue: StructuredDeliveryQueue | null;
  activeRegistry: AgentRegistry | null;
  activeHosts: Map<string, EngineHost> | null;
  registerActiveHost: ((item: StructuredDeliveryHost, ownsOperation?: () => Promise<boolean>) => Promise<() => Promise<void>>) | null;
  /* The hosts this generation currently serves, as re-registrable items. A
     successor takes them over at the swap, so a rebind never leaves a
     conversation without a resolvable host (#1191). */
  activeRegistrations: (() => readonly StructuredDeliveryHost[]) | null;
  republishActiveHost: ((key: SessionKey) => Promise<boolean>) | null;
  releaseActiveHost: ((key: SessionKey) => Promise<boolean>) | null;
  terminateActiveHost: ((key: SessionKey, expected?: Readonly<ProcessIdentity>) => Promise<boolean>) | null;
  completeActive: ((adopted: readonly StructuredDeliveryHost[]) => Promise<void>) | null;
  stopActive: () => void;
  /* Distinguishes "this process hosts the controller and is between
     publications" from "this process never hosted one at all" (#1191). */
  everPublished?: boolean;
}
const controllerStore = process as typeof process & { __llvStructuredDeliveryController?: ControllerState };
const state: ControllerState = controllerStore.__llvStructuredDeliveryController ??= {
  activeQueue: null,
  activeRegistry: null,
  activeHosts: null,
  registerActiveHost: null,
  activeRegistrations: null,
  republishActiveHost: null,
  releaseActiveHost: null,
  terminateActiveHost: null,
  completeActive: null,
  stopActive: () => {},
  everPublished: false,
};

const CONTROLLER_UNAVAILABLE_CODE = "structured-delivery-controller-unavailable";

export class StructuredDeliveryControllerUnavailableError extends Error {
  readonly code = CONTROLLER_UNAVAILABLE_CODE;

  constructor() {
    super("structured delivery controller is unavailable");
    this.name = "StructuredDeliveryControllerUnavailableError";
  }
}

export function isStructuredDeliveryControllerUnavailable(error: unknown): boolean {
  return error instanceof StructuredDeliveryControllerUnavailableError
    || (typeof error === "object" && error !== null && "code" in error
      && error.code === CONTROLLER_UNAVAILABLE_CODE);
}

export function requireStructuredDeliveryControllerPublication(): NonNullable<ControllerState["registerActiveHost"]> {
  const publish = state.registerActiveHost;
  if (!publish) throw new StructuredDeliveryControllerUnavailableError();
  return publish;
}

/**
 * Whether THIS process can publish a structured host right now.
 *
 * `unbound` is the load-bearing case (#1191): a process that never bound the
 * queue — the account-migration inventory sidecar reconciles files, and
 * therefore ticks pipelines, in a child process — can never publish one, so a
 * caller there must hand the work to the process that owns the controller
 * instead of retrying into a failure that cannot resolve.
 */
export function structuredDeliveryPublicationState(): "ready" | "rebinding" | "unbound" {
  if (state.registerActiveHost) return "ready";
  return state.everPublished ? "rebinding" : "unbound";
}

/** Drops the current publication and stops the queue behind it. Only a bind
    with no replacement to install takes this path. */
function retireStructuredDeliveryPublication(): void {
  state.stopActive();
  state.stopActive = () => {};
  state.activeQueue = null;
  state.activeRegistry = null;
  state.activeHosts = null;
  state.registerActiveHost = null;
  state.activeRegistrations = null;
  state.republishActiveHost = null;
  state.releaseActiveHost = null;
  state.terminateActiveHost = null;
  state.completeActive = null;
  setStructuredDeliveryKick(null);
}

function entryForHost(registry: AgentRegistry, adopted: StructuredDeliveryHost): AgentRegistryEntry | null {
  return registry.readOnlySnapshot().entries[sessionKeyId(adopted.key)] ?? null;
}

function conversationIdForEntry(registry: AgentRegistry, entry: AgentRegistryEntry): string | null {
  return registry.conversationForPath(entry.artifactPath)?.id ?? null;
}

/** Migration phases that still have work left for an executor to do. Mirrors
    the coordinator's own in-flight set; a terminal phase wakes nothing. */
const IN_FLIGHT_MIGRATION_PHASES = new Set(["waiting-turn", "requested", "preparing", "successor-starting", "verifying"]);

function pendingAccountSwitch(registry: AgentRegistry, conversationId: string): boolean {
  if (!conversationId.startsWith("conversation_")) return false;
  const phase = registry.conversation(conversationId as `conversation_${string}`)?.migration?.phase;
  return phase !== undefined && IN_FLIGHT_MIGRATION_PHASES.has(phase);
}

function deliveryStateKey(state: HostState): string {
  return JSON.stringify([state.status, state.activeTurnRef]);
}

function hostProjectionKey(state: HostState): string {
  return JSON.stringify([state.status, state.activeTurnRef, state.pendingAttention]);
}

export async function publishStructuredHostProjection(
  client: RuntimeHostClient,
  event: RuntimeEventInput,
): Promise<void> {
  await client.append(event);
  await publishFilesRevision(client);
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

async function yieldControllerTurn(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function reconcileTerminalDeliveries(
  registry: AgentRegistry,
  client: RuntimeHostClient,
  isCurrent: () => boolean,
): Promise<void> {
  const unsettledDeliveries = Object.values(registry.readOnlySnapshot().heldDeliveries)
    .filter((delivery) => delivery.state === "delivery-uncertain" || delivery.state === "failed");
  const pendingOutcomes: Parameters<AgentRegistry["recordDeliveryOutcomesForOperations"]>[0][number][] = [];
  const flushOutcomes = () => {
    if (pendingOutcomes.length === 0) return;
    registry.recordDeliveryOutcomesForOperations(pendingOutcomes.splice(0));
  };
  for (let offset = 0; offset < unsettledDeliveries.length && isCurrent(); offset += TERMINAL_RECONCILIATION_PAGE_SIZE) {
    const page = unsettledDeliveries.slice(offset, offset + TERMINAL_RECONCILIATION_PAGE_SIZE);
    const outcomes = (await Promise.all(page.map(async (delivery) => {
      try {
        const result = await client.operationStatus(delivery.command.operationId, { currentRetryLeaf: true });
        if (!result) return null;
        const status = result.receipt.status;
        if (status !== "delivered" && status !== "failed" && status !== "rejected") return null;
        const receiptConversationId = result.receipt.conversationId;
        if (!receiptConversationId.startsWith("conversation_")
          || registry.canonicalConversationId(receiptConversationId as `conversation_${string}`)
            !== registry.canonicalConversationId(delivery.conversationId)) {
          console.error("[structured delivery] terminal receipt conversation mismatch", {
            operationId: delivery.command.operationId,
            deliveryConversationId: delivery.conversationId,
            receiptConversationId,
          });
          return null;
        }
        const state = status === "delivered" ? "delivered" as const : "failed" as const;
        if (delivery.state === "failed" && state === "failed") return null;
        return {
          conversationId: receiptConversationId as `conversation_${string}`,
          operationId: result.receipt.presentationOperationId ?? delivery.command.operationId,
          state,
          error: result.receipt.reason ?? null,
        };
      } catch (error) {
        console.error("[structured delivery] terminal receipt reconciliation failed", {
          operationId: delivery.command.operationId,
          conversationId: delivery.conversationId,
          error,
        });
        return null;
      }
    }))).filter((outcome): outcome is NonNullable<typeof outcome> => outcome !== null);
    if (!isCurrent()) return;
    pendingOutcomes.push(...outcomes);
    if (pendingOutcomes.length >= TERMINAL_RECONCILIATION_SETTLEMENT_BATCH_SIZE) flushOutcomes();
    await yieldControllerTurn();
  }
  if (isCurrent()) flushOutcomes();
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
  /* A host with no active turn is the turn-end evidence a pending account
     switch has been promised (issue #1028), and for a pane-less structured
     session nothing else will ever produce it. The queue's own drain already
     re-fires the reconfigure that owns a card-requested switch on this same
     transition; this wakes the coordinator for the switches nobody owns — an
     engine drain, an active-account reseat — which otherwise wait on a 60s
     poll. */
  if (turn === "idle" && pendingAccountSwitch(registry, conversationId)) requestAccountMigrationTick();
  await publishStructuredHostProjection(client, {
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
      capabilities: {
        steer: adopted.key.engine === "codex",
        structuredAttention: true,
        imageInput: runtimeImageCapability(
          adopted.key.engine,
          state.activeFlags.includes(STRUCTURED_IMAGE_CAPABILITY),
        ),
        runtimeSettings: runtimeSettingsCapability(adopted.key.engine),
      },
      activeTurnId: state.activeTurnRef,
    },
  });
}

export async function bindStructuredDeliveryQueue(
  adopted: readonly StructuredDeliveryHost[],
  dependencies: {
    registry?: AgentRegistry;
    client?: RuntimeHostClient | null;
    recover?: StructuredConversationRecovery;
    deferStartupWork?: boolean;
  } = {},
): Promise<void> {
  const client = dependencies.client === undefined ? runtimeHostClient() : dependencies.client;
  /* Swap, never reset-then-rebuild (#1191): the publication a spawn reads stays
     the predecessor's until the successor is fully built, and the two change
     hands in one step below. Without a client there is no successor to build,
     so this is the one path that retires the publication outright. */
  if (!client) {
    retireStructuredDeliveryPublication();
    return;
  }
  const retirePredecessor = state.stopActive;
  const registry = dependencies.registry ?? agentRegistry();
  const hosts = new Map<string, EngineHost>();
  let scheduleAutomaticRetry = () => {};
  let requestDrain = () => {};
  const queue = new StructuredDeliveryQueue(
    {
      effects: (kinds, afterEventSeq) => client.effectBatch(kinds, afterEventSeq),
      ...(typeof client.events === "function" ? { events: (afterEventSeq: number) => client.events(afterEventSeq) } : {}),
      status: async (operationId: string) => (await client.operationStatus(operationId))?.receipt ?? null,
      transition: async (operationId, status, details) => {
        const result = await client.transitionOperation(operationId, status, details);
        /* Only the two states a held delivery can settle into. A compaction's
           `uncertain` is absent on purpose and costs nothing: this projection
           is keyed on `heldDeliveries`, which only a composer message ever
           creates, so a compact operation has no row here to settle (#862). */
        if (status !== "delivered" && status !== "failed") return;
        const conversationId = result.receipt.conversationId;
        if (!conversationId?.startsWith("conversation_")) return;
        registry.recordDeliveryOutcomeForOperation(
          conversationId as `conversation_${string}`,
          result.receipt.presentationOperationId ?? operationId,
          status,
          details?.reason ?? null,
        );
        if (status === "delivered" && operationId.startsWith("spawn_message_")) {
          const launchId = operationId.slice("spawn_message_".length);
          const receipt = registry.readOnlySnapshot().receipts[launchId];
          if (receipt?.conversationId === conversationId && receipt.state !== "completed") {
            const { reconcileStructuredSpawnReplay } = await import("./structuredSpawn");
            await reconcileStructuredSpawnReplay(launchId, registry, client);
            const parent = await client.operationStatus(launchId, { currentRetryLeaf: true });
            const parentStatus = parent?.receipt.status;
            if (parentStatus === "pending" || parentStatus === "queued" || parentStatus === "delivering") {
              await client.transitionOperation(launchId, "delivered");
            }
          }
        }
      },
    },
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
    () => scheduleAutomaticRetry(),
    async (conversationId) => {
      if (!conversationId.startsWith("conversation_")) return false;
      const conversation = registry.conversation(conversationId as `conversation_${string}`);
      const generation = conversation?.generations.at(-1);
      if (!conversation || !generation) return false;
      const recover = dependencies.recover
        ?? (await import("./structuredRecovery")).recoverDeadStructuredConversation;
      const recovered = await recover({
        path: generation.path,
        conversationId: conversation.id,
      }, {
        registry,
        client,
        requestDeliveryDrain: requestDrain,
      });
      return recovered?.spawned === true;
    },
    (effect, ownership) => applyStructuredReconfigure(effect, {
      registry,
      ownsOperation: ownership.isCurrent,
    }),
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
  const drainWithRetry = async (afterAdmission = false): Promise<void> => {
    try {
      if (afterAdmission) await queue.drainAfterAdmission();
      else await queue.drain();
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
  requestDrain = () => {
    if (state.activeQueue === queue) scheduleDrain();
  };
  scheduleAutomaticRetry = () => {
    if (state.activeQueue === queue) scheduleDrain(DELIVERY_DRAIN_MAX_BACKOFF_MS);
  };
  const registrations = new Map<string, HostRegistration>();
  const inheritedRetries = new Map<string, ReturnType<typeof setTimeout>>();
  const publishChains = new Map<string, Promise<void>>();
  const projectionEpoch = crypto.randomUUID();
  let projectionRevision = 0;
  const republishRegistration = async (
    registration: { key: SessionKey; host: ObservableEngineHost },
  ): Promise<string | null> => {
    const entry = entryForHost(registry, registration);
    if (!entry) return null;
    const conversationId = conversationIdForEntry(registry, entry);
    if (!conversationId) return null;
    const conversation = registry.conversation(conversationId as `conversation_${string}`);
    const generation = conversation?.generations.at(-1);
    if (!conversation || !generation) return null;
    if (sessionKeyId({ engine: conversation.engine, sessionId: generation.id }) !== sessionKeyId(registration.key)) return null;
    projectionRevision += 1;
    await publishHostState(
      client,
      registry,
      registration,
      await registration.host.health(),
      `projection:${projectionEpoch}:${projectionRevision}`,
    );
    return conversationId;
  };
  const republishCurrentHosts = async (): Promise<Set<string>> => {
    const republished = new Set<string>();
    for (const registration of registrations.values()) {
      const conversationId = await republishRegistration(registration);
      if (conversationId) republished.add(conversationId);
    }
    return republished;
  };
  const publishCurrentFallback = async (
    conversationId: string,
    current?: RuntimeSession,
  ): Promise<void> => {
    const conversation = registry.conversation(conversationId as `conversation_${string}`);
    const generation = conversation?.generations.at(-1);
    if (!conversation || !generation) return;
    const key = { engine: conversation.engine, sessionId: generation.id } as const;
    const entry = registry.readOnlySnapshot().entries[sessionKeyId(key)] ?? null;
    const legacy = entry?.host?.kind === "tmux";
    const host = entry?.status === "dead"
      ? "dead"
      : legacy && entry?.status !== "unhosted"
        ? "hosted"
        : "unhosted";
    const turn = entry?.status === "live" ? "running" : entry?.status === "idle" ? "idle" : "unknown";
    const hostKind = entry?.structuredHost?.kind ?? (legacy ? "tmux-legacy" : "unhosted");
    const provenance = entry?.structuredHost ? "structured" : "derived";
    const accountId = entry?.accountId ?? generation.accountId;
    const parentConversationId = generation.launchProfile.parentConversationId ?? null;
    const cwd = entry?.cwd ?? generation.launchProfile.cwd;
    if (current
      && current.sessionKey.engine === key.engine
      && current.sessionKey.sessionId === key.sessionId
      && current.hostKind === hostKind
      && current.host === (entry?.structuredHost && entry.status === "dead" ? "dead" : host)
      && current.turn === turn
      && current.provenance === provenance
      && current.accountId === accountId
      && current.parentConversationId === parentConversationId
      && current.cwd === cwd
      && current.artifactPath === generation.path
      && current.activeTurnId === null) return;
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
        hostKind,
        host: entry?.structuredHost && entry.status === "dead" ? "dead" : host,
        turn,
        provenance,
        accountId,
        parentConversationId,
        cwd,
        artifactPath: generation.path,
        capabilities: entry?.structuredHost
          ? {
              steer: entry.structuredHost.kind === "codex-app-server",
              structuredAttention: true,
              imageInput: runtimeImageCapability(key.engine, false),
              runtimeSettings: runtimeSettingsCapability(key.engine),
            }
          : {
              steer: false,
              structuredAttention: false,
              imageInput: runtimeImageCapability(key.engine, false),
              runtimeSettings: runtimeSettingsCapability(key.engine),
            },
        activeTurnId: null,
      },
    });
  };
  const refreshCurrentProjection = async (conversationId: string | null): Promise<void> => {
    const republished = await republishCurrentHosts();
    if (conversationId && !republished.has(conversationId)) await publishCurrentFallback(conversationId);
  };
  /* Taking a seat and giving one up are the only two writers of a host's
     lifecycle, and each writes both of its indexes — what a delivery resolves
     the host from, and the record that owns it — in one step. Every entry of
     one map therefore has its counterpart in the other at every yield point;
     splitting those writes is what let a carried-over host resolve with no
     registration behind it (#1191). */
  const seatRegistration = (key: string, registration: HostRegistration): void => {
    registrations.set(key, registration);
    hosts.set(key, registration.host);
  };
  /* Claiming a seat is one indivisible step, taken before anything awaits: it
     leaves both maps, cancels the registration still in flight behind it and
     drops its retry. A second release, a termination and that registration all
     decide what to do from this one record, so exactly one caller can end a
     host's lifecycle and exactly one releases it (#1191). */
  const takeRegistration = (key: string, host?: EngineHost): HostRegistration | null => {
    const registered = registrations.get(key);
    if (!registered || (host !== undefined && registered.host !== host)) return null;
    registered.cancelled = true;
    registrations.delete(key);
    hosts.delete(key);
    const retry = inheritedRetries.get(key);
    if (retry !== undefined) {
      clearTimeout(retry);
      inheritedRetries.delete(key);
    }
    return registered;
  };
  const detachRegistration = async (key: string, registered: HostRegistration): Promise<void> => {
    const discardedEntry = entryForHost(registry, registered);
    const conversationId = discardedEntry ? conversationIdForEntry(registry, discardedEntry) : null;
    registered.attachment?.unsubscribe();
    await registered.attachment?.stopEvents();
    const pendingPublications = publishChains.get(key);
    if (pendingPublications) {
      await pendingPublications;
      if (publishChains.get(key) === pendingPublications) publishChains.delete(key);
    }
    await refreshCurrentProjection(conversationId);
  };
  const unregisterHost = async (key: string, host: EngineHost): Promise<void> => {
    const registered = takeRegistration(key, host);
    if (registered) await detachRegistration(key, registered);
  };
  /* This generation no longer owns the publication: a swap installed a
     successor and retired it, or it was retired outright. */
  const superseded = (): boolean => stopped || state.activeQueue !== queue;
  /* A registration that started here and resumed after a swap must not commit
     into maps the retirement already cleared: the successor would not know the
     host while the caller was told it is live (#1191). Re-drive the item
     through whoever owns the publication now; with nobody owning it, the
     caller learns the controller is unavailable and can retry. */
  const registerThroughSuccessor = async (
    item: StructuredDeliveryHost,
    ownsOperation?: () => Promise<boolean>,
  ): Promise<() => Promise<void>> => {
    const successor = state.registerActiveHost;
    if (!successor || successor === register) throw new StructuredDeliveryControllerUnavailableError();
    return await successor(item, ownsOperation);
  };
  const register = async (
    item: StructuredDeliveryHost,
    ownsOperation?: () => Promise<boolean>,
  ): Promise<() => Promise<void>> => {
    if (superseded()) return await registerThroughSuccessor(item, ownsOperation);
    if (ownsOperation && !await ownsOperation()) return async () => {};
    const key = sessionKeyId(item.key);
    const current = registrations.get(key);
    /* The same host under the same key either already holds a registration of
       this generation, with nothing left to do, or holds a carried-over seat
       this call is filling in. Any other host under that key is replaced. */
    const seat = current && current.host === item.host ? current : null;
    if (seat?.attachment) return async () => {};
    if (current && !seat) await unregisterHost(key, current.host);
    /* The seat was given up while this registration was in flight — released,
       terminated, replaced, or filled in by another call. Its lifecycle ended
       there, so this call must not commit: the host would come back after its
       caller was told it was gone (#1191). */
    const abandoned = (): boolean => seat !== null
      && (seat.cancelled || seat.attachment !== null || registrations.get(key) !== seat);
    const initialState = await item.host.health();
    if (abandoned()) return async () => {};
    if (ownsOperation && !await ownsOperation()) return async () => {};
    const publicationEntry = entryForHost(registry, item);
    const publicationConversationId = publicationEntry
      ? conversationIdForEntry(registry, publicationEntry)
      : null;
    let acknowledgedEventCursor = 0;
    if (publicationConversationId) {
      /* A transport failure leaves durable acknowledgement unknown. Pause the
         clean registration attempt so startup retry can try again after the
         control plane recovers; replaying the whole engine ledger here can
         saturate the Viewer loop and keep the runtime response unread. */
      try {
        acknowledgedEventCursor = await client.producerCursor(
          item.key.engine === "codex" ? "codex-app-server" : "claude-broker",
          `engine-host:${key}:`,
        );
      } catch (error) {
        if (isRuntimeHostTransportFailure(error)) throw error;
        console.error("[structured delivery] producer cursor unavailable; replaying host events");
      }
    }
    if (abandoned()) return async () => {};
    await publishHostState(client, registry, item, initialState);
    if (abandoned() || (ownsOperation && !await ownsOperation())) {
      const restoreCurrentProjection = async () => {
        await refreshCurrentProjection(publicationConversationId);
      };
      await restoreCurrentProjection();
      return restoreCurrentProjection;
    }
    /* The last yield point before the commit. Nothing below awaits, so a
       registration either lands whole in a generation that is still live or is
       handed on before it leaves a trace in a retired one. A seat that ended
       is never handed on: the successor carried it over only if it still
       existed at the swap, and re-driving a released host would republish it. */
    if (abandoned()) return async () => {};
    if (superseded()) return await registerThroughSuccessor(item, ownsOperation);
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
    /* The carried-over seat gains its attachment in place, so a concurrent
       registration of the same host sees a seat that is already filled in and
       stands down instead of installing a second subscription and pump. */
    const registration: HostRegistration = seat
      ?? { key: item.key, host: item.host, attachment: null, cancelled: false };
    registration.attachment = { unsubscribe, stopEvents };
    seatRegistration(key, registration);
    requestDrain();
    return () => unregisterHost(key, item.host);
  };
  /* A carried-over host whose registration cannot commit yet — a producer-cursor
     transport fault, a control-plane blip — keeps its seat, so deliveries still
     resolve it. Left at that it would be a seat with no state subscription and
     no event pump: nothing wakes the queue when the host turns idle, and a busy
     delivery stays stranded there. Retry until the registration commits, the
     seat is given up, or this generation is retired (#1191). */
  const registerInherited = async (
    item: StructuredDeliveryHost,
    retryDelayMs = DELIVERY_DRAIN_COALESCE_MS,
  ): Promise<void> => {
    const key = sessionKeyId(item.key);
    const stillPending = (): boolean => {
      if (stopped || superseded()) return false;
      const seat = registrations.get(key);
      return seat !== undefined && seat.host === item.host && !seat.cancelled && seat.attachment === null;
    };
    if (!stillPending()) return;
    try {
      await register(item);
    } catch (error) {
      console.error("[structured delivery] carried-over host registration failed; retrying", error);
      if (!stillPending()) return;
      const timer = setTimeout(() => {
        inheritedRetries.delete(key);
        void registerInherited(item, Math.min(retryDelayMs * 2, DELIVERY_DRAIN_MAX_BACKOFF_MS));
      }, retryDelayMs);
      timer.unref?.();
      inheritedRetries.set(key, timer);
    }
  };
  /* Host resolution must not gap across the hand-over (#1191). Publishing an
     empty successor and registering its hosts afterwards left every delivery
     admitted in between resolving nothing, which settles the receipt `failed`
     with "structured host recovery did not start". Every host the predecessor
     served takes its seat here synchronously — no await stands between that and
     the installation below — so the successor answers for it from the instant
     it goes live. The seat is that host's whole lifecycle in this generation:
     the registration that follows fills in its state subscription, event pump
     and projection, and a release or a termination ends it whether or not that
     registration has committed yet.

     Only the predecessor's hosts are carried. An adopted host is a publication
     this bind has yet to make, and one whose registration fails — a
     producer-cursor transport fault, an evicted replay window — must stay
     unpublished so the startup retry can make it properly. */
  const inherited = state.activeRegistrations?.() ?? [];
  for (const item of inherited) {
    const id = sessionKeyId(item.key);
    if (registrations.has(id)) continue;
    seatRegistration(id, { key: item.key, host: item.host, attachment: null, cancelled: false });
  }
  state.activeHosts = hosts;
  state.registerActiveHost = register;
  state.activeRegistrations = () => [...registrations.values()].map(({ key, host }) => ({ key, host }));
  state.republishActiveHost = async (key) => {
    const registration = registrations.get(sessionKeyId(key));
    if (!registration) return false;
    return await republishRegistration(registration) !== null;
  };
  /* Both paths claim the seat first, so a host carried over at the swap is
     released here exactly like one this generation registered itself — even
     while its own registration is still in flight behind it (#1191). */
  state.releaseActiveHost = async (key) => {
    const id = sessionKeyId(key);
    const registered = takeRegistration(id);
    if (!registered) {
      const discardedEntry = registry.readOnlySnapshot().entries[id] ?? null;
      await refreshCurrentProjection(discardedEntry ? conversationIdForEntry(registry, discardedEntry) : null);
      return false;
    }
    try {
      await detachRegistration(id, registered);
    } finally {
      await registered.host.release();
    }
    return true;
  };
  state.terminateActiveHost = async (key, expected) => {
    const id = sessionKeyId(key);
    const current = registrations.get(id);
    if (!current) return false;
    /* Bound to the process the caller authorized, never to the seat alone: a
       replacement host that claimed this key since the caller's snapshot is
       somebody else's live work and must survive untouched (#1199). */
    if (expected) {
      const releaseIfOwned = (current.host as IdentityBoundEngineHost).releaseIfOwned;
      /* A health read can go stale before a later release signal. Real
         structured hosts expose an operation that rechecks the kernel
         identity inside that signal boundary. */
      if (!releaseIfOwned || !await releaseIfOwned.call(current.host, expected)) return false;
      const registered = takeRegistration(id, current.host);
      registry.terminateStructuredHost(key, expected);
      if (registered) await detachRegistration(id, registered);
      return true;
    }
    const registered = takeRegistration(id, current.host);
    if (!registered) return false;
    await registered.host.release();
    registry.terminateStructuredHost(key, expected);
    await detachRegistration(id, registered);
    return true;
  };
  state.activeQueue = queue;
  state.activeRegistry = registry;
  setStructuredDeliveryKick(() => {
    if (stopped) return;
    if (drainTimer) clearTimeout(drainTimer);
    drainTimer = null;
    return drainWithRetry(true);
  });
  state.stopActive = () => {
    stopped = true;
    if (drainTimer) clearTimeout(drainTimer);
    drainTimer = null;
    for (const timer of inheritedRetries.values()) clearTimeout(timer);
    inheritedRetries.clear();
    for (const registration of registrations.values()) {
      registration.attachment?.unsubscribe();
      void registration.attachment?.stopEvents();
    }
    registrations.clear();
    hosts.clear();
    if (state.activeQueue === queue) {
      state.activeQueue = null;
      state.activeRegistry = null;
      state.activeHosts = null;
      state.registerActiveHost = null;
      state.activeRegistrations = null;
      state.republishActiveHost = null;
      state.releaseActiveHost = null;
      state.terminateActiveHost = null;
      state.completeActive = null;
      setStructuredDeliveryKick(null);
    }
  };
  let completion = Promise.resolve();
  const complete = (items: readonly StructuredDeliveryHost[]) => {
    completion = completion.catch(() => {}).then(async () => {
      if (stopped || state.activeQueue !== queue) return;
      for (const item of items) await register(item);
      const startupSnapshot = registry.readOnlySnapshot();
      const runtimeSnapshot = typeof client.snapshot === "function"
        ? await client.snapshot().catch(() => null)
        : null;
      const runtimeSessions = new Map(
        (runtimeSnapshot?.sessions ?? []).map((session) => [session.conversationId, session]),
      );
      for (const conversation of Object.values(startupSnapshot.conversations)) {
        const generation = conversation.generations.at(-1);
        if (!generation) continue;
        const id = sessionKeyId({ engine: conversation.engine, sessionId: generation.id });
        if (registrations.has(id)) continue;
        const entry = startupSnapshot.entries[id];
        if (!entry?.structuredHost && entry?.host?.kind !== "tmux") continue;
        await publishCurrentFallback(conversation.id, runtimeSessions.get(conversation.id));
      }
      await reconcileTerminalDeliveries(registry, client, () => !stopped && state.activeQueue === queue);
      await queue.drain();
    });
    return completion;
  };
  state.completeActive = complete;
  state.everPublished = true;
  /* The successor now owns every hook, so the predecessor's teardown finds
     `state.activeQueue !== queue` and unwinds only its own timers, host
     subscriptions and event pumps — it cannot null the live publication. */
  retirePredecessor();
  /* The carried-over hosts resolve from their seats already; this gives each one
     a registration in this generation. It runs whether or not startup work is
     deferred, because startup's own completion only covers the set it adopts,
     and a host the predecessor picked up after its adoption pass belongs to
     neither set. One host that cannot be registered — an evicted replay window,
     a control-plane fault — must not take the bind down with it: failing here
     would retire nothing and leave the startup retry re-entering the same
     throw, so the seat keeps serving deliveries and the retry behind it makes
     the registration good. */
  for (const item of inherited) await registerInherited(item);
  if (!dependencies.deferStartupWork) await complete(adopted);
}

export function hasStructuredDeliveryController(registry: AgentRegistry): boolean {
  return state.activeQueue !== null
    && state.activeRegistry === registry
    && state.registerActiveHost !== null
    && state.completeActive !== null;
}

export function hasStructuredDeliveryHost(key: SessionKey): boolean {
  return state.activeHosts?.has(sessionKeyId(key)) ?? false;
}

export function structuredDeliveryHostForConversation(conversationId: string): EngineHost | null {
  if (!conversationId.startsWith("conversation_") || !state.activeRegistry || !state.activeHosts) return null;
  return hostResolver(state.activeRegistry, state.activeHosts)(conversationId);
}

export async function publishStructuredDeliveryHost(
  item: StructuredDeliveryHost,
  ownsOperation?: () => Promise<boolean>,
): Promise<() => Promise<void>> {
  return requireStructuredDeliveryControllerPublication()(item, ownsOperation);
}

export async function completeStructuredDeliveryQueueStartup(
  adopted: readonly StructuredDeliveryHost[],
): Promise<void> {
  if (!state.completeActive) throw new StructuredDeliveryControllerUnavailableError();
  await state.completeActive(adopted);
}

export async function republishStructuredDeliveryHost(key: SessionKey): Promise<boolean> {
  return await state.republishActiveHost?.(key) ?? false;
}

export async function releaseStructuredDeliveryHost(key: SessionKey): Promise<boolean> {
  return await state.releaseActiveHost?.(key) ?? false;
}

/**
 * Ends a host this generation still holds, through its own lifecycle: the
 * engine host is released and its registry row retired in one move. `expected`
 * pins that to one process — a registration whose host is a different process
 * is refused rather than terminated. False when no registration owns the key,
 * or when the one that does is not the caller's host: the caller then has only
 * the process to go on (the resources rail's released/orphaned rows, #1199).
 */
export async function terminateStructuredDeliveryHost(
  key: SessionKey,
  expected?: Readonly<ProcessIdentity>,
): Promise<boolean> {
  return await state.terminateActiveHost?.(key, expected) ?? false;
}
