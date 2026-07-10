import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { listFilesWithProjectCatalog } from "@/lib/scanner";
import { loadFlows } from "@/lib/flows/store";
import { loadTasks } from "@/lib/tasks/store";
import { loadWorkflows } from "@/lib/workflows/store";
import { filterWorkflowsForFileScan } from "@/lib/workflows/visibility";
import type { FilesResponse } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const selectedProject = url.searchParams.get("project")?.trim() || undefined;
  const { files, projectCatalog } = await listFilesWithProjectCatalog(selectedProject, { persist: false });
  // A scan is a read model. Runtime reconciliation and notifications belong to
  // the external scheduler, keeping repeated GETs byte-stable for state files.
  const tasks = loadTasks();
  const workflows = filterWorkflowsForFileScan(loadWorkflows(), files);
  const body = JSON.stringify({ files, projectCatalog, flows: loadFlows(), workflows, tasks } satisfies FilesResponse);
  /* The client re-polls every 10 s and this ~410 KB payload is usually
     identical between polls; a strong ETag over the exact bytes lets an
     unchanged response come back as a bodyless 304. force-dynamic still holds
     — the body is recomputed every request, only its transfer is skipped. */
  const etag = `"${createHash("sha1").update(body).digest("hex")}"`;
  if (request.headers.get("if-none-match") === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag } });
  }
  return new NextResponse(body, {
    status: 200,
    headers: { "content-type": "application/json", ETag: etag },
  });
}
