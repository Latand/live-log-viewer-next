export const LIVE_TURN_TEXT_LIMIT = 64 * 1024;
export const LIVE_TURN_ITEM_LIMIT = 32;
export const LIVE_TURN_OVERFLOW_LIMIT = 512;

export type RuntimeLiveTurnItemPhase = "streaming" | "awaiting-echo";
export type RuntimeLiveTurnItemKind = "assistant" | "tool";
export type RuntimeLiveTurnToolEngine = "claude" | "codex";

export interface RuntimeLiveTurnItem {
  /** Missing only on legacy snapshots, which normalize to assistant prose. */
  kind?: RuntimeLiveTurnItemKind;
  itemId: string | null;
  /** Assistant prose, or serialized tool arguments for a tool item. */
  text: string;
  toolName?: string;
  toolEngine?: RuntimeLiveTurnToolEngine;
  phase: RuntimeLiveTurnItemPhase;
  startedAt: string | null;
  completedAt: string | null;
  /** Characters omitted from the live projection to honor its text bound. The
      canonical transcript remains authoritative; the UI renders this count. */
  omittedChars?: number;
  /** Extremely old descriptors folded into this explicit bounded summary. */
  omittedItems?: number;
}

export interface RuntimeLiveTurn {
  turnId: string;
  /** Latest assistant item text retained for compatibility with existing status consumers. */
  text: string;
  /** Assistant and tool items awaiting canonical transcript ownership, in response order. */
  items?: RuntimeLiveTurnItem[];
  /** Older unclaimed items displaced from the 32-item hot window. Descriptors
      remain durable in journal snapshots and preserve response order/identity. */
  overflow?: RuntimeLiveTurnItem[];
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();
const utf8Length = (value: string) => utf8Encoder.encode(value).length;

function trimUtf8Start(value: string, bytes: number): {
  omittedChars: number;
  text: string;
} {
  const encoded = utf8Encoder.encode(value);
  let start = Math.min(bytes, encoded.length);
  while (start < encoded.length && (encoded[start]! & 0xc0) === 0x80) start += 1;
  const omitted = utf8Decoder.decode(encoded.subarray(0, start));
  return {
    omittedChars: [...omitted].length,
    text: utf8Decoder.decode(encoded.subarray(start)),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      const item = record(part);
      if (!item) return "";
      const type = text(item.type);
      return type === "text" || type === "input_text" || type === "output_text"
        ? text(item.text)
        : "";
    })
    .filter(Boolean)
    .join("\n");
}

interface ProjectedItem {
  kind: RuntimeLiveTurnItemKind;
  itemId: string | null;
  text: string;
  toolName?: string;
  toolEngine?: RuntimeLiveTurnToolEngine;
}

function serializedToolArgs(value: unknown): string {
  try {
    const serialized = JSON.stringify(value ?? {});
    return typeof serialized === "string" ? serialized : "";
  } catch {
    return "";
  }
}

function toolArgs(value: unknown): unknown {
  const args = record(value);
  return args ?? (value === undefined ? {} : { input: value });
}

function projectedTool(
  itemId: string | null,
  toolName: string,
  args: unknown,
  toolEngine: RuntimeLiveTurnToolEngine,
): ProjectedItem {
  return {
    kind: "tool",
    itemId,
    text: serializedToolArgs(toolArgs(args)),
    toolName: toolName.slice(0, 256) || "tool",
    toolEngine,
  };
}

