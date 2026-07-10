import { createHash } from "node:crypto";

import type { AppServerNotification, AppServerRequest } from "@/lib/accounts/codexAppServer";

import type { RuntimeAttentionRequest, RuntimeEventInput, RuntimeScope } from "./contracts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function eventKey(method: string, params: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(params ?? null)).digest("hex").slice(0, 24);
  return `codex:${method}:${digest}`;
}

function eventPayload(scope: RuntimeScope, notification: AppServerNotification): Record<string, unknown> {
  const payload = record(notification.params);
  const thread = record(payload.thread);
  const turn = record(payload.turn);
  const item = record(payload.item);
  if (notification.method === "turn/started" || notification.method === "turn/completed") {
    return {
      ...payload,
      conversationId: payload.conversationId,
      turnId: text(payload.turnId, turn.id),
      ...(notification.method === "turn/completed" ? { outcome: text(turn.status, payload.status) ?? "completed" } : {}),
    };
  }
  if (notification.method === "item/started" || notification.method === "item/completed") {
    return {
      ...payload,
      phase: notification.method.endsWith("started") ? "started" : "completed",
      itemId: text(payload.itemId, item.id),
      itemType: text(payload.itemType, item.type),
    };
  }
  if (notification.method === "thread/started") {
    return {
      ...payload,
      conversationId: scope.id,
      sessionKey: { engine: "codex", sessionId: text(payload.threadId, thread.id) ?? scope.id },
      hostKind: "codex-app-server",
      host: "hosted",
      turn: "idle",
      provenance: "structured",
      capabilities: { steer: true, structuredAttention: true },
    };
  }
  if (notification.method === "thread/status/changed") {
    const status = text(payload.status, thread.status);
    return {
      ...payload,
      conversationId: scope.id,
      host: "hosted",
      ...(status === "idle" ? { turn: "idle" } : status === "active" || status === "running" ? { turn: "running" } : {}),
      provenance: "structured",
    };
  }
  return payload;
}

/** Converts Codex protocol messages into the engine-neutral runtime vocabulary. */
export function normalizeCodexNotification(scope: RuntimeScope, notification: AppServerNotification): RuntimeEventInput | null {
  const kinds: Record<string, string> = {
    "thread/started": "session-status",
    "thread/status/changed": "session-status",
    "turn/started": "turn-started",
    "turn/completed": "turn-ended",
    "item/started": "item",
    "item/completed": "item",
    "account/rateLimits/updated": "limits",
  };
  const kind = kinds[notification.method];
  if (!kind) return null;
  return {
    scope,
    kind,
    payload: eventPayload(scope, notification),
    producer: {
      kind: "codex-app-server",
      ...((notification.method.startsWith("turn/") || notification.method.startsWith("item/")) ? { eventKey: eventKey(notification.method, notification.params) } : {}),
    },
  };
}

function attentionRequest(method: string, payload: Record<string, unknown>): RuntimeAttentionRequest {
  const item = record(payload.item);
  const command = text(payload.command, item.command);
  const tool = text(payload.tool, payload.toolName, item.type);
  const prompt = text(payload.prompt, payload.question);
  const request: RuntimeAttentionRequest = {};
  if (command) request.command = command;
  if (tool) request.tool = tool;
  if (prompt) request.question = { prompt };
  return request;
}

export function normalizeCodexRequest(scope: RuntimeScope, request: AppServerRequest): RuntimeEventInput {
  const payload = record(request.params);
  const turn = record(payload.turn);
  const attention = request.method.includes("requestApproval") ? "approval" : request.method.includes("requestUserInput") ? "question" : "permission";
  const id = `codex-${scope.id}-${String(request.id)}`;
  return {
    scope,
    kind: "attention",
    payload: {
      id,
      conversationId: scope.id,
      kind: attention,
      state: "open",
      unowned: false,
      createdAt: new Date().toISOString(),
      request: attentionRequest(request.method, payload),
      turnId: text(payload.turnId, turn.id),
      ...(typeof payload.autoResolutionMs === "number" ? { autoResolutionMs: payload.autoResolutionMs } : {}),
    },
    producer: { kind: "codex-app-server", eventKey: `codex-request:${scope.id}:${request.method}:${String(request.id)}` },
  };
}
