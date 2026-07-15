import { buildFilesResponse } from "./response";
import { cachedFileScan } from "./scanCache";

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
      return { ...scan.snapshot, pinOverlayPaths: scan.pinOverlayPaths };
    },
  });
  response.headers.set("x-llv-files-generation", String(responseGeneration));
  response.headers.set("x-llv-files-target-generation", String(targetGeneration));
  return response;
}
