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

const PROJECTION_CACHE_MAX = 32;
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
  selectedProject: string | undefined,
  pinnedPath: string | undefined,
): string {
  return createHash("sha1").update(JSON.stringify({
    selectedProject: selectedProject ?? null,
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
  selectedProject: string | undefined,
  pinnedPath: string | undefined,
): string {
  return JSON.stringify([selectedProject ?? null, pinnedPath ?? null]);
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
    if (cached && request.headers.has("if-none-match")) {
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
    return representation;
  })();
  projectionInflight().set(scopeKey, promise);
  void promise.catch(() => undefined).finally(() => {
    if (projectionInflight().get(scopeKey) === promise) projectionInflight().delete(scopeKey);
  });
  if (cached && request.headers.has("if-none-match")) {
    return { representation: cached.representation, cacheStatus: "stale" };
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

  const baseKey = projectionBaseKey(scan, selectedProject, pinnedPath);
  const key = projectionKey(baseKey);
  const scopeKey = projectionScopeKey(selectedProject, pinnedPath);
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
