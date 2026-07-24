import { NextRequest, NextResponse } from "next/server";

import { resolveAccountTerminalCommand, TerminalAccountUnavailableError } from "@/lib/accounts/terminalLaunch";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOrigin(req);
  if (rejected) return rejected;
  let body: { id?: unknown };
  try { body = await req.json() as typeof body; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (typeof body.id !== "string") return NextResponse.json({ error: "id must be a string" }, { status: 400 });
  try {
    return NextResponse.json({ ok: true, ...resolveAccountTerminalCommand("claude", body.id) });
  } catch (error) {
    if (error instanceof TerminalAccountUnavailableError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("[accounts] claude terminal command failed:", error);
    const detail = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: "Claude terminal command failed", detail }, { status: 500 });
  }
}
