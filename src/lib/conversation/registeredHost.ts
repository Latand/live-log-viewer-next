import type { AgentRegistryEntry, RegistryFile } from "@/lib/agent/registry";

/** Unique legacy ownership shared by presentation and the action fence. */
export function registeredHostForPath(
  snapshot: RegistryFile,
  filePath: string,
): AgentRegistryEntry | null {
  const candidates = Object.values(snapshot.entries)
    .filter((candidate) => candidate.artifactPath === filePath && candidate.host !== null);
  if (candidates.length !== 1) return null;
  const owned = candidates[0]!;
  const shared = Object.values(snapshot.entries).some((candidate) => candidate !== owned
    && candidate.host?.endpoint === owned.host?.endpoint
    && candidate.host?.paneId === owned.host?.paneId);
  return shared ? null : owned;
}

