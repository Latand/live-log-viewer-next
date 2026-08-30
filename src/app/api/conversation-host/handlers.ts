/**
 * Resume or respawn a conversation's host, and deliver to it.
 *
 * Mounted twice: at `/api/conversation-host`, which says what this does, and at
 * the legacy `/api/tmux`, which does not. NO TMUX RUNS IN THE DELIVERY PATH —
 * a send goes to `deliverConversationMessage` / `enqueueStructuredMessage`,
 * which resolve the conversation's structured host and spawn the engine into
 * the host namespace through `nsenter` with privileges dropped. Anyone
 * debugging a session that will not start should look there and at the host
 * claim, not for a tmux server (#1301).
 *
 * Three branches here do still drive tmux, and each is still wired to a live
 * caller, so the word means something where it survives:
 *   - `GET ?attach=1` composes a `tmux attach-session` command for a legacy
 *     pane (`AttachTerminalDialog`, `resources/AttachControls`);
 *   - `POST {action:"kill-target"}` kills a legacy pane from the resource
 *     panel (`ResourcesFooter`);
 *   - `POST {action:"attach-terminal"}` opens a tmux window that tails a
 *     *structured* conversation's transcript — the host stays structured, only
 *     the viewer window is a pane (`materializeStructuredTerminal`).
 * Everything else on this route — sends, conversation actions, reconfigure —
 * is structured end to end.
 */
import { NextRequest, NextResponse } from "next/server";

import {
  deliverConversationMessage,
  reconfigureConversation,
  type DeliveryOutcome,
} from "@/lib/delivery";
import { structuredHostsEnabled } from "@/lib/runtime/flags";
import { applyConversationAction, CONVERSATION_ACTIONS } from "@/lib/conversation/actions";
import { canonicalTranscriptTarget, readTranscriptHosts } from "@/lib/agent/transcriptHost";
import { directOperatorActivityAuthority } from "@/lib/agent/operatorAuthority";
import { reconfigurationFromBody } from "@/lib/agent/reconfigure";
import { listFiles } from "@/lib/scanner";
import { completedFileScan } from "@/lib/scanner/scanCache";
import { pathAllowed } from "@/lib/scanner/roots";
import { allowedKillTarget, consumeKillTarget } from "@/lib/resources";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { retireReplySuggestionsOnOperatorMessage } from "@/lib/suggestions/store";
import { parseMessageOrigin } from "@/lib/runtime/messageOrigin";
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
import { attachmentsAreOrphaned, structuredAttachmentOutcome, type AttachmentDeliveryOutcome } from "@/lib/attachmentRetention";
import type { InboxFileAdmissionResult } from "@/lib/inboxFiles";
import type { ApiError, FileEntry } from "@/lib/types";
import { recordDirectOperatorWakatimeActivity } from "@/lib/wakatime/operatorActivity";

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
  /** Inbox paths the general (non-image) attachments were written to (#1224):
      the same by-path handover images get, minus the base64-into-the-turn half. */
  filePaths?: string[];
  /** Set when the message booted a fresh agent host instead of reaching a live one. */
  spawned?: boolean;
  outcome?: "delivered-to-live" | "resumed" | "held" | "pending" | "reconfigured" | "queued" | "delivering" | "delivered";
  structured?: true;
  operationId?: string;
  receipt?: { operationId: string; status: string };
}

async function currentTranscriptHosts(files?: FileEntry[]) {
  const entries = files ?? (await completedFileScan()).snapshot.files;
  return readTranscriptHosts(true, entries);
}

function respond(outcome: DeliveryOutcome): NextResponse<SendResponse | ApiError | { ok: false; outcome: "failed"; error: string }> {
  if (!outcome.ok) {
    const { status, ...body } = outcome;
    return NextResponse.json(body, { status });
  }
  return NextResponse.json(outcome);
}

