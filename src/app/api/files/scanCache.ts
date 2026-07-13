import { listFilesWithProjectCatalog } from "@/lib/scanner";

type FileScanSnapshot = Awaited<ReturnType<typeof listFilesWithProjectCatalog>>;
type FileScanRefresh = {
  generation: number;
  promise: Promise<FileScanSnapshot>;
};
type FileScanCacheSlot = {
  schemaVersion: typeof FILE_SCAN_CACHE_SCHEMA_VERSION;
  snapshot?: FileScanSnapshot;
  snapshotGeneration: number;
  requestedGeneration: number;
  forcedRevision?: number;
  forcedGeneration?: number;
  refreshedAt: number;
  refresh?: FileScanRefresh;
};

export type CachedFileScan = {
  snapshot: FileScanSnapshot;
  pinOverlayPaths?: string[];
};

const FILE_SCAN_FRESH_MS = 1_000;
const FILE_SCAN_CACHE_SCHEMA_VERSION = 3 as const;
const fileScanCacheStore = globalThis as typeof globalThis & {
  __llvFilesRouteScans?: Map<string, unknown>;
};

function fileScanCache(): Map<string, unknown> {
  fileScanCacheStore.__llvFilesRouteScans ??= new Map();
  return fileScanCacheStore.__llvFilesRouteScans;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function refreshPromise(value: unknown): Promise<FileScanSnapshot> | undefined {
  if (isRecord(value) && "promise" in value) return refreshPromise(value.promise);
  if (isRecord(value) && typeof value.then === "function") {
    return Promise.resolve(value as unknown as PromiseLike<FileScanSnapshot>);
  }
  return undefined;
}

function installFileScanRefresh(slot: FileScanCacheSlot, generation: number, promise: Promise<FileScanSnapshot>): FileScanRefresh {
  const refresh = { generation, promise };
  slot.refresh = refresh;
  const clear = () => {
    if (slot.refresh === refresh) slot.refresh = undefined;
  };
  void promise.then(clear, clear);
  return refresh;
}

function normalizeFileScanCacheSlot(value: unknown): FileScanCacheSlot {
  if (
    isRecord(value)
    && value.schemaVersion === FILE_SCAN_CACHE_SCHEMA_VERSION
    && Number.isSafeInteger(value.snapshotGeneration)
    && Number.isSafeInteger(value.requestedGeneration)
  ) {
    return value as FileScanCacheSlot;
  }

  const legacy = isRecord(value) ? value : {};
  const slot: FileScanCacheSlot = {
    schemaVersion: FILE_SCAN_CACHE_SCHEMA_VERSION,
    snapshot: legacy.snapshot as FileScanSnapshot | undefined,
    snapshotGeneration: 0,
    requestedGeneration: 0,
    refreshedAt: typeof legacy.refreshedAt === "number" && Number.isFinite(legacy.refreshedAt) ? legacy.refreshedAt : 0,
  };
  const pending = refreshPromise(legacy.refresh);
  if (pending) {
    const promise = pending.then((snapshot) => {
      slot.snapshot = snapshot;
      slot.refreshedAt = Date.now();
      return snapshot;
    });
    installFileScanRefresh(slot, 0, promise);
  }
  return slot;
}

function beginFileScanRefresh(slot: FileScanCacheSlot, generation: number): FileScanRefresh {
  const promise = listFilesWithProjectCatalog(undefined, { persist: false }).then((snapshot) => {
    slot.snapshot = snapshot;
    slot.snapshotGeneration = Math.max(slot.snapshotGeneration, generation);
    slot.refreshedAt = Date.now();
    return snapshot;
  });
  return installFileScanRefresh(slot, generation, promise);
}

async function refreshThroughGeneration(
  slot: FileScanCacheSlot,
  requestedGeneration: number,
): Promise<FileScanSnapshot> {
  while (!slot.snapshot || slot.snapshotGeneration < requestedGeneration) {
    const refresh = slot.refresh ?? beginFileScanRefresh(slot, requestedGeneration);
    await refresh.promise;
  }
  return slot.snapshot;
}

export async function cachedFileScan(
  _selectedProject?: string,
  pinnedPath?: string,
  now = Date.now(),
  requiredRevision?: number,
): Promise<CachedFileScan> {
  const key = "";
  const cache = fileScanCache();
  const cachedSlot = cache.get(key);
  let slot: FileScanCacheSlot;
  if (cachedSlot === undefined) {
    slot = {
      schemaVersion: FILE_SCAN_CACHE_SCHEMA_VERSION,
      snapshotGeneration: 0,
      requestedGeneration: 0,
      refreshedAt: 0,
    };
    cache.set(key, slot);
  } else {
    slot = normalizeFileScanCacheSlot(cachedSlot);
    cache.delete(key);
    cache.set(key, slot);
  }

  /* A pin is an overlay on one global snapshot. Refresh the shared slot after
     collecting the pinned view, then append only rows the global cap omitted.
     The next ordinary request therefore sees the same or newer shared rows,
     while explicit provenance lets the browser discard the whole overlay. */
  if (pinnedPath) {
    const pinnedSnapshot = await listFilesWithProjectCatalog(undefined, { persist: false, pin: pinnedPath });
    const requestedGeneration = slot.requestedGeneration + 1;
    slot.requestedGeneration = requestedGeneration;
    const globalSnapshot = await refreshThroughGeneration(slot, requestedGeneration);
    const globalPaths = new Set(globalSnapshot.files.map((file) => file.path));
    const overlayFiles = pinnedSnapshot.files.filter((file) => !globalPaths.has(file.path));
    return structuredClone({
      snapshot: {
        ...globalSnapshot,
        files: [...globalSnapshot.files, ...overlayFiles],
      },
      ...(overlayFiles.length ? { pinOverlayPaths: overlayFiles.map((file) => file.path) } : {}),
    });
  }

  if (requiredRevision !== undefined) {
    let requestedGeneration: number;
    if (slot.forcedRevision === requiredRevision && slot.forcedGeneration !== undefined) {
      requestedGeneration = slot.forcedGeneration;
    } else {
      requestedGeneration = slot.requestedGeneration + 1;
      slot.requestedGeneration = requestedGeneration;
      slot.forcedRevision = requiredRevision;
      slot.forcedGeneration = requestedGeneration;
    }
    try {
      const snapshot = await refreshThroughGeneration(slot, requestedGeneration);
      return { snapshot: structuredClone(snapshot) };
    } finally {
      if (slot.forcedGeneration === requestedGeneration) {
        slot.forcedRevision = undefined;
        slot.forcedGeneration = undefined;
      }
    }
  }

  if (!slot.snapshot) {
    const refresh = slot.refresh ?? beginFileScanRefresh(slot, slot.snapshotGeneration);
    const snapshot = await refresh.promise;
    return { snapshot: structuredClone(snapshot) };
  }

  if (now - slot.refreshedAt >= FILE_SCAN_FRESH_MS) {
    const refresh = slot.refresh ?? beginFileScanRefresh(slot, slot.snapshotGeneration);
    const snapshot = await refresh.promise;
    return { snapshot: structuredClone(snapshot) };
  }
  return { snapshot: structuredClone(slot.snapshot) };
}

export function resetFilesRouteCacheForTests(): void {
  fileScanCache().clear();
}
