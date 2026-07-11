import { agentRegistry } from "@/lib/agent/registry";
import { claudeProjectRootFor, codexSessionRootFor, pathAllowed } from "@/lib/scanner/roots";
import { isRenameableTranscriptPath } from "@/lib/session/renameEligibility";
import { renameTmuxWindowForPid } from "@/lib/tmux";

/** A concrete, rename-eligible session resolved from a PATCH request. */
export interface TitleTarget {
  engine: "claude" | "codex";
  path: string;
  /** Present when the registry owns this session's stable identity. */
  conversationId?: string;
}

export interface TitleTargetInput {
  path?: unknown;
  conversationId?: unknown;
}

function engineForPath(pathname: string): "claude" | "codex" | null {
  if (codexSessionRootFor(pathname)) return "codex";
  if (claudeProjectRootFor(pathname)) return "claude";
  return null;
}

/**
 * Resolves a rename request to a concrete session. The Viewer conversation
 * identity owns the title when the registry knows it (so account/compaction
 * successors adopt it); a bare transcript path is accepted only when it lands
 * inside an allowed root. Returns null for anything unknown or unsupported.
 */
export function resolveTitleTarget(input: TitleTargetInput): TitleTarget | null {
  const conversationId = typeof input.conversationId === "string" && input.conversationId.startsWith("conversation_") ? input.conversationId : undefined;
  if (conversationId) {
    const conversation = agentRegistry().conversation(conversationId as `conversation_${string}`);
    const path = conversation?.generations.at(-1)?.path;
    if (conversation && path && (conversation.engine === "claude" || conversation.engine === "codex") && isRenameableTranscriptPath(conversation.engine, path)) {
      return { engine: conversation.engine, path, conversationId };
    }
    return null;
  }
  const path = typeof input.path === "string" ? input.path : "";
  if (!path || !pathAllowed(path)) return null;
  const engine = engineForPath(path);
  if (!engine || !isRenameableTranscriptPath(engine, path)) return null;
  const owner = agentRegistry().conversationForPath(path);
  return { engine, path, conversationId: owner?.id };
}

/** Best-effort tmux window rename for a live session pid. Never throws. */
export async function propagateTitleToWindow(pid: number, windowName: string): Promise<void> {
  await renameTmuxWindowForPid(pid, windowName).catch(() => null);
}
