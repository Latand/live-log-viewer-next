import { NextResponse } from "next/server";

import { runtimeHostClient } from "@/lib/runtime/client";
import { runtimeEventsEnabled } from "@/lib/runtime/flags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  if (!runtimeEventsEnabled()) return NextResponse.json({ error: "runtime events are disabled" }, { status: 503 });
  const client = runtimeHostClient();
  if (!client) return NextResponse.json({ error: "runtime host socket is unavailable" }, { status: 503 });
  try {
    return NextResponse.json({
      ...await client.snapshot(),
      structuredHostsEnabled: process.env.LLV_STRUCTURED_HOSTS === "1",
    }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "runtime host is unavailable" }, { status: 503 });
  }
}
