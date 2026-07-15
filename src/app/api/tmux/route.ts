import { NextRequest, NextResponse } from "next/server";

import {
  answerDialogKey,
  compactConversation,
  deliverConversationMessage,
  interruptConversation,
  killConversation,
  resumeConversation,
  reconfigureConversation,
  type DeliveryOutcome,
} from "@/lib/delivery";
import { canonicalTranscriptTarget, readTranscriptHosts } from "@/lib/agent/transcriptHost";
import { reconfigurationFromBody } from "@/lib/agent/reconfigure";
import { listFiles } from "@/lib/scanner";
import { pathAllowed } from "@/lib/scanner/roots";
import { allowedKillTarget, consumeKillTarget } from "@/lib/resources";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { materializeStructuredTerminal } from "@/lib/runtime/structuredTerminal";
import { dispatchStructuredControl } from "@/lib/runtime/structuredControls";
import {
  captureTmuxAttachReference,
  collectImagePayloads,
  killPane,
  panePidOf,
  resolveRequestedTmuxTarget,
  resolveTmuxAttach,
  tmuxEndpointDescriptor,
} from "@/lib/tmux";
import type { ApiError } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TargetResponse {
  target: string | null;
}

interface AttachResponse {
  attach: { target: string; command: string; readOnlyCommand: string };
  endpoint: { kind: "tmux-tmpdir"; tmuxTmpdir: string; socketName: "default"; socketPath: string };
}

interface AttachError {
  error: string;
  reason: "stale-pane" | "server-restarted" | "tmux-unavailable";
}

interface SendResponse {
  ok: true;
  target: string | null;
  imagePaths?: string[];
  /** Set when the message booted a fresh agent window instead of an existing pane. */
  spawned?: boolean;
  outcome?: "delivered-to-live" | "resumed" | "held" | "pending" | "reconfigured" | "queued" | "delivering" | "delivered";
  structured?: true;
  operationId?: string;
  receipt?: { operationId: string; status: string };
}

function respond(outcome: DeliveryOutcome): NextResponse<SendResponse | ApiError | { ok: false; outcome: "failed"; error: string }> {
  if (!outcome.ok) {
    const { status, ...body } = outcome;
    return NextResponse.json(body, { status });
  }
  return NextResponse.json(outcome);
}

async function targetForRequest(pid: number | null, filePath: string): Promise<string | null> {
  if (filePath && pathAllowed(filePath)) {
    /* A transcript path names the conversation being addressed. Its canonical
       host therefore wins over a client-side pid that may have exited and
       been recycled for another session between scanner polls. */
    return canonicalTranscriptTarget(await readTranscriptHosts(true), filePath);
  }
  return pid === null ? null : resolveRequestedTmuxTarget(pid);
}

