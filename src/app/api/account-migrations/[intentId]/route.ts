import { NextRequest, NextResponse } from "next/server";

import { agentRegistry } from "@/lib/agent/registry";
import { drainHeldDeliveries } from "@/lib/accounts/migration/coordinator";
import { deliverConversationMessage } from "@/lib/delivery";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deliveryPort = {
  async deliver({ delivery, path, clientMessageId }: { delivery: { text: string }; path: string; clientMessageId: string }) {
    const result = await deliverConversationMessage({ pid: null, path, text: delivery.text, images: [], clientMessageId });
    return result.ok ? "delivered" as const : "failed" as const;
  },
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ intentId: string }> }) {
  const rejected = rejectCrossOrigin(req); if (rejected) return rejected;
  let body: { action?: unknown; expectedRevision?: unknown }; try { body = await req.json() as typeof body; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (body.action !== "stop" && body.action !== "retry-failed") return NextResponse.json({ error: "unsupported migration action" }, { status: 400 });
  if (body.expectedRevision !== undefined && (!Number.isInteger(body.expectedRevision) || (body.expectedRevision as number) < 0)) return NextResponse.json({ error: "expectedRevision must be a non-negative integer" }, { status: 400 });
  const { intentId } = await params;
  try {
    const registry = agentRegistry();
    if (body.action === "stop") {
      const stopped = registry.setMigrationIntentState(intentId, "stopped", body.expectedRevision as number | undefined);
      for (const conversation of Object.values(registry.snapshot().conversations)) {
        if (conversation.migration?.intentId === intentId && conversation.migration.phase === "rolled-back") {
          await drainHeldDeliveries(conversation.id, deliveryPort, registry);
        }
      }
      return NextResponse.json(stopped);
    }
    const snapshot = registry.snapshot();
    const intent = snapshot.migrationIntents[intentId];
    if (!intent) return NextResponse.json({ error: "migration intent is unknown" }, { status: 404 });
    if (body.expectedRevision !== undefined && intent.revision !== body.expectedRevision) return NextResponse.json({ error: "migration intent revision is stale" }, { status: 409 });
    const retried = Object.values(snapshot.conversations)
      .filter((conversation) => conversation.migration?.intentId === intentId && conversation.migration.phase === "failed-recoverable")
      .map((conversation) => registry.retryConversationMigration(conversation.id, conversation.migration?.revision));
    return NextResponse.json({ intent, retried: retried.length });
  }
  catch (error) {
    const conflict = error instanceof Error && error.message.includes("revision");
    return NextResponse.json({ error: conflict ? "migration intent revision is stale" : "migration action failed" }, { status: conflict ? 409 : 404 });
  }
}
