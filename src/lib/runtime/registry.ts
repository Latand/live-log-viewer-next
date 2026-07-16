import type {
  AgentHostStatus,
  AgentRegistry,
  AgentRegistryEntry,
  ProcessIdentity,
  StructuredHostColumns,
} from "@/lib/agent/registry";
import { sessionKeyId, type SessionKey } from "@/lib/agent/sessionKey";
import { procBackend } from "@/lib/proc";

import { CodexAppServerHost, type CodexAppServerHostOptions } from "./codexAppServerHost";
import { ClaudeStreamBrokerHost, type ClaudeStreamBrokerHostOptions } from "./claudeStreamBrokerHost";
import { StructuredHostAdoptionCleanupError, type HostState } from "./engineHost";

export function structuredHostsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LLV_STRUCTURED_HOSTS === "1";
}

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

const DEFAULT_CURSOR_DEBOUNCE_MS = 1_000;

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
    const persisted = registry.setStructuredHostClaimed(
      key,
      columnsFromState(state, writerClaimEpoch),
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

async function waitForVerifiedProcessExit(processIdentity: ProcessIdentity, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (verifiedProcessAlive(processIdentity) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return !verifiedProcessAlive(processIdentity);
}

async function terminateVerifiedClaudeOrphan(
  processIdentity: ProcessIdentity,
  claimOwner: string | null,
): Promise<boolean> {
  if (processIdentity.pid === process.pid
    || !verifiedProcessAlive(processIdentity)
    || claimOwnerBlocksOrphanReap(claimOwner)) return false;
  try { process.kill(processIdentity.pid, "SIGTERM"); } catch { /* process exited */ }
  if (await waitForVerifiedProcessExit(processIdentity, ORPHAN_TERM_GRACE_MS)) return true;
  try { process.kill(processIdentity.pid, "SIGKILL"); } catch { /* process exited */ }
  return waitForVerifiedProcessExit(processIdentity, ORPHAN_KILL_GRACE_MS);
}

/** Reconciles claimable structured ownership for rows excluded by startup adoption. */
export async function demoteSkippedStructuredRegistryHosts(
  registry: AgentRegistry,
  shouldAdopt: StructuredHostAdoptionFilter,
): Promise<void> {
  const rows = Object.values(registry.snapshot().entries).filter((entry) =>
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
    const owner = { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) };
    try {
      await registry.withOperationLock(entry.key, owner, async () => {
        const current = registry.snapshot().entries[sessionKeyId(entry.key)];
        if (!current?.structuredHost || shouldAdopt(current)) return;
        let claimed = registry.claimStructuredHost(entry.key, owner, { allowUnhosted: true });
        if (!claimed) {
          const current = registry.snapshot().entries[sessionKeyId(entry.key)];
          const orphan = current?.structuredHost?.kind === "claude-broker"
            ? current.structuredHost.process
            : null;
          if (orphan && await terminateVerifiedClaudeOrphan(orphan, current?.claimOwner ?? null)) {
            claimed = registry.claimStructuredHost(entry.key, owner, { allowUnhosted: true });
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
): Promise<AdoptedCodexHost[]> {
  if (!structuredHostsEnabled(env)) return [];
  const rows = Object.values(registry.snapshot().entries).filter((entry) =>
    entry.key.engine === "codex"
    && entry.structuredHost?.kind === "codex-app-server"
    && shouldAdopt(entry));
  const adopted: AdoptedCodexHost[] = [];
  for (const entry of rows) {
    const owner = { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) };
    try {
      await registry.withOperationLock(entry.key, owner, async () => {
        const claimed = registry.claimStructuredHost(entry.key, owner, { allowUnhosted: true });
        if (!claimed?.structuredHost) return;
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
): Promise<AdoptedClaudeHost[]> {
  if (!structuredHostsEnabled(env)) return [];
  const rows = Object.values(registry.snapshot().entries).filter((entry) =>
    entry.key.engine === "claude"
    && entry.structuredHost?.kind === "claude-broker"
    && shouldAdopt(entry));
  const adopted: AdoptedClaudeHost[] = [];
  for (const entry of rows) {
    const owner = { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) };
    try {
      await registry.withOperationLock(entry.key, owner, async () => {
        let claimed = registry.claimStructuredHost(entry.key, owner, { allowUnhosted: true });
        if (!claimed) {
          const current = registry.snapshot().entries[`claude:${entry.key.sessionId}`];
          const orphan = current?.structuredHost?.kind === "claude-broker"
            ? current.structuredHost.process
            : null;
          if (orphan && await terminateVerifiedClaudeOrphan(orphan, current?.claimOwner ?? null)) {
            claimed = registry.claimStructuredHost(entry.key, owner, { allowUnhosted: true });
          }
        }
        if (!claimed?.structuredHost) return;
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
    }
  }
  return adopted;
}
