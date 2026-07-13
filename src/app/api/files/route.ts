import { buildFilesResponse } from "./response";
import { cachedFileScan } from "./scanCache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const revision = request.headers.get("x-llv-files-revision");
  const parsedRevision = revision !== null && /^\d+$/.test(revision) ? Number(revision) : undefined;
  const requiredRevision = parsedRevision !== undefined && Number.isSafeInteger(parsedRevision) ? parsedRevision : undefined;
  return buildFilesResponse(request, {
    listFilesWithProjectCatalog: async (selectedProject, pinnedPath) => {
      const scan = await cachedFileScan(selectedProject, pinnedPath, Date.now(), requiredRevision);
      return { ...scan.snapshot, pinOverlayPaths: scan.pinOverlayPaths };
    },
  });
}
