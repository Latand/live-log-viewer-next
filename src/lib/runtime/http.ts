import { createHash } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";

import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { attachmentsAreOrphaned, structuredAttachmentOutcome, type AttachmentDeliveryOutcome } from "@/lib/attachmentRetention";
import { directOperatorActivityAuthority } from "@/lib/agent/operatorAuthority";
import { retireReplySuggestionsOnOperatorMessage } from "@/lib/suggestions/store";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { recordDirectOperatorWakatimeActivity } from "@/lib/wakatime/operatorActivity";

import { RuntimeHostUnavailableError, runtimeHostClient, type RuntimeHostClient } from "./client";
import { parseRuntimeCommand } from "./commands";
import { runtimePresentationReceipt, type RuntimeOperationKind } from "./contracts";
import { runtimeEventsEnabled, structuredHostsEnabled } from "./flags";
import { republishStructuredDeliveryHost } from "./structuredDeliveryController";
import { recoverDeadStructuredConversation } from "./structuredRecovery";
import { enqueueStructuredMessage } from "./structuredMessageDelivery";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";
import { admitRuntimeImagePayload } from "./runtimeImageAdmission";
import type { RuntimeImageUpload } from "./runtimeImageStore";
import type { StructuredImageRef } from "./structuredContent";

export interface RuntimeHttpDependencies {
  enabled(): boolean;
  client(): RuntimeHostClient | null;
  structuredEnabled?(): boolean;
  registry?(): AgentRegistry;
  enqueue?: typeof enqueueStructuredMessage;
  recordOperatorActivity?: typeof recordDirectOperatorWakatimeActivity;
  /** #1202: retires the conversation's reply drafts when the operator answers. */
  retireReplySuggestions?: typeof retireReplySuggestionsOnOperatorMessage;
  kick?(): void | Promise<void>;
}

const DEFAULT_DEPENDENCIES: RuntimeHttpDependencies = {
  enabled: runtimeEventsEnabled,
  client: runtimeHostClient,
  structuredEnabled: () => structuredHostsEnabled(),
  registry: agentRegistry,
  enqueue: enqueueStructuredMessage,
  recordOperatorActivity: recordDirectOperatorWakatimeActivity,
  retireReplySuggestions: retireReplySuggestionsOnOperatorMessage,
  kick: kickStructuredDeliveryQueue,
};

export interface RuntimeRetryHttpDependencies extends RuntimeHttpDependencies {
  kick(): void;
  recover?: typeof recoverDeadStructuredConversation;
  republish?(conversationId: string): Promise<boolean>;
}

async function republishStructuredConversation(conversationId: string): Promise<boolean> {
  if (!conversationId.startsWith("conversation_")) return false;
  const conversation = agentRegistry().conversation(conversationId as `conversation_${string}`);
  const generation = conversation?.generations.at(-1);
  if (!conversation || !generation) return false;
  return republishStructuredDeliveryHost({ engine: conversation.engine, sessionId: generation.id });
}

const DEFAULT_RETRY_DEPENDENCIES: RuntimeRetryHttpDependencies = {
  enabled: () => structuredHostsEnabled(),
  client: runtimeHostClient,
  kick: kickStructuredDeliveryQueue,
  republish: republishStructuredConversation,
};

function terminalRetryIdempotencyKey(operationId: string): string {
  return `retry_${createHash("sha256").update(operationId).digest("hex")}`;
}

/**
 * One send's general (non-image) attachments and the fate of the delivery they
 * rode with, threaded through the dispatch so the wrapper below can release
 * them on a TERMINAL refusal and only then (#1224). Kept as a handle rather
 * than a return value because every failure exit is a plain response, and the
 * response's status cannot tell a refusal apart from an uncertain delivery.
 */
interface CommandAttachments {
  filePaths: string[];
  /** Starts `refused`: every exit above the delivery attempt is terminal —
      nothing was ever handed over, so nothing can be reading these paths. */
  outcome: AttachmentDeliveryOutcome;
}

