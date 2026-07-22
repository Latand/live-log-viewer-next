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

  const response = await buildFilesResponse(request, {
    listFilesWithProjectCatalog: async () => {
      return { ...scan.snapshot, pinOverlayPaths: scan.pinOverlayPaths };
    },
  });
  const projectionTiming = response.headers.get("server-timing");
  applyScanHeaders(response, scan, projectionTiming);
  return response;
}
