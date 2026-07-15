import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { listFilesWithProjectCatalog } from "@/lib/scanner";

type FileScanSnapshot = Awaited<ReturnType<typeof listFilesWithProjectCatalog>>;
type FileScanRefresh = {
  generation: number;
  promise: Promise<FileScanSnapshot>;
};
type PinnedFileScanSnapshot = CachedFileScan & {
  refreshedAt: number;
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
  pinnedSnapshots?: Map<string, PinnedFileScanSnapshot>;
};

export type CachedFileScan = {
  snapshot: FileScanSnapshot;
  pinOverlayPaths?: string[];
};

const FILE_SCAN_FRESH_MS = 1_000;
const FILE_SCAN_CACHE_SCHEMA_VERSION = 3 as const;
const FILE_SCAN_SNAPSHOT_VERSION = 1 as const;
const FILE_SCAN_SNAPSHOT_FILE = "files-scan-snapshot.json";
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

function isFileScanSnapshot(value: unknown): value is FileScanSnapshot {
  if (!isRecord(value) || !Array.isArray(value.files) || !Array.isArray(value.projectCatalog)) return false;
  const filesValid = value.files.every((candidate) => {
    if (!isRecord(candidate)) return false;
    return typeof candidate.path === "string"
      && (candidate.root === "codex-sessions" || candidate.root === "claude-projects" || candidate.root === "claude-tasks")
      && typeof candidate.name === "string"
      && typeof candidate.project === "string"
      && typeof candidate.title === "string"
      && (candidate.engine === "codex" || candidate.engine === "claude" || candidate.engine === "shell")
      && typeof candidate.kind === "string"
      && (candidate.fmt === "codex" || candidate.fmt === "claude" || candidate.fmt === "plain")
      && (candidate.parent === null || typeof candidate.parent === "string")
      && typeof candidate.mtime === "number" && Number.isFinite(candidate.mtime)
      && typeof candidate.size === "number" && Number.isFinite(candidate.size)
      && (candidate.activity === "live" || candidate.activity === "recent" || candidate.activity === "stalled" || candidate.activity === "idle")
      && (candidate.proc === null || candidate.proc === "running" || candidate.proc === "done" || candidate.proc === "killed")
      && (candidate.pid === null || typeof candidate.pid === "number")
      && (candidate.model === null || typeof candidate.model === "string")
      && (candidate.pendingQuestion === null || isRecord(candidate.pendingQuestion))
      && (candidate.waitingInput === null || isRecord(candidate.waitingInput));
  });
  const catalogValid = value.projectCatalog.every((candidate) => isRecord(candidate)
    && typeof candidate.project === "string"
    && typeof candidate.smt === "number" && Number.isFinite(candidate.smt)
    && typeof candidate.conversations === "number" && Number.isSafeInteger(candidate.conversations)
    && (candidate.projectRoot === undefined || typeof candidate.projectRoot === "string"));
  return filesValid && catalogValid;
}

function readPersistedFileScanSnapshot(): FileScanSnapshot | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(statePath(FILE_SCAN_SNAPSHOT_FILE), "utf8")) as unknown;
    if (!isRecord(value) || value.version !== FILE_SCAN_SNAPSHOT_VERSION || !isFileScanSnapshot(value.snapshot)) return undefined;
    return value.snapshot;
  } catch {
    return undefined;
  }
}

function writePersistedFileScanSnapshot(snapshot: FileScanSnapshot): void {
  try {
    const filename = statePath(FILE_SCAN_SNAPSHOT_FILE);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify({ version: FILE_SCAN_SNAPSHOT_VERSION, snapshot }) + "\n", "utf8");
    fs.renameSync(temporary, filename);
  } catch {
    // A later completed refresh can recreate the snapshot.
  }
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
  const promise = listFilesWithProjectCatalog(undefined, { persist: false, persistIndex: true }).then((snapshot) => {
    writePersistedFileScanSnapshot(snapshot);
    slot.snapshot = snapshot;
    slot.snapshotGeneration = Math.max(slot.snapshotGeneration, generation);
    slot.refreshedAt = Date.now();
    return snapshot;
  });
  return installFileScanRefresh(slot, generation, promise);
}

