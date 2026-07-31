import { createHash } from "node:crypto";
import fs from "node:fs";

import { agentRegistry } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { buildFilesResponse } from "./response";
import { cachedFileScan } from "@/lib/scanner/scanCache";
import { buildFilesResponseInWorker, filesResponseWorkerEnabled } from "@/lib/scanner/filesResponseWorker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function generationHeader(request: Request, name: string): number | undefined {
  const value = request.headers.get(name);
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const generation = Number(value);
  return Number.isSafeInteger(generation) ? generation : undefined;
}

type CachedScan = Awaited<ReturnType<typeof cachedFileScan>>;
type ProjectionRepresentation = {
  body: string;
  contentType: string;
  etag: string;
  timing: string;
};
type ProjectionResult = {
  representation: ProjectionRepresentation;
  cacheStatus: "hit" | "joined" | "miss" | "stale";
};
type CachedProjection = { key: string; representation: ProjectionRepresentation };
type PersistedProjection = {
  version: 1;
  bodyFile: string;
  contentType: string;
  etag: string;
  timing: string;
};

const PROJECTION_CACHE_MAX = 32;
const PROJECTION_STALE_WAIT_MS = 100;
const PERSISTED_PROJECTION_META_FILE = "files-response-cache.json";
const PERSISTED_PROJECTION_BODY_PREFIX = "files-response-cache-";
const PERSISTED_PROJECTION_KEY_PREFIX = "persisted:";
const PROJECTION_STATE_FILES = [
  "flows.json",
  "pipelines.json",
  "tasks.json",
  "workflows.json",
  "project-aliases.json",
  "worktree-map.json",
  "reaper-state.json",
] as const;
const projectionCacheStore = globalThis as typeof globalThis & {
  __llvFilesProjectionCache?: Map<string, CachedProjection>;
  __llvFilesProjectionInflight?: Map<string, Promise<ProjectionRepresentation>>;
  __llvFilesProjectionWorkerTail?: Promise<void>;
  __llvFilesProjectionPersistenceTail?: Promise<void>;
  __llvFilesPersistedProjectionChecked?: boolean;
};

function projectionCache(): Map<string, CachedProjection> {
  projectionCacheStore.__llvFilesProjectionCache ??= new Map();
  return projectionCacheStore.__llvFilesProjectionCache;
}

function projectionInflight(): Map<string, Promise<ProjectionRepresentation>> {
  projectionCacheStore.__llvFilesProjectionInflight ??= new Map();
  return projectionCacheStore.__llvFilesProjectionInflight;
}

function stateFileSignature(filename: string): string {
  const pathname = statePath(filename);
  try {
    const stat = fs.statSync(pathname);
    return `${pathname}:${stat.size}:${stat.mtimeMs}`;
  } catch {
    return `${pathname}:missing`;
  }
}

function projectionBaseKey(
  scan: CachedScan,
  pinnedPath: string | undefined,
): string {
  return createHash("sha1").update(JSON.stringify({
    pinnedPath: pinnedPath ?? null,
    /* `generation` is the immutable identity of the published snapshot.
       Re-stringifying every file row on every poll burns the request thread
       precisely while a new scan is being published. */
    generation: scan.generation,
    pinOverlayPaths: scan.pinOverlayPaths ?? [],
    stores: PROJECTION_STATE_FILES.map(stateFileSignature),
  })).digest("hex");
}

function projectionScopeKey(
  pinnedPath: string | undefined,
): string {
  return JSON.stringify([pinnedPath ?? null]);
}

function projectionKey(baseKey: string): string {
  const registryDiagnostics = agentRegistry().storageDiagnostics();
  return `${baseKey}:${registryDiagnostics.revision ?? "json"}:${registryDiagnostics.transactionCount}`;
}

function queueProjectionWorker(
  build: () => Promise<ProjectionRepresentation>,
): Promise<ProjectionRepresentation> {
  const previous = projectionCacheStore.__llvFilesProjectionWorkerTail ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(build);
  projectionCacheStore.__llvFilesProjectionWorkerTail = current.then(() => undefined, () => undefined);
  return current;
}

