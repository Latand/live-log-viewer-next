import type { AgentRegistry, RegistryConversation } from "@/lib/agent/registry";

export const BRANCH_SHARED_HOST_CODE = "branch-shares-root-host" as const;
export const BRANCH_SHARED_HOST_ERROR =
  "branch conversations share their root runtime host; dismiss the branch card or terminate the root conversation explicitly";

type BranchLineageRegistry = Pick<AgentRegistry, "canonicalConversationId" | "readOnlySnapshot">;

export function branchSharesRootHost(
  registry: BranchLineageRegistry,
  conversation: RegistryConversation | null,
): boolean {
  const parentConversationId = conversation?.generations.at(-1)?.launchProfile.parentConversationId ?? null;
  if (!conversation || !parentConversationId || parentConversationId === conversation.id) return false;
  const conversationId = registry.canonicalConversationId(conversation.id);
  const lineage = registry.readOnlySnapshot().lineageEdges[conversationId];
  /* Viewer-spawn lineage owns an independent host (pipeline stages included).
     Engine-native lineage shares its root executor. Missing legacy provenance
     stays protected because it cannot prove an independently owned host. */
  return lineage?.source !== "viewer-spawn";
}