function attachJson(body: AttachResponse | AttachError, status = 200): NextResponse<AttachResponse | AttachError> {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(req: NextRequest): Promise<NextResponse<TargetResponse | ApiError | AttachResponse | AttachError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;
  const pidRaw = req.nextUrl.searchParams.get("pid");
  const filePath = req.nextUrl.searchParams.get("path") ?? "";
  const resourceTarget = req.nextUrl.searchParams.get("target") ?? "";
  if (req.nextUrl.searchParams.get("attach") === "1") {
    if (Boolean(filePath) === Boolean(resourceTarget)) {
      return attachJson({ error: "path or target is required", reason: "tmux-unavailable" }, 400);
    }
    let reference;
    if (filePath) {
      if (!pathAllowed(filePath)) return attachJson({ error: "invalid transcript path", reason: "tmux-unavailable" }, 400);
      const host = (await readTranscriptHosts(true)).canonicalFor(filePath);
      if (host === null) return attachJson({ error: "unknown transcript host", reason: "tmux-unavailable" }, 400);
      reference = captureTmuxAttachReference(host);
    } else {
      const host = allowedKillTarget(resourceTarget);
      if (host === null) return attachJson({ error: "unknown resource target", reason: "tmux-unavailable" }, 400);
      reference = host;
    }
    const resolution = await resolveTmuxAttach(reference, tmuxEndpointDescriptor());
    if (!resolution.ok) {
      if (resolution.reason === "stale-pane") {
        return attachJson({ reason: resolution.reason, error: "This pane changed or closed. Refresh and try again." }, 409);
      }
      if (resolution.reason === "server-restarted") {
        return attachJson({ reason: resolution.reason, error: "The tmux server restarted. Refresh and try again." }, 409);
      }
      return attachJson({ reason: resolution.reason, error: "The tmux endpoint is unavailable. Refresh and try again." }, 503);
    }
    return attachJson({
      attach: { target: resolution.target, command: resolution.command, readOnlyCommand: resolution.readOnlyCommand },
      endpoint: resolution.endpoint,
    });
  }
  const pid = Number(pidRaw);
  const hasPid = Number.isInteger(pid) && pid > 0;
  if (!hasPid && !filePath) {
    return NextResponse.json({ error: "pid or path is required" }, { status: 400 });
  }
  try {
    return NextResponse.json({ target: await targetForRequest(hasPid ? pid : null, filePath) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse<SendResponse | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: { pid?: unknown; path?: unknown; conversationId?: unknown; clientMessageId?: unknown; text?: unknown; image?: unknown; images?: unknown; action?: unknown; key?: unknown; label?: unknown; question?: unknown; target?: unknown; model?: unknown; effort?: unknown; fast?: unknown };
  try {
    body = (await req.json()) as {
      pid?: unknown;
      path?: unknown;
      conversationId?: unknown;
      clientMessageId?: unknown;
      text?: unknown;
      image?: unknown;
      images?: unknown;
      action?: unknown;
      key?: unknown;
      label?: unknown;
      question?: unknown;
      target?: unknown;
      model?: unknown;
      effort?: unknown;
      fast?: unknown;
    };
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
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
      return NextResponse.json({ error: "unknown target — refresh the resource list" }, { status: 400 });
    }
    if ((await panePidOf(ref.paneId)) !== ref.panePid) {
      consumeKillTarget(target);
      return NextResponse.json({ error: "pane has changed — refresh the resource list" }, { status: 409 });
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
  const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
  if (!hasPid && !filePath && !conversationId.startsWith("conversation_")) {
    return NextResponse.json({ error: "pid, path, or conversationId is required" }, { status: 400 });
  }

  if (body.action === "attach-terminal") {
    if (!filePath || !pathAllowed(filePath)) {
      return NextResponse.json({ error: "valid transcript path is required" }, { status: 400 });
    }
    try {
      const attached = await materializeStructuredTerminal(filePath);
      return NextResponse.json({ ok: true, target: attached.target });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
    }
  }

  const explicitAction = typeof body.action === "string" ? body.action : "";
  const structuredControl = process.env.LLV_STRUCTURED_HOSTS === "1"
    ? await dispatchStructuredControl({ path: filePath, conversationId, action: explicitAction })
    : null;
  if (structuredControl) return NextResponse.json(structuredControl.body, { status: structuredControl.status });

  if (body.action === "interrupt") return respond(await interruptConversation(filePath));
  if (body.action === "compact") return respond(await compactConversation(filePath));
  if (body.action === "dialog-key") {
    const key = typeof body.key === "string" ? body.key : "";
    return respond(await answerDialogKey(filePath, key, body.label, body.question));
  }
  if (body.action === "resume") return respond(await resumeConversation(filePath));
  if (body.action === "kill") {
    const outcome = await killConversation(filePath);
    if (outcome.ok && !outcome.target) {
      return NextResponse.json({ ok: false, outcome: "failed", error: "kill resolved no registered pane" }, { status: 409 });
    }
    return respond(outcome);
  }
  if (body.action === "reconfigure") {
    const file = (await listFiles()).find((item) => item.path === filePath);
    if (!file || (file.engine !== "claude" && file.engine !== "codex")) {
      return NextResponse.json({ error: "conversation is unavailable" }, { status: 403 });
    }
    const parsed = reconfigurationFromBody(file.engine, body);
    if (!parsed.value) return NextResponse.json({ error: parsed.error ?? "invalid configuration" }, { status: 400 });
    return respond(await reconfigureConversation(filePath, parsed.value));
  }

  const text = typeof body.text === "string" ? body.text : "";
  const { images, error: imageError } = collectImagePayloads(body);
  if (imageError) {
    return NextResponse.json({ error: imageError.error }, { status: imageError.status });
  }
  if (!text.trim() && !images.length) {
    return NextResponse.json({ error: "empty message" }, { status: 400 });
  }

  if (process.env.LLV_STRUCTURED_HOSTS === "1") {
    const { enqueueStructuredMessage } = await import("@/lib/runtime/structuredMessageDelivery");
    const structured = await enqueueStructuredMessage({
      path: filePath,
      ...(conversationId ? { conversationId } : {}),
      ...(typeof body.clientMessageId === "string" ? { clientMessageId: body.clientMessageId.slice(0, 128) } : {}),
      text: text.trim(),
      hasImages: images.length > 0,
    });
    if (structured) {
      const { status, ...response } = structured.ok ? { ...structured, status: 200 } : structured;
      return NextResponse.json(response, { status });
    }
  }

  return respond(await deliverConversationMessage({
    pid: hasPid ? pid : null,
    path: filePath,
    ...(conversationId ? { conversationId } : {}),
    ...(typeof body.clientMessageId === "string" ? { clientMessageId: body.clientMessageId.slice(0, 128) } : {}),
    text,
    images,
  }));
}
