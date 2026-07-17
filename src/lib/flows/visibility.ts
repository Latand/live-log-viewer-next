import type { RegistryFile } from "@/lib/agent/registry";
import type { FileEntry } from "@/lib/types";

import type { Flow } from "./types";

/** Transcript rows that keep every active flow materialized on its canonical project board. */
export function activeFlowTranscriptPaths(
  flows: readonly Flow[],
  selectedProject?: string,
  projectForPath: (pathname: string) => string | null = () => null,
): string[] {
  const paths = new Set<string>();
  for (const flow of flows) {
    const project = projectForPath(flow.implementerPath) ?? flow.project;
    if (flow.state === "closed" || (selectedProject && project !== selectedProject)) continue;
    paths.add(flow.implementerPath);
    for (const round of flow.rounds) {
      if (round.reviewerPath) paths.add(round.reviewerPath);
    }
  }
  return [...paths];
}

export function projectRestoredFlows(
  flows: readonly Flow[],
  files: readonly FileEntry[],
  context: { pinnedPaths: ReadonlySet<string>; memberships: RegistryFile["memberships"] },
): Flow[] {
  const fileByPath = new Map(files.map((file) => [file.path, file] as const));
  const pinnedConversationIds = new Set(files
    .filter((file) => context.pinnedPaths.has(file.path) && file.conversationId)
    .map((file) => file.conversationId!));
  const restoredFlowIds = new Set<string>();
  for (const conversationId of pinnedConversationIds) {
    for (const membership of context.memberships[conversationId] ?? []) {
      if (membership.kind === "flow") restoredFlowIds.add(membership.containerId);
    }
  }
  return flows.map((storedFlow) => {
    const canonicalProject = fileByPath.get(storedFlow.implementerPath)?.project;
    const flow = canonicalProject && canonicalProject !== storedFlow.project
      ? { ...storedFlow, project: canonicalProject }
      : storedFlow;
    if (flow.state !== "closed") return flow;
    const restored = restoredFlowIds.has(flow.id)
      || Boolean(flow.implementerConversationId && pinnedConversationIds.has(flow.implementerConversationId))
      || context.pinnedPaths.has(flow.implementerPath)
      || flow.rounds.some((round) => Boolean(
        (round.reviewerConversationId && pinnedConversationIds.has(round.reviewerConversationId))
        || (round.reviewerPath && context.pinnedPaths.has(round.reviewerPath)),
      ));
    return restored ? { ...flow, restored: true } : flow;
  });
}
