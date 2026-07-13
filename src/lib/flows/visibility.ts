import type { RegistryFile } from "@/lib/agent/registry";
import type { FileEntry } from "@/lib/types";

import type { Flow } from "./types";

export function projectRestoredFlows(
  flows: readonly Flow[],
  files: readonly FileEntry[],
  context: { pinnedPaths: ReadonlySet<string>; memberships: RegistryFile["memberships"] },
): Flow[] {
  const pinnedConversationIds = new Set(files
    .filter((file) => context.pinnedPaths.has(file.path) && file.conversationId)
    .map((file) => file.conversationId!));
  const restoredFlowIds = new Set<string>();
  for (const conversationId of pinnedConversationIds) {
    for (const membership of context.memberships[conversationId] ?? []) {
      if (membership.kind === "flow") restoredFlowIds.add(membership.containerId);
    }
  }
  return flows.map((flow) => {
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
