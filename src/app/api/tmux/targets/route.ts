import { conversationHostTargetsPOST } from "@/app/api/conversation-host/targets/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Legacy path for `/api/conversation-host/targets`, kept working so callers
 * already in flight keep working. THE NAME IS WRONG AND NO TMUX IS INVOLVED:
 * this endpoint answers which host currently owns each conversation, out of the
 * transcript-host snapshot, and a structured host is what it usually names
 * (#1301).
 *
 * Prefer `/api/conversation-host/targets` for new callers. The handler is
 * shared, so the two paths cannot drift apart.
 */
export const POST = conversationHostTargetsPOST;
