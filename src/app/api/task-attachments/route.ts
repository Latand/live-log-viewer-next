import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { readAttachment, storeAttachment } from "@/lib/tasks/attachments";
import { isoNow } from "@/lib/tasks/helpers";
import type { TaskAttachment } from "@/lib/tasks/types";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Serves a stored attachment's bytes by its content address, so a draft's
    thumbnails render after reload from the durable ref (no in-memory preview). */
export async function GET(req: NextRequest): Promise<NextResponse<ApiError> | NextResponse> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  const sha = req.nextUrl.searchParams.get("sha") ?? "";
  const ext = req.nextUrl.searchParams.get("ext") ?? "";
  const found = readAttachment(sha, ext);
  if (!found) return NextResponse.json({ error: "attachment not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(found.data), {
    headers: { "content-type": found.mime, "cache-control": "private, max-age=31536000, immutable" },
  });
}

/**
 * Content-addressed image upload. A multipart `file` is validated against the
 * shared image policy, written under `attachments/tasks/<sha256>.<ext>`, and its
 * durable ref returned. Identical bytes replay to the identical record, so a
 * retried upload is safe. The ref is later attached to a task, which owns the
 * bytes for delivery — ending the old post-send base64 hop that dropped images.
 */
export async function POST(req: NextRequest): Promise<NextResponse<{ ok: true; attachment: TaskAttachment } | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "expected multipart form data" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "file is required" }, { status: 400 });

  const data = Buffer.from(await file.arrayBuffer());
  const result = storeAttachment(data, file.type, isoNow());
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ ok: true, attachment: result.attachment });
}
