import { modelFromBody } from "@/lib/agent/models";

import type { RuntimeOperationCommand, RuntimeOperationKind, RuntimeReconfigureCommand, RuntimeSendSettings } from "./contracts";
import { parseStructuredImageRefs, structuredContent } from "./structuredContent";

const MAX_OPERATION_BYTES = 256 * 1024;

/** The optional per-turn runtime snapshot a send may carry (issue #390 §10).
    Model reuses the CLI-argument bounds; effort is a bounded lowercase tier
    token (the host/capability enforces the engine catalog). Absent = today. */
function parseRuntimeSendSettings(value: unknown): RuntimeSendSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("runtime settings are invalid");
  const body = value as Record<string, unknown>;
  const settings: RuntimeSendSettings = {};
  if (body.model !== undefined && body.model !== null && body.model !== "") {
    const parsed = modelFromBody({ model: body.model });
    if (parsed.error) throw new Error(parsed.error);
    if (parsed.model) settings.model = parsed.model;
  }
  if (body.effort !== undefined && body.effort !== null && body.effort !== "") {
    if (typeof body.effort !== "string") throw new Error("runtime effort must be a string");
    const effort = body.effort.trim().toLowerCase();
    if (!effort || effort.length > 32 || !/^[a-z]+$/.test(effort)) throw new Error("runtime effort is invalid");
    settings.effort = effort;
  }
  if (typeof body.fast === "boolean") settings.fast = body.fast;
  return Object.keys(settings).length ? settings : undefined;
}

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
    const images = body.images === undefined ? undefined : body.images;
    const imageRefs = images === undefined ? [] : parseStructuredImageRefs(images, 16);
    if (!imageRefs) throw new Error("images are invalid");
    const content = structuredContent(text, imageRefs);
    const policy = body.policy === undefined ? undefined : body.policy;
    if (policy !== undefined && policy !== "queue" && policy !== "steer-if-active" && policy !== "interrupt-active") {
      throw new Error("policy is invalid");
    }
    const runtime = parseRuntimeSendSettings(body.runtime);
    return {
      kind,
      conversationId,
      ...(operationId ? { operationId } : {}),
      idempotencyKey,
      text: content.content.text,
      ...(imageRefs.length ? { images: imageRefs } : {}),
      contentDigest: content.contentDigest,
      ...(policy ? { policy } : {}),
      ...(turnId !== undefined ? { turnId } : {}),
      ...(runtime ? { runtime } : {}),
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

  if (kind === "reconfigure") {
    const model = typeof body.model === "string" ? body.model.trim() : "";
    const effort = typeof body.effort === "string" ? body.effort.trim() : "";
    if (!model || model.length > 128 || /[\r\n\0]/.test(model)) throw new Error("reconfigure model is invalid");
    if (!effort || effort.length > 32 || !/^[a-z]+$/.test(effort)) throw new Error("reconfigure effort is invalid");
    if (body.fast !== null && typeof body.fast !== "boolean") throw new Error("reconfigure speed is invalid");
    const accountId = optionalId(body.accountId, "accountId");
    const previous = body.previousProfile;
    if (previous !== undefined && (!previous || typeof previous !== "object" || Array.isArray(previous))) {
      throw new Error("reconfigure previous profile is invalid");
    }
    const previousProfile = previous as Record<string, unknown> | undefined;
    if (previousProfile
      && ((previousProfile.model !== null && typeof previousProfile.model !== "string")
        || (previousProfile.effort !== null && typeof previousProfile.effort !== "string")
        || (previousProfile.fast !== null && typeof previousProfile.fast !== "boolean"))) {
      throw new Error("reconfigure previous profile is invalid");
    }
    return {
      kind,
      conversationId,
      ...(operationId ? { operationId } : {}),
      idempotencyKey,
      model,
      effort,
      fast: body.fast,
      ...(accountId ? { accountId } : {}),
      ...(previousProfile ? { previousProfile: previousProfile as RuntimeReconfigureCommand["previousProfile"] } : {}),
    };
  }

  const engine = body.engine === "codex" || body.engine === "claude" ? body.engine : null;
  if (!engine) throw new Error("engine is invalid");
  const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
  if (!cwd) throw new Error("spawn cwd is required");
  if (typeof body.prompt !== "string") throw new Error("prompt is required");
  const prompt = body.prompt.trim();
  const images = body.images === undefined ? [] : parseStructuredImageRefs(body.images, 16);
  if (!images) throw new Error("images are invalid");
  const content = prompt || images.length ? structuredContent(prompt, images) : null;
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
    ...(images.length ? { images } : {}),
    ...(content ? { contentDigest: content.contentDigest } : {}),
    ...(accountId !== undefined ? { accountId } : {}),
    ...(parentConversationId !== undefined ? { parentConversationId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}
