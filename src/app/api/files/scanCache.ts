import { listFilesWithProjectCatalog } from "@/lib/scanner";

type FileScanSnapshot = Awaited<ReturnType<typeof listFilesWithProjectCatalog>>;
type FileScanCacheSlot = {
  snapshot?: FileScanSnapshot;
  refreshedAt: number;
  refresh?: Promise<FileScanSnapshot>;
  refreshScheduled?: boolean;
};

export type CachedFileScan = {
  snapshot: FileScanSnapshot;
  refreshAfterResponse?: () => Promise<void>;
};

const FILE_SCAN_FRESH_MS = 1_000;
const fileScanCacheStore = globalThis as typeof globalThis & {
  __llvFilesRouteScans?: Map<string, FileScanCacheSlot>;
};

function fileScanCache(): Map<string, FileScanCacheSlot> {
  fileScanCacheStore.__llvFilesRouteScans ??= new Map();
  return fileScanCacheStore.__llvFilesRouteScans;
}

function beginFileScanRefresh(slot: FileScanCacheSlot, selectedProject?: string): Promise<FileScanSnapshot> {
  const refresh = listFilesWithProjectCatalog(selectedProject, { persist: false }).then((snapshot) => {
    slot.snapshot = snapshot;
    slot.refreshedAt = Date.now();
    return snapshot;
  }).finally(() => {
    if (slot.refresh === refresh) slot.refresh = undefined;
  });
  slot.refresh = refresh;
  return refresh;
}

export async function cachedFileScan(selectedProject?: string, pinnedPath?: string, now = Date.now()): Promise<CachedFileScan> {
  /* Pinned scans are rare (a poll or two while a deep link resolves) and the
     pin value is user-controlled: caching them would grow one permanent
     snapshot slot per distinct path. They run uncached; the shared slots hold
     project-keyed scans only. */
  if (pinnedPath) {
    return { snapshot: await listFilesWithProjectCatalog(selectedProject, { persist: false, pin: pinnedPath }) };
  }
  const key = selectedProject ?? "";
  const cache = fileScanCache();
  let slot = cache.get(key);
  if (!slot) {
    slot = { refreshedAt: 0 };
    cache.set(key, slot);
  }

  if (!slot.snapshot) {
    const snapshot = await (slot.refresh ?? beginFileScanRefresh(slot, selectedProject));
    return { snapshot: structuredClone(snapshot) };
  }

  let refreshAfterResponse: (() => Promise<void>) | undefined;
  if (!slot.refresh && !slot.refreshScheduled && now - slot.refreshedAt >= FILE_SCAN_FRESH_MS) {
    slot.refreshScheduled = true;
    refreshAfterResponse = async () => {
      try {
        await (slot.refresh ?? beginFileScanRefresh(slot, selectedProject));
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
