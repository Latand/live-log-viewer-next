export const LIVE_TURN_TEXT_LIMIT = 64 * 1024;
export const LIVE_TURN_ITEM_LIMIT = 32;
export const LIVE_TURN_OVERFLOW_LIMIT = 512;
const LIVE_TURN_TOOL_TEXT_FLOOR = 96;

export type RuntimeLiveTurnItemPhase = "streaming" | "awaiting-echo";
export type RuntimeLiveTurnItemKind = "assistant" | "tool";
export type RuntimeLiveTurnToolEngine = "claude" | "codex";

export interface RuntimeLiveTurnItem {
  /** Missing only on legacy snapshots, which normalize to assistant prose. */
  kind?: RuntimeLiveTurnItemKind;
  /** Durable projection identity used only for row reconciliation. */
  rowId?: string;
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

function boundedToolJson(value: string, maxBytes: number): string {
  if (maxBytes < 2) return "";
  let source: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
    source = parsed as Record<string, unknown>;
  } catch {
    return "";
  }
  if (utf8Length(value) <= maxBytes) return value;
  const result: Record<string, unknown> = {};
  for (const [key, candidate] of Object.entries(source)) {
    const complete = JSON.stringify({ ...result, [key]: candidate });
    if (utf8Length(complete) <= maxBytes) {
      result[key] = candidate;
      continue;
    }
    if (typeof candidate !== "string") continue;
    const points = [...candidate];
    let low = 0;
    let high = points.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const trial = JSON.stringify({ ...result, [key]: points.slice(0, middle).join("") });
      if (utf8Length(trial) <= maxBytes) low = middle;
      else high = middle - 1;
    }
    const trial = JSON.stringify({ ...result, [key]: points.slice(0, low).join("") });
    if (utf8Length(trial) <= maxBytes) result[key] = points.slice(0, low).join("");
  }
  const serialized = JSON.stringify(result);
  return utf8Length(serialized) <= maxBytes ? serialized : "";
}

function trimToolText(value: string, maxBytes: number): {
  omittedChars: number;
  text: string;
} {
  const boundedText = boundedToolJson(value, maxBytes);
  return {
    omittedChars: Math.max(0, [...value].length - [...boundedText].length),
    text: boundedText,
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
  rowId?: string;
  itemId: string | null;
  text: string;
  toolName?: string;
  toolEngine?: RuntimeLiveTurnToolEngine;
  lifecycle?: "started" | "completed";
  omittedChars?: number;
}

function serializedToolArgs(value: unknown): string {
  try {
    const normalized = value ?? {};
    if (record(normalized) && Object.keys(normalized).length === 0) return "";
    const serialized = JSON.stringify(normalized);
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
    ...(itemId ? { rowId: `tool:${itemId}` } : {}),
    itemId,
    text: serializedToolArgs(toolArgs(args)),
    toolName: toolName.slice(0, 256) || "tool",
    toolEngine,
  };
}

function codexToolIdentity(item: Record<string, unknown>, type: string): ProjectedItem | null {
  const itemId = text(item.call_id) || text(item.id) || null;
  if (type === "commandExecution") {
    const command = text(item.command);
    const workdir = text(item.cwd);
    return projectedTool(itemId, "exec_command", {
      ...(command ? { cmd: command } : {}),
      ...(workdir ? { workdir } : {}),
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
    return content.flatMap((value, blockIndex): ProjectedItem[] => {
      const part = record(value);
      if (!part) return [];
      const partType = text(part.type);
      if (partType === "text" || partType === "input_text" || partType === "output_text") {
        const prose = text(part.text);
        return prose ? [{
          kind: "assistant",
          ...(parentId ? { rowId: `assistant:${parentId}:${blockIndex}` } : {}),
          itemId: parentId,
          text: prose,
          ...(typeof part.omittedChars === "number" && part.omittedChars > 0
            ? { omittedChars: Math.floor(part.omittedChars) }
            : {}),
        }] : [];
      }
      if (partType === "tool_use") {
        return [{
          ...projectedTool(
            text(part.id) || null,
            text(part.name) || "tool",
            part.input,
            "claude",
          ),
          lifecycle: "started",
        }];
      }
      return [];
    });
  }
  if (assistant) {
    return [{
      kind: "assistant",
      ...(parentId ? { rowId: `assistant:${parentId}` } : {}),
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
        ...(text(part.tool_use_id) ? { rowId: `tool:${text(part.tool_use_id)}` } : {}),
        itemId: text(part.tool_use_id) || null,
        text: "",
        toolName: "tool",
        toolEngine: "claude",
        lifecycle: "completed",
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
        ...(typeof item.rowId === "string" && item.rowId ? { rowId: item.rowId } : {}),
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
      rowId: `overflow:${turnId}:${omittedCount}`,
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
      const floor = item.kind === "tool" ? Math.min(before, LIVE_TURN_TOOL_TEXT_FLOOR) : 0;
      const removedBytes = Math.min(excess, Math.max(0, before - floor));
      const retainedBytes = before - removedBytes;
      const trimmed = item.kind === "tool"
        ? trimToolText(item.text, retainedBytes)
        : trimUtf8Start(item.text, removedBytes);
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
      rowId: `assistant:${turnId}:${current.length}:${occurredAt ?? "live"}`,
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
  const identities = itemIdentities(item).filter((identity) =>
    lifecycle === "completed" || identity.kind === "tool");
  if (!identities.length) return value ?? null;
  let current = itemsForTurn(value, turnId, occurredAt);
  const matchedIndexes = new Set<number>();
  for (const identity of identities) {
    const identityLifecycle = identity.lifecycle ?? lifecycle;
    const phase: RuntimeLiveTurnItemPhase = identityLifecycle === "started" ? "streaming" : "awaiting-echo";
    const existingIndex = identity.itemId
      ? current.findIndex((candidate, index) =>
        !matchedIndexes.has(index)
        && candidate.itemId === identity.itemId
        && (candidate.kind ?? "assistant") === identity.kind)
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
        ...(identity.text ? { omittedChars: identity.omittedChars } : {}),
        ...(identity.kind === "tool" ? {
          toolName: preserveToolName ? existing.toolName : identity.toolName,
          toolEngine: identity.toolEngine,
        } : { toolName: undefined, toolEngine: undefined }),
        phase,
        startedAt: existing.startedAt ?? occurredAt,
        completedAt: identityLifecycle === "completed" ? occurredAt : null,
      };
      current = items;
      matchedIndexes.add(existingIndex);
      continue;
    }
    const latest = current.at(-1);
    if (identityLifecycle === "completed"
      && identity.kind === "assistant"
      && latest?.phase === "streaming"
      && latest.kind !== "tool"
      && !matchedIndexes.has(current.length - 1)) {
      current = [
        ...current.slice(0, -1),
        {
          ...latest,
          kind: "assistant",
          itemId: identity.itemId,
          text: identity.text || latest.text,
          ...(identity.text ? { omittedChars: identity.omittedChars } : {}),
          phase: "awaiting-echo",
          completedAt: occurredAt,
        },
      ];
      matchedIndexes.add(current.length - 1);
      continue;
    }
    if (identity.kind === "assistant" && !identity.text) continue;
    current = [...current, {
      ...identity,
      rowId: identity.rowId
        ?? `${identity.kind}:${turnId}:${current.length}:${identity.itemId ?? occurredAt ?? "live"}`,
      phase,
      startedAt: occurredAt,
      completedAt: identityLifecycle === "completed" ? occurredAt : null,
    }];
    matchedIndexes.add(current.length - 1);
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
