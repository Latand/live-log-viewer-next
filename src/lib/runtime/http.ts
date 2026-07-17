import { createHash } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";

import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

import { RuntimeHostUnavailableError, runtimeHostClient, type RuntimeHostClient } from "./client";
import { parseRuntimeCommand } from "./commands";
import { runtimePresentationReceipt, type RuntimeOperationKind } from "./contracts";
import { runtimeEventsEnabled } from "./flags";
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
  kick?(): void | Promise<void>;
}

const DEFAULT_DEPENDENCIES: RuntimeHttpDependencies = {
  enabled: runtimeEventsEnabled,
  client: runtimeHostClient,
  structuredEnabled: () => process.env.LLV_STRUCTURED_HOSTS === "1",
  registry: agentRegistry,
  enqueue: enqueueStructuredMessage,
  kick: kickStructuredDeliveryQueue,
};

export interface RuntimeRetryHttpDependencies extends RuntimeHttpDependencies {
  kick(): void;
  recover?: typeof recoverDeadStructuredConversation;
}

const DEFAULT_RETRY_DEPENDENCIES: RuntimeRetryHttpDependencies = {
  enabled: () => process.env.LLV_STRUCTURED_HOSTS === "1",
  client: runtimeHostClient,
  kick: kickStructuredDeliveryQueue,
};

function terminalRetryIdempotencyKey(operationId: string): string {
  return `retry_${createHash("sha256").update(operationId).digest("hex")}`;
}

export async function handleRuntimeCommand(
  request: NextRequest,
  kind: RuntimeOperationKind,
  dependencies: RuntimeHttpDependencies = DEFAULT_DEPENDENCIES,
): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  if (!dependencies.enabled()) return NextResponse.json({ error: "runtime events are disabled" }, { status: 503 });
  if (!(dependencies.structuredEnabled ?? (() => process.env.LLV_STRUCTURED_HOSTS === "1"))()) {
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
      }, {
        enabled: dependencies.structuredEnabled ?? (() => process.env.LLV_STRUCTURED_HOSTS === "1"),
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
    const recovered = await (dependencies.recover ?? recoverDeadStructuredConversation)(
      { path: "", conversationId: previous.receipt.conversationId },
      { client },
    );
    if (!recovered || recovered.conversationId !== previous.receipt.conversationId) {
      return NextResponse.json({
        error: "structured recovery ownership is unavailable",
        retryable: true,
      }, { status: 503 });
    }
    const result = await client.retryOperation(previous.operationId, nextIdempotencyKey, {
      requireHostedConversationId: previous.receipt.conversationId,
    });
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