function beginPinnedFileScanRefresh(slot: FileScanCacheSlot, generation: number, pinnedPath: string): FileScanRefresh {
  const promise = (async () => {
    const pinnedSnapshot = await listFilesWithProjectCatalog(undefined, { persist: false, persistIndex: true, pin: pinnedPath });
    const pinOverlayPaths = pinnedSnapshot.pinOverlayPaths ?? [];
    const overlayPathSet = new Set(pinOverlayPaths);
    const globalSnapshot = {
      files: pinnedSnapshot.files.filter((file) => !overlayPathSet.has(file.path)),
      projectCatalog: pinnedSnapshot.projectCatalog,
    };
    slot.pinnedSnapshots ??= new Map();
    slot.pinnedSnapshots.set(pinnedPath, {
      snapshot: {
        ...globalSnapshot,
        files: pinnedSnapshot.files,
      },
      ...(pinOverlayPaths.length ? { pinOverlayPaths } : {}),
      refreshedAt: Date.now(),
    });
    writePersistedFileScanSnapshot(globalSnapshot);
    slot.snapshot = globalSnapshot;
    slot.snapshotGeneration = Math.max(slot.snapshotGeneration, generation);
    slot.refreshedAt = Date.now();
    return globalSnapshot;
  })();
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
    const persisted = readPersistedFileScanSnapshot();
    slot = {
      schemaVersion: FILE_SCAN_CACHE_SCHEMA_VERSION,
      snapshot: persisted,
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

  /* A pin is an overlay on one global snapshot. The scanner marks every row
     outside the global cap, letting one scan publish both views. A completed
     snapshot serves while that shared refresh runs. */
  if (pinnedPath) {
    slot.pinnedSnapshots ??= new Map();
    const pinned = slot.pinnedSnapshots.get(pinnedPath);
    if (!pinned || now - pinned.refreshedAt >= FILE_SCAN_FRESH_MS) {
      if (!slot.refresh) {
        const requestedGeneration = slot.requestedGeneration + 1;
        slot.requestedGeneration = requestedGeneration;
        beginPinnedFileScanRefresh(slot, requestedGeneration, pinnedPath);
      }
    }
    if (pinned) return structuredClone({ snapshot: pinned.snapshot, pinOverlayPaths: pinned.pinOverlayPaths });
    if (slot.snapshot) return { snapshot: structuredClone(slot.snapshot) };
    const globalSnapshot = await slot.refresh!.promise;
    const hydrated = slot.pinnedSnapshots.get(pinnedPath);
    return hydrated
      ? structuredClone({ snapshot: hydrated.snapshot, pinOverlayPaths: hydrated.pinOverlayPaths })
      : { snapshot: structuredClone(globalSnapshot) };
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
    const refresh = refreshThroughGeneration(slot, requestedGeneration);
    const clearForcedGeneration = () => {
      if (slot.forcedGeneration === requestedGeneration) {
        slot.forcedRevision = undefined;
        slot.forcedGeneration = undefined;
      }
    };
    if (!slot.snapshot) {
      try {
        const snapshot = await refresh;
        return { snapshot: structuredClone(snapshot) };
      } finally {
        clearForcedGeneration();
      }
    }
    void refresh.then(clearForcedGeneration, clearForcedGeneration);
    return { snapshot: structuredClone(slot.snapshot) };
  }

  if (!slot.snapshot) {
    const refresh = slot.refresh ?? beginFileScanRefresh(slot, slot.snapshotGeneration);
    const snapshot = await refresh.promise;
    return { snapshot: structuredClone(snapshot) };
  }

  if (now - slot.refreshedAt >= FILE_SCAN_FRESH_MS) {
    if (!slot.refresh) beginFileScanRefresh(slot, slot.snapshotGeneration);
  }
  return { snapshot: structuredClone(slot.snapshot) };
}

export function resetFilesRouteCacheForTests(): void {
  fileScanCache().clear();
}