function codexToolIdentity(item: Record<string, unknown>, type: string): ProjectedItem | null {
  const itemId = text(item.id) || text(item.call_id) || null;
  if (type === "commandExecution") {
    return projectedTool(itemId, "exec_command", {
      cmd: text(item.command),
      workdir: text(item.cwd),
    }, "codex");
  }
  if (type === "fileChange") {
    const changes = Array.isArray(item.changes) ? item.changes.map(record).filter(Boolean) : [];
    return projectedTool(itemId, "apply_patch", {
      input: changes.map((change) => text(change?.diff)).filter(Boolean).join("\n"),
      file_path: text(changes[0]?.path),
    }, "codex");
  }
  if (type === "mcpToolCall") {
    const server = text(item.server);
    const name = text(item.tool) || "tool";
    return projectedTool(itemId, server ? `mcp__${server}__${name}` : name, item.arguments, "codex");
  }
  if (type === "dynamicToolCall") {
    return projectedTool(itemId, text(item.tool) || "tool", item.arguments, "codex");
  }
  if (type === "collabAgentToolCall") {
    return projectedTool(itemId, text(item.tool) || "Agent", {
      "prompt": text(item.prompt),
      model: text(item.model),
      receiverThreadIds: item.receiverThreadIds,
    }, "codex");
  }
  if (type === "webSearch") {
    return projectedTool(itemId, "WebSearch", {
      query: text(item.query),
      action: item.action,
    }, "codex");
  }
  if (type === "imageView") return projectedTool(itemId, "view_image", { path: text(item.path) }, "codex");
  if (type === "sleep") return projectedTool(itemId, "wait", { yield_time_ms: item.durationMs }, "codex");
  if (type === "imageGeneration") {
    return projectedTool(itemId, "imagegen", {
      "prompt": text(item.revisedPrompt),
      path: text(item.savedPath),
    }, "codex");
  }
  if (type === "function_call") {
    let args: unknown = {};
    try { args = JSON.parse(text(item.arguments) || "{}"); } catch { /* readable generic fallback */ }
    return projectedTool(itemId, text(item.name) || "tool", args, "codex");
  }
  if (type === "custom_tool_call") {
    return projectedTool(itemId, text(item.name) || "tool", { input: text(item.input) }, "codex");
  }
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    return { kind: "tool", itemId, text: "", toolName: "tool", toolEngine: "codex" };
  }
  return null;
}

function itemIdentities(value: unknown): ProjectedItem[] {
  const item = record(value);
  if (!item) return [];
  const type = text(item.type);
  const message = record(item.message);
  const role = text(item.role) || text(message?.role);
  const assistant = type === "agentMessage"
    || type === "agent_message"
    || type === "assistant"
    || (type === "message" && role === "assistant");
  const parentId = text(item.id) || text(item.uuid) || text(message?.id) || null;
  const content = Array.isArray(item.content)
    ? item.content
    : Array.isArray(message?.content) ? message.content : null;
  if (assistant && content) {
    return content.flatMap((value): ProjectedItem[] => {
      const part = record(value);
      if (!part) return [];
      const partType = text(part.type);
      if (partType === "text" || partType === "input_text" || partType === "output_text") {
        const prose = text(part.text);
        return prose ? [{ kind: "assistant", itemId: parentId, text: prose }] : [];
      }
      if (partType === "tool_use") {
        return [projectedTool(
          text(part.id) || null,
          text(part.name) || "tool",
          part.input,
          "claude",
        )];
      }
      return [];
    });
  }
  if (assistant) {
    return [{
      kind: "assistant",
      itemId: parentId,
      text: text(item.text) || contentText(item.content) || contentText(message?.content),
    }];
  }
  const userContent = role === "user" && content ? content : [];
  const toolResults = userContent.flatMap((value): ProjectedItem[] => {
    const part = record(value);
    return part && text(part.type) === "tool_result"
      ? [{
        kind: "tool",
        itemId: text(part.tool_use_id) || null,
        text: "",
        toolName: "tool",
        toolEngine: "claude",
      }]
      : [];
  });
  if (toolResults.length) return toolResults;
  const codexTool = codexToolIdentity(item, type);
  return codexTool ? [codexTool] : [];
}