async function dispatchRuntimeCommand(
  request: NextRequest,
  kind: RuntimeOperationKind,
  dependencies: RuntimeHttpDependencies,
  attachments: CommandAttachments,
): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  if (!dependencies.enabled()) return NextResponse.json({ error: "runtime events are disabled" }, { status: 503 });
  if (!(dependencies.structuredEnabled ?? (() => structuredHostsEnabled()))()) {
    return NextResponse.json({ error: "structured hosts are disabled" }, { status: 503 });
  }
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  let command;
  let rawImages: RuntimeImageUpload[] | null = null;
  try {
    let parseValue = value;
    if ((kind === "send" || kind === "steer") && value && typeof value === "object" && !Array.isArray(value)) {
      const body = value as Record<string, unknown>;
      if (Array.isArray(body.images) && body.images.some((image) => image && typeof image === "object" && "base64" in image)) {
        const admitted = admitRuntimeImagePayload({ images: body.images });
        if (admitted.error) return NextResponse.json({ error: admitted.error.error }, { status: admitted.error.status });
        rawImages = admitted.images;
        const admissionRefs: StructuredImageRef[] = rawImages.map((image) => {
          const data = Buffer.from(image.base64, "base64");
          return {
            sha256: crypto.createHash("sha256").update(data).digest("hex"),
            mime: image.mime as StructuredImageRef["mime"],
            bytes: data.byteLength,
          };
        });
        parseValue = { ...body, images: admissionRefs };
      }
      /* #1224: general attachments take the by-path road instead of the
         base64-into-the-turn one — the bytes land in the viewer inbox and their
         paths are folded into the text the agent receives, so a document needs
         no engine image capability at all. Folded BEFORE the command is parsed,
         because an attachment-only send has no text of its own to validate. */
      if (body.files !== undefined && body.files !== null) {
        const { admitInboxFilePayload, buildFilePayload, inboxFileBatchToken } = await import("@/lib/inboxFiles");
        const admittedFiles = admitInboxFilePayload({ files: body.files });
        if (admittedFiles.error) {
          return NextResponse.json({ error: admittedFiles.error.error }, { status: admittedFiles.error.status });
        }
        /* The uploaded bytes never reach `parseRuntimeCommand`. Its 256 KiB
           ceiling bounds the COMMAND — and by this point the attachment is on
           disk and represented by a path, so leaving the base64 on the object
           would refuse every document past ~190 KB with an error naming neither
           the file nor the real limit. The images branch above reduces its own
           payload to refs for exactly this reason. */
        const parsed: Record<string, unknown> = { ...(parseValue as Record<string, unknown>) };
        delete parsed.files;
        if (admittedFiles.files.length) {
          const bundle = buildFilePayload(
            typeof parsed.text === "string" ? parsed.text : "",
            admittedFiles.files,
            inboxFileBatchToken(typeof body.idempotencyKey === "string" ? body.idempotencyKey : null),
          );
          attachments.filePaths = bundle.filePaths;
          parsed.text = bundle.payload;
        }
        parseValue = parsed;
      }
    }
    command = parseRuntimeCommand(kind, parseValue);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "runtime command is invalid" }, { status: 400 });
  }
  const client = dependencies.client();
  try {
    const byOperator = directOperatorActivityAuthority(request).ok;
    if ((command.kind === "send" || command.kind === "steer" || command.kind === "answer")
      && byOperator
      && dependencies.recordOperatorActivity) {
      try {
        dependencies.recordOperatorActivity({
          conversationId: command.conversationId,
          idempotencyKey: command.idempotencyKey,
        });
      } catch {
        return NextResponse.json({ error: "direct operator activity could not be recorded" }, { status: 503 });
      }
    }
    /* #1202: the operator's own message retires the reply drafts offered under
       the question it answers. Done in the path that accepts the message, so a
       closed dock or a second device changes nothing, and compared against the
       moment of acceptance, so a set offered while this request was in flight
       survives it. */
    if ((command.kind === "send" || command.kind === "steer") && byOperator) {
      /* Keyed by the command's own idempotency key, so a re-delivery of the
         same message clears against its first admission rather than against
         the clock of the retry — which would retire drafts offered in
         between, under a question this message never answered. */
      (dependencies.retireReplySuggestions ?? retireReplySuggestionsOnOperatorMessage)(
        command.conversationId,
        new Date(),
        command.idempotencyKey,
      );
    }
    if ((command.kind === "send" || command.kind === "steer") && dependencies.enqueue) {
      /* In flight ⇒ the Viewer cannot say. Set BEFORE the call so an enqueue
         that throws mid-delivery keeps the attachments too (#1224). */
      attachments.outcome = "uncertain";
      const admitted = await dependencies.enqueue({
        path: "",
        conversationId: command.conversationId,
        clientMessageId: command.idempotencyKey,
        ...(command.operationId ? { operationId: command.operationId } : {}),
        kind: command.kind,
        ...(command.policy ? { policy: command.policy } : {}),
        ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
        text: command.text,
        ...(rawImages ? { images: rawImages } : command.images?.length ? { imageRefs: command.images } : {}),
        ...(command.runtime ? { runtime: command.runtime } : {}),
        ...(command.selectedContext ? { selectedContext: command.selectedContext } : {}),
        /* #1117: this route is the operator's own composer surface, so
           authorship is stamped HERE, server-side — never read off the body. */
        origin: { kind: "operator" },
      }, {
        enabled: dependencies.structuredEnabled ?? (() => structuredHostsEnabled()),
        client: () => client,
        registry: dependencies.registry ?? agentRegistry,
        kick: dependencies.kick ?? kickStructuredDeliveryQueue,
      });
      if (admitted) {
        attachments.outcome = structuredAttachmentOutcome(admitted);
        if (!admitted.ok) {
          return NextResponse.json({
            error: admitted.error,
            ...(admitted.operationId ? { operationId: admitted.operationId } : {}),
            ...(admitted.receipt ? { receipt: admitted.receipt } : {}),
          }, { status: admitted.status });
        }
        /* #1131: a hold is an ACCEPTED send with a durable reservation behind
           it, so it answers with that reservation's operation id like every
           other acceptance. Without it this was the one admission a caller
           could never ask `message_receipt` about afterwards, which put
           `queued` back at the end of the story on the composer's own path. */
        if (admitted.outcome === "held") {
          return NextResponse.json({ held: true, operationId: admitted.operationId }, { status: 202 });
        }
        const status = admitted.receipt.status === "pending" || admitted.receipt.status === "queued" ? 202 : 200;
        return NextResponse.json({ operationId: admitted.operationId, receipt: admitted.receipt }, { status });
      }
      /* No structured ownership: nothing was delivered here, and the direct
         command below owns the fate from now on. */
      attachments.outcome = "refused";
    }
    if (!client) return NextResponse.json({ error: "runtime host socket is unavailable" }, { status: 503 });
    /* Same fence as the queue above: the command is on the wire, so its fate is
       unknown until it answers. A transport failure or an idempotency conflict
       lands in the catch below with the attachments intact — a conflict in
       particular means an earlier attempt under this key already holds them. */
    attachments.outcome = "uncertain";
    const result = await client.command(command);
    /* The host answered, so the command was handed over: the receipt's own
       status is the composer's business, not the inbox's. Bytes stay. */
    attachments.outcome = "accepted";
    if (result.receipt.status === "pending" || result.receipt.status === "queued") {
      dependencies.kick?.();
    }
    const status = result.receipt.status === "pending" || result.receipt.status === "queued" ? 202 : 200;
    return NextResponse.json({ operationId: result.operationId, receipt: result.receipt }, { status });
  } catch (error) {
    const status = error instanceof RuntimeHostUnavailableError && error.code === "idempotency-conflict" ? 409 : 503;
    return NextResponse.json({ error: error instanceof Error ? error.message : "runtime command failed" }, { status });
  }
}