async function targetForRequest(pid: number | null, filePath: string): Promise<string | null> {
  const files = (await completedFileScan()).snapshot.files;
  if (filePath && pathAllowed(filePath)) {
    /* A transcript path names the conversation being addressed. Its canonical
       host therefore wins over a client-side pid that may have exited and
       been recycled for another session between scanner polls. */
    return canonicalTranscriptTarget(await currentTranscriptHosts(files), filePath);
  }
  return pid === null ? null : resolveRequestedTmuxTarget(pid, files);
}

class OperatorActivityTargetConflictError extends Error {}

function operatorFallbackEntry(
  files: FileEntry[],
  target: { pid: number; hasPid: boolean; filePath: string; conversationId: string },
): FileEntry | undefined {
  const byPath = target.filePath ? files.find((entry) => entry.path === target.filePath) : undefined;
  const byConversation = target.conversationId
    ? files.find((entry) => entry.conversationId === target.conversationId)
    : undefined;
  if ((byPath && byConversation && byPath.path !== byConversation.path)
    || (byPath?.conversationId && target.conversationId && byPath.conversationId !== target.conversationId)
    || (byConversation && target.filePath && byConversation.path !== target.filePath)) {
    throw new OperatorActivityTargetConflictError("operator activity target evidence conflicts");
  }
  if (byPath) return byPath;
  if (byConversation) return byConversation;
  if (target.filePath || target.conversationId || !target.hasPid) return undefined;
  return files.find((entry) => entry.pid === target.pid);
}

/** Whether this request is the operator acting directly, and the conversation
    the target resolved to — the same resolution the activity record already
    performs, returned so a caller does not scan for it a second time. */
interface AuthorizedOperatorAction {
  byOperator: boolean;
  conversationId: string;
}

async function recordAuthorizedOperatorActivity(
  req: NextRequest,
  target: { pid: number; hasPid: boolean; filePath: string; conversationId: string },
  identity: { idempotencyKey?: string },
): Promise<AuthorizedOperatorAction> {
  if (!directOperatorActivityAuthority(req).ok) return { byOperator: false, conversationId: target.conversationId };
  const fallbackEntry = operatorFallbackEntry((await completedFileScan()).snapshot.files, target);
  recordDirectOperatorWakatimeActivity({
    ...(target.conversationId ? { conversationId: target.conversationId } : {}),
    ...(target.filePath ? { path: target.filePath } : {}),
    ...identity,
    ...(fallbackEntry ? { fallbackEntry } : {}),
  });
  return { byOperator: true, conversationId: target.conversationId || fallbackEntry?.conversationId || "" };
}

