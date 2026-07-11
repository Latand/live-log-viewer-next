import { agentRegistry } from "@/lib/agent/registry";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { listFiles } from "@/lib/scanner";
import { claudeProjectRootFor, codexSessionRootFor, pathAllowed } from "@/lib/scanner/roots";
import { livePidForPath } from "@/lib/session/livePane";
import { isRenameableTranscriptPath } from "@/lib/session/renameEligibility";
import { renameTmuxWindowForPid } from "@/lib/tmux";

/** A concrete, rename-eligible session resolved from a PATCH request. */
export interface TitleTarget {
  engine: "claude" | "codex";
  path: string;
  /** Canonical Viewer conversation id when the registry owns this session. */
  conversationId?: string;
  /** Former conversation ids the registry has coalesced into `conversationId`;
      title lookups/writes include them so a title filed under a provisional id
      stays reachable and migrates onto the canonical one. */
  aliasConversationIds: string[];
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

/** Every conversation id the registry currently resolves to `canonicalId`
    (excluding the canonical id itself), so a title stored under an old id is
    still found after coalescing. */
function aliasConversationIds(canonicalId: string): string[] {
  const registry = agentRegistry();
  const aliases = registry.snapshot().conversationAliases;
  const result: string[] = [];
  for (const alias of Object.keys(aliases)) {
    if (alias !== canonicalId && registry.canonicalConversationId(alias as ViewerConversationId) === canonicalId) result.push(alias);
  }
  return result;
}

/**
 * Resolves a rename request to a concrete session. The Viewer conversation
 * identity owns the title when the registry knows it (so account/compaction
 * successors adopt it); a bare transcript path is accepted only when it lands
 * inside an allowed root. A submitted conversation id is canonicalized so the
 * title never stays filed under a provisional alias. Returns null for anything
 * unknown or unsupported.
 */
export function resolveTitleTarget(input: TitleTargetInput): TitleTarget | null {
  const requested = typeof input.conversationId === "string" && input.conversationId.startsWith("conversation_") ? input.conversationId : undefined;
  if (requested) {
    const conversation = agentRegistry().conversation(requested as ViewerConversationId);
    const path = conversation?.generations.at(-1)?.path;
    if (conversation && path && (conversation.engine === "claude" || conversation.engine === "codex") && isRenameableTranscriptPath(conversation.engine, path)) {
      // `conversation.id` is the canonical id even when `requested` was an alias.
      return { engine: conversation.engine, path, conversationId: conversation.id, aliasConversationIds: aliasConversationIds(conversation.id) };
    }
    return null;
  }
  const path = typeof input.path === "string" ? input.path : "";
  if (!path || !pathAllowed(path)) return null;
  const engine = engineForPath(path);
  if (!engine || !isRenameableTranscriptPath(engine, path)) return null;
  const owner = agentRegistry().conversationForPath(path);
  return { engine, path, conversationId: owner?.id, aliasConversationIds: owner ? aliasConversationIds(owner.id) : [] };
}

/**
 * Best-effort tmux window rename bound to the target's own live pane. The pane
 * pid is resolved from the scanner by the target's transcript path — never from
 * the request — so a stale, reused, or crafted pid can't rename an unrelated
 * session's window. No live pane ⇒ silent no-op. Never throws.
 */
export async function propagateTitleToWindow(target: TitleTarget, windowName: string): Promise<void> {
  const entries = await listFiles().catch(() => []);
  const pid = livePidForPath(entries, target.path);
  if (pid === null) return;
  await renameTmuxWindowForPid(pid, windowName).catch(() => null);
}
