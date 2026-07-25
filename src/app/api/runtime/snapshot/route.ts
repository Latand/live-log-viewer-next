import { NextResponse } from "next/server";

import { runtimeHostClient } from "@/lib/runtime/client";
import { runtimeEventsEnabled, structuredHostsEnabled, RUNTIME_PLANE_ABSENT } from "@/lib/runtime/flags";
import { structuredStartupAxis } from "@/lib/runtime/startupStatus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  /* `runtime-plane-absent` distinguishes "this deployment has no runtime plane
     at all" from "the host is momentarily unreachable": the client bus stops
     claiming host authority on the former (so conversations resolve through the
     legacy path) and keeps its fail-safe reconnect on the latter. */
  if (!runtimeEventsEnabled()) {
    return NextResponse.json({ error: "runtime events are disabled", code: RUNTIME_PLANE_ABSENT }, { status: 503 });
  }
  const client = runtimeHostClient();
  if (!client) {
    return NextResponse.json({ error: "runtime host socket is unavailable", code: RUNTIME_PLANE_ABSENT }, { status: 503 });
  }
  try {
    return NextResponse.json({
      // The request signal reaches the runtime host, so a disconnected caller
      // cancels its socket wait instead of leaving late host work behind.
      ...await client.snapshot(request.signal),
      structuredHostsEnabled: structuredHostsEnabled(),
      structuredStartup: structuredStartupAxis(),
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "runtime host is unavailable" }, { status: 503 });
  }
}
