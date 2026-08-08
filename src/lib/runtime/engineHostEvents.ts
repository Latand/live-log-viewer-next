import type { RuntimeAttentionKind, RuntimeAttentionRequest, RuntimeEventInput } from "./contracts";
import type { RuntimeEvent } from "./engineHost";
import { LIVE_TURN_TEXT_LIMIT } from "./liveTurn";
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

function boundedToolArguments(value: unknown, maxBytes: number): unknown {
  let serialized: string;
  try { serialized = JSON.stringify(value ?? {}); } catch { return {}; }
  if (Buffer.byteLength(serialized) <= maxBytes) return value ?? {};
  const source = record(value);
  const result: JsonObject = { truncated: true };
  const primaryKeys = [
    "cmd", "command", "file_path", "path", "input", "query", "url", "pattern",
    "prompt", "description", "session_id", "cell_id", "chars", "workdir",
  ];
  const keys = [...new Set([...primaryKeys, ...Object.keys(source)])];
  for (const key of keys) {
    const candidate = source[key];
    if (candidate === undefined) continue;
    let projected: unknown;
    if (typeof candidate === "string") projected = clipped(candidate, Math.min(8 * 1024, Math.max(256, maxBytes - 512)));
    else if (typeof candidate === "number" || typeof candidate === "boolean" || candidate === null) projected = candidate;
    else if (Array.isArray(candidate)) projected = candidate.slice(0, 16);
    else continue;
    const next = { ...result, [key]: projected };
    if (Buffer.byteLength(JSON.stringify(next)) <= maxBytes) result[key] = projected;
  }
  return result;
}

function boundedCodexToolItem(source: JsonObject, type: string): unknown | null {
  const identity = {
    type,
    ...(text(source.call_id) ? { call_id: clipped(text(source.call_id)!, 256) } : {}),
    ...(text(source.id) ? { id: clipped(text(source.id)!, 256) } : {}),
  };
  if (type === "commandExecution") {
    return {
      ...identity,
      ...(text(source.command) ? { command: clipped(text(source.command)!, 48 * 1024) } : {}),
      ...(text(source.cwd) ? { cwd: clipped(text(source.cwd)!, 2 * 1024) } : {}),
    };
  }
  if (type === "fileChange") {
    const changes = Array.isArray(source.changes) ? source.changes.slice(0, 32).map(record) : [];
    const diffBytes = Math.max(256, Math.floor((32 * 1024) / Math.max(changes.length, 1)));
    return {
      ...identity,
      changes: changes.map((change) => ({
        ...(text(change.path) ? { path: clipped(text(change.path)!, 512) } : {}),
        ...(text(change.diff) ? { diff: clipped(text(change.diff)!, diffBytes) } : {}),
      })),
    };
  }
  if (type === "mcpToolCall" || type === "dynamicToolCall") {
    return {
      ...identity,
      ...(text(source.server) ? { server: clipped(text(source.server)!, 256) } : {}),
      ...(text(source.tool) ? { tool: clipped(text(source.tool)!, 256) } : {}),
      arguments: boundedToolArguments(source.arguments, 48 * 1024),
    };
  }
  if (type === "collabAgentToolCall") {
    return {
      ...identity,
      ...(text(source.tool) ? { tool: clipped(text(source.tool)!, 256) } : {}),
      ...(text(source.prompt) ? { "prompt": clipped(text(source.prompt)!, 48 * 1024) } : {}),
      ...(text(source.model) ? { model: clipped(text(source.model)!, 256) } : {}),
      ...(Array.isArray(source.receiverThreadIds) ? {
        receiverThreadIds: source.receiverThreadIds
          .flatMap((candidate) => text(candidate) ? [clipped(text(candidate)!, 256)] : [])
          .slice(0, 32),
      } : {}),
    };
  }
  if (type === "webSearch") {
    return {
      ...identity,
      ...(text(source.query) ? { query: clipped(text(source.query)!, 48 * 1024) } : {}),
      ...(source.action !== undefined ? { action: boundedToolArguments(source.action, 8 * 1024) } : {}),
    };
  }
  if (type === "imageView") return { ...identity, ...(text(source.path) ? { path: clipped(text(source.path)!, 48 * 1024) } : {}) };
  if (type === "sleep") return { ...identity, ...(typeof source.durationMs === "number" ? { durationMs: source.durationMs } : {}) };
  if (type === "imageGeneration") {
    return {
      ...identity,
      ...(text(source.revisedPrompt) ? { revisedPrompt: clipped(text(source.revisedPrompt)!, 48 * 1024) } : {}),
      ...(text(source.savedPath) ? { savedPath: clipped(text(source.savedPath)!, 2 * 1024) } : {}),
    };
  }
  if (type === "function_call") {
    return {
      ...identity,
      ...(text(source.name) ? { name: clipped(text(source.name)!, 256) } : {}),
      ...(typeof source.arguments === "string" ? { arguments: clipped(source.arguments, 48 * 1024) } : {}),
    };
  }
  if (type === "custom_tool_call") {
    return {
      ...identity,
      ...(text(source.name) ? { name: clipped(text(source.name)!, 256) } : {}),
      ...(text(source.input) ? { input: clipped(text(source.input)!, 48 * 1024) } : {}),
    };
  }
  if (type === "function_call_output" || type === "custom_tool_call_output") return identity;
  return null;
}

