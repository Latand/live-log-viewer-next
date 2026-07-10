import { NextRequest, NextResponse } from "next/server";

import { handleRuntimeCommand } from "@/lib/runtime/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(request: NextRequest): Promise<NextResponse> {
  return handleRuntimeCommand(request, "answer");
}
