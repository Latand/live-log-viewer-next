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
type PinnedFileScanSnapshot = Pick<CachedFileScan, "snapshot" | "pinOverlayPaths"> & {
  generation: number;
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
  pinnedGenerations?: Map<string, number>;
};

export type CachedFileScan = {
  snapshot: FileScanSnapshot;
  pinOverlayPaths?: string[];
  generation: number;
  targetGeneration: number;
};

const FILE_SCAN_FRESH_MS = 1_000;
const FILE_SCAN_PIN_CACHE_MAX = 8;
const FILE_SCAN_CACHE_SCHEMA_VERSION = 4 as const;
const FILE_SCAN_SNAPSHOT_VERSION = 1 as const;
const FILE_SCAN_SNAPSHOT_FILE = "files-scan-snapshot.json";
const FILE_SCAN_PERSISTENCE_DIAGNOSTIC_MS = 60_000;
let lastFileScanPersistenceDiagnosticAt = Number.NEGATIVE_INFINITY;
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
  if (!isRecord(value) || value.complete !== true || !Array.isArray(value.files) || !Array.isArray(value.projectCatalog)) return false;
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
  let temporary: string | undefined;
  let operation = "create state directory";
  let target = statePath(FILE_SCAN_SNAPSHOT_FILE);
  try {
    const filename = statePath(FILE_SCAN_SNAPSHOT_FILE);
    target = filename;
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${process.pid}.${crypto.randomUUID()}.tmp`);
    operation = "write temporary snapshot";
    target = temporary;
    fs.writeFileSync(temporary, JSON.stringify({ version: FILE_SCAN_SNAPSHOT_VERSION, snapshot }) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    operation = "rename temporary snapshot";
    target = filename;
    fs.renameSync(temporary, filename);
  } catch (error) {
    if (temporary !== undefined) {
      try {
        fs.unlinkSync(temporary);
      } catch {
        // The write may have failed before the temp file was created.
      }
    }
    const now = Date.now();
    if (now - lastFileScanPersistenceDiagnosticAt >= FILE_SCAN_PERSISTENCE_DIAGNOSTIC_MS) {
      lastFileScanPersistenceDiagnosticAt = now;
      const detail = error instanceof Error ? `${error.message}${"code" in error && error.code ? ` (${String(error.code)})` : ""}` : String(error);
      console.error(`[files scan cache] ${operation} failed for ${target}: ${detail}; a later refresh will retry`);
    }
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
    snapshot: isFileScanSnapshot(legacy.snapshot) ? legacy.snapshot : undefined,
    snapshotGeneration: 0,
    requestedGeneration: 0,
    refreshedAt: typeof legacy.refreshedAt === "number" && Number.isFinite(legacy.refreshedAt) ? legacy.refreshedAt : 0,
  };
  const pending = refreshPromise(legacy.refresh);
  if (pending) {
    const promise = pending.then((snapshot) => {
      if (!snapshot.complete) throw new Error("filesystem scan incomplete");
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
    if (!snapshot.complete) throw new Error("filesystem scan incomplete");
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
    if (!pinnedSnapshot.complete) throw new Error("filesystem scan incomplete");
    const pinOverlayPaths = pinnedSnapshot.pinOverlayPaths ?? [];
    const overlayPathSet = new Set(pinOverlayPaths);
    const globalSnapshot = {
      files: pinnedSnapshot.files.filter((file) => !overlayPathSet.has(file.path)),
      projectCatalog: pinnedSnapshot.projectCatalog,
      complete: true,
    };
    slot.pinnedSnapshots ??= new Map();
    slot.pinnedSnapshots.delete(pinnedPath);
    slot.pinnedSnapshots.set(pinnedPath, {
      snapshot: {
        ...globalSnapshot,
        files: pinnedSnapshot.files,
      },
      ...(pinOverlayPaths.length ? { pinOverlayPaths } : {}),
      generation,
      refreshedAt: Date.now(),
    });
    while (slot.pinnedSnapshots.size > FILE_SCAN_PIN_CACHE_MAX) {
      const oldest = slot.pinnedSnapshots.keys().next().value;
      if (oldest === undefined) break;
      slot.pinnedSnapshots.delete(oldest);
      slot.pinnedGenerations?.delete(oldest);
    }
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
  pinnedPath?: string,
): Promise<FileScanSnapshot> {
  while (
    !slot.snapshot
    || slot.snapshotGeneration < requestedGeneration
    || (pinnedPath !== undefined && (slot.pinnedSnapshots?.get(pinnedPath)?.generation ?? -1) < requestedGeneration)
  ) {
    const refresh = slot.refresh ?? (pinnedPath
      ? beginPinnedFileScanRefresh(slot, requestedGeneration, pinnedPath)
      : beginFileScanRefresh(slot, requestedGeneration));
    await refresh.promise;
  }
  return slot.snapshot;
}

function cachedPinnedSnapshot(slot: FileScanCacheSlot, pinnedPath: string): PinnedFileScanSnapshot | undefined {
  const pinned = slot.pinnedSnapshots?.get(pinnedPath);
  if (!pinned) return undefined;
  slot.pinnedSnapshots!.delete(pinnedPath);
  slot.pinnedSnapshots!.set(pinnedPath, pinned);
  return pinned;
}

function completedScan(slot: FileScanCacheSlot, pinnedPath: string | undefined, targetGeneration: number): CachedFileScan {
  const pinned = pinnedPath ? cachedPinnedSnapshot(slot, pinnedPath) : undefined;
  if (pinned) {
    return structuredClone({
      snapshot: pinned.snapshot,
      pinOverlayPaths: pinned.pinOverlayPaths,
      generation: pinned.generation,
      targetGeneration,
    });
  }
  return {
    snapshot: structuredClone(slot.snapshot!),
    generation: slot.snapshotGeneration,
    targetGeneration,
  };
}

function nextGeneration(slot: FileScanCacheSlot): number {
  slot.requestedGeneration += 1;
  return slot.requestedGeneration;
}

function continueRefreshInBackground(refresh: Promise<FileScanSnapshot>): void {
  /* The response carries an incomplete target generation. Its client retries
     until a later scan completes, including after this attempt rejects. */
  void refresh.catch(() => undefined);
}

function rememberPinnedGeneration(slot: FileScanCacheSlot, pinnedPath: string, generation: number): number {
  slot.pinnedGenerations ??= new Map();
  const remembered = Math.max(slot.pinnedGenerations.get(pinnedPath) ?? -1, generation);
  slot.pinnedGenerations.delete(pinnedPath);
  slot.pinnedGenerations.set(pinnedPath, remembered);
  while (slot.pinnedGenerations.size > FILE_SCAN_PIN_CACHE_MAX) {
    const oldest = slot.pinnedGenerations.keys().next().value;
    if (oldest === undefined) break;
    slot.pinnedGenerations.delete(oldest);
  }
  return remembered;
}

function pinnedRefreshGeneration(slot: FileScanCacheSlot, pinnedPath: string): number {
  const pending = slot.pinnedGenerations?.get(pinnedPath);
  const completed = slot.pinnedSnapshots?.get(pinnedPath)?.generation ?? -1;
  if (pending !== undefined && pending > completed) return pending;
  return rememberPinnedGeneration(slot, pinnedPath, nextGeneration(slot));
}

export async function cachedFileScan(
  _selectedProject?: string,
  pinnedPath?: string,
  now = Date.now(),
  requiredRevision?: number,
  requiredGeneration?: number,
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

  let targetGeneration = requiredGeneration !== undefined && requiredGeneration <= slot.requestedGeneration
    ? requiredGeneration
    : undefined;
  if (targetGeneration !== undefined) {
    if (pinnedPath) {
      targetGeneration = rememberPinnedGeneration(slot, pinnedPath, targetGeneration);
    }
  } else if (requiredRevision !== undefined) {
    let requestedGeneration: number;
    if (slot.forcedRevision === requiredRevision && slot.forcedGeneration !== undefined) {
      requestedGeneration = slot.forcedGeneration;
    } else {
      requestedGeneration = nextGeneration(slot);
      slot.forcedRevision = requiredRevision;
      slot.forcedGeneration = requestedGeneration;
    }
    targetGeneration = requestedGeneration;
    if (pinnedPath) {
      targetGeneration = rememberPinnedGeneration(slot, pinnedPath, requestedGeneration);
    }
    const refresh = refreshThroughGeneration(slot, targetGeneration, pinnedPath);
    const clearForcedGeneration = () => {
      if (slot.forcedGeneration === requestedGeneration) {
        slot.forcedRevision = undefined;
        slot.forcedGeneration = undefined;
      }
    };
    if (!slot.snapshot) {
      try {
        await refresh;
        return completedScan(slot, pinnedPath, targetGeneration);
      } finally {
        clearForcedGeneration();
      }
    }
    void refresh.then(clearForcedGeneration, clearForcedGeneration);
  }

  if (targetGeneration !== undefined) {
    const refresh = refreshThroughGeneration(slot, targetGeneration, pinnedPath);
    if (!slot.snapshot) await refresh;
    else continueRefreshInBackground(refresh);
    return completedScan(slot, pinnedPath, targetGeneration);
  }

  /* A pin is an overlay on one global snapshot. The scanner marks every row
     outside the global cap, letting one scan publish both views. A completed
     snapshot serves while that shared refresh runs. */
  if (pinnedPath) {
    slot.pinnedSnapshots ??= new Map();
    const pinned = cachedPinnedSnapshot(slot, pinnedPath);
    if (pinned && now - pinned.refreshedAt < FILE_SCAN_FRESH_MS) {
      return completedScan(slot, pinnedPath, pinned.generation);
    }
    targetGeneration = pinnedRefreshGeneration(slot, pinnedPath);
    const refresh = refreshThroughGeneration(slot, targetGeneration, pinnedPath);
    if (!slot.snapshot) await refresh;
    else continueRefreshInBackground(refresh);
    return completedScan(slot, pinnedPath, targetGeneration);
  }

  if (!slot.snapshot) {
    targetGeneration = slot.refresh?.generation ?? nextGeneration(slot);
    const refresh = slot.refresh ?? beginFileScanRefresh(slot, targetGeneration);
    await refresh.promise;
    return completedScan(slot, undefined, targetGeneration);
  }

  if (slot.refresh) {
    targetGeneration = slot.refresh.generation;
  } else if (now - slot.refreshedAt >= FILE_SCAN_FRESH_MS) {
    targetGeneration = nextGeneration(slot);
    beginFileScanRefresh(slot, targetGeneration);
  } else {
    targetGeneration = slot.snapshotGeneration;
  }
  return completedScan(slot, undefined, targetGeneration);
}

export function resetFilesRouteCacheForTests(): void {
  fileScanCache().clear();
}
