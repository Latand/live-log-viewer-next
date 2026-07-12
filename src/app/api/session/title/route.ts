import { NextRequest, NextResponse } from "next/server";

import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { isoNow } from "@/lib/tasks/helpers";
import {
  MAX_CUSTOM_TITLE,
  sanitizeCustomTitle,
  titleKeysForEntry,
  TitleStoreUnreadableError,
  writeSessionTitle,
  type SessionTitleOverride,
} from "@/lib/session/titleStore";
import { publishTitleUpdate } from "@/lib/session/titleEvents";
import { propagateTitleToWindow, resolveTitleTarget } from "@/lib/session/titleTarget";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface PatchTitleBody {
  path?: unknown;
  conversationId?: unknown;
  title?: unknown;
  baseRevision?: unknown;
  /** Derived title to stamp on the tmux window on a reset (the set-path window
      name comes from the server-sanitized stored title). Sanitized server-side;
      the pane is resolved from the target, not from the client. */
  windowName?: unknown;
}

type PatchTitleResponse =
  | { ok: true; override: SessionTitleOverride | null; revision: number }
  | (ApiError & { conflict?: SessionTitleOverride | null });

export async function PATCH(req: NextRequest): Promise<NextResponse<PatchTitleResponse>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: PatchTitleBody;
  try {
    body = (await req.json()) as PatchTitleBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (!(body.title === null || typeof body.title === "string")) {
    return NextResponse.json({ error: "title must be a string or null" }, { status: 400 });
  }
  if (typeof body.title === "string" && body.title.length > MAX_CUSTOM_TITLE * 4) {
    return NextResponse.json({ error: "title is too long" }, { status: 400 });
  }
  if (body.baseRevision !== undefined && (typeof body.baseRevision !== "number" || !Number.isInteger(body.baseRevision) || body.baseRevision < 0)) {
    return NextResponse.json({ error: "baseRevision must be a non-negative integer" }, { status: 400 });
  }

  const target = resolveTitleTarget(body);
  if (!target) return NextResponse.json({ error: "unknown or unsupported session" }, { status: 400 });

  // Candidate keys include the target's alias conversation ids and every owned
  // transcript path, so a title filed under a provisional id or a predecessor
  // generation is found and migrated onto the canonical key.
  const candidateKeys = titleKeysForEntry(target, target.aliasConversationIds, target.ownedPaths);
  let outcome;
  try {
    outcome = writeSessionTitle(candidateKeys, candidateKeys[0]!, body.title as string | null, body.baseRevision as number | undefined, isoNow());
  } catch (error) {
    // The store is corrupt/unreadable: the mutation aborted without touching the
    // existing bytes. Surface it instead of silently erasing every title.
    if (error instanceof TitleStoreUnreadableError) {
      return NextResponse.json({ error: "session titles store is unreadable" }, { status: 503 });
    }
    throw error;
  }
  if (!outcome.ok) {
    // Structured 409: the editor adopts the current server record and retries.
    return NextResponse.json(
      { error: "revision conflict", conflict: outcome.conflict },
      { status: 409 },
    );
  }

  // Best-effort tmux window rename, bound to the target's own live pane (the pid
  // is resolved from the target, never trusted from the request). On a set the
  // window name is the server-sanitized title; on a reset the client supplies
  // the derived title, which we still sanitize before it reaches tmux.
  const windowName = outcome.override?.title
    ?? (typeof body.windowName === "string" ? sanitizeCustomTitle(body.windowName) : null);
  if (windowName) await propagateTitleToWindow(target, windowName);

  // Publish an identity-based set/clear signal + a files bump so other
  // tabs/devices converge even when SSE has disabled their fallback poll.
  await publishTitleUpdate(candidateKeys[0]!, outcome.override === null);

  return NextResponse.json({ ok: true, override: outcome.override, revision: outcome.revision });
}
