import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { statePath } from "@/lib/configDir";
import { listFilesWithProjectCatalog } from "@/lib/scanner";
import { globalCache } from "@/lib/scanner/caches";
import type { FileEntry } from "@/lib/types";

type FileScanSnapshot = Awaited<ReturnType<typeof listFilesWithProjectCatalog>>;
type FileScanRefresh = {
  generation: number;
  promise: Promise<FileScanSnapshot>;
  resourcePromise: Promise<FileScanSnapshot>;
  cancelBeforeStart?: () => boolean;
};
type FileScanReason = "cold" | "ordinary" | "pinned" | "revision" | "generation" | "fresh" | "current";
type FileScanDiagnostic = {
  generation: number;
  reason: FileScanReason;
  status: "complete" | "failed";
  durationMs: number;
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
  freshObservationGeneration?: number;
  refreshedAt: number;
  refresh?: FileScanRefresh;
  pinnedSnapshots?: Map<string, PinnedFileScanSnapshot>;
  pinnedGenerations?: Map<string, number>;
  requestCount?: number;
  lastScan?: FileScanDiagnostic;
  ordinaryRefreshRequestedAt?: number;
};

export type CachedFileScan = {
  snapshot: FileScanSnapshot;
  pinOverlayPaths?: string[];
  generation: number;
  targetGeneration: number;
  cacheStatus: "hit" | "stale" | "miss";
  requestCount: number;
  cloneDurationMs: number;
  lastScan?: FileScanDiagnostic;
};

const FILE_SCAN_FRESH_MS = 1_000;
/** Poll-driven attempts share the client's fallback cadence, including failures. */
const FILE_SCAN_ORDINARY_REFRESH_MS = 10_000;
const FILE_SCAN_PIN_CACHE_MAX = 8;
const FILE_SCAN_CACHE_SCHEMA_VERSION = 5 as const;
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

function persistedTurnState(entry: FileEntry): string | null | undefined {
  if (entry.activityReason === "jsonl_turn_open" || entry.activityReason === "jsonl_turn_stalled") return "busy";
  if (entry.activityReason === "jsonl_turn_completed") return "done";
  if (entry.activityReason === "mtime_fresh" || entry.activityReason === "mtime_recent" || entry.activityReason === "mtime_old") return null;
  return undefined;
}

