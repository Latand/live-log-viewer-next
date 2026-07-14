import type { RuntimeAttentionKind, RuntimeAttentionRequest, RuntimeEventInput } from "./contracts";
import type { RuntimeEvent } from "./engineHost";

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
    prompt: clipped(prompt, 512),
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
  if (event.kind === "item") {
    return { ...base, kind: "item", payload: { conversationId, turnId: event.turnId, item: boundedValue(event.item), phase: event.phase } };
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
  return null;
}
