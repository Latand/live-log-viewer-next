import { accountManager } from "@/lib/accounts/manager";
import { agentRegistry, type AgentRegistry, type AgentRegistryEntry } from "@/lib/agent/registry";

import { adoptCodexRegistryHosts, type AdoptedCodexHost } from "./registry";

let adoptedHosts: AdoptedCodexHost[] = [];

export interface StructuredStartupDependencies {
  registry?: AgentRegistry;
  adopt?: typeof adoptCodexRegistryHosts;
  resolveCodexHome?: (entry: AgentRegistryEntry) => string | undefined;
}

/** Called once by Next instrumentation before the Node server accepts requests. */
export async function adoptStructuredHostsAtStartup(
  dependencies: StructuredStartupDependencies = {},
): Promise<AdoptedCodexHost[]> {
  const resolveCodexHome = dependencies.resolveCodexHome ?? ((entry: AgentRegistryEntry) =>
    accountManager.resolveTranscriptOwner("codex", entry.artifactPath)?.home);
  adoptedHosts = await (dependencies.adopt ?? adoptCodexRegistryHosts)(
    dependencies.registry ?? agentRegistry(),
    (entry) => ({
      cwd: entry.cwd,
      codexHome: resolveCodexHome(entry),
      model: entry.launchProfile?.model ?? undefined,
      effort: entry.launchProfile?.effort ?? undefined,
    }),
  );
  return adoptedHosts;
}

export function structuredStartupHosts(): readonly AdoptedCodexHost[] {
  return adoptedHosts;
}
