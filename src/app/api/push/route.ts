import { NextRequest, NextResponse } from "next/server";

import { pushKeys, saveSubscription, type PushSubscriptionRecord } from "@/lib/push";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse<{ publicKey: string }>> {
  return NextResponse.json({ publicKey: pushKeys().publicKey });
}

export async function POST(req: NextRequest): Promise<NextResponse<{ ok: true } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  try {
    const body = (await req.json()) as PushSubscriptionRecord;
    if (!body.endpoint) return NextResponse.json({ error: "немає endpoint" }, { status: 400 });
    await saveSubscription(body);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "некоректний JSON" }, { status: 400 });
  }
}
