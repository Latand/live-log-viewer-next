import { NextRequest, NextResponse } from "next/server";

import { executeRealtimeControl } from "@/lib/runtime/realtimeControl";
import { realtimeRequestAuthority } from "@/lib/runtime/realtimeInjection";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse<Record<string, unknown> | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const requestBody = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {};
  const result = await executeRealtimeControl(
    body,
    undefined,
    realtimeRequestAuthority(req, requestBody),
  );
  return NextResponse.json(result.body, { status: result.status });
}
