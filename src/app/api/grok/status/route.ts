import { NextResponse } from "next/server";

import { grokAuthStatus } from "@/lib/accounts/grok";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Sign-in presence for the Grok footer row. Tokens never leave this process. */
export async function GET() {
  return NextResponse.json({ grok: grokAuthStatus() });
}
