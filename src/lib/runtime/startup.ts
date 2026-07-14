import { accountManager } from "@/lib/accounts/manager";
import { claudeSettingsPath } from "@/lib/accounts/claude";
import { agentRegistry, type AgentRegistry, type AgentRegistryEntry } from "@/lib/agent/registry";
import { VIEWER_SPAWN_CAPABILITY_ENV } from "@/lib/agent/spawnPolicy";

import {
  adoptClaudeRegistryHosts,
  adoptCodexRegistryHosts,
  type AdoptedClaudeHost,
  type AdoptedCodexHost,
} from "./registry";
import { runtimeHostClient, type RuntimeHostClient } from "./client";
import { bindStructuredDeliveryQueue } from "./structuredDeliveryController";
import { recoverPendingStructuredSpawns } from "./structuredSpawn";

type AdoptedStructuredHost = AdoptedCodexHost | AdoptedClaudeHost;
let adoptedHosts: AdoptedStructuredHost[] = [];

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
  );
  adoptedHosts = [...codex, ...claude];
  const client = dependencies.client === undefined ? runtimeHostClient() : dependencies.client;
  await bindStructuredDeliveryQueue(adoptedHosts, { registry: dependencies.registry, client });
  if (client) await recoverPendingStructuredSpawns(registry, client);
  return adoptedHosts;
}

export function structuredStartupHosts(): readonly AdoptedStructuredHost[] {
  return adoptedHosts;
}
