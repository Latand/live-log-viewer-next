import { NextResponse } from "next/server";

import { NoHealthyClaudeAccountError } from "@/lib/accounts/spawnHealth";

export function spawnAccountErrorResponse(error: unknown): NextResponse<{ error: string; retrySafe: true }> | null {
  if (!(error instanceof NoHealthyClaudeAccountError)) return null;
  return NextResponse.json({ error: error.message, retrySafe: true }, { status: 503 });
}
