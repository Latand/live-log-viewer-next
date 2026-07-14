import { conversationIdentity } from "@/lib/accounts/identity";
import type { FileEntry } from "@/lib/types";

import { projectKey } from "@/components/projectModel";

/** A favorited conversation resolved to its freshest scanned generation. */
export interface FavoriteRow {
  /** Durable conversation identity (`conversationIdentity`). */
  id: string;
  file: FileEntry;
  project: string;
}

/**
 * Resolve the crowned ids to one row each — the freshest scanned generation of
 * that conversation, so a resumed chat lists once under its current file — and
 * sort freshest-first. Shared by the docked task panel, the mobile task sheet,
 * and the attention («Чекають») popover so every favorites surface mirrors the
 * pinned scheme row (issues #185, #224).
 */
export function resolveFavoriteRows(files: FileEntry[], favoriteIds: readonly string[]): FavoriteRow[] {
  if (favoriteIds.length === 0) return [];
  const favoriteSet = new Set(favoriteIds);
  const byId = new Map<string, FileEntry>();
  for (const file of files) {
    const id = conversationIdentity(file);
    if (!favoriteSet.has(id)) continue;
    const existing = byId.get(id);
    if (!existing || file.mtime > existing.mtime) byId.set(id, file);
  }
  return [...byId.entries()]
    .map(([id, file]) => ({ id, file, project: projectKey(file) }))
    .sort((a, b) => b.file.mtime - a.file.mtime);
}
