import { NextRequest, NextResponse } from "next/server";

import { canonicalProject } from "@/lib/projects/aliases";
import { createManualProject } from "@/lib/projects/curation";
import { conversationCatalogSnapshot } from "@/lib/scanner/conversationCatalog";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

const FAILURE_STATUS: Record<string, number> = {
  INVALID_NAME: 400,
  INVALID_ROOT: 400,
  MISSING_DIRECTORY: 400,
  MKDIR_FAILED: 500,
  DUPLICATE_PROJECT: 409,
  STORE_ERROR: 500,
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) { rejection.headers.set("Cache-Control", "no-store"); return rejection; }
  let payload: unknown = null;
  try {
    payload = await request.json();
  } catch {
    // fall through to the shape check
  }
  const record = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : null;
  const name = typeof record?.name === "string" ? record.name : "";
  const root = typeof record?.root === "string" ? record.root : "";
  if (!name.trim() || !root.trim() || name.length > 256 || root.length > 4096) {
    return NextResponse.json({ error: "INVALID_REQUEST", message: "name and root are required" }, { status: 400, headers });
  }
  /* Identities already visible on the board: the scanned catalog resolved
     through the alias machinery. A manual project must never fork one of them. */
  const existing = new Set<string>();
  for (const entry of conversationCatalogSnapshot()) {
    existing.add(canonicalProject(entry.project));
  }
  const result = createManualProject(name, root, existing, { createMissingRoot: record?.createRoot === true });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.code, message: result.message },
      { status: FAILURE_STATUS[result.code] ?? 500, headers },
    );
  }
  return NextResponse.json({
    ok: true,
    project: result.entry.project,
    displayName: result.entry.displayName,
    root: result.entry.root,
    createdAt: result.entry.createdAt,
  }, { headers });
}
