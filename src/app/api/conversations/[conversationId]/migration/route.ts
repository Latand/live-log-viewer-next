import { NextRequest, NextResponse } from "next/server";

import { agentRegistry } from "@/lib/agent/registry";
import { listClaudeAccounts } from "@/lib/accounts/claude";
import { listCodexAccounts } from "@/lib/accounts/codex";
import { advanceConversationMigration, drainHeldDeliveries } from "@/lib/accounts/migration/coordinator";
import { createMigrationDeliveryPort } from "@/lib/accounts/migration/deliveryPort";
import { RegisteredSuccessorProvider } from "@/lib/accounts/migration/provider";
import { chooseReseatTarget } from "@/lib/accounts/reseat";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deliveryPort = createMigrationDeliveryPort();

const IN_FLIGHT_PHASES = new Set(["requested", "waiting-turn", "preparing", "successor-starting", "verifying"]);

export async function POST(req: NextRequest, { params }: { params: Promise<{ conversationId: string }> }) {
  const rejected = rejectCrossOrigin(req); if (rejected) return rejected;
  let body: { action?: unknown; expectedRevision?: unknown; path?: unknown }; try { body = await req.json() as typeof body; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  const { conversationId } = await params;
  if (!conversationId.startsWith("conversation_")) return NextResponse.json({ error: "invalid conversation id" }, { status: 400 });
  if (body.action === "reseat") {
    /* One-click rate-limit reseat (issue #97). Lineage first: a client acting
       on an archived generation (a migration already forked the thread) or on
       a conversation with an in-flight migration must never mint a second
       successor — those return idempotently instead of re-requesting. */
    if (body.path !== undefined && typeof body.path !== "string") return NextResponse.json({ error: "path must be a string" }, { status: 400 });
    const registry = agentRegistry();
    const conversation = registry.conversation(conversationId as ViewerConversationId);
    if (!conversation) return NextResponse.json({ error: "viewer conversation is unknown" }, { status: 404 });
    const source = conversation.generations.at(-1);
    if (!source?.accountId) return NextResponse.json({ error: "conversation has no managed account to reseat from" }, { status: 409 });
    if (typeof body.path === "string" && body.path !== source.path) {
      return NextResponse.json({ reseat: "already-reseated", error: "a successor already replaced this conversation" }, { status: 409 });
    }
    if (conversation.migration && IN_FLIGHT_PHASES.has(conversation.migration.phase)) {
      return NextResponse.json({ reseat: "already-migrating", phase: conversation.migration.phase, conversation });
    }
    const accounts = conversation.engine === "claude" ? listClaudeAccounts() : listCodexAccounts();
    const target = chooseReseatTarget(source.accountId, registry.quotaObservations(conversation.engine), accounts);
    if (!target) return NextResponse.json({ error: "no healthy account with fresh quota headroom is available" }, { status: 409 });
    const requested = registry.requestConversationReseat(conversationId as ViewerConversationId, target.accountId);
    let final = requested;
    if (requested.migration) {
      /* Best effort: a provider preflight failure stays recoverable and the
         background controller keeps reconciling the requested migration. */
      try {
        final = await advanceConversationMigration(conversationId as ViewerConversationId, registry, new RegisteredSuccessorProvider());
        if (final.migration?.phase === "committed") await drainHeldDeliveries(final.id, deliveryPort, registry);
      } catch { final = registry.conversation(conversationId as ViewerConversationId) ?? requested; }
    }
    /* `phase` exposes the exact wait state: "waiting-turn" means the reseat is
       parked until the walled turn releases (the wall itself frees it on the
       next inventory pass), anything else is actively migrating. */
    return NextResponse.json({ reseat: "requested", phase: final.migration?.phase ?? null, targetId: target.accountId, targetLabel: target.label, conversation: final });
  }
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
