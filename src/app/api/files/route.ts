import { after } from "next/server";

import { buildFilesResponse } from "./response";
import { cachedFileScan } from "./scanCache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return buildFilesResponse(request, {
    listFilesWithProjectCatalog: async (selectedProject) => {
      const scan = await cachedFileScan(selectedProject);
      if (scan.refreshAfterResponse) after(scan.refreshAfterResponse);
      return scan.snapshot;
    },
  });
}