function normalizedList(value: unknown): RuntimeLiveTurnItem[] {
  if (!Array.isArray(value)) return [];
  return value
      .filter((item) =>
        item
        && typeof item.text === "string"
        && (item.kind === "tool" || item.text.length > 0 || (item.omittedChars ?? 0) > 0 || (item.omittedItems ?? 0) > 0))
      .map((item) => ({
        kind: item.kind === "tool" ? "tool" as const : "assistant" as const,
        itemId: typeof item.itemId === "string" ? item.itemId : null,
        text: item.text,
        ...(item.kind === "tool"
          ? {
            toolName: typeof item.toolName === "string" && item.toolName ? item.toolName.slice(0, 256) : "tool",
            toolEngine: item.toolEngine === "claude" ? "claude" as const : "codex" as const,
          }
          : {}),
        phase: item.phase === "awaiting-echo" ? "awaiting-echo" : "streaming",
        startedAt: typeof item.startedAt === "string" ? item.startedAt : null,
        completedAt: typeof item.completedAt === "string" ? item.completedAt : null,
        ...(typeof item.omittedChars === "number" && item.omittedChars > 0
          ? { omittedChars: Math.floor(item.omittedChars) }
          : {}),
        ...(typeof item.omittedItems === "number" && item.omittedItems > 0
          ? { omittedItems: Math.floor(item.omittedItems) }
          : {}),
      }));
}

function normalizedItems(value: RuntimeLiveTurn): RuntimeLiveTurnItem[] {
  if (Array.isArray(value.items) || Array.isArray(value.overflow)) {
    return [...normalizedList(value.overflow), ...normalizedList(value.items)];
  }
  return value.text
    ? [{
      kind: "assistant",
      itemId: null,
      text: value.text,
      phase: "streaming",
      startedAt: null,
      completedAt: null,
    }]
    : [];
}

function bounded(turnId: string, items: RuntimeLiveTurnItem[]): RuntimeLiveTurn | null {
  const descriptorLimit = LIVE_TURN_ITEM_LIMIT + LIVE_TURN_OVERFLOW_LIMIT;
  const omittedCount = items.length > descriptorLimit
    ? items.length - descriptorLimit + 1
    : 0;
  const omitted = items.slice(0, omittedCount);
  let kept = omitted.length
    ? [{
      kind: "assistant" as const,
      itemId: null,
      text: "",
      phase: "awaiting-echo" as const,
      startedAt: omitted[0]?.startedAt ?? null,
      completedAt: omitted.at(-1)?.completedAt ?? null,
      omittedItems: omitted.reduce((total, item) =>
        total + (item.omittedItems ?? 1), 0),
      omittedChars: omitted.reduce((total, item) =>
        total + [...item.text].length + (item.omittedChars ?? 0), 0),
    }, ...items.slice(omittedCount)]
    : items;
  let excess = kept.reduce((total, item) => total + utf8Length(item.text), 0) - LIVE_TURN_TEXT_LIMIT;
  if (excess > 0) {
    kept = kept.map((item) => {
      if (excess <= 0) return item;
      const before = utf8Length(item.text);
      const trimmed = trimUtf8Start(item.text, excess);
      excess -= before - utf8Length(trimmed.text);
      return {
        ...item,
        text: trimmed.text,
        omittedChars: (item.omittedChars ?? 0) + trimmed.omittedChars,
      };
    });
  }
  if (!kept.length) return null;
  const activeStart = Math.max(0, kept.length - LIVE_TURN_ITEM_LIMIT);
  const overflow = kept.slice(0, activeStart);
  const active = kept.slice(activeStart);
  return {
    turnId,
    text: kept.findLast((item) => item.kind !== "tool")?.text ?? "",
    items: active,
    ...(overflow.length ? { overflow } : {}),
  };
}

function itemsForTurn(
  value: RuntimeLiveTurn | null | undefined,
  turnId: string,
  occurredAt: string | null,
): RuntimeLiveTurnItem[] {
  if (!value) return [];
  const items = normalizedItems(value);
  if (value.turnId === turnId) return items;
  return items.map((item) => item.phase === "streaming"
    ? { ...item, phase: "awaiting-echo", completedAt: item.completedAt ?? occurredAt }
    : item);
}

export function normalizeRuntimeLiveTurn(value: unknown): RuntimeLiveTurn | null {
  const live = record(value);
  const turnId = text(live?.turnId);
  const latestText = text(live?.text);
  if (!turnId || (!latestText && !Array.isArray(live?.items) && !Array.isArray(live?.overflow))) return null;
  return bounded(turnId, normalizedItems({
    turnId,
    text: latestText,
    items: Array.isArray(live?.items) ? live.items as RuntimeLiveTurnItem[] : undefined,
    overflow: Array.isArray(live?.overflow) ? live.overflow as RuntimeLiveTurnItem[] : undefined,
  }));
}

