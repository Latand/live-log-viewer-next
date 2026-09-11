import { NextRequest, NextResponse } from "next/server";

import { handleRuntimeCommand } from "@/lib/runtime/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Native Codex history injection (#1560).
 *
 * A sibling of `/api/runtime/steer`, and deliberately routed through the same
 * `handleRuntimeCommand` gate rather than around it: same cross-origin
 * rejection, same operator-authority check, same durable admission, same
 * attachment retention. The only thing that distinguishes it is the operation
 * kind it admits, which is what decides that the engine is asked to append
 * input to the thread instead of to answer it.
 */
export function POST(request: NextRequest): Promise<NextResponse> {
  return handleRuntimeCommand(request, "inject");
}
