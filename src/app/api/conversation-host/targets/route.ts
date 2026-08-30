import { conversationHostTargetsPOST } from "./handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* The name that says what the endpoint does: which host currently owns each of
   these conversations. `/api/tmux/targets` is the same handler under the old
   path, kept so nothing in flight breaks (#1301). */
export const POST = conversationHostTargetsPOST;
