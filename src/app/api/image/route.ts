import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/* SVG is deliberately excluded: served inline from the app origin it would run
   embedded same-origin script. Only inert raster formats are embeddable. */
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
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
  // Same gate as the mutating routes: a drive-by page or DNS-rebind must not
  // pull local image bytes off this loopback service.
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  const raw = req.nextUrl.searchParams.get("path") ?? "";
  if (!raw) return NextResponse.json({ error: "path is required" }, { status: 400 });
  const abs = resolveLocal(raw);

  const home = path.resolve(os.homedir());
  const underHome = (p: string): boolean => p === home || p.startsWith(home + path.sep);
  if (!underHome(abs)) {
    return NextResponse.json({ error: "path not allowed" }, { status: 403 });
  }
  const mime = MIME[path.extname(abs).toLowerCase()];
  if (!mime) return NextResponse.json({ error: "not an image" }, { status: 400 });

  let data: Buffer;
  try {
    // Resolve symlinks and re-check containment: a symlink under home with an
    // image extension must not read a file outside home (e.g. ~/x.png → /etc/shadow).
    const real = await fs.realpath(abs);
    if (!underHome(real)) {
      return NextResponse.json({ error: "path not allowed" }, { status: 403 });
    }
    const stat = await fs.stat(real);
    if (!stat.isFile()) return NextResponse.json({ error: "not a file" }, { status: 404 });
    data = await fs.readFile(real);
  } catch {
    return NextResponse.json({ error: "file not found" }, { status: 404 });
  }
  return new NextResponse(new Uint8Array(data), {
    headers: { "content-type": mime, "cache-control": "private, max-age=60", "x-content-type-options": "nosniff" },
  });
}
