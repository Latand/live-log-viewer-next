import { NextRequest, NextResponse } from "next/server";

import { CorruptCodexAccountsError, UnknownAccountError, setActiveCodexAccount } from "@/lib/accounts/codex";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const rejected = rejectCrossOrigin(req);
  if (rejected) return rejected;
  let body: { id?: unknown };
  try { body = await req.json() as { id?: unknown }; } catch { return NextResponse.json({ error: "invalid JSON" }, { status: 400 }); }
  if (typeof body.id !== "string") return NextResponse.json({ error: "id must be a string" }, { status: 400 });
  try {
    setActiveCodexAccount(body.id);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    const status = error instanceof UnknownAccountError || error instanceof CorruptCodexAccountsError ? 400 : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "could not select account" }, { status });
  }
}
