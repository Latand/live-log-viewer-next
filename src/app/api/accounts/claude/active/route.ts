import { NextRequest, NextResponse } from "next/server";

import { CorruptClaudeAccountsError, UnknownClaudeAccountError, setActiveClaudeAccount } from "@/lib/accounts/claude";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOrigin(req); if (rejected) return rejected;
  let body: { id?: unknown }; try { body = await req.json() as { id?: unknown }; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (typeof body.id !== "string") return NextResponse.json({ error: "id must be a string" }, { status: 400 });
  try { setActiveClaudeAccount(body.id); return new NextResponse(null, { status: 204 }); }
  catch (error) { const status = error instanceof UnknownClaudeAccountError || error instanceof CorruptClaudeAccountsError ? 400 : 500; return NextResponse.json({ error: error instanceof Error ? error.message : "could not select Claude account" }, { status }); }
}