function boundedText(value: string, maxBytes: number): { text: string; omittedChars: number } {
  if (Buffer.byteLength(value) <= maxBytes) return { text: value, omittedChars: 0 };
  const points = [...value];
  if (maxBytes < Buffer.byteLength("…")) return { text: "", omittedChars: points.length };
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${points.slice(0, middle).join("")}…`;
    if (Buffer.byteLength(candidate) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return {
    text: `${points.slice(0, low).join("")}…`,
    omittedChars: points.length - low,
  };
}

function boundedClaudeToolItem(source: JsonObject): unknown | null {
  const message = record(source.message);
  const content = Array.isArray(source.content)
    ? source.content
    : Array.isArray(message.content) ? message.content : [];
  if (!content.some((candidate) => {
    const type = text(record(candidate).type);
    return type === "tool_use" || type === "tool_result";
  })) return null;
  const toolCount = content.filter((candidate) => text(record(candidate).type) === "tool_use").length;
  const toolBytes = toolCount > 0 ? Math.max(64, Math.floor((8 * 1024) / toolCount)) : 0;
  const projectedToolInputs = content.map((candidate) => {
    const part = record(candidate);
    return text(part.type) === "tool_use"
      ? boundedToolArguments(part.input, toolBytes)
      : null;
  });
  const usedToolBytes = projectedToolInputs.reduce<number>((total, input) =>
    total + (input === null ? 0 : Buffer.byteLength(JSON.stringify(input))), 0);
  const textBudget = Math.max(0, 40 * 1024 - usedToolBytes);
  const totalTextBytes = content.reduce((total, candidate) => {
    const part = record(candidate);
    const type = text(part.type);
    return type === "text" || type === "input_text" || type === "output_text"
      ? total + Buffer.byteLength(text(part.text) ?? "")
      : total;
  }, 0);
  const projectedContent = content.flatMap((candidate, index): JsonObject[] => {
    const part = record(candidate);
    const type = text(part.type);
    if (type === "text" || type === "input_text" || type === "output_text") {
      const prose = text(part.text) ?? "";
      const payloadBytes = totalTextBytes <= textBudget
        ? Buffer.byteLength(prose)
        : Math.floor(textBudget * (Buffer.byteLength(prose) / Math.max(totalTextBytes, 1)));
      const bounded = boundedText(prose, payloadBytes);
      return [{
        type,
        ...(bounded.text ? { text: bounded.text } : {}),
        ...(bounded.omittedChars > 0 ? { omittedChars: bounded.omittedChars } : {}),
      }];
    }
    if (type === "tool_use") {
      return [{
        type,
        ...(text(part.id) ? { id: clipped(text(part.id)!, 256) } : {}),
        ...(text(part.name) ? { name: clipped(text(part.name)!, 256) } : {}),
        input: projectedToolInputs[index] ?? {},
      }];
    }
    if (type === "tool_result") {
      return [{
        type,
        ...(text(part.tool_use_id) ? { tool_use_id: clipped(text(part.tool_use_id)!, 256) } : {}),
      }];
    }
    return [];
  });
  const projectedMessage = {
    ...(text(source.role, message.role) ? { role: text(source.role, message.role)! } : {}),
    ...(text(message.id) ? { id: clipped(text(message.id)!, 256) } : {}),
    content: projectedContent,
  };
  return {
    ...(text(source.type) ? { type: text(source.type)! } : {}),
    ...(text(source.id) ? { id: clipped(text(source.id)!, 256) } : {}),
    ...(text(source.uuid) ? { uuid: clipped(text(source.uuid)!, 256) } : {}),
    ...(Array.isArray(source.content) ? {
      ...(text(source.role) ? { role: text(source.role)! } : {}),
      content: projectedContent,
    } : { message: projectedMessage }),
  };
}

function boundedLiveTurnItem(value: unknown): unknown {
  const source = record(value);
  const type = text(source.type) ?? "";
  const descriptor = boundedCodexToolItem(source, type) ?? boundedClaudeToolItem(source);
  return descriptor ? boundedValue(descriptor, LIVE_TURN_TEXT_LIMIT) : boundedValue(value);
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
        item: boundedLiveTurnItem(event.item),
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
    return { ...base, kind: "attention-resolved", payload: { id: event.id, conversationId, state: "resolved", resolution: event.resolution } };
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
