import { NextRequest, NextResponse } from "next/server";

import { applyConversationMigration } from "@/lib/accounts/migration/conversationCommand";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ conversationId: string }> }) {
  const rejected = rejectCrossOrigin(req);
  if (rejected) return rejected;
  let body: { action?: unknown; expectedRevision?: unknown; path?: unknown };
  try {
    body = await req.json() as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const { conversationId } = await params;
  const result = await applyConversationMigration({
    conversationId,
    action: typeof body.action === "string" ? body.action : "",
    expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
    path: body.path as string | undefined,
  });
  return NextResponse.json(result.body, { status: result.status });
}
