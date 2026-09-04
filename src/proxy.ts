import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { tokensMatch } from "@/lib/authToken";

const AUTH_COOKIE = "llv_auth";
const COOKIE_MAX_AGE_SECONDS = 2_592_000;

function tokenMatches(candidate: string | undefined, token: string): boolean {
  if (candidate === undefined) {
    return false;
  }

  return tokensMatch(candidate, token);
}

function redirectWithCookie(request: NextRequest, token: string): NextResponse {
  const url = request.nextUrl.clone();
  url.searchParams.delete("k");

  const response = NextResponse.redirect(url, 307);
  response.cookies.set({
    name: AUTH_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
    secure: request.headers.get("x-forwarded-proto") === "https",
  });
  return response;
}

function forbidden(request: NextRequest): NextResponse {
  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "access denied: key required" }, { status: 403 });
  }

  return new NextResponse(
    "Access denied. Open the link with the key from the terminal where the viewer is running (bunx agent-log-viewer --tailscale).",
    {
      status: 403,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );
}

export function proxy(request: NextRequest): NextResponse {
  const token = process.env.LLV_TOKEN;
  if (!token) {
    return NextResponse.next();
  }

  // LLV_TOKEN is the explicit access-control switch. Once configured, every
  // connection authenticates because loopback is shared by every OS account.

  const cookieToken = request.cookies.get(AUTH_COOKIE)?.value;
  if (tokenMatches(cookieToken, token)) {
    return NextResponse.next();
  }

  const authorizationHeader = request.headers.get("authorization");
  const bearer = authorizationHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (tokenMatches(bearer, token)) {
    return NextResponse.next();
  }

  const queryToken = request.nextUrl.searchParams.get("k");
  if (queryToken !== null && tokensMatch(queryToken, token)) {
    return redirectWithCookie(request, token);
  }

  return forbidden(request);
}

export const config = { matcher: ["/((?!_next/static|favicon.ico).*)"] };
