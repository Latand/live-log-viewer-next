import type {
  AgentHostStatus,
  AgentRegistry,
  AgentRegistryEntry,
  ProcessIdentity,
  RegistryConversation,
  StructuredHostColumns,
} from "@/lib/agent/registry";
import { sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";
import { procBackend } from "@/lib/proc";

import { CodexAppServerHost, type CodexAppServerHostOptions } from "./codexAppServerHost";
import { ClaudeStreamBrokerHost, type ClaudeStreamBrokerHostOptions } from "./claudeStreamBrokerHost";
import { StructuredHostAdoptionCleanupError, type HostState } from "./engineHost";
import { structuredHostsEnabled } from "./flags";
import { conversationTurnLiveness, type TurnLivenessDependencies } from "./liveness";

export { structuredHostsEnabled };

export async function startCodexStructuredHost(
  options: CodexAppServerHostOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CodexAppServerHost> {
  if (!structuredHostsEnabled(env)) throw new Error("structured hosts are disabled");
  return CodexAppServerHost.start(options);
}

export async function startClaudeStructuredHost(
  options: ClaudeStreamBrokerHostOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClaudeStreamBrokerHost> {
  if (!structuredHostsEnabled(env)) throw new Error("structured hosts are disabled");
  return ClaudeStreamBrokerHost.start(options);
}

function registryStatus(state: HostState): AgentHostStatus {
  if (state.status === "active" || state.status === "attention") return "live";
  if (state.status === "idle") return "idle";
  if (state.status === "unhosted") return "unhosted";
  return "dead";
}

export function codexHostColumns(state: HostState, writerClaimEpoch: number): StructuredHostColumns {
  return {
    kind: "codex-app-server",
    endpoint: state.endpoint,
    process: state.pid === null ? null : { pid: state.pid, startIdentity: state.processStartIdentity },
    eventCursor: state.eventCursor,
    protocolVersion: state.protocolVersion,
    writerClaimEpoch,
    activeTurnRef: state.activeTurnRef,
    pendingAttention: state.pendingAttention,
    activeFlags: state.activeFlags,
  };
}

export function claudeHostColumns(state: HostState, writerClaimEpoch: number): StructuredHostColumns {
  return {
    kind: "claude-broker",
    endpoint: state.endpoint,
    process: state.pid === null ? null : { pid: state.pid, startIdentity: state.processStartIdentity },
    eventCursor: state.eventCursor,
    protocolVersion: state.protocolVersion,
    writerClaimEpoch,
    activeTurnRef: state.activeTurnRef,
    pendingAttention: state.pendingAttention,
    activeFlags: state.activeFlags,
  };
}

export async function persistCodexHost(
  registry: AgentRegistry,
  key: SessionKey,
  host: CodexAppServerHost,
  claimOwner: string,
  writerClaimEpoch: number,
): Promise<AgentRegistryEntry> {
  const state = await host.health();
  const persisted = registry.setStructuredHostClaimed(
    key,
    codexHostColumns(state, writerClaimEpoch),
    registryStatus(state),
    claimOwner,
    writerClaimEpoch,
  );
  if (!persisted) throw new Error("structured host writer claim is stale");
  return persisted;
}

export interface StructuredHostPersistenceOptions {
  cursorDebounceMs?: number;
}

interface ObservableStructuredHost {
  health(): Promise<HostState>;
  release(): Promise<void>;
  setWriterFence(check: () => boolean): void;
  onStateChange(listener: (state: HostState) => void): () => void;
}

export const DEFAULT_CURSOR_DEBOUNCE_MS = 30_000;

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameMaterialHostState(left: HostState, right: HostState): boolean {
  return left.status === right.status
    && left.endpoint === right.endpoint
    && left.pid === right.pid
    && left.processStartIdentity === right.processStartIdentity
    && left.protocolVersion === right.protocolVersion
    && left.activeTurnRef === right.activeTurnRef
    && sameStrings(left.pendingAttention, right.pendingAttention)
    && sameStrings(left.activeFlags, right.activeFlags);
}

async function bindStructuredHostPersistence(
  registry: AgentRegistry,
  key: SessionKey,
  host: ObservableStructuredHost,
  claimOwner: string,
  writerClaimEpoch: number,
  releasedStatus: "unhosted" | "dead",
  columnsFromState: (state: HostState, writerClaimEpoch: number) => StructuredHostColumns,
  options: StructuredHostPersistenceOptions,
): Promise<() => void> {
  host.setWriterFence(() => registry.ownsStructuredHostClaim(key, claimOwner, writerClaimEpoch));
  let lastPersistedState: HostState;
  const persist = (state: HostState, terminal = false): AgentRegistryEntry => {
    const columns = columnsFromState(state, writerClaimEpoch);
    const persisted = registry.setStructuredHostClaimed(
      key,
      /* `unhosted` releases the writer claim permanently. Keeping its wrapper
         PID would make the released row appear owned for every successor. */
      terminal && state.status === "unhosted" ? { ...columns, process: null } : columns,
      terminal && releasedStatus === "dead" ? "dead" : registryStatus(state),
      claimOwner,
      writerClaimEpoch,
      terminal,
    );
    if (!persisted) throw new Error("structured host writer claim is stale");
    lastPersistedState = structuredClone(state);
    return persisted;
  };
  try {
    persist(await host.health());
  } catch (error) {
    await host.release();
    throw error;
  }

  const cursorDebounceMs = Number.isFinite(options.cursorDebounceMs)
    ? Math.max(0, options.cursorDebounceMs!)
    : DEFAULT_CURSOR_DEBOUNCE_MS;
  let failed = false;
  let stopped = false;
  let claimReleased = false;
  let pendingState: HostState | null = null;
  let cursorTimer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe = () => {};

  const clearCursorTimer = () => {
    if (cursorTimer === null) return;
    clearTimeout(cursorTimer);
    cursorTimer = null;
  };
  const releaseClaim = () => {
    if (claimReleased) return;
    claimReleased = true;
    registry.releaseStructuredHostClaim(key, claimOwner, writerClaimEpoch);
  };
  const fail = () => {
    if (failed) return;
    failed = true;
    stopped = true;
    pendingState = null;
    clearCursorTimer();
    unsubscribe();
    releaseClaim();
    void host.release();
  };
  const persistPending = () => {
    const state = pendingState;
    pendingState = null;
    clearCursorTimer();
    if (state) persist(state);
  };
  const schedulePending = () => {
    if (cursorTimer !== null) return;
    cursorTimer = setTimeout(() => {
      cursorTimer = null;
      if (failed || stopped || pendingState === null) return;
      try {
        persistPending();
      } catch {
        fail();
      }
    }, cursorDebounceMs);
    cursorTimer.unref?.();
  };
  const stop = () => {
    if (stopped) return;
    try {
      persistPending();
    } catch {
      fail();
      return;
    }
    stopped = true;
    unsubscribe();
    releaseClaim();
  };

  unsubscribe = host.onStateChange((state) => {
    if (failed || stopped) return;
    const terminal = state.status === "unhosted" || (state.status === "dead" && state.pid === null);
    if (!terminal && sameMaterialHostState(lastPersistedState, state)) {
      pendingState = structuredClone(state);
      schedulePending();
      return;
    }
    pendingState = null;
    clearCursorTimer();
    try {
      persist(state, terminal);
      if (terminal) {
        claimReleased = true;
        stopped = true;
        unsubscribe();
      }
    } catch {
      fail();
    }
  });
  if (stopped) unsubscribe();
  return stop;
}

export async function bindCodexHostPersistence(
  registry: AgentRegistry,
  key: SessionKey,
  host: CodexAppServerHost,
  claimOwner: string,
  writerClaimEpoch: number,
  releasedStatus: "unhosted" | "dead" = "unhosted",
  options: StructuredHostPersistenceOptions = {},
): Promise<() => void> {
  return bindStructuredHostPersistence(
    registry,
    key,
    host,
    claimOwner,
    writerClaimEpoch,
    releasedStatus,
    codexHostColumns,
    options,
  );
}

export async function bindClaudeHostPersistence(
  registry: AgentRegistry,
  key: SessionKey,
  host: ClaudeStreamBrokerHost,
  claimOwner: string,
  writerClaimEpoch: number,
  releasedStatus: "unhosted" | "dead" = "unhosted",
  options: StructuredHostPersistenceOptions = {},
): Promise<() => void> {
  return bindStructuredHostPersistence(
    registry,
    key,
    host,
    claimOwner,
    writerClaimEpoch,
    releasedStatus,
    claudeHostColumns,
    options,
  );
}

export interface AdoptedCodexHost {
  key: SessionKey;
  host: CodexAppServerHost;
}

export interface AdoptedClaudeHost {
  key: SessionKey;
  host: ClaudeStreamBrokerHost;
}

export type StructuredHostAdoptionFilter = (entry: AgentRegistryEntry) => boolean;
export type StructuredHostAdoptionProgress = (entry: AgentRegistryEntry) => void;

const STRUCTURED_CLAIM_PREFIX = "structured-host:";
const ORPHAN_TERM_GRACE_MS = 250;
const ORPHAN_KILL_GRACE_MS = 1_000;

function claimOwnerBlocksOrphanReap(claimOwner: string | null): boolean {
  if (!claimOwner) return false;
  if (!claimOwner.startsWith(STRUCTURED_CLAIM_PREFIX)) return true;
  let identity: Partial<ProcessIdentity>;
  try { identity = JSON.parse(claimOwner.slice(STRUCTURED_CLAIM_PREFIX.length)) as Partial<ProcessIdentity>; }
  catch { return true; }
  if (!Number.isInteger(identity.pid) || identity.pid! <= 0) return true;
  const startIdentity = typeof identity.startIdentity === "string" ? identity.startIdentity : null;
  return procBackend.pidAlive(identity.pid!)
    && (startIdentity === null || procBackend.processIdentity(identity.pid!) === startIdentity);
}

function verifiedProcessAlive(processIdentity: ProcessIdentity): boolean {
  return processIdentity.startIdentity !== null
    && procBackend.processIdentity(processIdentity.pid) === processIdentity.startIdentity;
}

/** Clears one structured ownership claim only when its recorded engine process
    exists and the registry revalidates its PID plus start identity, when one
    was captured, as gone. */
export function reconcileDeadStructuredRegistryHost(
  registry: AgentRegistry,
  conversationId: RegistryConversation["id"],
  key: SessionKey,
): boolean {
  const entry = registry.readOnlySnapshot().entries[sessionKeyId(key)];
  const structuredProcess = entry?.structuredHost?.process;
  if (!entry || !structuredProcess) return false;
  return Boolean(registry.terminateInactiveStructuredHost(conversationId, key, {
    process: structuredProcess,
    claimEpoch: entry.claimEpoch,
  }));
}

/** Bounded reconciliation pass for completed conversation rows. Active conversation
    recovery stays demand-driven. `shouldRetain` protects rows the same startup
    pass will re-host; every other terminal row releases its dead process claim. */
export function reconcileDeadStructuredRegistryHosts(
  registry: AgentRegistry,
  shouldRetain: StructuredHostAdoptionFilter = () => false,
): void {
  const snapshot = registry.readOnlySnapshot();
  for (const conversation of Object.values(snapshot.conversations)) {
    if (conversation.turn.state !== "terminal" && !conversation.supersededBy) continue;
    const generation = conversation.generations.at(-1);
    if (!generation) continue;
    const key = { engine: conversation.engine, sessionId: generation.id } as const;
    const entry = snapshot.entries[sessionKeyId(key)];
    if (!entry?.structuredHost?.process || shouldRetain(entry)) continue;
    reconcileDeadStructuredRegistryHost(registry, conversation.id, key);
  }
}

async function waitForVerifiedProcessExit(processIdentity: ProcessIdentity, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (verifiedProcessAlive(processIdentity) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return !verifiedProcessAlive(processIdentity);
}

/** Ends one process the registry recorded, fenced on its start identity: a pid
    that has been reused since the row was written is somebody else's process
    and is never signalled. */
async function terminateVerifiedProcess(processIdentity: ProcessIdentity): Promise<boolean> {
  if (processIdentity.pid === process.pid || !verifiedProcessAlive(processIdentity)) return false;
  try { process.kill(processIdentity.pid, "SIGTERM"); } catch { /* process exited */ }
  if (await waitForVerifiedProcessExit(processIdentity, ORPHAN_TERM_GRACE_MS)) return true;
  try { process.kill(processIdentity.pid, "SIGKILL"); } catch { /* process exited */ }
  return waitForVerifiedProcessExit(processIdentity, ORPHAN_KILL_GRACE_MS);
}

async function terminateVerifiedClaudeOrphan(
  processIdentity: ProcessIdentity,
  claimOwner: string | null,
): Promise<boolean> {
  if (claimOwnerBlocksOrphanReap(claimOwner)) return false;
  return terminateVerifiedProcess(processIdentity);
}

/**
 * Ends a structured host process that evidence shows is severed, for a caller
 * that has already established nothing in this Viewer owns it (#1282).
 *
 * This is the gap the incident fell into. `terminateInactiveStructuredHost`
 * refuses while the recorded process is alive — correctly, since a live host is
 * usually somebody's live work — and the claim owner is this Viewer itself, so
 * the orphan reap above refuses too. A host adopted at boot but never claimed by
 * the delivery controller satisfies both refusals at once and becomes
 * unkillable: the operator's kill effect blocks the conversation's whole drain
 * forever, taking every message queued behind it with it.
 *
 * The two fences that make the signal safe are independent of each other: the
 * caller has proven no registration resolves this host, and the liveness
 * decision has proven from process and transcript evidence that the turn is
 * severed (#1281). A host that is working, or that cannot be shown not to be,
 * is left strictly alone.
 */
export async function reapSeveredStructuredHost(
  registry: AgentRegistry,
  conversationId: RegistryConversation["id"],
  key: SessionKey,
  dependencies: TurnLivenessDependencies = {},
): Promise<{ reaped: boolean; reason: string } | null> {
  const entry = registry.readOnlySnapshot().entries[sessionKeyId(key)];
  const structuredProcess = entry?.structuredHost?.process;
  if (!structuredProcess) return null;
  const liveness = await conversationTurnLiveness(registry, conversationId, dependencies);
  if (liveness?.state !== "severed") return null;
  if (sessionKeyId(liveness.key) !== sessionKeyId(key)) return null;
  return { reaped: await terminateVerifiedProcess(structuredProcess), reason: liveness.reason };
}

/** Reconciles claimable structured ownership for rows excluded by startup adoption. */
export async function demoteSkippedStructuredRegistryHosts(
  registry: AgentRegistry,
  shouldAdopt: StructuredHostAdoptionFilter,
): Promise<void> {
  const rows = Object.values(registry.readOnlySnapshot().entries).filter((entry) =>
    entry.structuredHost && !shouldAdopt(entry));
  for (const entry of rows) {
    const host = entry.structuredHost!;
    const alreadyDead = entry.status === "dead"
      && host.process === null
      && entry.claimOwner === null
      && host.endpoint === "stdio:released"
      && host.activeTurnRef === null
      && host.pendingAttention.length === 0
      && host.activeFlags.length === 0;
    if (alreadyDead) continue;
    const conversation = registry.conversationForPath(entry.artifactPath);
    if (conversation
      && reconcileDeadStructuredRegistryHost(registry, conversation.id, entry.key)) continue;
    const owner = { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) };
    try {
      await registry.withOperationLock(entry.key, owner, async () => {
        const current = registry.readOnlySnapshot().entries[sessionKeyId(entry.key)];
        if (!current?.structuredHost || shouldAdopt(current)) return;
        /* A PID-only claim cannot prove ownership across reboot. Runtime and
           transcript signals already excluded this row from adoption, so the
           startup demotion may replace that unverifiable owner and settle the
           retained receipt through the ordinary terminal path. */
        let claimed = registry.claimStructuredHost(entry.key, owner, {
          allowUnhosted: true,
          reclaimUnverifiedOwner: true,
        });
        if (!claimed) {
          const current = registry.readOnlySnapshot().entries[sessionKeyId(entry.key)];
          const orphan = current?.structuredHost?.kind === "claude-broker"
            ? current.structuredHost.process
            : null;
          if (orphan && await terminateVerifiedClaudeOrphan(orphan, current?.claimOwner ?? null)) {
            claimed = registry.claimStructuredHost(entry.key, owner, {
              allowUnhosted: true,
              reclaimUnverifiedOwner: true,
            });
          }
        }
        if (!claimed?.structuredHost || !claimed.claimOwner) return;
        const demoted = registry.setStructuredHostClaimed(entry.key, {
          ...claimed.structuredHost,
          endpoint: "stdio:released",
          process: null,
          activeTurnRef: null,
          pendingAttention: [],
          activeFlags: [],
        }, "dead", claimed.claimOwner, claimed.claimEpoch, true);
        if (!demoted) throw new Error("structured host writer claim is stale");
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "agent registry is busy") throw error;
    }
  }
}

/** Boot seam: resume selected durable Codex rows when structured hosting is enabled. */
export async function adoptCodexRegistryHosts(
  registry: AgentRegistry,
  optionsFor: (entry: AgentRegistryEntry) => CodexAppServerHostOptions,
  env: NodeJS.ProcessEnv = process.env,
  shouldAdopt: StructuredHostAdoptionFilter = () => true,
  processed?: StructuredHostAdoptionProgress,
): Promise<AdoptedCodexHost[]> {
  if (!structuredHostsEnabled(env)) return [];
  const rows = Object.values(registry.readOnlySnapshot().entries).filter((entry) =>
    entry.key.engine === "codex"
    && entry.structuredHost?.kind === "codex-app-server"
    && shouldAdopt(entry));
  const adopted: AdoptedCodexHost[] = [];
  for (const entry of rows) {
    const owner = { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) };
    try {
      await registry.withOperationLock(entry.key, owner, async () => {
        const current = registry.readOnlySnapshot().entries[sessionKeyId(entry.key)];
        if (!current?.structuredHost || !shouldAdopt(current)) return;
        const claimed = registry.claimStructuredHost(entry.key, owner, { allowUnhosted: true });
        if (!claimed?.structuredHost) return;
        if (!shouldAdopt(claimed)) {
          registry.releaseStructuredHostClaim(entry.key, claimed.claimOwner!, claimed.claimEpoch);
          return;
        }
        try {
          const host = await CodexAppServerHost.adopt(entry.key.sessionId, {
            ...optionsFor(claimed),
            initialEventCursor: claimed.structuredHost.eventCursor,
          });
          await bindCodexHostPersistence(registry, entry.key, host, claimed.claimOwner!, claimed.claimEpoch);
          adopted.push({ key: entry.key, host });
        } catch (error) {
          if (error instanceof StructuredHostAdoptionCleanupError
            && error.host instanceof CodexAppServerHost) {
            try {
              await bindCodexHostPersistence(
                registry,
                entry.key,
                error.host,
                claimed.claimOwner!,
                claimed.claimEpoch,
                "dead",
              );
              await error.host.release();
            } catch { /* retain the live process and claim until its late reap is observed */ }
            return;
          }
          registry.setStructuredHostClaimed(entry.key, {
            ...claimed.structuredHost,
            endpoint: "stdio:released",
            process: null,
            activeTurnRef: null,
            pendingAttention: [],
            activeFlags: [],
          }, "dead", claimed.claimOwner!, claimed.claimEpoch, true);
        }
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "agent registry is busy") throw error;
    } finally {
      processed?.(entry);
    }
  }
  return adopted;
}


/** Boot seam: resume selected durable Claude broker rows when structured hosting is enabled. */
export async function adoptClaudeRegistryHosts(
  registry: AgentRegistry,
  optionsFor: (entry: AgentRegistryEntry) => ClaudeStreamBrokerHostOptions,
  env: NodeJS.ProcessEnv = process.env,
  shouldAdopt: StructuredHostAdoptionFilter = () => true,
  processed?: StructuredHostAdoptionProgress,
): Promise<AdoptedClaudeHost[]> {
  if (!structuredHostsEnabled(env)) return [];
  const rows = Object.values(registry.readOnlySnapshot().entries).filter((entry) =>
    entry.key.engine === "claude"
    && entry.structuredHost?.kind === "claude-broker"
    && shouldAdopt(entry));
  const adopted: AdoptedClaudeHost[] = [];
  for (const entry of rows) {
    const owner = { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) };
    try {
      await registry.withOperationLock(entry.key, owner, async () => {
        const eligible = registry.readOnlySnapshot().entries[sessionKeyId(entry.key)];
        if (!eligible?.structuredHost || !shouldAdopt(eligible)) return;
        let claimed = registry.claimStructuredHost(entry.key, owner, { allowUnhosted: true });
        if (!claimed) {
          const current = registry.readOnlySnapshot().entries[`claude:${entry.key.sessionId}`];
          const orphan = current?.structuredHost?.kind === "claude-broker"
            ? current.structuredHost.process
            : null;
          if (orphan
            && current
            && shouldAdopt(current)
            && await terminateVerifiedClaudeOrphan(orphan, current.claimOwner ?? null)) {
            const retry = registry.readOnlySnapshot().entries[sessionKeyId(entry.key)];
            if (!retry?.structuredHost || !shouldAdopt(retry)) return;
            claimed = registry.claimStructuredHost(entry.key, owner, { allowUnhosted: true });
          }
        }
        if (!claimed?.structuredHost) return;
        if (!shouldAdopt(claimed)) {
          registry.releaseStructuredHostClaim(entry.key, claimed.claimOwner!, claimed.claimEpoch);
          return;
        }
        try {
          const host = await ClaudeStreamBrokerHost.adopt(entry.key.sessionId, {
            ...optionsFor(claimed),
            initialEventCursor: claimed.structuredHost.eventCursor,
          });
          await bindClaudeHostPersistence(registry, entry.key, host, claimed.claimOwner!, claimed.claimEpoch);
          adopted.push({ key: entry.key, host });
        } catch (error) {
          if (error instanceof StructuredHostAdoptionCleanupError
            && error.host instanceof ClaudeStreamBrokerHost) {
            try {
              await bindClaudeHostPersistence(
                registry,
                entry.key,
                error.host,
                claimed.claimOwner!,
                claimed.claimEpoch,
                "dead",
              );
              await error.host.release();
            } catch { /* retain the live process and claim until its late reap is observed */ }
            return;
          }
          registry.setStructuredHostClaimed(entry.key, {
            ...claimed.structuredHost,
            endpoint: "stdio:released",
            process: null,
            activeTurnRef: null,
            pendingAttention: [],
            activeFlags: [],
          }, "dead", claimed.claimOwner!, claimed.claimEpoch, true);
        }
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "agent registry is busy") throw error;
    } finally {
      processed?.(entry);
    }
  }
  return adopted;
}
