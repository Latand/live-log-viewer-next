import { NextRequest, NextResponse } from "next/server";

import { agentRegistry } from "@/lib/agent/registry";
import { advanceConversationMigration, drainHeldDeliveries } from "@/lib/accounts/migration/coordinator";
import { RegisteredSuccessorProvider } from "@/lib/accounts/migration/provider";
import { deliverConversationMessage } from "@/lib/delivery";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deliveryPort = {
  async deliver({ delivery, path, clientMessageId }: { delivery: { text: string }; path: string; clientMessageId: string }) {
    const result = await deliverConversationMessage({ pid: null, path, text: delivery.text, images: [], clientMessageId });
    if (!result.ok) return "failed" as const;
    return "delivered" as const;
  },
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ conversationId: string }> }) {
  const rejected = rejectCrossOrigin(req); if (rejected) return rejected;
  let body: { action?: unknown; expectedRevision?: unknown }; try { body = await req.json() as typeof body; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  const { conversationId } = await params;
  if (!conversationId.startsWith("conversation_")) return NextResponse.json({ error: "invalid conversation id" }, { status: 400 });
  if (!Number.isInteger(body.expectedRevision) || (body.expectedRevision as number) < 0) return NextResponse.json({ error: "expectedRevision must be a non-negative integer" }, { status: 400 });
  if (body.action === "rollback") {
    try {
      const registry = agentRegistry();
      const conversation = registry.rollbackConversationMigration(conversationId as ViewerConversationId, body.expectedRevision as number);
      await drainHeldDeliveries(conversation.id, deliveryPort, registry);
      return NextResponse.json(conversation);
    }
    catch (error) {
      const conflict = error instanceof Error && error.message.includes("revision");
      return NextResponse.json({ error: conflict ? "migration revision is stale" : "conversation migration rollback failed" }, { status: conflict ? 409 : 404 });
    }
  }
  if (body.action === "retry") {
    try {
      const registry = agentRegistry();
      registry.retryConversationMigration(conversationId as ViewerConversationId, body.expectedRevision as number);
      const conversation = await advanceConversationMigration(conversationId as ViewerConversationId, registry, new RegisteredSuccessorProvider());
      if (conversation.migration?.phase === "committed") await drainHeldDeliveries(conversation.id, deliveryPort, registry);
      return NextResponse.json(conversation);
    }
    catch { return NextResponse.json({ error: "migration retry failed a recoverable preflight" }, { status: 409 }); }
  }
  return NextResponse.json({ error: "unsupported conversation migration action" }, { status: 400 });
}
