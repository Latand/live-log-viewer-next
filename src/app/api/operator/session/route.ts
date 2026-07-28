import { NextRequest, NextResponse } from "next/server";

import { requireOperatorAuthority } from "@/lib/agent/operatorAuthority";
import {
  establishOperatorBrowserSession,
  OPERATOR_SESSION_COOKIE,
  OPERATOR_SESSION_MAX_AGE_SECONDS,
} from "@/lib/agent/operatorBrowserSession";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The operator's browser session (`operatorBrowserSession.ts`).
 *
 * POST — establish: a tab that adopted the startup-link credential trades it for
 * the browser-scoped httpOnly cookie, which then authorizes every tab of this
 * browser and survives server restarts. The token travels ONLY in `Set-Cookie`;
 * the body is a bare boolean. An already-established browser may POST again,
 * which rotates it a fresh token (bounded server-side).
 *
 * GET — probe: "is this browser the operator's?" as a boolean, nothing else.
 * Deliberately safe for the anonymous loopback page: a caller without the cookie
 * or the link credential learns only `false`, and no secret exists in any
 * response body either way.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  const authority = requireOperatorAuthority(request);
  if (!authority.ok) {
    return NextResponse.json({ error: authority.error }, { status: authority.status });
  }
  const response = NextResponse.json({ operator: true });
  response.cookies.set({
    name: OPERATOR_SESSION_COOKIE,
    value: establishOperatorBrowserSession(),
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: OPERATOR_SESSION_MAX_AGE_SECONDS,
  });
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  return NextResponse.json({ operator: requireOperatorAuthority(request).ok });
}