/**
 * A runtime send/steer, with its attachments' retention attached to its fate:
 * a command TERMINALLY refused leaves no bytes in the inbox, and one that was
 * admitted — or one whose delivery could not be established — keeps them,
 * because the agent still has to open the path it was handed (#1224; see
 * `attachmentRetention.ts` for why "not ok" is the wrong key).
 */
export async function handleRuntimeCommand(
  request: NextRequest,
  kind: RuntimeOperationKind,
  dependencies: RuntimeHttpDependencies = DEFAULT_DEPENDENCIES,
): Promise<NextResponse> {
  const attachments: CommandAttachments = { filePaths: [], outcome: "refused" };
  const response = await dispatchRuntimeCommand(request, kind, dependencies, attachments);
  if (attachments.filePaths.length && attachmentsAreOrphaned(attachments.outcome)) {
    (await import("@/lib/inboxFiles")).deleteInboxFiles(attachments.filePaths);
  }
  return response;
}

export async function handleRuntimeRetry(
  request: NextRequest,
  operationId: string,
  dependencies: RuntimeRetryHttpDependencies = DEFAULT_RETRY_DEPENDENCIES,
): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  if (!dependencies.enabled()) return NextResponse.json({ error: "structured hosts are disabled" }, { status: 503 });
  if (!operationId || operationId.includes(":") || /\s/.test(operationId)) {
    return NextResponse.json({ error: "operationId is invalid" }, { status: 400 });
  }
  const client = dependencies.client();
  if (!client) return NextResponse.json({ error: "runtime host socket is unavailable" }, { status: 503 });
  try {
    let nextIdempotencyKey: string | undefined;
    const rawBody = await request.text();
    if (rawBody.trim()) {
      let value: { idempotencyKey?: unknown };
      try {
        const parsed = JSON.parse(rawBody) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
        }
        value = parsed as { idempotencyKey?: unknown };
      } catch {
        return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
      }
      if (value.idempotencyKey !== undefined) {
        if (typeof value.idempotencyKey !== "string"
          || !value.idempotencyKey.trim()
          || value.idempotencyKey.length > 200
          || /[\r\n]/.test(value.idempotencyKey)) {
          return NextResponse.json({ error: "idempotencyKey is invalid" }, { status: 400 });
        }
        nextIdempotencyKey = value.idempotencyKey;
      }
    }
    const previous = await client.operationStatus(operationId, { currentRetryLeaf: true });
    if (!previous) return NextResponse.json({ error: "operation not found" }, { status: 404 });
    if (previous.receipt.kind !== "send" && previous.receipt.kind !== "steer") {
      return NextResponse.json({ error: "runtime operation does not support retry" }, { status: 409 });
    }
    if (previous.receipt.status !== "failed" && previous.receipt.status !== "rejected") {
      if (previous.operationId !== operationId) {
        const status = previous.receipt.status === "pending"
          || previous.receipt.status === "queued"
          || previous.receipt.status === "delivering"
          ? 202
          : 200;
        if (status === 202) dependencies.kick();
        return NextResponse.json({
          operationId: previous.operationId,
          receipt: runtimePresentationReceipt(previous.receipt),
        }, { status });
      }
      return NextResponse.json({ error: "only terminal failed runtime operations can start a new attempt" }, { status: 409 });
    }
    nextIdempotencyKey ??= terminalRetryIdempotencyKey(previous.operationId);
    const recover = dependencies.recover ?? recoverDeadStructuredConversation;
    const recovered = await recover(
      { path: "", conversationId: previous.receipt.conversationId },
      { client },
    );
    if (!recovered || recovered.conversationId !== previous.receipt.conversationId) {
      return NextResponse.json({
        error: "structured recovery ownership is unavailable",
        retryable: true,
      }, { status: 503 });
    }
    await dependencies.republish?.(previous.receipt.conversationId);
    const retry = () => client.retryOperation(previous.operationId, nextIdempotencyKey, {
      requireHostedConversationId: previous.receipt.conversationId,
    });
    let result: Awaited<ReturnType<typeof retry>>;
    try {
      result = await retry();
    } catch (error) {
      if (!(error instanceof Error)
        || error.message !== "structured recovery ownership changed before retry admission") throw error;
      const converged = await recover(
        { path: "", conversationId: previous.receipt.conversationId },
        { client },
      );
      if (!converged || converged.conversationId !== previous.receipt.conversationId) {
        throw new Error("structured recovery ownership is unavailable");
      }
      await dependencies.republish?.(previous.receipt.conversationId);
      result = await retry();
    }
    dependencies.kick();
    return NextResponse.json({
      operationId: result.operationId,
      receipt: runtimePresentationReceipt(result.receipt),
    }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "runtime operation retry failed";
    let status = 503;
    if (error instanceof RuntimeHostUnavailableError && error.code === "idempotency-conflict") status = 409;
    else if (/unknown/.test(message)) status = 404;
    else if (/only failed|terminal failed|fresh idempotency|does not support/.test(message)) status = 409;
    const retryable = message === "structured recovery ownership changed before retry admission";
    return NextResponse.json({ error: message, ...(retryable ? { retryable: true } : {}) }, { status });
  }
}
