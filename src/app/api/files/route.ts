import { listFilesWithProjectCatalog } from "@/lib/scanner";

import { buildFilesResponse } from "./response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return buildFilesResponse(request, { listFilesWithProjectCatalog });
}
