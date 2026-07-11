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
  refreshScheduled?: boolean;
};

export type CachedFileScan = {
  snapshot: FileScanSnapshot;
  refreshAfterResponse?: () => Promise<void>;
};

const FILE_SCAN_FRESH_MS = 1_000;
const FILE_SCAN_CACHE_MAX_PROJECTS = 32;
const FILE_SCAN_CACHE_SCHEMA_VERSION = 2 as const;
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
    refreshScheduled: false,
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

function beginFileScanRefresh(slot: FileScanCacheSlot, selectedProject: string | undefined, generation: number): FileScanRefresh {
  const promise = listFilesWithProjectCatalog(selectedProject, { persist: false }).then((snapshot) => {
    slot.snapshot = snapshot;
    slot.snapshotGeneration = Math.max(slot.snapshotGeneration, generation);
    slot.refreshedAt = Date.now();
    return snapshot;
  });
  return installFileScanRefresh(slot, generation, promise);
}

async function refreshThroughGeneration(
  slot: FileScanCacheSlot,
  selectedProject: string | undefined,
  requestedGeneration: number,
): Promise<FileScanSnapshot> {
  while (!slot.snapshot || slot.snapshotGeneration < requestedGeneration) {
    const refresh = slot.refresh ?? beginFileScanRefresh(slot, selectedProject, requestedGeneration);
    await refresh.promise;
  }
  return slot.snapshot;
}

export async function cachedFileScan(
  selectedProject?: string,
  pinnedPath?: string,
  now = Date.now(),
  requiredRevision?: number,
): Promise<CachedFileScan> {
  /* Pinned scans are rare (a poll or two while a deep link resolves) and the
     pin value is user-controlled: caching them would grow one permanent
     snapshot slot per distinct path. They run uncached; the shared slots hold
     project-keyed scans only. */
  if (pinnedPath) {
    return { snapshot: await listFilesWithProjectCatalog(selectedProject, { persist: false, pin: pinnedPath }) };
  }
  const key = selectedProject ?? "";
  const cache = fileScanCache();
  const cachedSlot = cache.get(key);
  let slot: FileScanCacheSlot;
  if (cachedSlot === undefined) {
    if (cache.size >= FILE_SCAN_CACHE_MAX_PROJECTS) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
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
      const snapshot = await refreshThroughGeneration(slot, selectedProject, requestedGeneration);
      return { snapshot: structuredClone(snapshot) };
    } finally {
      if (slot.forcedGeneration === requestedGeneration) {
        slot.forcedRevision = undefined;
        slot.forcedGeneration = undefined;
      }
    }
  }

  if (!slot.snapshot) {
    const refresh = slot.refresh ?? beginFileScanRefresh(slot, selectedProject, slot.snapshotGeneration);
    const snapshot = await refresh.promise;
    return { snapshot: structuredClone(snapshot) };
  }

  let refreshAfterResponse: (() => Promise<void>) | undefined;
  if (!slot.refresh && !slot.refreshScheduled && now - slot.refreshedAt >= FILE_SCAN_FRESH_MS) {
    slot.refreshScheduled = true;
    refreshAfterResponse = async () => {
      try {
        const refresh = slot.refresh ?? beginFileScanRefresh(slot, selectedProject, slot.snapshotGeneration);
        await refresh.promise;
      } catch (error) {
        console.error("[files] background scan refresh failed", error);
      } finally {
        slot.refreshScheduled = false;
      }
    };
  }
  return { snapshot: structuredClone(slot.snapshot), refreshAfterResponse };
}

export function resetFilesRouteCacheForTests(): void {
  fileScanCache().clear();
}
