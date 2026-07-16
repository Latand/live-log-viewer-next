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

export async function GET(request: Request): Promise<Response> {
  const requiredRevision = generationHeader(request, "x-llv-files-revision");
  const requiredGeneration = generationHeader(request, "x-llv-files-generation");
  let responseGeneration = 0;
  let targetGeneration = 0;
  let cacheStatus: "hit" | "stale" | "miss" = "miss";
  let requestCount = 0;
  let cloneDurationMs = 0;
  let lastScan: Awaited<ReturnType<typeof cachedFileScan>>["lastScan"];
  const response = await buildFilesResponse(request, {
    listFilesWithProjectCatalog: async (selectedProject, pinnedPath) => {
      const scan = await cachedFileScan(
        selectedProject,
        pinnedPath,
        Date.now(),
        requiredRevision,
        requiredGeneration,
      );
      responseGeneration = scan.generation;
      targetGeneration = scan.targetGeneration;
      cacheStatus = scan.cacheStatus;
      requestCount = scan.requestCount;
      cloneDurationMs = scan.cloneDurationMs;
      lastScan = scan.lastScan;
      return { ...scan.snapshot, pinOverlayPaths: scan.pinOverlayPaths };
    },
  });
  response.headers.set("x-llv-files-generation", String(responseGeneration));
  response.headers.set("x-llv-files-target-generation", String(targetGeneration));
  response.headers.set("x-llv-files-cache", cacheStatus);
  response.headers.set("x-llv-files-cache-requests", String(requestCount));
  const serverTiming = [`files-clone;dur=${cloneDurationMs.toFixed(1)}`];
  if (lastScan) {
    const failure = lastScan.status === "failed" ? " failed" : "";
    serverTiming.push(`files-scan;dur=${lastScan.durationMs.toFixed(1)};desc="${lastScan.reason} generation ${lastScan.generation}${failure}"`);
  }
  response.headers.set("server-timing", serverTiming.join(", "));
  return response;
}
