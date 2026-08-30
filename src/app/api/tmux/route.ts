import { conversationHostGET, conversationHostPOST } from "@/app/api/conversation-host/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Legacy path for `/api/conversation-host`, kept working so callers already in
 * flight keep working. THE NAME IS WRONG AND NO TMUX IS INVOLVED: this endpoint
 * resumes or respawns a conversation's structured host — the engine is spawned
 * into the host namespace through `nsenter` with privileges dropped — and
 * delivers the message to it. A session that will not start is diagnosed at
 * that spawn or at the host claim, never at a tmux server (#1301).
 *
 * Prefer `/api/conversation-host` for new callers. The handlers are shared, so
 * the two paths cannot drift apart.
 */
export const GET = conversationHostGET;
export const POST = conversationHostPOST;