function primePersistedFileDerivations(snapshot: FileScanSnapshot): void {
  for (const entry of snapshot.files) {
    let current: fs.Stats;
    try {
      current = fs.statSync(entry.path);
    } catch {
      continue;
    }
    if (current.size !== entry.size || current.mtimeMs / 1000 !== entry.mtime) continue;
    const turnState = persistedTurnState(entry);
    if (turnState !== undefined) globalCache<[number, string | null]>("turn").set(entry.path, [entry.size, turnState]);
    if (!(entry.root === "claude-projects" && entry.path.includes(`${path.sep}subagents${path.sep}`))) {
      globalCache<[number, { display: string | null; launch: string | null }]>("model")
        .set(entry.path, [entry.size, { display: entry.model, launch: entry.launchModel ?? null }]);
    }
    if (Object.hasOwn(entry, "effort") && !(entry.engine === "claude" && entry.proc === "running")) {
      globalCache<[number, string | null]>("effort").set(entry.path, [entry.size, entry.effort ?? null]);
    }
    if (Object.hasOwn(entry, "plan")) globalCache<[number, FileEntry["plan"]]>("plan").set(entry.path, [entry.size, entry.plan]);
    if (Object.hasOwn(entry, "goal")) globalCache<[number, FileEntry["goal"]]>("goal").set(entry.path, [entry.size, entry.goal]);
    if (Object.hasOwn(entry, "ctx")) globalCache<[number, FileEntry["ctx"]]>("ctx").set(entry.path, [entry.size, entry.ctx]);
    if (Object.hasOwn(entry, "lastTurn")) {
      globalCache<[number, FileEntry["lastTurn"]]>("last-turn").set(entry.path, [entry.size, entry.lastTurn]);
    }
    if (Object.hasOwn(entry, "pendingWakeup")) {
      globalCache<[number, FileEntry["pendingWakeup"]]>("wakeup").set(entry.path, [entry.size, entry.pendingWakeup]);
    }
  }
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

function installFileScanRefresh(
  slot: FileScanCacheSlot,
  generation: number,
  promise: Promise<FileScanSnapshot>,
  resourcePromise: Promise<FileScanSnapshot> = promise,
): FileScanRefresh {
  const refresh = { generation, promise, resourcePromise };
  slot.refresh = refresh;
  const clear = () => {
    if (slot.refresh === refresh) slot.refresh = undefined;
  };
  void promise.then(clear, clear);
  return refresh;
}

function installStagedFileScanRefresh(
  slot: FileScanCacheSlot,
  generation: number,
  start: (publish: (snapshot: FileScanSnapshot) => void) => Promise<FileScanSnapshot>,
): FileScanRefresh {
  let publishResource!: (snapshot: FileScanSnapshot) => void;
  let rejectResource!: (error: unknown) => void;
  let published = false;
  const resourcePromise = new Promise<FileScanSnapshot>((resolve, reject) => {
    publishResource = resolve;
    rejectResource = reject;
  });
  void resourcePromise.catch(() => {});
  const publish = (snapshot: FileScanSnapshot) => {
    if (published) return;
    published = true;
    publishResource(snapshot);
  };
  const promise = start(publish);
  void promise.then(publish, (error) => {
    if (!published) rejectResource(error);
  });
  return installFileScanRefresh(slot, generation, promise, resourcePromise);
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

async function instrumentFileScan(
  slot: FileScanCacheSlot,
  generation: number,
  reason: FileScanReason,
  task: () => Promise<FileScanSnapshot>,
): Promise<FileScanSnapshot> {
  const startedAt = performance.now();
  try {
    const snapshot = await task();
    slot.lastScan = { generation, reason, status: "complete", durationMs: performance.now() - startedAt };
    return snapshot;
  } catch (error) {
    slot.lastScan = { generation, reason, status: "failed", durationMs: performance.now() - startedAt };
    throw error;
  }
}

function fileScanRefreshPromise(
  slot: FileScanCacheSlot,
  generation: number,
  reason: FileScanReason,
  onResourceSnapshot?: (snapshot: FileScanSnapshot) => void,
): Promise<FileScanSnapshot> {
  const fresh = slot.freshObservationGeneration !== undefined
    && generation >= slot.freshObservationGeneration;
  return instrumentFileScan(slot, generation, reason, async () => {
    const snapshot = await listFilesWithProjectCatalog(undefined, {
      persist: false,
      persistIndex: process.env.LLV_RESOURCE_OBSERVATION_WORKER !== "1",
      ...(fresh ? { fresh: true } : {}),
      ...(onResourceSnapshot ? { onResourceSnapshot, resourceBaseline: slot.snapshot } : {}),
    });
    if (!snapshot.complete) throw new Error("filesystem scan incomplete");
    if (process.env.LLV_RESOURCE_OBSERVATION_WORKER !== "1") writePersistedFileScanSnapshot(snapshot);
    slot.snapshot = snapshot;
    slot.snapshotGeneration = Math.max(slot.snapshotGeneration, generation);
    slot.refreshedAt = Date.now();
    if (fresh && slot.freshObservationGeneration !== undefined
      && generation >= slot.freshObservationGeneration) {
      slot.freshObservationGeneration = undefined;
    }
    return snapshot;
  });
}

function beginFileScanRefresh(
  slot: FileScanCacheSlot,
  generation: number,
  reason: FileScanReason,
): FileScanRefresh {
  return installStagedFileScanRefresh(
    slot,
    generation,
    (publish) => fileScanRefreshPromise(slot, generation, reason, publish),
  );
}

function beginDeferredFileScanRefresh(slot: FileScanCacheSlot, generation: number): FileScanRefresh {
  let started = false;
  let canceled = false;
  let publishResource!: (snapshot: FileScanSnapshot) => void;
  let rejectResource!: (error: unknown) => void;
  let published = false;
  const resourcePromise = new Promise<FileScanSnapshot>((resolve, reject) => {
    publishResource = resolve;
    rejectResource = reject;
  });
  void resourcePromise.catch(() => {});
  const publish = (snapshot: FileScanSnapshot) => {
    if (published) return;
    published = true;
    publishResource(snapshot);
  };
  const promise = new Promise<void>((resolve) => setImmediate(resolve)).then(() => {
    started = true;
    if (canceled) {
      if (!slot.snapshot) throw new Error("deferred file scan canceled without a completed snapshot");
      return slot.snapshot;
    }
    return fileScanRefreshPromise(slot, generation, "ordinary", publish);
  });
  void promise.then(publish, (error) => {
    if (!published) rejectResource(error);
  });
  const refresh = installFileScanRefresh(slot, generation, promise, resourcePromise);
  refresh.cancelBeforeStart = () => {
    if (started) return false;
    canceled = true;
    return true;
  };
  return refresh;
}

function beginPinnedFileScanRefresh(
  slot: FileScanCacheSlot,
  generation: number,
  pinnedPath: string,
  reason: FileScanReason,
): FileScanRefresh {
  const fresh = slot.freshObservationGeneration !== undefined
    && generation >= slot.freshObservationGeneration;
  return installStagedFileScanRefresh(slot, generation, (publish) => instrumentFileScan(slot, generation, reason, async () => {
    const pinnedSnapshot = await listFilesWithProjectCatalog(undefined, {
      persist: false,
      persistIndex: process.env.LLV_RESOURCE_OBSERVATION_WORKER !== "1",
      pin: pinnedPath,
      ...(fresh ? { fresh: true } : {}),
      onResourceSnapshot: publish,
      resourceBaseline: slot.snapshot,
    });
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
    if (process.env.LLV_RESOURCE_OBSERVATION_WORKER !== "1") writePersistedFileScanSnapshot(globalSnapshot);
    slot.snapshot = globalSnapshot;
    slot.snapshotGeneration = Math.max(slot.snapshotGeneration, generation);
    slot.refreshedAt = Date.now();
    if (fresh && slot.freshObservationGeneration !== undefined
      && generation >= slot.freshObservationGeneration) {
      slot.freshObservationGeneration = undefined;
    }
    return globalSnapshot;
  }));
}

async function refreshThroughGeneration(
  slot: FileScanCacheSlot,
  requestedGeneration: number,
  pinnedPath?: string,
  reason: FileScanReason = "generation",
): Promise<FileScanSnapshot> {
  while (
    !slot.snapshot
    || slot.snapshotGeneration < requestedGeneration
    || (pinnedPath !== undefined && (slot.pinnedSnapshots?.get(pinnedPath)?.generation ?? -1) < requestedGeneration)
  ) {
    const refresh = slot.refresh ?? (pinnedPath
      ? beginPinnedFileScanRefresh(slot, requestedGeneration, pinnedPath, reason)
      : beginFileScanRefresh(slot, requestedGeneration, reason));
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

function completedScan(
  slot: FileScanCacheSlot,
  pinnedPath: string | undefined,
  targetGeneration: number,
  cacheStatus?: CachedFileScan["cacheStatus"],
): CachedFileScan {
  const cloneStartedAt = performance.now();
  const pinned = pinnedPath ? cachedPinnedSnapshot(slot, pinnedPath) : undefined;
  if (pinned) {
    const completed = structuredClone({
      snapshot: pinned.snapshot,
      pinOverlayPaths: pinned.pinOverlayPaths,
      generation: pinned.generation,
      targetGeneration,
    });
    return {
      ...completed,
      cacheStatus: cacheStatus ?? (completed.generation < targetGeneration ? "stale" : "hit"),
      requestCount: slot.requestCount ?? 0,
      cloneDurationMs: performance.now() - cloneStartedAt,
      ...(slot.lastScan ? { lastScan: { ...slot.lastScan } } : {}),
    };
  }
  const snapshot = structuredClone(slot.snapshot!);
  return {
    snapshot,
    generation: slot.snapshotGeneration,
    targetGeneration,
    cacheStatus: cacheStatus ?? (slot.snapshotGeneration < targetGeneration ? "stale" : "hit"),
    requestCount: slot.requestCount ?? 0,
    cloneDurationMs: performance.now() - cloneStartedAt,
    ...(slot.lastScan ? { lastScan: { ...slot.lastScan } } : {}),
  };
}

function resourceScan(
  slot: FileScanCacheSlot,
  snapshot: FileScanSnapshot,
  generation: number,
  targetGeneration: number,
): CachedFileScan {
  return {
    snapshot,
    generation,
    targetGeneration,
    cacheStatus: "miss",
    requestCount: slot.requestCount ?? 0,
    cloneDurationMs: 0,
    ...(slot.lastScan ? { lastScan: { ...slot.lastScan } } : {}),
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

function globalFileScanSlot(): FileScanCacheSlot {
  const key = "";
  const cache = fileScanCache();
  const cachedSlot = cache.get(key);
  if (cachedSlot === undefined) {
    const snapshot = readPersistedFileScanSnapshot();
    if (snapshot) primePersistedFileDerivations(snapshot);
    const slot: FileScanCacheSlot = {
      schemaVersion: FILE_SCAN_CACHE_SCHEMA_VERSION,
      snapshot,
      snapshotGeneration: 0,
      requestedGeneration: 0,
      refreshedAt: 0,
    };
    cache.set(key, slot);
    return slot;
  }

  const slot = normalizeFileScanCacheSlot(cachedSlot);
  cache.delete(key);
  cache.set(key, slot);
  return slot;
}

export async function cachedFileScan(
  _selectedProject?: string,
  pinnedPath?: string,
  now = Date.now(),
  requiredRevision?: number,
  requiredGeneration?: number,
): Promise<CachedFileScan> {
  const slot = globalFileScanSlot();
  slot.requestCount = (slot.requestCount ?? 0) + 1;

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
    const refresh = refreshThroughGeneration(slot, targetGeneration, pinnedPath, "revision");
    const clearForcedGeneration = () => {
      if (slot.forcedGeneration === requestedGeneration) {
        slot.forcedRevision = undefined;
        slot.forcedGeneration = undefined;
      }
    };
    if (!slot.snapshot) {
      try {
        await refresh;
        return completedScan(slot, pinnedPath, targetGeneration, "miss");
      } finally {
        clearForcedGeneration();
      }
    }
    void refresh.then(clearForcedGeneration, clearForcedGeneration);
  }

  if (targetGeneration !== undefined) {
    const refresh = refreshThroughGeneration(slot, targetGeneration, pinnedPath, "generation");
    const missesSnapshot = !slot.snapshot;
    if (missesSnapshot) await refresh;
    else continueRefreshInBackground(refresh);
    return completedScan(slot, pinnedPath, targetGeneration, missesSnapshot ? "miss" : undefined);
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
    const refresh = refreshThroughGeneration(slot, targetGeneration, pinnedPath, "pinned");
    const missesSnapshot = !slot.snapshot;
    if (missesSnapshot) await refresh;
    else continueRefreshInBackground(refresh);
    return completedScan(slot, pinnedPath, targetGeneration, missesSnapshot ? "miss" : undefined);
  }

  if (!slot.snapshot) {
    targetGeneration = slot.refresh?.generation ?? nextGeneration(slot);
    const refresh = slot.refresh ?? beginFileScanRefresh(slot, targetGeneration, "cold");
    await refresh.promise;
    return completedScan(slot, undefined, targetGeneration, "miss");
  }

  if (slot.refresh) {
    targetGeneration = slot.refresh.generation;
  } else if (now - Math.max(slot.refreshedAt, slot.ordinaryRefreshRequestedAt ?? 0) >= FILE_SCAN_ORDINARY_REFRESH_MS) {
    targetGeneration = nextGeneration(slot);
    slot.ordinaryRefreshRequestedAt = now;
    beginDeferredFileScanRefresh(slot, targetGeneration);
  } else {
    targetGeneration = slot.snapshotGeneration;
  }
  return completedScan(slot, undefined, targetGeneration);
}

/** Returns the latest completed global generation. A missing snapshot joins
    or starts the shared cold generation so every consumer receives a corpus. */
export async function completedFileScan(): Promise<CachedFileScan> {
  const slot = globalFileScanSlot();
  slot.requestCount = (slot.requestCount ?? 0) + 1;
  if (slot.snapshot) {
    const now = Date.now();
    if (!slot.refresh && now - Math.max(slot.refreshedAt, slot.ordinaryRefreshRequestedAt ?? 0) >= FILE_SCAN_ORDINARY_REFRESH_MS) {
      const targetGeneration = nextGeneration(slot);
      slot.ordinaryRefreshRequestedAt = now;
      beginDeferredFileScanRefresh(slot, targetGeneration);
    }
    return completedScan(slot, undefined, slot.snapshotGeneration);
  }

  const targetGeneration = slot.refresh?.generation ?? nextGeneration(slot);
  const refresh = slot.refresh ?? beginFileScanRefresh(slot, targetGeneration, "cold");
  await refresh.promise;
  return completedScan(slot, undefined, targetGeneration, "miss");
}

/** Returns metadata from a completed current generation. The first fresh
    caller reserves a generation beyond existing requests; concurrent fresh
    callers join that pending fence. Older work completes before the fence. */
export async function currentFileScan(
  { fresh = false, now = Date.now() }: { fresh?: boolean; now?: number } = {},
): Promise<CachedFileScan> {
  if (fresh) {
    const slot = globalFileScanSlot();
    const targetGeneration = slot.freshObservationGeneration ?? nextGeneration(slot);
    slot.freshObservationGeneration = targetGeneration;
    await refreshThroughGeneration(slot, targetGeneration, undefined, "fresh");
    return completedScan(slot, undefined, targetGeneration);
  }

  const scan = await cachedFileScan(undefined, undefined, now);
  if (scan.generation >= scan.targetGeneration) return scan;

  const slot = globalFileScanSlot();
  await refreshThroughGeneration(slot, scan.targetGeneration, undefined, "current");
  return completedScan(slot, undefined, scan.targetGeneration);
}

/** Returns the fresh resource projection as soon as its file generation has
    current filesystem scope. The worker performs fresh ownership observation;
    sidebar enrichment continues through the completed-generation seam. */
export async function currentResourceFileScan(): Promise<CachedFileScan> {
  const slot = globalFileScanSlot();
  slot.requestCount = (slot.requestCount ?? 0) + 1;
  let targetGeneration = slot.freshObservationGeneration;
  let requestedRefresh: FileScanRefresh | undefined;
  if (targetGeneration === undefined) {
    const pending = slot.refresh;
    if (pending?.cancelBeforeStart?.()) {
      targetGeneration = nextGeneration(slot);
      slot.freshObservationGeneration = targetGeneration;
      requestedRefresh = beginFileScanRefresh(slot, targetGeneration, "fresh");
    } else if (pending) {
      targetGeneration = pending.generation;
    } else {
      targetGeneration = nextGeneration(slot);
      slot.freshObservationGeneration = targetGeneration;
    }
  }
  while (true) {
    const refresh = requestedRefresh ?? slot.refresh ?? beginFileScanRefresh(slot, targetGeneration, "fresh");
    requestedRefresh = undefined;
    const snapshot = await refresh.resourcePromise;
    if (refresh.generation >= targetGeneration) {
      return resourceScan(slot, snapshot, refresh.generation, targetGeneration);
    }
    await refresh.promise;
  }
}

export function resetFilesRouteCacheForTests(): void {
  fileScanCache().clear();
}
