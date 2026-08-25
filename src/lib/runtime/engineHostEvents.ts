import type { RuntimeAttentionKind, RuntimeAttentionRequest, RuntimeEventInput } from "./contracts";
import type { RuntimeEvent } from "./engineHost";
import { boundedToolArgs } from "./liveTurn";
import { terminalVoiceResponse } from "./voiceDelivery";

type JsonObject = Record<string, unknown>;

function record(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function text(...values: unknown[]): string | null {
  return values.find((value) => typeof value === "string" && value.trim()) as string | undefined ?? null;
}

function clipped(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  return bytes.byteLength <= maxBytes ? value : `${bytes.subarray(0, maxBytes).toString("utf8")}…`;
}

function boundedValue(value: unknown, maxBytes = 8 * 1024): unknown {
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { return { truncated: true }; }
  if (Buffer.byteLength(serialized) <= maxBytes) return value;
  const source = record(value);
  return {
    truncated: true,
    ...(text(source.id) ? { id: text(source.id) } : {}),
    ...(text(source.type) ? { type: text(source.type) } : {}),
    ...(text(source.name) ? { name: text(source.name) } : {}),
  };
}

const TRUNCATED_ITEM_STRING_LIMIT = 256;

/** A bounded string form of a terminal-outcome field (a Codex `error` /
    `failure` may be a string or an object): enough to keep the discriminant
    the live turn reads, never the payload. */
function boundedOutcome(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return clipped(value, TRUNCATED_ITEM_STRING_LIMIT);
  try {
    const serialized = JSON.stringify(value);
    return serialized ? clipped(serialized, TRUNCATED_ITEM_STRING_LIMIT) : undefined;
  } catch {
    return undefined;
  }
}

/** The bounded form of one Claude content block: a tool call keeps its identity
    and (by default) a bounded argument projection; a tool result keeps its call
    id and outcome; prose carries nothing the live turn needs (the streamed
    deltas already hold the text). */
function reducedToolBlock(block: JsonObject, keepArgs: boolean): JsonObject | null {
  const type = text(block.type);
  if (type === "tool_use") {
    return {
      type,
      ...(text(block.id) ? { id: text(block.id) } : {}),
      ...(text(block.name) ? { name: text(block.name) } : {}),
      ...(keepArgs ? { input: boundedToolArgs(block.input) } : { input: {}, inputOmitted: true }),
    };
  }
  if (type === "tool_result") {
    return {
      type,
      ...(text(block.tool_use_id) ? { tool_use_id: text(block.tool_use_id) } : {}),
      ...(block.is_error === true ? { is_error: true } : {}),
    };
  }
  return null;
}

function projectionBytes(value: JsonObject): number {
  try { return Buffer.byteLength(JSON.stringify(value)); } catch { return Number.POSITIVE_INFINITY; }
}

/**
 * The bounded replacement for an oversized item keeps what the live turn
 * projects (issue #1100): the response identity and EVERY tool call's id and
 * name, so a large `Write`/`Edit` input, a long shell heredoc, or a message of
 * many parallel calls still shows each call as a tool row. Arguments are the
 * first thing to go: a projection that does not fit with bounded arguments is
 * retried with identity-only calls (`inputOmitted`, which the live row reports
 * as omitted arguments); only when even the identities do not fit are the
 * trailing calls dropped, and then the message says how many: `omittedToolCalls`,
 * which the live turn renders as an explicit omission descriptor, and
 * `omittedToolResults`, which settles that many still-running rows as
 * `unknown` (finished, outcome not retained) instead of leaving them spinning.
 * Prose bodies are dropped on purpose: the streamed deltas already carry the
 * text, and a clipped authoritative body would otherwise overwrite them. Codex
 * tool items keep their terminal outcome discriminants (`status`, `exitCode`,
 * `error`, `success`, `failure`) so a failed oversized call never projects as a
 * successful row.
 */
function truncatedItemProjection(source: JsonObject, maxBytes: number): JsonObject {
  const message = record(source.message);
  const blocks = Array.isArray(message.content) ? message.content : Array.isArray(source.content) ? source.content : null;
  const reducedStrings: JsonObject = {};
  for (const key of ["status", "command", "cwd", "tool", "server", "query", "path", "model"]) {
    const candidate = text(source[key]);
    if (candidate) reducedStrings[key] = clipped(candidate, TRUNCATED_ITEM_STRING_LIMIT);
  }
  const outcome: JsonObject = {};
  for (const key of ["error", "success", "failure"]) {
    const bounded = boundedOutcome(source[key]);
    if (bounded !== undefined) outcome[key] = bounded;
  }
  const base: JsonObject = {
    truncated: true,
    ...(text(source.id) ? { id: text(source.id) } : {}),
    ...(text(source.uuid) ? { uuid: text(source.uuid) } : {}),
    ...(text(source.type) ? { type: text(source.type) } : {}),
    ...(text(source.name) ? { name: text(source.name) } : {}),
    ...(typeof source.exitCode === "number" ? { exitCode: source.exitCode } : {}),
    ...reducedStrings,
    ...outcome,
    ...(record(source.arguments) && Object.keys(record(source.arguments)).length
      ? { arguments: boundedToolArgs(source.arguments) }
      : {}),
  };
  if (!blocks) return base;
  const envelope = (content: JsonObject[], omitted: { calls: number; results: number }): JsonObject => ({
    ...base,
    message: {
      ...(text(message.id) ? { id: text(message.id) } : {}),
      ...(text(message.role) ? { role: text(message.role) } : {}),
      content,
      ...(omitted.calls ? { omittedToolCalls: omitted.calls } : {}),
      ...(omitted.results ? { omittedToolResults: omitted.results } : {}),
    },
  });
  const toolBlocks = blocks.map(record).filter((block) => {
    const type = text(block.type);
    return type === "tool_use" || type === "tool_result";
  });
  /* Rung 1: every call with bounded arguments. Rung 2: every call, identity only. */
  for (const keepArgs of [true, false]) {
    const content = toolBlocks.flatMap((block) => {
      const reduced = reducedToolBlock(block, keepArgs);
      return reduced ? [reduced] : [];
    });
    const candidate = envelope(content, { calls: 0, results: 0 });
    if (projectionBytes(candidate) <= maxBytes) return candidate;
  }
  /* Rung 3: the leading identities that fit, with the dropped tail counted.
     A byte estimate picks the cut in one pass; the exact serialization then
     confirms it (and trims the odd block the estimate missed). */
  const identities = toolBlocks.flatMap((block) => {
    const reduced = reducedToolBlock(block, false);
    return reduced ? [reduced] : [];
  });
  const omittedPast = (kept: number) => {
    const dropped = identities.slice(kept);
    return {
      calls: dropped.filter((block) => block.type === "tool_use").length,
      results: dropped.filter((block) => block.type === "tool_result").length,
    };
  };
  let used = projectionBytes(envelope([], omittedPast(0)));
  let kept = 0;
  for (const block of identities) {
    const bytes = projectionBytes(block) + 1;
    if (used + bytes > maxBytes) break;
    used += bytes;
    kept += 1;
  }
  for (;;) {
    const candidate = envelope(identities.slice(0, kept), omittedPast(kept));
    if (projectionBytes(candidate) <= maxBytes || kept === 0) return candidate;
    kept -= 1;
  }
}

/** An item payload bounded for the journal: small items pass through, an
    oversized one is reduced to its live-turn projection, and a projection that
    is still too large falls back to bare identity. */
function boundedItem(value: unknown, maxBytes = 8 * 1024): unknown {
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { return { truncated: true }; }
  if (Buffer.byteLength(serialized) <= maxBytes) return value;
  const projection = truncatedItemProjection(record(value), maxBytes);
  try {
    if (Buffer.byteLength(JSON.stringify(projection)) <= maxBytes) return projection;
  } catch { /* fall through to the bare identity below */ }
  return boundedValue(value, 0);
}

function questionFrom(value: unknown): RuntimeAttentionRequest["question"] | null {
  const source = record(value);
  const prompt = text(source.question, source.prompt);
  if (!prompt) return null;
  const options = Array.isArray(source.options)
    ? source.options.map(record).flatMap((option) => {
      const label = text(option.label);
      return label ? [{ label: clipped(label, 256), ...(text(option.description) ? { description: clipped(text(option.description)!, 256) } : {}) }] : [];
    })
    : undefined;
  return {
    ...(text(source.header) ? { header: clipped(text(source.header)!, 256) } : {}),
    "prompt": clipped(prompt, 512),
    ...(options?.length ? { options } : {}),
    ...(typeof source.multiSelect === "boolean" ? { multiSelect: source.multiSelect } : {}),
  };
}

function attentionProjection(engine: "codex" | "claude", event: Extract<RuntimeEvent, { kind: "attention" }>): {
  kind: RuntimeAttentionKind;
  request: RuntimeAttentionRequest;
  turnId: string | null;
  autoResolutionMs?: number;
} {
  const source = record(event.attention);
  const input = record(source.input);
  const questions = Array.isArray(source.questions)
    ? source.questions
    : Array.isArray(input.questions) ? input.questions : [];
  const tool = text(source.tool, source.tool_name, source.toolName);
  const method = event.method;
  const kind: RuntimeAttentionKind = method.includes("requestApproval")
    ? "approval"
    : method.includes("requestUserInput") || tool === "AskUserQuestion" || questions.length > 0
      ? "question"
      : "permission";
  const request: RuntimeAttentionRequest = {};
  const command = text(source.command, record(source.item).command);
  if (command) request.command = clipped(command, 4 * 1024);
  if (tool) request.tool = clipped(tool, 256);
  const projectedQuestions = questions
    .map(questionFrom)
    .filter((question): question is NonNullable<RuntimeAttentionRequest["question"]> => question !== null);
  const question = projectedQuestions[0] ?? questionFrom(source);
  if (question) request.question = question;
  if (projectedQuestions.length > 0) request.questions = projectedQuestions;
  const title = text(source.title);
  if (title) request.title = clipped(title, 256);
  const detail = text(source.detail, source.message);
  if (detail) request.detail = clipped(detail, 2 * 1024);
  const firstQuestion = record(questions[0]);
  const questionIds = questions.map((candidate) => text(record(candidate).id)).filter((id): id is string => id !== null);
  const protocolInput = tool === "AskUserQuestion"
    && Object.keys(input).length > 0
    && Buffer.byteLength(JSON.stringify(input)) <= 4 * 1024
    ? input
    : null;
  request.protocol = {
    engine,
    method,
    ...(text(firstQuestion.id) ? { questionId: text(firstQuestion.id)! } : {}),
    ...(questionIds.length > 0 ? { questionIds } : {}),
    ...(protocolInput ? { input: protocolInput } : {}),
  };
  return {
    kind,
    request,
    turnId: text(source.turnId, record(source.turn).id),
    ...(typeof source.autoResolutionMs === "number" ? { autoResolutionMs: source.autoResolutionMs } : {}),
  };
}

export function projectEngineHostEvent(
  conversationId: string,
  hostKey: string,
  event: RuntimeEvent,
): RuntimeEventInput | null {
  const base = {
    scope: { type: "session" as const, id: conversationId },
    producer: { kind: hostKey.startsWith("codex:") ? "codex-app-server" : "claude-broker", eventKey: `engine-host:${hostKey}:${event.seq}` },
  };
  const engine = hostKey.startsWith("codex:") ? "codex" : "claude";
  if (event.kind === "turn-started") {
    return { ...base, kind: "turn-started", payload: { conversationId, turnId: event.turnId } };
  }
  if (event.kind === "delta") {
    return { ...base, kind: "delta", payload: { conversationId, turnId: event.turnId, text: clipped(event.text, 8 * 1024) } };
  }
  if (event.kind === "voice-chunk") {
    return {
      ...base,
      kind: "voice-chunk",
      payload: {
        conversationId,
        turnId: event.turnId,
        voiceDelivery: event.delivery,
      },
    };
  }
  if (event.kind === "item") {
    const voiceResponse = "voiceResponse" in event
      ? event.voiceResponse
      : engine === "codex" && event.phase === "completed"
        ? terminalVoiceResponse(event.item, `engine-host:${hostKey}:${event.seq}`)
        : null;
    return {
      ...base,
      kind: "item",
      payload: {
        conversationId,
        turnId: event.turnId,
        item: boundedItem(event.item),
        phase: event.phase,
        ...(voiceResponse ? { voiceResponse } : {}),
      },
    };
  }
  if (event.kind === "turn-ended") {
    return { ...base, kind: "turn-ended", payload: { conversationId, turnId: event.turnId, outcome: event.status } };
  }
  if (event.kind === "attention") {
    const projected = attentionProjection(engine, event);
    return {
      ...base,
      kind: "attention",
      payload: {
        id: event.id,
        conversationId,
        kind: projected.kind,
        state: "open",
        unowned: false,
        createdAt: new Date().toISOString(),
        request: projected.request,
        turnId: projected.turnId,
        ...(projected.autoResolutionMs !== undefined ? { autoResolutionMs: projected.autoResolutionMs } : {}),
      },
    };
  }
  if (event.kind === "attention-resolved") {
    /* `attentionId` is the field every reducer keys on (the journal's own
       answer path writes it; the client store reads it). Emitting only `id`
       here meant an engine-originated resolution — a CLI cancellation, an
       answer typed in the terminal, a turn ending past the question — never
       retired the card anywhere (#765). `id` stays for older readers. */
    return {
      ...base,
      kind: "attention-resolved",
      payload: {
        id: event.id,
        attentionId: event.id,
        conversationId,
        state: event.resolution === "turn-ended" ? "cancelled" : "resolved",
        resolution: event.resolution,
      },
    };
  }
  if (event.kind === "limits") {
    return { ...base, kind: "limits", payload: { conversationId, snapshot: boundedValue(event.snapshot) } };
  }
  if (event.kind === "realtime-delivery-progress") {
    return {
      ...base,
      kind: "voice-delivery-progress",
      payload: {
        conversationId,
        deliveryId: event.deliveryId,
        responseIndex: event.responseIndex,
        offset: event.offset,
      },
    };
  }
  if (event.kind === "realtime-delivery-acknowledged") {
    return {
      ...base,
      kind: "voice-delivery-acknowledged",
      payload: { conversationId, deliveryId: event.deliveryId },
    };
  }
  return null;
}
