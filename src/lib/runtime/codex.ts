import type { AppServerNotification, AppServerRequest } from "@/lib/accounts/codexAppServer";

import type { RuntimeEventInput } from "./contracts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Converts protocol-version-specific app-server messages into journal vocabulary. */
export function normalizeCodexNotification(scope: RuntimeEventInput["scope"], notification: AppServerNotification): RuntimeEventInput | null {
  const payload = record(notification.params);
  const kinds: Record<string, string> = {
    "thread/started": "host.connected",
    "thread/status/changed": "session.status",
    "turn/started": "turn.started",
    "turn/completed": "turn.completed",
    "item/started": "item.started",
    "item/completed": "item.completed",
  };
  const kind = kinds[notification.method];
  return kind ? { scope, kind, payload, producerKey: `codex:${notification.method}:${String(payload.turnId ?? payload.itemId ?? payload.threadId ?? "unknown")}` } : null;
}

export function normalizeCodexRequest(scope: RuntimeEventInput["scope"], request: AppServerRequest): RuntimeEventInput {
  const attention = request.method.includes("requestApproval") ? "approval" : request.method.includes("requestUserInput") ? "question" : "permission";
  return {
    scope,
    kind: "attention.requested",
    payload: { kind: attention, requestId: request.id, method: request.method, request: record(request.params) },
    producerKey: `codex-request:${String(request.id)}`,
  };
}
