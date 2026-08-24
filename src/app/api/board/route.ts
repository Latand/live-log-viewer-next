import { NextRequest, NextResponse } from "next/server";

import { applyBoardCommand } from "@/lib/board/command";
import { boardFor, BoardStoreError } from "@/lib/board/store";
import { readBoardPatchPayload } from "@/lib/board/validation";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { ViewValidationError } from "@/lib/view/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

export function GET(request: NextRequest): NextResponse {
  const rejection = rejectCrossOrigin(request);
  if (rejection) { rejection.headers.set("Cache-Control", "no-store"); return rejection; }
  const project = request.nextUrl.searchParams.get("project");
  if (!project || project.length > 256) return NextResponse.json({ error: "INVALID_REQUEST", message: "project is required" }, { status: 400, headers });
  try {
    return NextResponse.json({ ok: true, board: boardFor(project) }, { headers });
  } catch (error) {
    if (error instanceof BoardStoreError) return NextResponse.json({ error: "INTERNAL_ERROR", message: "board state unavailable" }, { status: 500, headers });
    return NextResponse.json({ error: "INTERNAL_ERROR", message: "internal error" }, { status: 500, headers });
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) { rejection.headers.set("Cache-Control", "no-store"); return rejection; }
  try {
    const result = applyBoardCommand(await readBoardPatchPayload(request));
    if (!result.ok) return NextResponse.json({ error: "BOARD_REVISION_CONFLICT", board: result.board }, { status: 409, headers });
    /* `applied` lets the caller tell its own committed write from a no-op that
       was accepted against a board some other writer produced (#38). */
    return NextResponse.json({ ok: true, applied: result.applied, board: result.board }, { headers });
  } catch (error) {
    if (error instanceof ViewValidationError) return NextResponse.json({ error: error.code, message: error.message }, { status: error.status, headers });
    if (error instanceof BoardStoreError) return NextResponse.json({ error: "INTERNAL_ERROR", message: "board state unavailable" }, { status: 500, headers });
    return NextResponse.json({ error: "INTERNAL_ERROR", message: "internal error" }, { status: 500, headers });
  }
}
