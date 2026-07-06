import { NextRequest, NextResponse } from "next/server";

import {
  answerDialogKey,
  compactConversation,
  deliverConversationMessage,
  interruptConversation,
  killConversation,
  resumeConversation,
  type DeliveryOutcome,
} from "@/lib/delivery";
import { allowedKillTarget, consumeKillTarget } from "@/lib/resources";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { collectImagePayloads, killPane, panePidOf, resolveRequestedTmuxTarget } from "@/lib/tmux";
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
  return NextResponse.json({ target: await resolveRequestedTmuxTarget(hasPid ? pid : null, filePath) });
}

export async function POST(req: NextRequest): Promise<NextResponse<SendResponse | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: { pid?: unknown; path?: unknown; text?: unknown; image?: unknown; images?: unknown; action?: unknown; key?: unknown; label?: unknown; question?: unknown; target?: unknown };
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
      target?: unknown;
    };
  } catch {
    return NextResponse.json({ error: "некоректний JSON" }, { status: 400 });
  }

  /* Resource-panel cleanup: kills an agent session's pane. Only targets from
     the last /api/resources snapshot are accepted (server-held allowlist) —
     an arbitrary client-named pane, e.g. the user's own work shell, is
     refused. The kill addresses the stable `%N` pane id recorded in the
     snapshot, verifies the pane still runs the snapshot's pane pid right
     before killing, and consumes the target afterwards. Display coordinates
     renumber as windows close (`renumber-windows on`), so a stale or
     repeated POST aimed at coordinates could take down a different pane
     than the one the panel showed. */
  if (body.action === "kill-target") {
    const target = typeof body.target === "string" ? body.target : "";
    const ref = allowedKillTarget(target);
    if (ref === null) {
      return NextResponse.json({ error: "невідома ціль — онови список ресурсів" }, { status: 400 });
    }
    if ((await panePidOf(ref.paneId)) !== ref.panePid) {
      consumeKillTarget(target);
      return NextResponse.json({ error: "пейн уже змінився — онови список ресурсів" }, { status: 409 });
    }
    try {
      await killPane(ref.paneId);
      consumeKillTarget(target);
      return NextResponse.json({ ok: true, target });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
    }
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
