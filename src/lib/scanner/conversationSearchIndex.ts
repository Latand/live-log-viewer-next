import type { ConversationCatalogEntry } from "./conversationCatalog";
import { cleanTitle } from "@/lib/title";

import { searchTextForTranscript } from "./describe";

type TranscriptSearchText = ReturnType<typeof searchTextForTranscript>;
type SearchTextReader = (pathname: string, size: number, engine: "codex" | "claude") => TranscriptSearchText;
type YieldControl = () => Promise<void>;

interface SearchTextCacheEntry extends TranscriptSearchText {
  size: number;
  bytes: number;
}

const BATCH_SIZE = 24;
const MAX_SEARCH_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_SEARCH_CACHE_ENTRIES = 2_048;
const MAX_SEARCH_PROJECTION_BYTES = 128 * 1024 * 1024;
const MAX_SEARCH_PROJECTION_ENTRIES = 50_000;
const SEARCH_PROJECTION_TTL_MS = 15_000;
const store = globalThis as typeof globalThis & {
  __llvConversationSearchText?: Map<string, SearchTextCacheEntry>;
  __llvConversationSearchTextBytes?: number;
  __llvConversationSearchProjection?: {
    catalog: readonly ConversationCatalogEntry[];
    items: ConversationCatalogEntry[];
    expiresAt: number;
  };
  __llvConversationSearchProjectionTimer?: ReturnType<typeof setTimeout>;
  __llvConversationSearchBuild?: {
    catalog: readonly ConversationCatalogEntry[];
    controller: AbortController;
    promise: Promise<ConversationCatalogEntry[]>;
  };
};

