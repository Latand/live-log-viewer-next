import { NextRequest, NextResponse } from "next/server";

import { attentionForDevice, raiseAttentionRequest } from "@/lib/attention/service";
import { AttentionStoreError, AttentionValidationError } from "@/lib/attention/store";
import { AttentionRequestError, readBoundedJson, validateAttentionCreate } from "@/lib/attention/validation";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "Cache-Control": "no-store" };

function failure(error: unknown): NextResponse {
  if (error instanceof AttentionRequestError) {
    return NextResponse.json({ error: error.code, message: error.message }, { status: error.status, headers });
  }
  if (error instanceof AttentionValidationError) {
    return NextResponse.json({ error: error.code, message: error.message }, { status: 400, headers });
  }
  if (error instanceof AttentionStoreError) {
    return NextResponse.json({ error: "ATTENTION_STATE_UNAVAILABLE", message: error.message }, { status: 503, headers });
  }
  return NextResponse.json({ error: "INVALID_REQUEST", message: "invalid request" }, { status: 400, headers });
}

/** What this device should render right now, plus anything the clock just
    expired so the caller can say so once. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const deviceId = request.nextUrl.searchParams.get("deviceId");
  if (!deviceId) {
    return NextResponse.json({ error: "INVALID_REQUEST", message: "deviceId is required" }, { status: 400, headers });
  }
  try {
    return NextResponse.json({ ok: true, ...attentionForDevice(deviceId) }, { headers });
  } catch (error) {
    return failure(error);
  }
}

/** Raise a request. The root identity is resolved server-side (D4). */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) {
    rejection.headers.set("Cache-Control", "no-store");
    return rejection;
  }
  try {
    const created = raiseAttentionRequest(validateAttentionCreate(await readBoundedJson(request)));
    return NextResponse.json({ ok: true, ...created }, { headers });
  } catch (error) {
    return failure(error);
  }
}
