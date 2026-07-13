import type { ConversationHash } from "@/lib/accounts/identity";
import type { FileEntry } from "@/lib/types";

export interface ActiveConversationPin {
  value: string;
  targetPath: string;
  project: string;
}

function intentValue(intent: ConversationHash | null): string | null {
  return intent?.filePath ?? intent?.conversationId ?? null;
}

export function resolvedConversationPin(
  intent: ConversationHash,
  target: Pick<FileEntry, "path" | "project">,
): ActiveConversationPin | null {
  const value = intentValue(intent);
  return value ? { value, targetPath: target.path, project: target.project } : null;
}

export function releaseConversationPin(
  active: ActiveConversationPin | null,
  closedPath: string,
): ActiveConversationPin | null {
  return active?.targetPath === closedPath ? null : active;
}

export function pinForProject(
  active: ActiveConversationPin | null,
  project: string,
): ActiveConversationPin | null {
  return active?.project === project ? active : null;
}

export function filesRequestPin(
  pending: ConversationHash | null,
  active: ActiveConversationPin | null,
): string | null {
  return intentValue(pending) ?? active?.value ?? null;
}
