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
export type ConversationMetadataHydrator = (entry: ConversationCatalogEntry) => ConversationCatalogEntry | Promise<ConversationCatalogEntry>;

export interface ConversationCatalogQuery {
  project?: string;
  query?: string;
  cursor?: string | null;
  limit?: number;
}

interface Cursor {
  snapshot: number;
  offset: number;
}

interface CatalogPaginationSnapshot {
  items: ConversationCatalogEntry[];
  total: number;
}

const DEFAULT_PAGE_SIZE = 40;
const MAX_PAGE_SIZE = 100;
const catalogStore = globalThis as typeof globalThis & {
  __llvConversationCatalog?: ConversationCatalogEntry[];
  __llvConversationPagination?: Map<number, CatalogPaginationSnapshot>;
  __llvConversationPaginationSequence?: number;
};
const MAX_PAGINATION_SNAPSHOTS = 16;
const MAX_PAGINATION_ROWS = 20_000;

export class ExpiredConversationCatalogCursorError extends Error {
  constructor() {
    super("conversation catalog cursor expired");
    this.name = "ExpiredConversationCatalogCursorError";
  }
}

export function replaceConversationCatalog(entries: ConversationCatalogEntry[]): void {
  catalogStore.__llvConversationCatalog = entries;
}

export function conversationCatalogSnapshot(): readonly ConversationCatalogEntry[] {
  return catalogStore.__llvConversationCatalog ?? [];
}

export function conversationCatalogReady(): boolean {
  return catalogStore.__llvConversationCatalog !== undefined;
}

function paginationSnapshots(): Map<number, CatalogPaginationSnapshot> {
  return catalogStore.__llvConversationPagination ??= new Map();
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<Cursor>;
    if (!Number.isSafeInteger(parsed.snapshot) || !Number.isSafeInteger(parsed.offset) || parsed.offset! < 1) return null;
    return { snapshot: parsed.snapshot!, offset: parsed.offset! };
  } catch {
    return null;
  }
}

function rememberPagination(items: ConversationCatalogEntry[]): number {
  const snapshots = paginationSnapshots();
  const snapshot = (catalogStore.__llvConversationPaginationSequence ?? 0) + 1;
  catalogStore.__llvConversationPaginationSequence = snapshot;
  snapshots.set(snapshot, { items: [...items], total: items.length });
  let retainedRows = [...snapshots.values()].reduce((total, page) => total + page.items.length, 0);
  while ((snapshots.size > MAX_PAGINATION_SNAPSHOTS || retainedRows > MAX_PAGINATION_ROWS) && snapshots.size > 1) {
    const oldest = snapshots.keys().next().value!;
    retainedRows -= snapshots.get(oldest)!.items.length;
    snapshots.delete(oldest);
  }
  return snapshot;
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
  if (options.cursor && !cursor) throw new ExpiredConversationCatalogCursorError();
  let snapshotId: number;
  let offset: number;
  let snapshot: CatalogPaginationSnapshot;
  if (cursor) {
    const remembered = paginationSnapshots().get(cursor.snapshot);
    if (remembered) {
      snapshotId = cursor.snapshot;
      offset = cursor.offset;
      snapshot = remembered;
    } else {
      throw new ExpiredConversationCatalogCursorError();
    }
  } else {
    const matching = catalog
      .filter((entry) => !options.project || entry.project === options.project)
      .filter((entry) => matchesQuery(entry, options.query ?? ""))
      .sort((left, right) => right.mtime - left.mtime || left.path.localeCompare(right.path))
      .map((entry) => entry.firstPrompt ? { ...entry, firstPrompt: "" } : entry);
    snapshotId = rememberPagination(matching);
    offset = 0;
    snapshot = paginationSnapshots().get(snapshotId)!;
  }
  const items = snapshot.items.slice(offset, offset + limit);
  const nextOffset = offset + items.length;
  const hasMore = nextOffset < snapshot.total;
  if (!hasMore) paginationSnapshots().delete(snapshotId);
  return {
    items,
    nextCursor: hasMore ? encodeCursor({ snapshot: snapshotId, offset: nextOffset }) : null,
    total: snapshot.total,
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
  hydrateMetadata?: ConversationMetadataHydrator,
): Promise<ConversationListPage> {
  const page = paginateConversationCatalog(catalog, options);
  const items = await Promise.all(page.items.map(async (entry) => {
    const hydrated = hydrateMetadata ? await hydrateMetadata(entry) : entry;
    try {
      const current = await statFile(hydrated.path);
      return catalogEntryToFileEntry({
        ...hydrated,
        mtime: current.mtimeMs / 1000,
        size: current.size,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }));
  return {
    items: items.filter((item): item is FileEntry => item !== null),
    nextCursor: page.nextCursor,
    total: page.total,
  };
}
