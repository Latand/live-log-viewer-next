import { NextRequest, NextResponse } from "next/server";

import { runtimeHostClient } from "@/lib/runtime/client";
import type { RuntimeEventInput } from "@/lib/runtime/contracts";
import { runtimeEventsEnabled } from "@/lib/runtime/flags";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  if (!runtimeEventsEnabled()) return NextResponse.json({ error: "runtime events are disabled" }, { status: 503 });
  let event: RuntimeEventInput;
  try { event = await request.json() as RuntimeEventInput; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (event.effect !== undefined) return NextResponse.json({ error: "generic runtime operations cannot submit effects" }, { status: 400 });
  const client = runtimeHostClient();
  if (!client) return NextResponse.json({ error: "runtime host socket is unavailable" }, { status: 503 });
  try {
    return NextResponse.json(await client.operation(event), { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "runtime operation failed" }, { status: 503 });
  }
}
