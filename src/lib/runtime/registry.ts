import type {
  AgentHostStatus,
  AgentRegistry,
  AgentRegistryEntry,
  StructuredHostColumns,
} from "@/lib/agent/registry";
import type { SessionKey } from "@/lib/agent/sessionKey";
import { procBackend } from "@/lib/proc";

import { CodexAppServerHost, type CodexAppServerHostOptions } from "./codexAppServerHost";
import type { HostState } from "./engineHost";

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

export async function bindCodexHostPersistence(
  registry: AgentRegistry,
  key: SessionKey,
  host: CodexAppServerHost,
  claimOwner: string,
  writerClaimEpoch: number,
): Promise<() => void> {
  host.setWriterFence(() => registry.ownsStructuredHostClaim(key, claimOwner, writerClaimEpoch));
  try {
    await persistCodexHost(registry, key, host, claimOwner, writerClaimEpoch);
  } catch (error) {
    await host.release();
    throw error;
  }
  let failed = false;
  let stopped = false;
  let unsubscribe = () => {};
  const stop = () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    registry.releaseStructuredHostClaim(key, claimOwner, writerClaimEpoch);
  };
  unsubscribe = host.onStateChange((state) => {
    if (failed || stopped) return;
    try {
      const terminal = state.status === "unhosted" || (state.status === "dead" && state.pid === null);
      const persisted = registry.setStructuredHostClaimed(
        key,
        codexHostColumns(state, writerClaimEpoch),
        registryStatus(state),
        claimOwner,
        writerClaimEpoch,
        terminal,
      );
      if (!persisted) throw new Error("structured host writer claim is stale");
      if (terminal) {
        stopped = true;
        unsubscribe();
      }
    } catch {
      failed = true;
      stop();
      void host.release();
    }
  });
  if (stopped) unsubscribe();
  return stop;
}

export interface AdoptedCodexHost {
  key: SessionKey;
  host: CodexAppServerHost;
}

/** Boot seam: resume every durable Codex row when structured hosting is enabled. */
export async function adoptCodexRegistryHosts(
  registry: AgentRegistry,
  optionsFor: (entry: AgentRegistryEntry) => CodexAppServerHostOptions,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AdoptedCodexHost[]> {
  if (!structuredHostsEnabled(env)) return [];
  const rows = Object.values(registry.snapshot().entries).filter((entry) =>
    entry.key.engine === "codex"
    && entry.status !== "unhosted"
    && entry.structuredHost?.kind === "codex-app-server");
  const adopted: AdoptedCodexHost[] = [];
  for (const entry of rows) {
    const owner = { pid: process.pid, startIdentity: procBackend.processIdentity(process.pid) };
    try {
      await registry.withOperationLock(entry.key, owner, async () => {
        const claimed = registry.claimStructuredHost(entry.key, owner);
        if (!claimed?.structuredHost) return;
        try {
          const host = await CodexAppServerHost.adopt(entry.key.sessionId, {
            ...optionsFor(claimed),
            initialEventCursor: claimed.structuredHost.eventCursor,
          });
          await bindCodexHostPersistence(registry, entry.key, host, claimed.claimOwner!, claimed.claimEpoch);
          adopted.push({ key: entry.key, host });
        } catch {
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
