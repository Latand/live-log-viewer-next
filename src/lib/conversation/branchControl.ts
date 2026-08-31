import type { RegistryConversation } from "@/lib/agent/registry";

export const BRANCH_SHARED_HOST_CODE = "branch-shares-root-host" as const;
export const BRANCH_SHARED_HOST_ERROR =
  "branch conversations share their root runtime host; dismiss the branch card or terminate the root conversation explicitly";

export function branchSharesRootHost(conversation: RegistryConversation | null): boolean {
  const parentConversationId = conversation?.generations.at(-1)?.launchProfile.parentConversationId ?? null;
  return Boolean(parentConversationId && parentConversationId !== conversation?.id);
}
