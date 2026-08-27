import { createHash } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";

import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { directOperatorActivityAuthority } from "@/lib/agent/operatorAuthority";
import { retireReplySuggestionsOnOperatorMessage } from "@/lib/suggestions/store";
import { rejectCrossOrigin } from "@/lib/sameOrigin";
import { recordDirectOperatorWakatimeActivity } from "@/lib/wakatime/operatorActivity";

import { RuntimeHostUnavailableError, runtimeHostClient, type RuntimeHostClient } from "./client";
import { parseRuntimeCommand } from "./commands";
import { runtimePresentationReceipt, type RuntimeOperationKind, type RuntimeOperationReceipt, type RuntimeReceiptStatus } from "./contracts";
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
 * The reason stamped on a delivery the operator gave up on (issue #1213).
 *
 * A structured send is handed over only at a turn boundary, so an admitted
 * message can sit `queued` — with a `delivery-uncertain` reservation behind it
 * — for as long as the host stays inside a turn. Nothing terminalizes that
 * while the conversation is live: the reaper's stale-delivery convergence skips
 * live conversations and the controller only settles a reservation whose
 * receipt already went terminal. This reason is the operator taking ownership.
 */
export const DELIVERY_UNCONFIRMED_REASON = "delivery-unconfirmed";

/** Statuses the journal will not transition out of. Mirrors the client model's
    `receiptIsTerminal`; kept here so the server path carries no UI import. */
const TERMINAL_RECEIPT_STATUSES: ReadonlySet<RuntimeReceiptStatus> = new Set([
  "delivered", "applied", "answered", "rejected", "failed", "interrupted",
]);

function receiptIsTerminal(status: RuntimeReceiptStatus): boolean {
  return TERMINAL_RECEIPT_STATUSES.has(status);
}

/**
 * Statuses in which the hand-over to the agent has already begun (issue #1213).
 *
 * The delivery queue writes `delivering` BEFORE it calls `host.send`, and only
 * writes `delivered` after the engine answers. Failing the operation inside
 * that window would retire the durable effect while the message is already on
 * its way: the agent receives it, the real delivery can no longer record itself
 * because its operation is settled, and a replacement send delivers the same
 * message a second time. Nothing on this side of the wire can un-send it, so
 * abandon refuses here and says so. The window is owned — the queue always
 * writes an outcome — so refusing strands nothing.
 */
const HANDOVER_RECEIPT_STATUSES: ReadonlySet<RuntimeReceiptStatus> = new Set(["delivering", "applying"]);

function receiptIsHandingOver(status: RuntimeReceiptStatus): boolean {
  return HANDOVER_RECEIPT_STATUSES.has(status);
}

/** What an abandon attempt did. `handing-over` and `settled` both mean nothing
    was written and the caller must NOT mint a replacement. */
type AbandonOutcome =
  | { outcome: "abandoned"; receipt: RuntimeOperationReceipt }
  | { outcome: "settled"; receipt: RuntimeOperationReceipt }
  | { outcome: "handing-over"; receipt: RuntimeOperationReceipt };

function handoverResponse(operationId: string, receipt: RuntimeOperationReceipt): NextResponse {
  return NextResponse.json({
    error: "runtime delivery is being handed over to the agent",
    handover: true,
    operationId,
    receipt: runtimePresentationReceipt(receipt),
  }, { status: 409 });
}

/**
 * Terminalizes an unconfirmed send/steer so it can never be handed over later.
 *
 * `transitionOperation(…, "failed")` marks the operation's outbox row completed
 * in the SAME journal transaction that writes the failed receipt, so the
 * delivery queue can no longer drain the effect — which is exactly what makes a
 * following retry unable to duplicate the message. The journal refuses the
 * transition once the operation has settled, so a delivery that landed while
 * the operator was reading the screen wins the race: this returns the settled
 * receipt untouched and the caller must not retry.
 *
 * A hand-over already under way is refused outright — see
 * {@link HANDOVER_RECEIPT_STATUSES}.
 */
async function abandonUnconfirmedOperation(
  client: RuntimeHostClient,
  operationId: string,
  registry: (() => AgentRegistry) | undefined,
  current: RuntimeOperationReceipt,
): Promise<AbandonOutcome> {
  if (receiptIsHandingOver(current.status)) return { outcome: "handing-over", receipt: current };
  let result;
  try {
    result = await client.transitionOperation(operationId, "failed", { reason: DELIVERY_UNCONFIRMED_REASON });
  } catch (error) {
    /* A transition can fail because the operation settled first — the race the
       operator is allowed to lose — or because the journal itself faulted. Only
       a receipt that is genuinely terminal proves the former; anything else is
       an error, and reporting it as "the delivery landed" would tell the
       operator their message arrived when nobody knows that. */
    const settled = await client.operationStatus(operationId, { currentRetryLeaf: true });
    if (!settled || !receiptIsTerminal(settled.receipt.status)) throw error;
    return { outcome: "settled", receipt: settled.receipt };
  }
  const conversationId = result.receipt.conversationId;
  if (conversationId.startsWith("conversation_")) {
    /* The reservation the composer is rendering settles with the receipt. The
       delivery controller's own transition wrapper is not in this path, so the
       registry write belongs here. */
    try {
      (registry ?? agentRegistry)().recordDeliveryOutcomeForOperation(
        conversationId as `conversation_${string}`,
        result.receipt.presentationOperationId ?? operationId,
        "failed",
        DELIVERY_UNCONFIRMED_REASON,
      );
    } catch (error) {
      console.error("[runtime abandon] held delivery did not settle with its receipt", { operationId, error });
    }
  }
  return { outcome: "abandoned", receipt: result.receipt };
}

/**
 * Discard: the operator's exit from a delivery that never arrived (#1213).
 *
 * Idempotent by construction — an operation that already settled is reported
 * as it stands and nothing is written, so pressing Discard on a message that
 * landed a moment ago cannot unsay the delivery.
 */
export async function handleRuntimeAbandon(
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
    const previous = await client.operationStatus(operationId, { currentRetryLeaf: true });
    if (!previous) return NextResponse.json({ error: "operation not found" }, { status: 404 });
    if (previous.receipt.kind !== "send" && previous.receipt.kind !== "steer") {
      return NextResponse.json({ error: "runtime operation does not support discard" }, { status: 409 });
    }
    if (receiptIsTerminal(previous.receipt.status)) {
      return NextResponse.json({
        operationId: previous.operationId,
        receipt: runtimePresentationReceipt(previous.receipt),
      });
    }
    const abandoned = await abandonUnconfirmedOperation(
      client,
      previous.operationId,
      dependencies.registry,
      previous.receipt,
    );
    if (abandoned.outcome === "handing-over") return handoverResponse(previous.operationId, abandoned.receipt);
    return NextResponse.json({
      operationId: previous.operationId,
      receipt: runtimePresentationReceipt(abandoned.receipt),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "runtime operation discard failed";
    return NextResponse.json({ error: message }, { status: /unknown/.test(message) ? 404 : 503 });
  }
}

export async function handleRuntimeCommand(
  request: NextRequest,
  kind: RuntimeOperationKind,
  dependencies: RuntimeHttpDependencies = DEFAULT_DEPENDENCIES,
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
        if (!admitted.ok) {
          return NextResponse.json({
            error: admitted.error,
            ...(admitted.operationId ? { operationId: admitted.operationId } : {}),
            ...(admitted.receipt ? { receipt: admitted.receipt } : {}),
          }, { status: admitted.status });
        }
        if (admitted.outcome === "held") return NextResponse.json({ held: true }, { status: 202 });
        const status = admitted.receipt.status === "pending" || admitted.receipt.status === "queued" ? 202 : 200;
        return NextResponse.json({ operationId: admitted.operationId, receipt: admitted.receipt }, { status });
      }
    }
    if (!client) return NextResponse.json({ error: "runtime host socket is unavailable" }, { status: 503 });
    const result = await client.command(command);
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
    let abandonUnconfirmed = false;
    const rawBody = await request.text();
    if (rawBody.trim()) {
      let value: { idempotencyKey?: unknown; abandonUnconfirmed?: unknown };
      try {
        const parsed = JSON.parse(rawBody) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
        }
        value = parsed as { idempotencyKey?: unknown; abandonUnconfirmed?: unknown };
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
      if (value.abandonUnconfirmed !== undefined) {
        if (typeof value.abandonUnconfirmed !== "boolean") {
          return NextResponse.json({ error: "abandonUnconfirmed is invalid" }, { status: 400 });
        }
        abandonUnconfirmed = value.abandonUnconfirmed;
      }
    }
    let previous = await client.operationStatus(operationId, { currentRetryLeaf: true });
    if (!previous) return NextResponse.json({ error: "operation not found" }, { status: 404 });
    if (previous.receipt.kind !== "send" && previous.receipt.kind !== "steer") {
      return NextResponse.json({ error: "runtime operation does not support retry" }, { status: 409 });
    }
    /* The operator's exit from an unconfirmed delivery (issue #1213): abandon
       the parked attempt BEFORE minting a replacement, so the durable effect is
       retired first and only one copy of the message stays deliverable. A
       delivery that landed in the meantime refuses the transition and is
       reported as delivered — the retry never happens. */
    if (abandonUnconfirmed && previous.receipt.status !== "failed" && previous.receipt.status !== "rejected") {
      /* A message that landed while the operator was reading the screen is not
         an error to raise at them — it is the answer to what they asked. */
      if (receiptIsTerminal(previous.receipt.status)) {
        return NextResponse.json({
          operationId: previous.operationId,
          receipt: runtimePresentationReceipt(previous.receipt),
        });
      }
      const outcome = await abandonUnconfirmedOperation(
        client,
        previous.operationId,
        dependencies.registry,
        previous.receipt,
      );
      /* Nothing was written in either of these: a message already on its way to
         the agent cannot be un-sent, and one that landed while the operator was
         reading the screen is the answer to what they asked. Minting a
         replacement in either case is how the same message arrives twice. */
      if (outcome.outcome === "handing-over") return handoverResponse(previous.operationId, outcome.receipt);
      if (outcome.outcome === "settled") {
        return NextResponse.json({
          operationId: previous.operationId,
          receipt: runtimePresentationReceipt(outcome.receipt),
        });
      }
      previous = { operationId: previous.operationId, receipt: outcome.receipt, replayed: false };
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
