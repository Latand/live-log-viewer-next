import type { FileEntry } from "@/lib/types";

/**
 * Stable conversation identity for account migration (issue #40, Sol contract).
 *
 * A Viewer card owns one `ViewerConversationId` for its whole life. A native
 * generation under a different account gets a new transcript `path`, but the
 * card, its board position, its DOM key, and its deep link must stay put. So
 * every consumer that today keys on `path` should key on
 * {@link conversationIdentity} instead — it returns the stable id when the
 * backend supplies one and falls back to `path` otherwise, so pre-migration
 * payloads (today's reality) behave exactly as before.
 *
 * Callers must never walk `predecessorPath`/`migratedTo` to decide *current*
 * identity — those are compatibility/history metadata. The only cross-entry
 * lookups here match on `conversationId` equality, never on chain edges.
 */

/** The stable card identity: the conversation id when present, else the path. */
export function conversationIdentity(file: Pick<FileEntry, "conversationId" | "path">): string {
  return file.conversationId ?? file.path;
}

/** An archived predecessor: a committed migration moved this transcript's card
    onto a successor, so it folds into that successor's history and must not
    render as a standalone card / switchboard row / attention item. */
export function isArchivedPredecessor(file: Pick<FileEntry, "migratedTo">): boolean {
  return Boolean(file.migratedTo);
}

/** A successor: the current generation of a card that migrated at least once.
    Renders a "Continued from …" feed divider at the top of its transcript. */
export function isMigrationSuccessor(file: Pick<FileEntry, "predecessorPath">): boolean {
  return Boolean(file.predecessorPath);
}

// ── Deep links ────────────────────────────────────────────────────────────────

export interface ConversationHash {
  /** Canonical `#c=<conversationId>` target. */
  conversationId: string | null;
  /** Legacy `#f=<path>` target (resolved to the current generation on lookup). */
  filePath: string | null;
  /** `#p=<project>` selection. */
  project: string | null;
}

function decode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Parses a location hash into its conversation/file/project intent. Recognises
    the canonical `#c=` form alongside the existing `#f=` / `#p=` forms; the
    `#question` suffix on a file link is stripped (it drives a separate scroll). */
export function parseConversationHash(hash: string): ConversationHash {
  const conv = hash.match(/^#c=(.+)$/);
  if (conv) return { conversationId: decode((conv[1] ?? "").replace(/#question$/, "")), filePath: null, project: null };
  const file = hash.match(/^#f=(.+)$/);
  if (file) return { conversationId: null, filePath: decode((file[1] ?? "").replace(/#question$/, "")), project: null };
  const project = hash.match(/^#p=(.+)$/);
  if (project) return { conversationId: null, filePath: null, project: decode(project[1] ?? "") };
  return { conversationId: null, filePath: null, project: null };
}

/** Canonical hash for a file: `#c=` when it carries a stable id, else `#f=`.
    Callers writing deep links get forward-compatible URLs for free. */
export function formatConversationHash(file: Pick<FileEntry, "conversationId" | "path">): string {
  return file.conversationId
    ? "#c=" + encodeURIComponent(file.conversationId)
    : "#f=" + encodeURIComponent(file.path);
}

/** The current, visible entry for a stable id: the one generation that is not an
    archived predecessor. */
function currentByConversation(files: FileEntry[], conversationId: string): FileEntry | null {
  let fallback: FileEntry | null = null;
  for (const file of files) {
    if (file.conversationId !== conversationId) continue;
    fallback = fallback ?? file;
    if (!isArchivedPredecessor(file)) return file;
  }
  return fallback;
}

/**
 * Resolves a parsed hash to the file its card should open, applying legacy
 * resolution: a `#f=` path that now points at an archived predecessor redirects
 * to the current generation sharing its conversation id (one alias lookup, not
 * a chain walk). Returns `null` when nothing matches yet (the caller keeps the
 * request pending until the next `/api/files` poll).
 */
export function resolveConversationTarget(files: FileEntry[], hash: ConversationHash): FileEntry | null {
  if (hash.conversationId) return currentByConversation(files, hash.conversationId);
  if (hash.filePath) {
    const direct = files.find((file) => file.path === hash.filePath) ?? null;
    if (direct && isArchivedPredecessor(direct) && direct.conversationId) {
      return currentByConversation(files, direct.conversationId) ?? direct;
    }
    return direct;
  }
  return null;
}

/**
 * Filters archived predecessors out of a board/switchboard/attention list so a
 * migrated conversation shows as exactly one card (its current generation).
 * A no-op on pre-migration payloads.
 */
export function withoutArchivedPredecessors(files: FileEntry[]): FileEntry[] {
  if (!files.some(isArchivedPredecessor)) return files;
  return files.filter((file) => !isArchivedPredecessor(file));
}
