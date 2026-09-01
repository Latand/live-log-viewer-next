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
import { runtimeEventsEnabled, runtimeEventsRolledBack, structuredHostsEnabled, RUNTIME_PLANE_ABSENT } from "./flags";
import { readEvidence, type Evidence } from "./evidence";
import { journalVerdict, resolveSendReceipt, runtimeReceiptForSend, SEND_DISCARDED_REASON, sendReceiptFor, type SendReceipt } from "./sendSettlement";
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
  /** Gives the id this route is about to hand back a durable record of its own
      (#1131), so the caller holding it can be answered during a runtime outage
      and the settlement deadline can end it. Defaulted at the call site rather
      than in the dependency literal, because a caller that supplies its own
      dependencies must not silently opt the settlement record out. */
  recordRetryAttempt?(previousOperationId: string, retryOperationId: string): boolean;
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

function recordDeliveryRetryAttempt(previousOperationId: string, retryOperationId: string): boolean {
  return agentRegistry().recordDeliveryRetryAttempt(previousOperationId, retryOperationId);
}

function terminalRetryIdempotencyKey(operationId: string): string {
  return `retry_${createHash("sha256").update(operationId).digest("hex")}`;
}

/**
 * The refusal that keeps a retry id from leaving this process without a durable
 * row behind it (#1131).
 *
 * Retryable, and honestly so: the attempt is admitted under its own idempotency
 * key, so the next call converges on the same leaf rather than admitting a
 * second one, and it persists the row this one could not.
 */
const RETRY_RECORD_UNAVAILABLE = "retry attempt could not be recorded durably";
const DISCARDABLE_RECEIPT_STATUSES = ["pending", "queued"] as const;