function attachJson(body: AttachResponse | AttachError, status = 200): NextResponse<AttachResponse | AttachError> {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function conversationHostGET(req: NextRequest): Promise<NextResponse<TargetResponse | ApiError | AttachResponse | AttachError>> {
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
      const host = (await currentTranscriptHosts()).canonicalFor(filePath);
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

export async function conversationHostPOST(req: NextRequest): Promise<NextResponse<SendResponse | ApiError>> {
  const rejection = rejectCrossOrigin(req);
  if (rejection) return rejection;

  let body: { pid?: unknown; path?: unknown; conversationId?: unknown; clientMessageId?: unknown; operationId?: unknown; text?: unknown; image?: unknown; images?: unknown; action?: unknown; key?: unknown; label?: unknown; question?: unknown; target?: unknown; model?: unknown; effort?: unknown; fast?: unknown; accountId?: unknown };
  try {
    body = (await req.json()) as {
      pid?: unknown;
      path?: unknown;
      conversationId?: unknown;
      clientMessageId?: unknown;
      operationId?: unknown;
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
      accountId?: unknown;
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
  if ((CONVERSATION_ACTIONS as readonly string[]).includes(explicitAction)) {
    if (explicitAction === "dialog-key") {
      const clientMessageId = typeof body.clientMessageId === "string" ? body.clientMessageId.trim().slice(0, 128) : "";
      const target = { pid, hasPid, filePath, conversationId };
      try {
        await recordAuthorizedOperatorActivity(
          req,
          target,
          clientMessageId ? { idempotencyKey: clientMessageId } : {},
        );
      } catch (error) {
        if (error instanceof OperatorActivityTargetConflictError) {
          return NextResponse.json({ error: error.message }, { status: 409 });
        }
        return NextResponse.json({ error: "direct operator activity could not be recorded" }, { status: 503 });
      }
    }
    const result = await applyConversationAction({
      conversationId,
      transcriptPath: filePath,
      action: explicitAction,
      /* #862: the caller owns operation identity for durable controls. Without
         it every HTTP retry of one user gesture would mint a fresh operation —
         and a second compaction — instead of replaying the first receipt. */
      ...(typeof body.operationId === "string" && body.operationId.trim()
        ? { operationId: body.operationId.trim() }
        : {}),
      key: typeof body.key === "string" ? body.key : "",
      label: body.label,
      question: body.question,
    });
    return NextResponse.json(result.body, { status: result.status });
  }

  const structuredControl = explicitAction === "reconfigure" && structuredHostsEnabled()
    ? await dispatchStructuredControl({
        path: filePath,
        conversationId,
        action: explicitAction,
        ...(explicitAction === "reconfigure" ? {
          reconfiguration: {
            model: typeof body.model === "string" ? body.model : undefined,
            effort: typeof body.effort === "string" ? body.effort : undefined,
            fast: typeof body.fast === "boolean" || body.fast === null ? body.fast : undefined,
            accountId: typeof body.accountId === "string" ? body.accountId : undefined,
          },
        } : {}),
      })
    : null;
  if (structuredControl) return NextResponse.json(structuredControl.body, { status: structuredControl.status });
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
  /* #1224: a general attachment is admitted against the same shared policy the
     composer refuses against, so an over-budget file is answered with the reason
     rather than dropped from the batch on its way through. Imported lazily: only
     a request that actually carries files touches the inbox module. */
  const rawFiles = (body as { files?: unknown }).files;
  const fileAdmission: InboxFileAdmissionResult = rawFiles === undefined || rawFiles === null
    ? { files: [], error: null }
    : (await import("@/lib/inboxFiles")).admitInboxFilePayload({ files: rawFiles });
  if (fileAdmission.error) {
    return NextResponse.json({ error: fileAdmission.error.error }, { status: fileAdmission.error.status });
  }
  if (!text.trim() && !images.length && !fileAdmission.files.length) {
    return NextResponse.json({ error: "empty message" }, { status: 400 });
  }

  /* #1117: message authorship declared by the caller — the in-process MCP
     bindings stamp their sends `agent` with the server-attributed sender role.
     Validated, never defaulted: a send without it stays unattributed. */
  const origin = parseMessageOrigin((body as { origin?: unknown }).origin);

  const clientMessageId = typeof body.clientMessageId === "string" ? body.clientMessageId.trim().slice(0, 128) : "";
  const operatorTarget = { pid, hasPid, filePath, conversationId };
  /* Stamped before the message is accepted, so the compare-and-clear below
     retires the set that was standing when the operator pressed send and
     leaves a fresher one — offered while this request was in flight — alone. */
  const acceptedAt = new Date();
  let operatorAction: AuthorizedOperatorAction;
  try {
    operatorAction = await recordAuthorizedOperatorActivity(
      req,
      operatorTarget,
      clientMessageId ? { idempotencyKey: clientMessageId } : {},
    );
  } catch (error) {
    if (error instanceof OperatorActivityTargetConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json({ error: "direct operator activity could not be recorded" }, { status: 503 });
  }
  /* #1202: the operator answered, so the drafts offered under the question are
     over — retired HERE, in the path that accepts their message, rather than by
     a pane that may be closed, unmounted or on another device. An agent's send
     through this same route is not an answer and leaves the set standing. */
  if (operatorAction.byOperator) {
    /* The client's own message id rides along: a delivery retried under the
       key it already used answers the question that was standing the FIRST
       time it was accepted, so the record clears against that moment and
       leaves whatever has been offered since alone. */
    retireReplySuggestionsOnOperatorMessage(operatorAction.conversationId, acceptedAt, clientMessageId);
  }

  /* The attachments hit disk HERE, after every early refusal above — a rejected
     request never orphans bytes — and the paths ride the delivered text the way
     `buildImagePayload` folds image paths in. The batch is keyed by the client's
     own message id, so a retried delivery rewrites the same paths instead of
     leaving a second copy behind. */
  let payloadText = text;
  let filePaths: string[] = [];
  if (fileAdmission.files.length) {
    const { buildFilePayload, inboxFileBatchToken } = await import("@/lib/inboxFiles");
    try {
      const bundle = buildFilePayload(text, fileAdmission.files, inboxFileBatchToken(clientMessageId));
      payloadText = bundle.payload;
      filePaths = bundle.filePaths;
    } catch (error) {
      return NextResponse.json({
        error: error instanceof Error ? error.message : "attachments could not be saved",
      }, { status: 500 });
    }
  }
  /* A TERMINALLY refused delivery leaves no bytes behind (#1224). A delivery
     that was accepted — including one held for a switch — keeps them, because
     the agent still has to open the path it was handed, and so does one whose
     fate could not be established: see `attachmentRetention.ts` for why "not
     ok" is the wrong key to hang a deletion on. */
  const releaseAttachments = async (outcome: AttachmentDeliveryOutcome): Promise<void> => {
    if (!filePaths.length || !attachmentsAreOrphaned(outcome)) return;
    (await import("@/lib/inboxFiles")).deleteInboxFiles(filePaths);
    filePaths = [];
  };
  const attachmentField = () => (filePaths.length ? { filePaths } : {});

  if (structuredHostsEnabled()) {
    const { enqueueStructuredMessage } = await import("@/lib/runtime/structuredMessageDelivery");
    const structured = await enqueueStructuredMessage({
      path: filePath,
      ...(conversationId ? { conversationId } : {}),
      ...(typeof body.clientMessageId === "string" ? { clientMessageId: body.clientMessageId.slice(0, 128) } : {}),
      text: payloadText.trim(),
      images,
      ...(origin ? { origin } : {}),
    });
    if (structured) {
      await releaseAttachments(structuredAttachmentOutcome(structured));
      const { status, ...response } = structured.ok ? { ...structured, status: 200 } : structured;
      return NextResponse.json({ ...response, ...attachmentField() }, { status });
    }
  }

  const outcome = await deliverConversationMessage({
    pid: hasPid ? pid : null,
    path: filePath,
    ...(conversationId ? { conversationId } : {}),
    ...(typeof body.clientMessageId === "string" ? { clientMessageId: body.clientMessageId.slice(0, 128) } : {}),
    text: payloadText,
    images,
    ...(origin ? { origin } : {}),
    // The "on resume" profile (issue #241 §4): honored only when this send
    // reopens a finished conversation; a live pane ignores it.
    ...(typeof body.model === "string" ? { resumeModel: body.model } : {}),
    ...(typeof body.effort === "string" ? { resumeEffort: body.effort } : {}),
    ...(typeof body.fast === "boolean" ? { resumeFast: body.fast } : {}),
  });
  /* `started` actuation is the uncertain case the image path also keeps: the
     agent may already hold the message, so its attachments stay readable. */
  await releaseAttachments(outcome.ok
    ? "accepted"
    : outcome.actuation === "started" ? "uncertain" : "refused");
  if (!outcome.ok) return respond(outcome);
  return NextResponse.json({ ...outcome, ...attachmentField() });
}
