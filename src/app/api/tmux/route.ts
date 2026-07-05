import { NextRequest, NextResponse } from "next/server";

import {
  answerDialogKey,
  compactConversation,
  deliverConversationMessage,
  interruptConversation,
  killConversation,
  resumeConversation,
  targetForKnownPid,
  type DeliveryOutcome,
} from "@/lib/delivery";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { pathAllowed } from "@/lib/scanner/roots";
import { collectImagePayloads, liveResumePane } from "@/lib/tmux";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TargetResponse {
  target: string | null;
}

interface SendResponse {
  ok: true;
  target: string;
  imagePaths?: string[];
  /** Set when the message booted a fresh agent window instead of an existing pane. */
  spawned?: boolean;
}

function respond(outcome: DeliveryOutcome): NextResponse<SendResponse | ApiError> {
  if ("error" in outcome) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  return NextResponse.json(outcome);
}

export async function GET(req: NextRequest): Promise<NextResponse<TargetResponse | ApiError>> {
  const pidRaw = req.nextUrl.searchParams.get("pid");
  const filePath = req.nextUrl.searchParams.get("path") ?? "";
  const pid = Number(pidRaw);
  const hasPid = Number.isInteger(pid) && pid > 0;
  if (!hasPid && !filePath) {
    return NextResponse.json({ error: "потрібен pid або path" }, { status: 400 });
  }
  if (hasPid) {
    const target = await targetForKnownPid(pid);
    if (target !== "unknown" && target !== null) return NextResponse.json({ target });
  }
  /* A finished conversation has no pid, but its resume window may still run. */
  if (filePath && pathAllowed(filePath)) {
    const pane = await liveResumePane(filePath);
    if (pane) return NextResponse.json({ target: pane.display });
  }
  return NextResponse.json({ target: null });
}

export async function POST(req: NextRequest): Promise<NextResponse<SendResponse | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: { pid?: unknown; path?: unknown; text?: unknown; image?: unknown; images?: unknown; action?: unknown; key?: unknown; label?: unknown; question?: unknown };
  try {
    body = (await req.json()) as {
      pid?: unknown;
      path?: unknown;
      text?: unknown;
      image?: unknown;
      images?: unknown;
      action?: unknown;
      key?: unknown;
      label?: unknown;
      question?: unknown;
    };
  } catch {
    return NextResponse.json({ error: "некоректний JSON" }, { status: 400 });
  }

  const pid = Number(body.pid);
  const hasPid = Number.isInteger(pid) && pid > 0;
  const filePath = typeof body.path === "string" ? body.path : "";
  if (!hasPid && !filePath) {
    return NextResponse.json({ error: "потрібен pid або path" }, { status: 400 });
  }

  if (body.action === "interrupt") return respond(await interruptConversation(filePath));
  if (body.action === "compact") return respond(await compactConversation(filePath));
  if (body.action === "dialog-key") {
    const key = typeof body.key === "string" ? body.key : "";
    return respond(await answerDialogKey(filePath, key, body.label, body.question));
  }
  if (body.action === "resume") return respond(await resumeConversation(filePath));
  if (body.action === "kill") return respond(await killConversation(filePath));

  const text = typeof body.text === "string" ? body.text : "";
  const { images, error: imageError } = collectImagePayloads(body);
  if (imageError) {
    return NextResponse.json({ error: imageError.error }, { status: imageError.status });
  }
  if (!text.trim() && !images.length) {
    return NextResponse.json({ error: "порожнє повідомлення" }, { status: 400 });
  }

  return respond(await deliverConversationMessage({ pid: hasPid ? pid : null, path: filePath, text, images }));
}