function retryRecordUnavailable(recorded: Evidence<boolean>): NextResponse {
  return NextResponse.json({
    error: recorded.readable ? RETRY_RECORD_UNAVAILABLE : recorded.reason,
    retryable: true,
  }, { status: 503 });
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
      /* No structured ownership. The direct command below used to own the fate
         from here, and for a SEND that is `queued` as a final answer by another
         road (#1131): the operation is admitted straight into the journal with
         no durable reservation behind it, so no receipt query can settle it and
         a lasting outage leaves it unqueryable as well as unexecuted. A send
         nothing owns is refused instead — the caller learns now, rather than
         holding an id that never becomes an answer. Controls are untouched:
         they carry no message and reserve nothing. */
      attachments.outcome = "refused";
      return NextResponse.json(
        { error: "structured delivery ownership is unavailable for this conversation" },
        { status: 503 },
      );
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

export interface RuntimeOperationQueryDependencies {
  client(): RuntimeHostClient | null;
  rolledBack(): boolean;
  /** The durable settlement for this id, read through the same client the
      journal half uses so both halves describe one runtime. */
  settle(operationId: string, client: RuntimeHostClient | null): Promise<SendReceipt | null>;
}

const DEFAULT_OPERATION_QUERY_DEPENDENCIES: RuntimeOperationQueryDependencies = {
  client: runtimeHostClient,
  rolledBack: () => runtimeEventsRolledBack(),
  settle: (operationId, client) => resolveSendReceipt(operationId, { client }),
};

/**
 * What became of one operation, from the two stores that can answer.
 *
 * #1131: this used to report the delivery journal's raw state and nothing else,
 * so an accepted send answered `queued` for as long as the outage lasted and
 * 503 once the socket was gone. It settles the durable record first now — and
 * settling first is also what stopped the two answers from being written in the
 * wrong order.
 *
 * ── THE CONSISTENCY RULE ──────────────────────────────────────────────────
 *
 * **A terminal durable settlement is authoritative once it is written.** The
 * journal is preferred everywhere else: while the send is still in flight, and
 * for every operation kind the durable record knows nothing about.
 *
 * It needs a rule because the two stores can be terminal in one and open in the
 * other, by design. Settlement deliberately writes the record when the journal
 * READ succeeds and the fence WRITE fails — a host whose reads work and whose
 * writes do not must not make `queued` permanent — and in that supported half
 * outage the journal still holds the operation open. Preferring the journal
 * unconditionally answered `send: failed` beside `receipt: queued`: one query,
 * two contradictory answers, and the caller left to guess which one is safe to
 * act on. Once an answer has been settled and handed out it has to stay the
 * answer, so the settled record wins and the journal's open status is not
 * reported beside it. Nothing is lost by that: the delivery queue reads the
 * same record before it actuates anything, so the operation the journal still
 * shows as open will not be delivered later either.
 */
export async function handleRuntimeOperationQuery(
  operationId: string,
  dependencies: RuntimeOperationQueryDependencies = DEFAULT_OPERATION_QUERY_DEPENDENCIES,
): Promise<NextResponse> {
  if (dependencies.rolledBack()) {
    return NextResponse.json(
      { error: "runtime events are disabled", code: RUNTIME_PLANE_ABSENT },
      { status: 503 },
    );
  }
  if (!operationId || operationId.includes(":") || /\s/.test(operationId)) {
    return NextResponse.json({ error: "operationId is invalid" }, { status: 400 });
  }
  const client = dependencies.client();
  /* The authoritative store, and a FAILABLE read of it. A settlement that could
     not be read is not a send that was never settled: answering the journal's
     still-open status from here would re-open an answer this endpoint may
     already have handed out as terminal, so an unreadable record ends the query
     rather than being converted into `queued`. */
  const settlement = await readEvidence(
    () => dependencies.settle(operationId, client),
    "delivery settlement is unavailable",
  );
  const send = settlement.readable ? settlement.value : null;
  /* The rule above, applied before anything can contradict it. */
  if (send && send.state !== "in-flight") {
    return NextResponse.json({ operationId, receipt: runtimeReceiptForSend(send), send });
  }
  /* An absent plane and an unreachable one stay distinct answers: only the
     first carries the code, and reporting a dead socket as a rolled-back plane
     is what makes an outage look like a configuration. */
  let unreachable: string | null = null;
  if (client) {
    try {
      const result = await client.operationStatus(operationId);
      /* A journal answer that is itself TERMINAL is proof on its own, and the
         record is projected from it, so the two cannot disagree about it. An
         open one can, which is exactly the case the unreadable record has to
         stop. */
      if (result && (settlement.readable || journalVerdict(result.receipt.status, result.receipt.reason))) {
        return NextResponse.json({
          operationId: result.operationId,
          receipt: result.receipt,
          ...(send ? { send } : {}),
        });
      }
    } catch (error) {
      unreachable = error instanceof Error ? error.message : "runtime host is unavailable";
    }
  }
  /* The journal could not answer. The durable delivery record still can, and
     for an accepted send that is the whole point of settling it there. */
  if (send) return NextResponse.json({ operationId, receipt: runtimeReceiptForSend(send), send });
  if (!settlement.readable) {
    /* Neither store gave a usable answer, and one of them was never read. That
       is not an operation nobody admitted, so it must not be answered as one. */
    return NextResponse.json({ error: settlement.reason, retryable: true }, { status: 503 });
  }
  if (unreachable) return NextResponse.json({ error: unreachable }, { status: 503 });
  if (!client) {
    return NextResponse.json(
      { error: "runtime host socket is unavailable", code: RUNTIME_PLANE_ABSENT },
      { status: 503 },
    );
  }
  return NextResponse.json({ error: "operation not found" }, { status: 404 });
}

export async function handleRuntimeDiscard(
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
    const current = await readEvidence(
      () => client.operationStatus(operationId, { currentRetryLeaf: true }),
      "runtime operation status is unavailable",
    );
    if (!current.readable) return NextResponse.json({ error: current.reason, retryable: true }, { status: 503 });
    if (!current.value) return NextResponse.json({ error: "operation not found" }, { status: 404 });
    let operation = current.value;
    if (operation.receipt.kind !== "send" && operation.receipt.kind !== "steer") {
      return NextResponse.json({ error: "runtime operation does not support discard" }, { status: 409 });
    }
    if (!operation.receipt.conversationId.startsWith("conversation_")) {
      return NextResponse.json({ error: "runtime operation has no delivery reservation" }, { status: 409 });
    }
    const registry = (dependencies.registry ?? agentRegistry)();
    const presentationOperationId = operation.receipt.presentationOperationId ?? operation.operationId;
    const deliveryRecord = sendReceiptFor(registry.readOnlySnapshot(), presentationOperationId);
    const settleDelivered = () => {
      if (operation.receipt.conversationId.startsWith("conversation_")) {
        registry.recordDeliveryOutcomeForOperation(
          operation.receipt.conversationId as `conversation_${string}`,
          operation.receipt.presentationOperationId ?? operation.operationId,
          "delivered",
        );
      }
      return NextResponse.json({
        operationId: operation.operationId,
        receipt: runtimePresentationReceipt(operation.receipt),
      });
    };
    if (journalVerdict(operation.receipt.status, operation.receipt.reason)?.state === "delivered") return settleDelivered();
    if (operation.receipt.status === "delivering" || operation.receipt.status === "applying") {
      return NextResponse.json({
        error: "runtime delivery is being handed over to the agent",
        operationId: operation.operationId,
        receipt: runtimePresentationReceipt(operation.receipt),
      }, { status: 409 });
    }
    let disposition: "lost" | "unverified" = "unverified";
    if (operation.receipt.status === "pending" || operation.receipt.status === "queued") {
      try {
        operation = await client.transitionOperation(
          operation.operationId,
          "failed",
          { reason: SEND_DISCARDED_REASON },
          { fromStatuses: DISCARDABLE_RECEIPT_STATUSES },
        );
        if (deliveryRecord?.duplicateRisk !== true) disposition = "lost";
      } catch (error) {
        if (error instanceof Error && /runtime delivery (?:discard|retry) already won/.test(error.message)) {
          throw error;
        }
        const moved = await client.operationStatus(operation.operationId);
        if (!moved) throw error;
        operation = moved;
        if (journalVerdict(operation.receipt.status, operation.receipt.reason)?.state === "delivered") return settleDelivered();
        if (operation.receipt.status === "delivering" || operation.receipt.status === "applying") {
          return NextResponse.json({
            error: "runtime delivery is being handed over to the agent",
            operationId: operation.operationId,
            receipt: runtimePresentationReceipt(operation.receipt),
          }, { status: 409 });
        }
        if (operation.receipt.status !== "uncertain"
          && !(operation.receipt.status === "failed" && operation.receipt.reason === SEND_DISCARDED_REASON)) {
          throw error;
        }
      }
    } else if (operation.receipt.status !== "uncertain"
      && !(operation.receipt.status === "failed" && operation.receipt.reason === SEND_DISCARDED_REASON)
      && !(deliveryRecord?.state === "failed" && deliveryRecord.duplicateRisk)) {
      return NextResponse.json({ error: "delivery outcome is already resolved" }, { status: 409 });
    } else {
      const claim = await client.claimDeliveryAction(operation.operationId, "discard");
      if (claim.winner !== "discard") {
        return NextResponse.json({
          error: `runtime delivery ${claim.winner} already won; discard refused`,
        }, { status: 409 });
      }
    }
    registry.discardDeliveryForOperation(
      operation.receipt.conversationId as `conversation_${string}`,
      presentationOperationId,
      SEND_DISCARDED_REASON,
      disposition,
    );
    const settled = sendReceiptFor(registry.readOnlySnapshot(), presentationOperationId);
    if (!settled || settled.state !== "failed" || settled.reason !== SEND_DISCARDED_REASON) {
      return NextResponse.json({
        error: "delivery discard could not be recorded durably",
        retryable: true,
      }, { status: 503 });
    }
    const receipt = runtimeReceiptForSend(settled);
    return NextResponse.json({
      operationId: presentationOperationId,
      receipt: {
        ...receipt,
        ...(operation.receipt.text ? { text: operation.receipt.text } : {}),
      },
      send: settled,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "runtime operation discard failed";
    const status = /unknown/.test(message)
      ? 404
      : /runtime delivery (?:discard|retry) already won|cannot discard after|moved before its transition/.test(message)
        ? 409
        : 503;
    return NextResponse.json({ error: message }, { status });
  }
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
    let action: "retry-uncertain" | undefined;
    const rawBody = await request.text();
    if (rawBody.trim()) {
      let value: { idempotencyKey?: unknown; action?: unknown };
      try {
        const parsed = JSON.parse(rawBody) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
        }
        value = parsed as { idempotencyKey?: unknown; action?: unknown };
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
      if (value.action !== undefined) {
        if (value.action !== "retry-uncertain") {
          return NextResponse.json({ error: "runtime retry action is invalid" }, { status: 400 });
        }
        action = value.action;
      }
      if (action && nextIdempotencyKey) {
        return NextResponse.json({ error: "uncertain retry keeps the original idempotency key" }, { status: 400 });
      }
    }
    const recordRetryAttempt = dependencies.recordRetryAttempt ?? recordDeliveryRetryAttempt;
    /* The attempt this call is about, and a FAILABLE read of it. Only a read
       that COMPLETED and found nothing may answer `operation not found`: the
       catch below classifies by message, and an outage whose message happens to
       carry the journal's word for a missing operation would otherwise tell a
       caller its send never existed. Unreadable ends the call retryably. */
    const status = await readEvidence(
      () => client.operationStatus(operationId, { currentRetryLeaf: true }),
      "runtime operation status is unavailable",
    );
    if (!status.readable) return NextResponse.json({ error: status.reason, retryable: true }, { status: 503 });
    let previous = status.value;
    if (!previous) return NextResponse.json({ error: "operation not found" }, { status: 404 });
    if (previous.receipt.kind !== "send" && previous.receipt.kind !== "steer") {
      return NextResponse.json({ error: "runtime operation does not support retry" }, { status: 409 });
    }
    if (previous.receipt.status === "failed" && previous.receipt.reason === SEND_DISCARDED_REASON) {
      const claim = await client.claimDeliveryAction(previous.operationId, "retry");
      return NextResponse.json({
        error: `runtime delivery ${claim.winner} already won; retry refused`,
      }, { status: 409 });
    }
    const registry = (dependencies.registry ?? agentRegistry)();
    const deliverySnapshot = registry.readOnlySnapshot();
    const deliveryRecord = sendReceiptFor(deliverySnapshot, previous.operationId);
    if (previous.operationId === operationId
      && previous.receipt.status !== "failed"
      && previous.receipt.status !== "rejected"
      && deliveryRecord?.state === "failed"
      && deliveryRecord.resend === "safe") {
      /* A migration can cancel a held, never-actuated reservation while its
         journal operation still reads queued. The durable record proves a
         resend is safe, so fence the stale journal operation before asking it
         to mint the fresh attempt. Unknown-fate deliveries never enter here. */
      previous = await client.transitionOperation(operationId, "failed", { reason: deliveryRecord.reason });
    }
    if (deliveryRecord?.reason === SEND_DISCARDED_REASON) {
      return NextResponse.json({ error: "discarded runtime operations cannot retry" }, { status: 409 });
    }
    /* Only the composer's explicit unknown-fate action authorizes this path.
       Durable ambiguity identifies which identity must be preserved; it cannot
       act as retry authority by itself. */
    if (action === "retry-uncertain") {
      if (previous.operationId !== operationId) {
        return NextResponse.json({ error: "uncertain retry must target its original operation" }, { status: 409 });
      }
      if (previous.receipt.status === "delivering" || previous.receipt.status === "applying") {
        return NextResponse.json({
          error: "runtime delivery is being handed over to the agent",
          operationId,
          receipt: runtimePresentationReceipt(previous.receipt),
        }, { status: 409 });
      }
      if (!deliveryRecord) {
        return NextResponse.json({ error: "runtime operation has no delivery reservation" }, { status: 409 });
      }
      if (deliveryRecord.state === "delivered"
        || (deliveryRecord.state === "failed" && deliveryRecord.resend !== "verify-first")) {
        return NextResponse.json({
          operationId,
          receipt: runtimeReceiptForSend(deliveryRecord),
          send: deliveryRecord,
        });
      }
      const claim = await client.claimDeliveryAction(operationId, "retry");
      if (claim.winner !== "retry") {
        return NextResponse.json({
          error: `runtime delivery ${claim.winner} already won; retry refused`,
        }, { status: 409 });
      }
      const reservation = registry.retryUncertainDeliveryForOperation(operationId);
      if (!reservation) {
        return NextResponse.json({ error: "runtime operation has no delivery reservation" }, { status: 409 });
      }
      if (reservation.state === "delivered" || reservation.state === "failed") {
        const settled = sendReceiptFor(registry.readOnlySnapshot(), operationId);
        if (settled) {
          return NextResponse.json({ operationId, receipt: runtimeReceiptForSend(settled), send: settled });
        }
        return NextResponse.json({ error: "delivery outcome is already resolved" }, { status: 409 });
      }
      if (reservation.state === "assigned" && reservation.generationId) {
        const claimed = registry.beginDeliveryAttempt(reservation.id, reservation.generationId);
        if (!claimed) {
          return NextResponse.json({
            error: "delivery reservation ownership changed before retry admission",
            retryable: true,
          }, { status: 503 });
        }
      }
      let result = previous;
      if (previous.receipt.status !== "pending" && previous.receipt.status !== "queued") {
        result = await client.retryOperation(operationId);
      }
      dependencies.kick();
      return NextResponse.json({
        operationId,
        receipt: runtimePresentationReceipt(result.receipt),
      }, { status: 202 });
    }
    if (previous.receipt.status !== "failed" && previous.receipt.status !== "rejected") {
      if (previous.operationId !== operationId) {
        /* The network replay: an earlier call's response was lost, and the
           journal converges this one onto the SAME attempt. The id is still an
           id this response is handing out, so it needs the same durable row the
           fresh admission needs — this path used to return the leaf without
           persisting anything at all, so a lost response was enough to leave a
           caller holding an id no query and no deadline could ever settle. The
           record is idempotent: the row an earlier call wrote is the row this
           one finds. */
        const recorded = await readEvidence(
          () => recordRetryAttempt(previous.receipt.presentationOperationId ?? operationId, previous.operationId),
          RETRY_RECORD_UNAVAILABLE,
        );
        if (!recorded.readable || !recorded.value) return retryRecordUnavailable(recorded);
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
    /* Before the queue is kicked, and before the id leaves this process: the
       attempt gets a durable record keyed by the id the caller is handed
       (#1131). Without it that id named nothing — a query during a runtime
       outage found no record to answer from, no deadline could end it, and the
       delivery queue's own fence, which reads this record, had nothing to read.
       It starts non-terminal, so the attempt keeps its intended eligibility for
       one fresh execution; once the deadline settles it, the same fence is what
       stops a late recovery from delivering it after the caller was told it had
       not arrived.

       The write is failable and its result was ignored, which made the record
       best-effort and the id in the caller's hand an orphan whenever it did not
       land. A row that was not written and a row whose write could not be read
       are the same answer here: the id does not leave this process. The attempt
       itself is idempotent under its own key, so a caller that retries after
       this refusal converges on the same leaf through the replay path above and
       gets the id once the row exists. */
    const recorded = await readEvidence(
      () => recordRetryAttempt(previous.receipt.presentationOperationId ?? previous.operationId, result.operationId),
      RETRY_RECORD_UNAVAILABLE,
    );
    if (!recorded.readable || !recorded.value) return retryRecordUnavailable(recorded);
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
    else if (/only failed|terminal failed|fresh idempotency|does not support|runtime delivery (?:discard|retry) already won/.test(message)) status = 409;
    const retryable = message === "structured recovery ownership changed before retry admission";
    return NextResponse.json({ error: message, ...(retryable ? { retryable: true } : {}) }, { status });
  }
}
