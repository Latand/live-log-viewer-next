import fs from "node:fs/promises";

import { NextRequest, NextResponse } from "next/server";

import { inboxImageRef } from "@/lib/inbox";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface DeleteResponse {
  ok: true;
  /** Set when the file was already gone — the desired end state either way. */
  missing?: true;
}

/** Serves the bytes of a composer-saved inbox image (`?name=img-….png`). */
export async function GET(req: NextRequest): Promise<NextResponse<ApiError> | NextResponse> {
  const ref = inboxImageRef(req.nextUrl.searchParams.get("name") ?? "");
  if (!ref) return NextResponse.json({ error: "недопустиме ім'я файлу" }, { status: 400 });
  let data: Buffer;
  try {
    data = await fs.readFile(ref.path);
  } catch {
    return NextResponse.json({ error: "файл не знайдено" }, { status: 404 });
  }
  /* no-store: a deleted image must not resurrect from the browser cache. */
  return new NextResponse(new Uint8Array(data), {
    headers: { "content-type": ref.mime, "cache-control": "no-store" },
  });
}

/** Deletes an inbox image from disk. The client confirms before calling. */
export async function DELETE(req: NextRequest): Promise<NextResponse<DeleteResponse | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  const ref = inboxImageRef(req.nextUrl.searchParams.get("name") ?? "");
  if (!ref) return NextResponse.json({ error: "недопустиме ім'я файлу" }, { status: 400 });
  try {
    await fs.unlink(ref.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ ok: true, missing: true });
    }
    return NextResponse.json({ error: "не вдалося видалити файл" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
