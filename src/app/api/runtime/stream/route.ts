import { runtimeHostClient } from "@/lib/runtime/client";
import { runtimeEventsEnabled } from "@/lib/runtime/flags";
import { runtimeCursor, runtimeEventStream } from "@/lib/runtime/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (!runtimeEventsEnabled()) return Response.json({ error: "runtime events are disabled" }, { status: 503 });
  const client = runtimeHostClient();
  if (!client) return Response.json({ error: "runtime host socket is unavailable" }, { status: 503 });
  const url = new URL(request.url);
  const header = request.headers.get("last-event-id");
  let after: number;
  try {
    after = runtimeCursor(url.searchParams.get("after"), header);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "runtime cursor is invalid" }, { status: 400 });
  }
  return new Response(runtimeEventStream(client, after, request.signal), {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    },
  });
}
