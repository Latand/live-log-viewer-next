import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
};

function resolveLocal(raw: string): string {
  let p = raw.replace(/^file:\/\//, "");
  if (p === "~" || p.startsWith("~/")) p = path.join(os.homedir(), p.slice(1));
  return path.resolve(p);
}

/**
 * Serves the bytes of a local image a transcript references by path, so the
 * markdown renderer can embed it inline (Markdown `![alt](/abs/path.png)`).
 * Confined to files under the user's home with an image extension — a
 * localhost-only tool, but there is no reason to hand out arbitrary files.
 */
export async function GET(req: NextRequest): Promise<NextResponse<ApiError> | NextResponse> {
  const raw = req.nextUrl.searchParams.get("path") ?? "";
  if (!raw) return NextResponse.json({ error: "path is required" }, { status: 400 });
  const abs = resolveLocal(raw);

  const home = path.resolve(os.homedir());
  if (abs !== home && !abs.startsWith(home + path.sep)) {
    return NextResponse.json({ error: "path not allowed" }, { status: 403 });
  }
  const mime = MIME[path.extname(abs).toLowerCase()];
  if (!mime) return NextResponse.json({ error: "not an image" }, { status: 400 });

  let data: Buffer;
  try {
    const stat = await fs.stat(abs);
    if (!stat.isFile()) return NextResponse.json({ error: "not a file" }, { status: 404 });
    data = await fs.readFile(abs);
  } catch {
    return NextResponse.json({ error: "file not found" }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(data), {
    headers: { "content-type": mime, "cache-control": "private, max-age=60", "x-content-type-options": "nosniff" },
  });
}
