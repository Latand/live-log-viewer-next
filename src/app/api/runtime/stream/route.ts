import { runtimeHostClient } from "@/lib/runtime/client";
import { runtimeEventsEnabled } from "@/lib/runtime/flags";
import { runtimeEventStream } from "@/lib/runtime/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  if (!runtimeEventsEnabled()) return Response.json({ error: "runtime events are disabled" }, { status: 503 });
  const client = runtimeHostClient();
  if (!client) return Response.json({ error: "runtime host socket is unavailable" }, { status: 503 });
  const url = new URL(request.url);
  const header = request.headers.get("last-event-id");
  const after = Number(url.searchParams.get("after") ?? header ?? 0);
  if (!Number.isInteger(after) || after < 0) return Response.json({ error: "after must be a non-negative sequence" }, { status: 400 });
  return new Response(runtimeEventStream(client, after, request.signal), {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}
