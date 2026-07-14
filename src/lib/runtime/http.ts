import { NextRequest, NextResponse } from "next/server";

import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { rejectCrossOrigin } from "@/lib/sameOrigin";

import { RuntimeHostUnavailableError, runtimeHostClient, type RuntimeHostClient } from "./client";
import { parseRuntimeCommand } from "./commands";
import type { RuntimeOperationKind } from "./contracts";
import { runtimeEventsEnabled } from "./flags";
import { enqueueStructuredMessage } from "./structuredMessageDelivery";
import { kickStructuredDeliveryQueue } from "./structuredDeliverySignal";

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
}

const DEFAULT_RETRY_DEPENDENCIES: RuntimeRetryHttpDependencies = {
  enabled: () => process.env.LLV_STRUCTURED_HOSTS === "1",
  client: runtimeHostClient,
  kick: kickStructuredDeliveryQueue,
};

export async function handleRuntimeCommand(
  request: NextRequest,
  kind: RuntimeOperationKind,
  dependencies: RuntimeHttpDependencies = DEFAULT_DEPENDENCIES,
): Promise<NextResponse> {
  const rejection = rejectCrossOrigin(request);
  if (rejection) return rejection;
  if (!dependencies.enabled()) return NextResponse.json({ error: "runtime events are disabled" }, { status: 503 });
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  let command;
  try {
    command = parseRuntimeCommand(kind, value);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "runtime command is invalid" }, { status: 400 });
  }
  const client = dependencies.client();
  if (!client) return NextResponse.json({ error: "runtime host socket is unavailable" }, { status: 503 });
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
        hasImages: Boolean(command.images?.length),
      }, {
        enabled: dependencies.structuredEnabled ?? (() => process.env.LLV_STRUCTURED_HOSTS === "1"),
        client: () => client,
        registry: dependencies.registry ?? agentRegistry,
        kick: dependencies.kick ?? kickStructuredDeliveryQueue,
      });
      if (admitted) {
        if (!admitted.ok) return NextResponse.json({ error: admitted.error }, { status: admitted.status });
        if (admitted.outcome === "held") return NextResponse.json({ held: true }, { status: 202 });
        const status = admitted.receipt.status === "pending" || admitted.receipt.status === "queued" ? 202 : 200;
        return NextResponse.json({ operationId: admitted.operationId, receipt: admitted.receipt }, { status });
      }
    }
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
    const result = await client.retryOperation(operationId);
    dependencies.kick();
    return NextResponse.json({ operationId: result.operationId, receipt: result.receipt }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "runtime operation retry failed";
    const status = /unknown/.test(message) ? 404 : /only failed|does not support/.test(message) ? 409 : 503;
    return NextResponse.json({ error: message }, { status });
  }
}
