import { NextRequest, NextResponse } from "next/server";

import { readSession } from "@/lib/session/reader";
import { claudeProjectRootFor, codexSessionRootFor, pathAllowed } from "@/lib/scanner/roots";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function engineForPath(pathname: string): "claude" | "codex" | null {
  if (codexSessionRootFor(pathname)) return "codex";
  if (claudeProjectRootFor(pathname)) return "claude";
  return null;
}

export async function GET(req: NextRequest): Promise<NextResponse<ReturnType<typeof readSession> | ApiError>> {
  const pathname = req.nextUrl.searchParams.get("path") ?? "";
  if (!pathname || !pathAllowed(pathname)) return NextResponse.json({ error: "path is outside allowed roots" }, { status: 400 });
  const engine = engineForPath(pathname);
  if (!engine) return NextResponse.json({ error: "unsupported session path" }, { status: 400 });
  return NextResponse.json(readSession(pathname, engine));
}
