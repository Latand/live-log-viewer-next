import type { RuntimeOperationCommand, RuntimeOperationKind } from "./contracts";

const MAX_OPERATION_BYTES = 256 * 1024;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("request body must be an object");
  return value as Record<string, unknown>;
}

function requiredId(value: unknown, name: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id || id.includes(":") || /\s/.test(id) || id.length > 200) throw new Error(`${name} is invalid`);
  return id;
}

function optionalId(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : requiredId(value, name);
}

function optionalNullableId(value: unknown, name: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  return requiredId(value, name);
}

function idempotency(body: Record<string, unknown>, operationId: string | undefined): string {
  return requiredId(body.idempotencyKey ?? operationId, "idempotencyKey");
}

export function parseRuntimeCommand(kind: RuntimeOperationKind, value: unknown): RuntimeOperationCommand {
  const body = object(value);
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_OPERATION_BYTES) throw new Error("request body exceeds 256 KiB");
  const conversationId = requiredId(body.conversationId, "conversationId");
  const operationId = optionalId(body.operationId, "operationId");
  const idempotencyKey = idempotency(body, operationId);
  const turnId = optionalNullableId(body.turnId, "turnId");

  if (kind === "send" || kind === "steer") {
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) throw new Error("text is required");
    const images = body.images === undefined ? undefined : body.images;
    if (images !== undefined && (!Array.isArray(images) || images.length > 16 || images.some((image) => typeof image !== "string"))) throw new Error("images are invalid");
    const policy = body.policy === undefined ? undefined : body.policy;
    if (policy !== undefined && policy !== "queue" && policy !== "steer-if-active") throw new Error("policy is invalid");
    return {
      kind,
      conversationId,
      ...(operationId ? { operationId } : {}),
      idempotencyKey,
      text,
      ...(images ? { images: images as string[] } : {}),
      ...(policy ? { policy } : {}),
      ...(turnId !== undefined ? { turnId } : {}),
    };
  }

  if (kind === "interrupt") {
    return {
      kind,
      conversationId,
      ...(operationId ? { operationId } : {}),
      idempotencyKey,
      ...(turnId !== undefined ? { turnId } : {}),
    };
  }

  if (kind === "kill") {
    const key = body.sessionKey;
    if (!key || typeof key !== "object" || Array.isArray(key)) throw new Error("sessionKey is invalid");
    const candidate = key as Record<string, unknown>;
    const engine = candidate.engine === "codex" || candidate.engine === "claude" ? candidate.engine : null;
    const sessionId = typeof candidate.sessionId === "string" ? candidate.sessionId.trim() : "";
    if (!engine || !sessionId || sessionId.includes(":") || /\s/.test(sessionId)) throw new Error("sessionKey is invalid");
    return {
      kind,
      conversationId,
      ...(operationId ? { operationId } : {}),
      idempotencyKey,
      sessionKey: { engine, sessionId },
    };
  }

  if (kind === "answer") {
    if (!("resolution" in body)) throw new Error("resolution is required");
    return {
      kind,
      conversationId,
      ...(operationId ? { operationId } : {}),
      idempotencyKey,
      attentionId: requiredId(body.attentionId, "attentionId"),
      resolution: body.resolution,
    };
  }

  const engine = body.engine === "codex" || body.engine === "claude" ? body.engine : null;
  if (!engine) throw new Error("engine is invalid");
  const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
  if (!cwd) throw new Error("spawn cwd is required");
  if (typeof body.prompt !== "string") throw new Error("prompt is required");
  const prompt = body.prompt.trim();
  const accountId = optionalNullableId(body.accountId, "accountId");
  const parentConversationId = optionalNullableId(body.parentConversationId, "parentConversationId");
  const sessionId = optionalNullableId(body.sessionId, "sessionId");
  return {
    kind,
    conversationId,
    ...(operationId ? { operationId } : {}),
    idempotencyKey,
    engine,
    cwd,
    prompt,
    ...(accountId !== undefined ? { accountId } : {}),
    ...(parentConversationId !== undefined ? { parentConversationId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}
