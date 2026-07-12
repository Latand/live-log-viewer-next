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
  };
}

export async function persistCodexHost(
  registry: AgentRegistry,
  key: SessionKey,
  host: CodexAppServerHost,
  writerClaimEpoch: number,
): Promise<AgentRegistryEntry> {
  const state = await host.health();
  return registry.setStructuredHost(key, codexHostColumns(state, writerClaimEpoch), registryStatus(state));
}

export async function bindCodexHostPersistence(
  registry: AgentRegistry,
  key: SessionKey,
  host: CodexAppServerHost,
  writerClaimEpoch: number,
): Promise<() => void> {
  await persistCodexHost(registry, key, host, writerClaimEpoch);
  let failed = false;
  let unsubscribe = () => {};
  unsubscribe = host.onStateChange((state) => {
    if (failed) return;
    try {
      registry.setStructuredHost(key, codexHostColumns(state, writerClaimEpoch), registryStatus(state));
    } catch {
      failed = true;
      unsubscribe();
      void host.release();
    }
  });
  return unsubscribe;
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
    entry.key.engine === "codex" && entry.structuredHost?.kind === "codex-app-server");
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
          await bindCodexHostPersistence(registry, entry.key, host, claimed.claimEpoch);
          adopted.push({ key: entry.key, host });
        } catch {
          registry.setStructuredHost(entry.key, {
            ...claimed.structuredHost,
            endpoint: "stdio:released",
            process: null,
            activeTurnRef: null,
          }, "dead");
          registry.releaseClaim(entry.key, claimed.claimOwner!);
        }
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "agent registry is busy") throw error;
    }
  }
  return adopted;
}
