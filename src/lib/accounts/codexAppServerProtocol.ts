const MAX_METHOD_LENGTH = 256;
const MAX_ID_LENGTH = 512;
const MAX_ERROR_MESSAGE_LENGTH = 2_000;
const MAX_REDACTED_DETAIL_LENGTH = 500;

export type AppServerRequestId = string | number;
export type AppServerEnvelope = "headerless" | "jsonrpc-2.0";

export type AppServerMessage =
  | { kind: "response"; envelope: AppServerEnvelope; id: AppServerRequestId; result?: unknown; error?: { code: number; message: string } }
  | { kind: "request"; envelope: AppServerEnvelope; id: AppServerRequestId; method: string; params: unknown }
  | { kind: "notification"; envelope: AppServerEnvelope; method: string; params: unknown };

export class CodexAppServerProtocolError extends Error {
  constructor(message: string) {
    super(`Codex app-server protocol error: ${redactAppServerDetail(message)}`);
    this.name = "CodexAppServerProtocolError";
  }
}

export function redactAppServerDetail(value: string): string {
  return value
    .replace(/(bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(["']?(?:access|refresh|id)[_-]?token["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[REDACTED]")
    .replace(/(["']?(?:api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[REDACTED]")
    .slice(0, MAX_REDACTED_DETAIL_LENGTH);
}

export function isAppServerRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function has(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validId(value: unknown): value is AppServerRequestId {
  return (typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH) ||
    (typeof value === "number" && Number.isSafeInteger(value));
}

function validMethod(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_METHOD_LENGTH;
}

function protocol(message: string): never {
  throw new CodexAppServerProtocolError(message);
}

/** Classifies installed headerless frames and explicit JSON-RPC 2.0 envelopes. */
export function parseAppServerMessage(value: unknown): AppServerMessage {
  if (!isAppServerRecord(value)) protocol("message must be an object");
  if (has(value, "jsonrpc") && value.jsonrpc !== "2.0") protocol("jsonrpc must be 2.0 when present");
  const envelope: AppServerEnvelope = has(value, "jsonrpc") ? "jsonrpc-2.0" : "headerless";

  const hasId = has(value, "id");
  const hasMethod = has(value, "method");
  const hasResult = has(value, "result");
  const hasError = has(value, "error");

  if (hasResult || hasError) {
    if (hasMethod || !hasId || hasResult === hasError) protocol("response shape is invalid");
    if (!validId(value.id)) protocol("response id is invalid");
    if (hasError) {
      if (!isAppServerRecord(value.error) || typeof value.error.code !== "number" || !Number.isSafeInteger(value.error.code) ||
        typeof value.error.message !== "string" || value.error.message.length > MAX_ERROR_MESSAGE_LENGTH) {
        protocol("response error is invalid");
      }
      return { kind: "response", envelope, id: value.id, error: { code: value.error.code, message: value.error.message } };
    }
    return { kind: "response", envelope, id: value.id, result: value.result };
  }

  if (!hasMethod || !validMethod(value.method)) protocol("method is invalid");
  if (hasId) {
    if (!validId(value.id)) protocol(`server request ${value.method} has an invalid id`);
    return { kind: "request", envelope, id: value.id, method: value.method, params: value.params };
  }
  return { kind: "notification", envelope, method: value.method, params: value.params };
}
