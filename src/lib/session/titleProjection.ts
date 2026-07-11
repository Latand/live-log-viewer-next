import { agentRegistry } from "@/lib/agent/registry";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import type { FileEntry } from "@/lib/types";

import { isRenameableSessionEntry } from "./renameEligibility";
import { applyTitleOverride, indexSessionTitles, loadSessionTitles } from "./titleStore";

/**
 * The single projection that makes a custom session title (issue #33) the last
 * word on `FileEntry.title` for every server consumer — the files response,
 * push notifications, `/api/timeline`, and `/api/resources` — instead of only
 * the files response. Each consumer applies it to its own scanner entries so
 * the override, the preserved `autoTitle`, and the `renamable` flag reach push
 * bodies, timeline actors, and resource rows alike.
 *
 * Stamps `conversationId` when the registry owns the path (needed for the
 * conversation-keyed override lookup, and a bonus canonical deep link for
 * push), applies the alias-aware override, and sets `renamable`. Idempotent and
 * safe to run after the files response has already stamped identity/launch
 * profile — it never re-derives `autoTitle` once set.
 */
export function overlaySessionTitles(entries: FileEntry[]): void {
  const index = indexSessionTitles(loadSessionTitles());
  const registry = agentRegistry();
  let snapshot: ReturnType<typeof registry.snapshot> | null;
  try {
    snapshot = registry.snapshot();
  } catch {
    // Registry unreadable (corrupt/skew): titles filed under UUID/path still
    // apply; conversation-keyed ones wait for the registry to recover.
    snapshot = null;
  }

  const conversationByPath = new Map<string, string>();
  const aliasesByCanonical = new Map<string, string[]>();
  if (snapshot) {
    for (const conversation of Object.values(snapshot.conversations)) {
      for (const generation of conversation.generations) if (!conversationByPath.has(generation.path)) conversationByPath.set(generation.path, conversation.id);
      for (const pathname of conversation.continuityPaths) if (!conversationByPath.has(pathname)) conversationByPath.set(pathname, conversation.id);
    }
    for (const alias of Object.keys(snapshot.conversationAliases)) {
      const canonical = registry.canonicalConversationId(alias as ViewerConversationId);
      if (canonical === alias) continue;
      const list = aliasesByCanonical.get(canonical);
      if (list) list.push(alias); else aliasesByCanonical.set(canonical, [alias]);
    }
  }

  for (const entry of entries) {
    if (entry.engine !== "claude" && entry.engine !== "codex") continue;
    if (!entry.conversationId) {
      const owner = conversationByPath.get(entry.path);
      if (owner) entry.conversationId = owner;
    }
    entry.renamable = isRenameableSessionEntry(entry);
    if (index.size > 0) applyTitleOverride(entry, index, entry.conversationId ? aliasesByCanonical.get(entry.conversationId) ?? [] : []);
  }
}
