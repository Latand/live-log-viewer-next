import { NextRequest, NextResponse } from "next/server";

import {
  MCP_OPERATIONS_MAX_LIMIT,
  parseCreationsCursor,
  readMcpOperations,
  type McpOperationsPage,
  type McpPipelineCreation,
} from "@/lib/mcp/operationsFeed";
import { openMcpReceiptsReadOnly } from "@/lib/mcp/receiptsDatabase";
import { loadPipelinesForList } from "@/lib/pipelines/store";
import { canonicalProject } from "@/lib/projects/aliases";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A project's `create_pipeline` and `update_task` operations, read only from
 * the MCP receipt rows and the stamped pipelines (#1695 C5, C8). `project` is
 * required; `after` is the cursor a previous page returned, and without it the
 * newest rows answer; `limit` is clamped to 1..50; `unresolved` lists up to 50
 * sequences the reader still holds as pending or unknown; `creationsAfter` is
 * the creations cursor a previous page returned. Nothing is claimed, settled
 * or replayed here.
 */
export async function GET(req: NextRequest): Promise<NextResponse<McpOperationsPage | ApiError>> {
  const params = req.nextUrl.searchParams;
  const project = params.get("project")?.trim();
  if (!project) return NextResponse.json({ error: "project is required" }, { status: 400 });
  const rawAfter = params.get("after")?.trim() || null;
  const after = rawAfter === null ? null : /^\d+$/.test(rawAfter) ? Number(rawAfter) : Number.NaN;
  if (after !== null && !Number.isSafeInteger(after)) {
    return NextResponse.json({ error: "after must be a sequence a previous page returned" }, { status: 400 });
  }
  const rawUnresolved = params.get("unresolved")?.trim() || null;
  const unresolved = rawUnresolved === null ? [] : rawUnresolved.split(",").map((part) => part.trim());
  if (unresolved.some((part) => !/^\d+$/.test(part) || !Number.isSafeInteger(Number(part)))) {
    return NextResponse.json({ error: "unresolved must be receipt sequences separated by commas" }, { status: 400 });
  }
  if (unresolved.length > MCP_OPERATIONS_MAX_LIMIT) {
    return NextResponse.json({ error: `unresolved takes at most ${MCP_OPERATIONS_MAX_LIMIT} sequences per request` }, { status: 400 });
  }
  const creationsAfter = params.get("creationsAfter")?.trim() || null;
  if (creationsAfter !== null && !parseCreationsCursor(creationsAfter)) {
    return NextResponse.json({ error: "creationsAfter must be the cursor a previous page returned" }, { status: 400 });
  }
  const rawLimit = params.get("limit");
  const limit = rawLimit && /^\d+$/.test(rawLimit) ? Number(rawLimit) : MCP_OPERATIONS_MAX_LIMIT;
  const creations = new Map<string, McpPipelineCreation>();
  try {
    for (const pipeline of loadPipelinesForList()) {
      if (!pipeline.creationReceipt) continue;
      creations.set(pipeline.creationReceipt.requestDigest, {
        pipelineId: pipeline.id,
        project: canonicalProject(pipeline.project),
        claimedAt: pipeline.creationReceipt.claimedAt,
        recordedAt: pipeline.creationReceipt.recordedAt ?? null,
      });
    }
  } catch {
    /* The receipt rows still answer on their own. */
  }
  let db: ReturnType<typeof openMcpReceiptsReadOnly> = null;
  try {
    db = openMcpReceiptsReadOnly();
    const page = readMcpOperations(db, { project, after, limit, unresolved: unresolved.map(Number), creationsAfter }, { creations });
    return NextResponse.json(page, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "MCP receipts unreadable" }, { status: 500 });
  } finally {
    db?.close();
  }
}
