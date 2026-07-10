import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { tokensMatch } from "@/lib/authToken";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const AUTH_COOKIE = "llv_auth";
const COOKIE_MAX_AGE_SECONDS = 2_592_000;

function hostWithoutPort(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(1, end);
  }

  const idx = host.lastIndexOf(":");
  return idx === -1 ? host : host.slice(0, idx);
}

function isLoopbackAddress(address: string): boolean {
  if (address === "::1" || address === "::ffff:127.0.0.1") {
    return true;
  }

  const ipv4Match = /^127(?:\.(?:\d{1,3})){3}$/.exec(address);
  if (ipv4Match === null) {
    return false;
  }

  return address
    .split(".")
    .every((part) => {
      const value = Number(part);
      return Number.isInteger(value) && value >= 0 && value <= 255;
    });
}

function hasRemoteForwardedAddress(header: string): boolean {
  return header
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .some((entry) => !isLoopbackAddress(entry));
}

function isRemote(request: NextRequest): boolean {
  const forwardedFor = request.headers.get("x-forwarded-for");
  // Next injects loopback X-Forwarded-For in production, so inspect values instead of treating header presence as remote.
  if (forwardedFor !== null && hasRemoteForwardedAddress(forwardedFor)) {
    return true;
  }

  const host = request.headers.get("host");
  return host === null || !LOOPBACK_HOSTS.has(hostWithoutPort(host));
}

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

  if (!isRemote(request)) {
    return NextResponse.next();
  }

  const cookieToken = request.cookies.get(AUTH_COOKIE)?.value;
  if (tokenMatches(cookieToken, token)) {
    return NextResponse.next();
  }

  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
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
