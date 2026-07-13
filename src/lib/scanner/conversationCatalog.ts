import { stat } from "node:fs/promises";

import type { FileEntry, Fmt, RootKey } from "../types";

export interface ConversationCatalogEntry {
  path: string;
  root: RootKey;
  name: string;
  project: string;
  worktree?: string;
  title: string;
  firstPrompt: string;
  engine: "codex" | "claude";
  kind: string;
  fmt: Fmt;
  /** Unix seconds. */
  mtime: number;
  size: number;
}

export interface ConversationCatalogPage {
  items: ConversationCatalogEntry[];
  nextCursor: string | null;
  total: number;
}

export interface ConversationListPage {
  items: FileEntry[];
  nextCursor: string | null;
  total: number;
}

export type ConversationStat = (pathname: string) => Promise<{ size: number; mtimeMs: number }>;

export interface ConversationCatalogQuery {
  project?: string;
  query?: string;
  cursor?: string | null;
  limit?: number;
}

interface Cursor {
  mtime: number;
  path: string;
}

const DEFAULT_PAGE_SIZE = 40;
const MAX_PAGE_SIZE = 100;
const catalogStore = globalThis as typeof globalThis & {
  __llvConversationCatalog?: ConversationCatalogEntry[];
};

export function replaceConversationCatalog(entries: ConversationCatalogEntry[]): void {
  catalogStore.__llvConversationCatalog = entries;
}

export function conversationCatalogSnapshot(): readonly ConversationCatalogEntry[] {
  return catalogStore.__llvConversationCatalog ?? [];
}

export function conversationCatalogReady(): boolean {
  return catalogStore.__llvConversationCatalog !== undefined;
}

function encodeCursor(entry: ConversationCatalogEntry): string {
  return Buffer.from(JSON.stringify({ mtime: entry.mtime, path: entry.path } satisfies Cursor)).toString("base64url");
}

function decodeCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    if (typeof parsed.mtime !== "number" || !Number.isFinite(parsed.mtime) || typeof parsed.path !== "string") return null;
    return { mtime: parsed.mtime, path: parsed.path };
  } catch {
    return null;
  }
}

function afterCursor(entry: ConversationCatalogEntry, cursor: Cursor): boolean {
  return entry.mtime < cursor.mtime || (entry.mtime === cursor.mtime && entry.path > cursor.path);
}

function matchesQuery(entry: ConversationCatalogEntry, query: string): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const haystack = `${entry.title}\n${entry.firstPrompt}\n${entry.project}`.toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * Stable cursor pagination over the complete lightweight conversation catalog.
 * The catalog is independent of the scheme shortlist, so callers can traverse
 * every matching conversation while hydrating filesystem metadata one page at
 * a time.
 */
export function paginateConversationCatalog(
  catalog: readonly ConversationCatalogEntry[],
  options: ConversationCatalogQuery = {},
): ConversationCatalogPage {
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(options.limit ?? DEFAULT_PAGE_SIZE)));
  const cursor = decodeCursor(options.cursor);
  const matching = catalog
    .filter((entry) => !options.project || entry.project === options.project)
    .filter((entry) => matchesQuery(entry, options.query ?? ""))
    .sort((left, right) => right.mtime - left.mtime || left.path.localeCompare(right.path));
  const page = (cursor ? matching.filter((entry) => afterCursor(entry, cursor)) : matching).slice(0, limit + 1);
  const hasMore = page.length > limit;
  const items = hasMore ? page.slice(0, limit) : page;
  return {
    items,
    nextCursor: hasMore && items.length ? encodeCursor(items.at(-1)!) : null,
    total: matching.length,
  };
}

/** Minimal inactive FileEntry used by list/search results before a pin hydrates
 * the conversation through the full scheme scanner. */
export function catalogEntryToFileEntry(entry: ConversationCatalogEntry): FileEntry {
  return {
    path: entry.path,
    root: entry.root,
    name: entry.name,
    project: entry.project,
    worktree: entry.worktree,
    title: entry.title,
    engine: entry.engine,
    kind: entry.kind,
    fmt: entry.fmt,
    parent: null,
    mtime: entry.mtime,
    size: entry.size,
    activity: "idle",
    proc: null,
    pid: null,
    model: null,
    pendingQuestion: null,
    waitingInput: null,
  };
}

/** Hydrates one catalog page with current filesystem metadata. Directory
 * traversal and transcript parsing remain in the recurring discovery pass;
 * opening the list adds one stat per rendered row. */
export async function loadConversationCatalogPage(
  catalog: readonly ConversationCatalogEntry[],
  options: ConversationCatalogQuery = {},
  statFile: ConversationStat = stat,
): Promise<ConversationListPage> {
  const page = paginateConversationCatalog(catalog, options);
  const items = await Promise.all(page.items.map(async (entry) => {
    try {
      const current = await statFile(entry.path);
      return catalogEntryToFileEntry({
        ...entry,
        mtime: current.mtimeMs / 1000,
        size: current.size,
      });
    } catch {
      return null;
    }
  }));
  return {
    items: items.filter((item): item is FileEntry => item !== null),
    nextCursor: page.nextCursor,
    total: page.total,
  };
}
