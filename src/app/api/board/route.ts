import { NextRequest, NextResponse } from "next/server";

import { agentRegistry, RegistryReadError } from "@/lib/agent/registry";
import type { BoardMutationV1 } from "@/lib/board/mutations";
import { boardFor, BoardStoreError, mutateBoard, patchBoard } from "@/lib/board/store";
import { validateBoardPatchRequest } from "@/lib/board/validation";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { ViewValidationError } from "@/lib/view/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };

function mutationsWithConversationAliases(mutations: readonly BoardMutationV1[]): BoardMutationV1[] {
  const mentionedPaths = new Set<string>();
  const suppliedRemapSources = new Set<string>();
  for (const mutation of mutations) {
    if (mutation.kind === "close" || mutation.kind === "restore") mentionedPaths.add(mutation.path);
    if (mutation.kind === "reconcile-roots") {
      for (const pathname of mutation.roots) mentionedPaths.add(pathname);
    }
    if (mutation.kind === "remap-paths") {
      for (const pair of mutation.pairs) {
        mentionedPaths.add(pair.from);
        mentionedPaths.add(pair.to);
        suppliedRemapSources.add(pair.from);
      }
    }
  }
  if (mentionedPaths.size === 0) return [...mutations];

  let conversations: ReturnType<ReturnType<typeof agentRegistry>["snapshot"]>["conversations"];
  try {
    conversations = agentRegistry().snapshot().conversations;
  } catch (error) {
    if (error instanceof RegistryReadError) return [...mutations];
    throw error;
  }
  const pairs: Array<{ from: string; to: string }> = [];
  const pairedSources = new Set(suppliedRemapSources);
  for (const conversation of Object.values(conversations)) {
    if (conversation.generations.length < 2) continue;
    const pendingContinuityPaths = conversation.migration && conversation.migration.phase !== "committed"
      ? new Set(conversation.migration.pendingContinuityPaths)
      : new Set<string>();
    const continuityPaths = conversation.continuityPaths.filter((pathname) => !pendingContinuityPaths.has(pathname));
    const paths = [
      ...conversation.generations.map((generation) => generation.path),
      ...continuityPaths,
    ];
    if (!paths.some((pathname) => mentionedPaths.has(pathname))) continue;
    const target = conversation.generations.at(-1)?.path;
    if (!target) continue;
    for (const source of paths) {
      if (source === target || pairedSources.has(source)) continue;
      pairedSources.add(source);
      pairs.push({ from: source, to: target });
    }
  }
  return pairs.length > 0
    ? [{ kind: "remap-paths", pairs }, ...mutations]
    : [...mutations];
}

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
    const payload = await validateBoardPatchRequest(request);
    const result = payload.mutations
      ? mutateBoard(payload.project, payload.baseRevision, mutationsWithConversationAliases(payload.mutations))
      : patchBoard(payload.project, payload.baseRevision, payload.patch!);
    if (!result.ok) return NextResponse.json({ error: "BOARD_REVISION_CONFLICT", board: result.board }, { status: 409, headers });
    return NextResponse.json({ ok: true, board: result.board }, { headers });
  } catch (error) {
    if (error instanceof ViewValidationError) return NextResponse.json({ error: error.code, message: error.message }, { status: error.status, headers });
    if (error instanceof BoardStoreError) return NextResponse.json({ error: "INTERNAL_ERROR", message: "board state unavailable" }, { status: 500, headers });
    return NextResponse.json({ error: "INTERNAL_ERROR", message: "internal error" }, { status: 500, headers });
  }
}
