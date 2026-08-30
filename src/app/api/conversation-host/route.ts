import { conversationHostGET, conversationHostPOST } from "./handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* The name that says what the endpoint does: resume or respawn a conversation's
   host and deliver to it. `/api/tmux` is the same handlers under the old path,
   kept so nothing in flight breaks (#1301). */
export const GET = conversationHostGET;
export const POST = conversationHostPOST;