function eventLoopYield(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export function pruneConversationSearchCache(catalogPaths: ReadonlySet<string>): void {
  const cache = store.__llvConversationSearchText;
  if (!cache) return;
  let cacheBytes = store.__llvConversationSearchTextBytes
    ?? [...cache].reduce((total, [pathname, entry]) => total + (entry.bytes ?? searchTextBytes(entry, pathname)), 0);
  for (const [pathname, entry] of cache) {
    if (catalogPaths.has(pathname)) continue;
    cache.delete(pathname);
    cacheBytes -= entry.bytes ?? searchTextBytes(entry, pathname);
  }
  store.__llvConversationSearchTextBytes = Math.max(0, cacheBytes);
}

async function buildIndex(
  catalog: readonly ConversationCatalogEntry[],
  readText: SearchTextReader,
  yieldControl: YieldControl,
  batchSize: number,
  maxCacheBytes: number,
  maxCacheEntries: number,
  signal?: AbortSignal,
): Promise<ConversationCatalogEntry[]> {
  const cache = store.__llvConversationSearchText ??= new Map();
  pruneConversationSearchCache(new Set(catalog.map((entry) => entry.path)));
  let cacheBytes = store.__llvConversationSearchTextBytes
    ?? [...cache].reduce((total, [pathname, entry]) => total + (entry.bytes ?? searchTextBytes(entry, pathname)), 0);
  const enforceBudget = () => {
    while ((cacheBytes > maxCacheBytes || cache.size > maxCacheEntries) && cache.size) {
      const oldestPath = cache.keys().next().value!;
      const oldest = cache.get(oldestPath)!;
      cache.delete(oldestPath);
      cacheBytes -= oldest.bytes ?? searchTextBytes(oldest, oldestPath);
    }
  };
  enforceBudget();
  store.__llvConversationSearchTextBytes = Math.max(0, cacheBytes);
  const indexed: ConversationCatalogEntry[] = [];
  for (let index = 0; index < catalog.length; index += 1) {
    signal?.throwIfAborted();
    const entry = catalog[index];
    let text = cache.get(entry.path);
    if (!text || text.size !== entry.size) {
      if (text) {
        cache.delete(entry.path);
        cacheBytes -= text.bytes ?? searchTextBytes(text, entry.path);
        store.__llvConversationSearchTextBytes = Math.max(0, cacheBytes);
      }
      const hydrated = readText(entry.path, entry.size, entry.engine);
      text = { ...hydrated, size: entry.size, bytes: searchTextBytes(hydrated, entry.path) };
      /* A full-catalog sweep must preserve entries retained from its previous
         run. Admit a miss only into free capacity, preventing early misses
         from evicting entries the same sweep has yet to reuse. */
      if (cache.size < maxCacheEntries && cacheBytes + text.bytes <= maxCacheBytes) {
        cache.set(entry.path, text);
        cacheBytes += text.bytes;
        store.__llvConversationSearchTextBytes = Math.max(0, cacheBytes);
      }
    }
    indexed.push({
      ...entry,
      title: entry.kind === "session" && text.title ? cleanTitle(text.title, 120) : entry.title,
      firstPrompt: text.firstPrompt ?? "",
    });
    if ((index + 1) % batchSize === 0) {
      await yieldControl();
      signal?.throwIfAborted();
    }
  }
  store.__llvConversationSearchTextBytes = Math.max(0, cacheBytes);
  return indexed;
}

function searchTextBytes(text: TranscriptSearchText, pathname: string): number {
  return 128 + 2 * (pathname.length + (text.title?.length ?? 0) + (text.firstPrompt?.length ?? 0));
}

function projectionFits(items: readonly ConversationCatalogEntry[], maxBytes: number, maxEntries: number): boolean {
  if (items.length > maxEntries) return false;
  let bytes = 0;
  for (const entry of items) {
    bytes += 192 + 2 * (entry.path.length + entry.project.length + entry.title.length + entry.firstPrompt.length);
    if (bytes > maxBytes) return false;
  }
  return true;
}

export function conversationSearchCacheStats(): { entries: number; trackedBytes: number; computedBytes: number } {
  const cache = store.__llvConversationSearchText ?? new Map();
  return {
    entries: cache.size,
    trackedBytes: store.__llvConversationSearchTextBytes ?? 0,
    computedBytes: [...cache].reduce((total, [pathname, entry]) => total + searchTextBytes(entry, pathname), 0),
  };
}

/** Builds the uncapped search projection in small event-loop batches. The
 * scheme scanner never calls this path, and repeated searches reuse transcript
 * head text until a file's size changes. */
export async function indexConversationCatalog(
  catalog: readonly ConversationCatalogEntry[],
  options: {
    readText?: SearchTextReader;
    yieldControl?: YieldControl;
    batchSize?: number;
    maxCacheBytes?: number;
    maxCacheEntries?: number;
    signal?: AbortSignal;
    reuseProjection?: boolean;
    maxProjectionBytes?: number;
    maxProjectionEntries?: number;
  } = {},
): Promise<ConversationCatalogEntry[]> {
  const readText = options.readText ?? searchTextForTranscript;
  const yieldControl = options.yieldControl ?? eventLoopYield;
  const batchSize = Math.max(1, options.batchSize ?? BATCH_SIZE);
  const maxCacheBytes = Math.max(0, options.maxCacheBytes ?? MAX_SEARCH_CACHE_BYTES);
  const maxCacheEntries = Math.max(0, Math.floor(options.maxCacheEntries ?? MAX_SEARCH_CACHE_ENTRIES));
  const maxProjectionBytes = Math.max(0, options.maxProjectionBytes ?? MAX_SEARCH_PROJECTION_BYTES);
  const maxProjectionEntries = Math.max(0, Math.floor(options.maxProjectionEntries ?? MAX_SEARCH_PROJECTION_ENTRIES));
  const hasOverrides = Boolean(options.readText || options.yieldControl || options.batchSize
    || options.maxCacheBytes !== undefined || options.maxCacheEntries !== undefined);
  const reuseProjection = options.reuseProjection ?? !hasOverrides;
  if (!reuseProjection) {
    return buildIndex(catalog, readText, yieldControl, batchSize, maxCacheBytes, maxCacheEntries, options.signal);
  }

  options.signal?.throwIfAborted();
  const ready = store.__llvConversationSearchProjection;
  if (ready && ready.expiresAt <= Date.now()) delete store.__llvConversationSearchProjection;
  else if (ready?.catalog === catalog) return ready.items;
  let building = store.__llvConversationSearchBuild;
  if (building?.catalog !== catalog) {
    building?.controller.abort();
    delete store.__llvConversationSearchProjection;
    if (store.__llvConversationSearchProjectionTimer) clearTimeout(store.__llvConversationSearchProjectionTimer);
    const controller = new AbortController();
    const promise = buildIndex(catalog, readText, yieldControl, batchSize, maxCacheBytes, maxCacheEntries, controller.signal);
    building = { catalog, controller, promise };
    store.__llvConversationSearchBuild = building;
    void promise.then((items) => {
      if (store.__llvConversationSearchBuild === building && projectionFits(items, maxProjectionBytes, maxProjectionEntries)) {
        const projection = { catalog, items, expiresAt: Date.now() + SEARCH_PROJECTION_TTL_MS };
        store.__llvConversationSearchProjection = projection;
        store.__llvConversationSearchProjectionTimer = setTimeout(() => {
          if (store.__llvConversationSearchProjection === projection) delete store.__llvConversationSearchProjection;
        }, SEARCH_PROJECTION_TTL_MS);
        store.__llvConversationSearchProjectionTimer.unref?.();
      }
    }).finally(() => {
      if (store.__llvConversationSearchBuild === building) delete store.__llvConversationSearchBuild;
    }).catch(() => undefined);
  }
  return waitForSearchProjection(building.promise, options.signal);
}

function waitForSearchProjection(promise: Promise<ConversationCatalogEntry[]>, signal?: AbortSignal): Promise<ConversationCatalogEntry[]> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const cleanup = () => signal.removeEventListener("abort", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    void promise.then(
      (items) => { cleanup(); resolve(items); },
      (error) => { cleanup(); reject(error); },
    );
  });
}
