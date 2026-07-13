import { agentRegistry } from "@/lib/agent/registry";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import type { FileEntry } from "@/lib/types";

import { isRenameableSessionEntry } from "./renameEligibility";
import { applyTitleOverride, indexSessionTitles, loadSessionTitles } from "./titleStore";

/**
 * The single projection for user-visible session metadata. The latest registry
 * launch profile supplies its title and project, then a custom title (issue
 * #33) has final precedence for every server consumer: files, conversation
 * search, push notifications, `/api/timeline`, and `/api/resources`.
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

  const conversationByPath = new Map<string, ViewerConversationId>();
  const aliasesByCanonical = new Map<string, string[]>();
  const ownedPathsByConversation = new Map<string, string[]>();
  if (snapshot) {
    for (const conversation of Object.values(snapshot.conversations)) {
      const owned = [...conversation.generations.map((generation) => generation.path), ...conversation.continuityPaths];
      ownedPathsByConversation.set(conversation.id, owned);
      for (const pathname of owned) if (!conversationByPath.has(pathname)) conversationByPath.set(pathname, conversation.id);
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
    const owner = conversationByPath.get(entry.path);
    if (!entry.conversationId) {
      if (owner) entry.conversationId = owner;
    }
    const conversation = owner ? snapshot?.conversations[owner] : undefined;
    const latest = conversation?.generations.at(-1);
    if (latest?.path === entry.path) {
      entry.title = latest.launchProfile.title ?? entry.title;
      entry.project = latest.launchProfile.project ?? entry.project;
    }
    entry.renamable = isRenameableSessionEntry(entry);
    if (index.size > 0) {
      const aliases = entry.conversationId ? aliasesByCanonical.get(entry.conversationId) ?? [] : [];
      const ownedPaths = entry.conversationId ? ownedPathsByConversation.get(entry.conversationId) ?? [] : [];
      applyTitleOverride(entry, index, aliases, ownedPaths);
    }
  }
}