async function projectionWithinBudget(
  promise: Promise<ProjectionRepresentation>,
  waitMs = PROJECTION_STALE_WAIT_MS,
): Promise<ProjectionRepresentation | undefined> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function rememberProjection(scopeKey: string, key: string, representation: ProjectionRepresentation): void {
  const cache = projectionCache();
  cache.delete(scopeKey);
  cache.set(scopeKey, { key, representation });
  while (cache.size > PROJECTION_CACHE_MAX) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function validPersistedProjection(value: unknown): value is PersistedProjection {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1
    && typeof candidate.bodyFile === "string"
    && new RegExp(`^${PERSISTED_PROJECTION_BODY_PREFIX}[0-9a-f]{40}\\.json$`).test(candidate.bodyFile)
    && typeof candidate.contentType === "string"
    && typeof candidate.etag === "string"
    && /^"[0-9a-f]{40}"$/.test(candidate.etag)
    && typeof candidate.timing === "string";
}

function warmPersistedProjection(scopeKey: string, pinnedPath: string | undefined): void {
  if (pinnedPath || projectionCacheStore.__llvFilesPersistedProjectionChecked) return;
  projectionCacheStore.__llvFilesPersistedProjectionChecked = true;
  try {
    const metadata = JSON.parse(fs.readFileSync(statePath(PERSISTED_PROJECTION_META_FILE), "utf8")) as unknown;
    if (!validPersistedProjection(metadata)) return;
    const body = fs.readFileSync(statePath(metadata.bodyFile), "utf8");
    const etag = `"${createHash("sha1").update(body).digest("hex")}"`;
    if (etag !== metadata.etag) return;
    rememberProjection(scopeKey, `${PERSISTED_PROJECTION_KEY_PREFIX}${etag}`, {
      body,
      contentType: metadata.contentType,
      etag,
      timing: metadata.timing,
    });
  } catch {
    // A first run or interrupted cache write performs one live projection.
  }
}

async function persistProjection(representation: ProjectionRepresentation): Promise<void> {
  const digest = representation.etag.slice(1, -1);
  if (!/^[0-9a-f]{40}$/.test(digest)) return;
  const directory = statePath(".");
  const bodyFile = `${PERSISTED_PROJECTION_BODY_PREFIX}${digest}.json`;
  const bodyPath = statePath(bodyFile);
  const metaPath = statePath(PERSISTED_PROJECTION_META_FILE);
  const nonce = `${process.pid}-${Date.now()}`;
  const bodyTemporary = `${bodyPath}.${nonce}.tmp`;
  const metaTemporary = `${metaPath}.${nonce}.tmp`;
  let previousBodyFile: string | undefined;
  try {
    const previous = JSON.parse(await fs.promises.readFile(metaPath, "utf8")) as unknown;
    if (validPersistedProjection(previous)) previousBodyFile = previous.bodyFile;
  } catch {
    // The first completed projection has no predecessor.
  }
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.promises.writeFile(bodyTemporary, representation.body, { encoding: "utf8", mode: 0o600 });
  await fs.promises.rename(bodyTemporary, bodyPath);
  const metadata: PersistedProjection = {
    version: 1,
    bodyFile,
    contentType: representation.contentType,
    etag: representation.etag,
    timing: representation.timing,
  };
  await fs.promises.writeFile(metaTemporary, `${JSON.stringify(metadata)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.promises.rename(metaTemporary, metaPath);
  if (previousBodyFile && previousBodyFile !== bodyFile) {
    await fs.promises.rm(statePath(previousBodyFile), { force: true });
  }
}

function schedulePersistProjection(representation: ProjectionRepresentation): void {
  if (process.env.NODE_ENV === "test" && process.env.LLV_FILES_PROJECTION_PERSIST_FOR_TEST !== "1") return;
  const previous = projectionCacheStore.__llvFilesProjectionPersistenceTail ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => persistProjection(representation));
  projectionCacheStore.__llvFilesProjectionPersistenceTail = current;
  void current.catch((error) => {
    console.error("[files projection cache] persistence failed", error);
  });
}

async function projectionFor(
  scopeKey: string,
  key: string,
  request: Request,
  scan: CachedScan,
): Promise<ProjectionResult> {
  const cached = projectionCache().get(scopeKey);
  if (cached?.key === key) return { representation: cached.representation, cacheStatus: "hit" };

  const current = projectionInflight().get(scopeKey);
  if (current) {
    if (cached) {
      return { representation: cached.representation, cacheStatus: "stale" };
    }
    return { representation: await current, cacheStatus: "joined" };
  }

  const promise = (async () => {
    const headers = new Headers(request.headers);
    headers.delete("if-none-match");
    const snapshot = { ...scan.snapshot, pinOverlayPaths: scan.pinOverlayPaths };
    const persistedSnapshot = statePath("files-scan-snapshot.json");
    let representation: ProjectionRepresentation;
    if (filesResponseWorkerEnabled()) {
      representation = await queueProjectionWorker(() =>
        buildFilesResponseInWorker({
          type: "project",
          url: request.url,
          headers: [...headers.entries()],
          ...(scan.pinOverlayPaths?.length || !fs.existsSync(persistedSnapshot)
            ? { snapshot }
            : { snapshotFile: persistedSnapshot }),
        }));
    } else {
      const response = await buildFilesResponse(new Request(request.url, { headers }), {
        listFilesWithProjectCatalog: async () => snapshot,
      });
      representation = {
        body: await response.text(),
        contentType: response.headers.get("content-type") ?? "application/json",
        etag: response.headers.get("etag") ?? "",
        timing: response.headers.get("server-timing") ?? "",
      };
    }
    rememberProjection(scopeKey, key, representation);
    if (scopeKey === projectionScopeKey(undefined)) {
      schedulePersistProjection(representation);
    }
    return representation;
  })();
  projectionInflight().set(scopeKey, promise);
  void promise.catch(() => undefined).finally(() => {
    if (projectionInflight().get(scopeKey) === promise) projectionInflight().delete(scopeKey);
  });
  if (cached && (
    request.headers.has("if-none-match")
    || cached.key.startsWith(PERSISTED_PROJECTION_KEY_PREFIX)
  )) {
    return { representation: cached.representation, cacheStatus: "stale" };
  }
  if (cached) {
    const completed = await projectionWithinBudget(promise);
    return completed
      ? { representation: completed, cacheStatus: "miss" }
      : { representation: cached.representation, cacheStatus: "stale" };
  }
  try {
    return { representation: await promise, cacheStatus: "miss" };
  } finally {
    if (projectionInflight().get(scopeKey) === promise) projectionInflight().delete(scopeKey);
  }
}

function applyScanHeaders(response: Response, scan: CachedScan, projectionTiming?: string | null): void {
  response.headers.set("x-llv-files-generation", String(scan.generation));
  response.headers.set("x-llv-files-target-generation", String(scan.targetGeneration));
  response.headers.set("x-llv-files-cache", scan.cacheStatus);
  response.headers.set("x-llv-files-cache-requests", String(scan.requestCount));
  const serverTiming = [`files-clone;dur=${scan.cloneDurationMs.toFixed(1)}`];
  if (scan.lastScan) {
    const failure = scan.lastScan.status === "failed" ? " failed" : "";
    serverTiming.push(`files-scan;dur=${scan.lastScan.durationMs.toFixed(1)};desc="${scan.lastScan.reason} generation ${scan.lastScan.generation}${failure}"`);
  }
  if (projectionTiming) serverTiming.push(projectionTiming);
  response.headers.set("server-timing", serverTiming.join(", "));
}

export async function GET(request: Request): Promise<Response> {
  const requiredRevision = generationHeader(request, "x-llv-files-revision");
  const requiredGeneration = generationHeader(request, "x-llv-files-generation");
  const url = new URL(request.url);
  const selectedProject = url.searchParams.get("project")?.trim() || undefined;
  const pinnedPath = url.searchParams.get("path")?.trim() || undefined;
  const scan = await cachedFileScan(
    selectedProject,
    pinnedPath,
    Date.now(),
    requiredRevision,
    requiredGeneration,
  );

  /* Completion retries already hold the last successful representation. While
     its requested scan is still running, rebuilding the multi-store projection
     only delays that scan and can form a self-sustaining retry storm. */
  const previousEtag = request.headers.get("if-none-match");
  if (requiredGeneration !== undefined && scan.generation < scan.targetGeneration && previousEtag) {
    const response = new Response(null, {
      status: 304,
      headers: {
        ETag: previousEtag,
        "server-timing": `files-generation-wait;dur=0.0;desc="generation ${scan.generation} of ${scan.targetGeneration}"`,
      },
    });
    applyScanHeaders(response, scan, response.headers.get("server-timing"));
    return response;
  }

  const baseKey = projectionBaseKey(scan, pinnedPath);
  const key = projectionKey(baseKey);
  const scopeKey = projectionScopeKey(pinnedPath);
  warmPersistedProjection(scopeKey, pinnedPath);
  const projected = await projectionFor(scopeKey, key, request, scan);
  const notModified = request.headers.get("if-none-match") === projected.representation.etag;
  const projectionTiming = [
    projected.representation.timing,
    `files-projection-cache;dur=0.0;desc="${projected.cacheStatus}"`,
  ].filter(Boolean).join(", ");
  const response = new Response(notModified ? null : projected.representation.body, {
    status: notModified ? 304 : 200,
    headers: {
      ETag: projected.representation.etag,
      ...(notModified ? {} : { "content-type": projected.representation.contentType }),
      "x-llv-files-projection-cache": projected.cacheStatus,
    },
  });
  applyScanHeaders(response, scan, projectionTiming);
  return response;
}
