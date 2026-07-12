import { accountManager } from "@/lib/accounts/manager";
import { agentRegistry, type AgentRegistry, type AgentRegistryEntry } from "@/lib/agent/registry";

import { adoptCodexRegistryHosts, type AdoptedCodexHost } from "./registry";

let adoptedHosts: AdoptedCodexHost[] = [];

export interface StructuredStartupDependencies {
  registry?: AgentRegistry;
  adopt?: typeof adoptCodexRegistryHosts;
  resolveCodexOwner?: (entry: AgentRegistryEntry) => { home: string; kind: "legacy" | "managed" } | null;
}

/** Called once by Next instrumentation before the Node server accepts requests. */
export async function adoptStructuredHostsAtStartup(
  dependencies: StructuredStartupDependencies = {},
): Promise<AdoptedCodexHost[]> {
  const resolveCodexOwner = dependencies.resolveCodexOwner ?? ((entry: AgentRegistryEntry) =>
    accountManager.resolveTranscriptOwner("codex", entry.artifactPath));
  adoptedHosts = await (dependencies.adopt ?? adoptCodexRegistryHosts)(
    dependencies.registry ?? agentRegistry(),
    (entry) => {
      const owner = resolveCodexOwner(entry);
      return {
        cwd: entry.cwd,
        codexHome: owner?.home,
        fileAuthCredentials: owner?.kind === "managed",
        model: entry.launchProfile?.model ?? undefined,
        effort: entry.launchProfile?.effort ?? undefined,
      };
    },
  );
  return adoptedHosts;
}

export function structuredStartupHosts(): readonly AdoptedCodexHost[] {
  return adoptedHosts;
}
