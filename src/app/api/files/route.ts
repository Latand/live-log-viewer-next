import { createHash } from "node:crypto";
import fs from "node:fs";

import { agentRegistry } from "@/lib/agent/registry";
import { statePath } from "@/lib/configDir";
import { buildFilesResponse } from "./response";
import { cachedFileScan } from "@/lib/scanner/scanCache";

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
  cacheStatus: "hit" | "joined" | "miss";
};

const PROJECTION_CACHE_MAX = 8;
const PROJECTION_HEALTH_BUCKET_MS = 60_000;
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
  __llvFilesProjectionCache?: Map<string, ProjectionRepresentation>;
  __llvFilesProjectionInflight?: Map<string, Promise<ProjectionRepresentation>>;
};

function projectionCache(): Map<string, ProjectionRepresentation> {
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

function projectionKey(
  scan: CachedScan,
  selectedProject: string | undefined,
  pinnedPath: string | undefined,
  now: number,
): string {
  const registryDiagnostics = agentRegistry().storageDiagnostics();
  const hash = createHash("sha1");
  hash.update(JSON.stringify({
    selectedProject: selectedProject ?? null,
    pinnedPath: pinnedPath ?? null,
    snapshot: scan.snapshot,
    pinOverlayPaths: scan.pinOverlayPaths ?? [],
    registryRevision: registryDiagnostics.revision,
    registryTransactions: registryDiagnostics.transactionCount,
    stores: PROJECTION_STATE_FILES.map(stateFileSignature),
    healthBucket: Math.floor(now / PROJECTION_HEALTH_BUCKET_MS),
  }));
  return hash.digest("hex");
}

function rememberProjection(key: string, representation: ProjectionRepresentation): void {
  const cache = projectionCache();
  cache.delete(key);
  cache.set(key, representation);
  while (cache.size > PROJECTION_CACHE_MAX) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function projectionFor(
  key: string,
  request: Request,
  scan: CachedScan,
): Promise<ProjectionResult> {
  const cached = projectionCache().get(key);
  if (cached) return { representation: cached, cacheStatus: "hit" };

  const current = projectionInflight().get(key);
  if (current) return { representation: await current, cacheStatus: "joined" };

  const promise = (async () => {
    const headers = new Headers(request.headers);
    headers.delete("if-none-match");
    const projectionRequest = new Request(request.url, { headers });
    const response = await buildFilesResponse(projectionRequest, {
      listFilesWithProjectCatalog: async () => {
        return { ...scan.snapshot, pinOverlayPaths: scan.pinOverlayPaths };
      },
    });
    const representation = {
      body: await response.text(),
      contentType: response.headers.get("content-type") ?? "application/json",
      etag: response.headers.get("etag") ?? "",
      timing: response.headers.get("server-timing") ?? "",
    };
    rememberProjection(key, representation);
    return representation;
  })();
  projectionInflight().set(key, promise);
  try {
    return { representation: await promise, cacheStatus: "miss" };
  } finally {
    if (projectionInflight().get(key) === promise) projectionInflight().delete(key);
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

  const key = projectionKey(scan, selectedProject, pinnedPath, Date.now());
  const projected = await projectionFor(key, request, scan);
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