export function runtimeLiveTurnItems(value: RuntimeLiveTurn | null | undefined): RuntimeLiveTurnItem[] {
  return value ? normalizedItems(value) : [];
}

export function appendRuntimeLiveTurnDelta(
  value: RuntimeLiveTurn | null | undefined,
  turnId: string,
  fragment: string,
  occurredAt: string | null = null,
): RuntimeLiveTurn | null {
  if (!fragment) return value ?? null;
  const current = itemsForTurn(value, turnId, occurredAt);
  const latest = current.at(-1);
  const items = latest?.phase === "streaming"
    && latest.kind !== "tool"
    ? [...current.slice(0, -1), { ...latest, kind: "assistant" as const, text: latest.text + fragment }]
    : [...current, {
      kind: "assistant" as const,
      itemId: null,
      text: fragment,
      phase: "streaming" as const,
      startedAt: occurredAt,
      completedAt: null,
    }];
  return bounded(turnId, items);
}

export function projectRuntimeLiveTurnItem(
  value: RuntimeLiveTurn | null | undefined,
  turnId: string,
  item: unknown,
  lifecycle: "started" | "completed",
  occurredAt: string | null = null,
): RuntimeLiveTurn | null {
  const identities = itemIdentities(item);
  if (!identities.length) return value ?? null;
  const phase: RuntimeLiveTurnItemPhase = lifecycle === "started" ? "streaming" : "awaiting-echo";
  let current = itemsForTurn(value, turnId, occurredAt);
  for (const identity of identities) {
    const existingIndex = identity.itemId
      ? current.findIndex((candidate) =>
        candidate.itemId === identity.itemId && (candidate.kind ?? "assistant") === identity.kind)
      : -1;
    if (existingIndex >= 0) {
      const existing = current[existingIndex]!;
      const items = current.slice();
      const preserveToolName = identity.kind === "tool" && identity.toolName === "tool";
      items[existingIndex] = {
        ...existing,
        kind: identity.kind,
        /* A non-empty completed item is authoritative: it repairs missed streamed
           suffixes and may legitimately rewrite a divergent draft. Tool-result
           records carry no arguments and retain the call summary already shown. */
        text: identity.text || existing.text,
        ...(identity.text ? { omittedChars: undefined } : {}),
        ...(identity.kind === "tool" ? {
          toolName: preserveToolName ? existing.toolName : identity.toolName,
          toolEngine: identity.toolEngine,
        } : { toolName: undefined, toolEngine: undefined }),
        phase,
        startedAt: existing.startedAt ?? occurredAt,
        completedAt: lifecycle === "completed" ? occurredAt : existing.completedAt,
      };
      current = items;
      continue;
    }
    const latest = current.at(-1);
    if (lifecycle === "completed"
      && identity.kind === "assistant"
      && latest?.phase === "streaming"
      && latest.kind !== "tool") {
      current = [
        ...current.slice(0, -1),
        {
          ...latest,
          kind: "assistant",
          itemId: identity.itemId,
          text: identity.text || latest.text,
          ...(identity.text ? { omittedChars: undefined } : {}),
          phase: "awaiting-echo",
          completedAt: occurredAt,
        },
      ];
      continue;
    }
    if (identity.kind === "assistant" && !identity.text) continue;
    current = [...current, {
      ...identity,
      phase,
      startedAt: occurredAt,
      completedAt: lifecycle === "completed" ? occurredAt : null,
    }];
  }
  return bounded(turnId, current);
}

export function completeRuntimeLiveTurnItem(
  value: RuntimeLiveTurn | null | undefined,
  turnId: string,
  item: unknown,
  occurredAt: string | null = null,
): RuntimeLiveTurn | null {
  return projectRuntimeLiveTurnItem(value, turnId, item, "completed", occurredAt);
}
