export const LIVE_TURN_TEXT_LIMIT = 64 * 1024;
export const LIVE_TURN_ITEM_LIMIT = 32;
export const LIVE_TURN_OVERFLOW_LIMIT = 512;
/** Serialized tool-argument bytes retained across the whole live window. The
    newest calls keep their arguments; older rows shed them first and keep only
    the tool name and status, marked `argsOmitted` so the UI says so. */
export const LIVE_TURN_TOOL_ARGS_LIMIT = 32 * 1024;
/** Per-row ceiling on the serialized argument projection. */
export const LIVE_TURN_TOOL_ARGS_ITEM_LIMIT = 2 * 1024;
const TOOL_ARG_STRING_LIMIT = 256;
const TOOL_ARG_KEY_LIMIT = 12;
const TOOL_NAME_LIMIT = 128;

export type RuntimeLiveTurnItemPhase = "streaming" | "awaiting-echo";
export type RuntimeLiveTurnToolStatus = "run" | "ok" | "err";
export type RuntimeLiveTurnToolEngine = "claude" | "codex";

/**
 * One tool call projected from the structured host's event stream (issue
 * #1100): the Claude stream-json `tool_use` / `tool_result` blocks and the
 * Codex app-server `item/started` / `item/completed` tool items. The row's
 * `itemId` is the engine call id — the same identity the canonical transcript
 * row carries, which is what the claim handoff keys on.
 */
export interface RuntimeLiveTurnTool {
  name: string;
  engine: RuntimeLiveTurnToolEngine;
  status: RuntimeLiveTurnToolStatus;
  /** Bounded argument projection the UI summarizes the same way it summarizes
      the transcript row (command, path, query…). Never the full payload. */
  args: Record<string, unknown>;
  /** Arguments were dropped to honor the window's argument bound. */
  argsOmitted?: boolean;
}

export interface RuntimeLiveTurnItem {
  itemId: string | null;
  text: string;
  phase: RuntimeLiveTurnItemPhase;
  startedAt: string | null;
  completedAt: string | null;
  /** Characters omitted from the live projection to honor its text bound. The
      canonical transcript remains authoritative; the UI renders this count. */
  omittedChars?: number;
  /** Extremely old descriptors folded into this explicit bounded summary. */
  omittedItems?: number;
  /** Tool activity row. Absent on prose rows and on snapshots written before
      tool projection existed, which therefore normalize to prose. */
  tool?: RuntimeLiveTurnTool;
}

export interface RuntimeLiveTurn {
  turnId: string;
  /** Latest assistant prose retained for compatibility with existing status consumers. */
  text: string;
  /** Assistant prose and tool rows awaiting canonical transcript ownership, in
      response order. */
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

function clipChars(value: string, limit: number): string {
  const points = [...value];
  return points.length > limit ? points.slice(0, limit - 1).join("") + "…" : value;
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

function itemIdentity(value: unknown): { itemId: string | null; text: string } | null {
  const item = record(value);
  if (!item) return null;
  const type = text(item.type);
  const message = record(item.message);
  const role = text(item.role) || text(message?.role);
  const assistant = type === "agentMessage"
    || type === "agent_message"
    || type === "assistant"
    || (type === "message" && role === "assistant");
  if (!assistant) return null;
  return {
    itemId: text(item.id) || text(item.uuid) || text(message?.id) || null,
    text: text(item.text) || contentText(item.content) || contentText(message?.content),
  };
}

/* ------------------------------------------------------------------ *
 * Tool activity projection                                             *
 * ------------------------------------------------------------------ */

/**
 * Bounded argument projection: a flat record whose string values are clipped,
 * nested values are folded into clipped JSON strings, and the whole thing is
 * capped by key count and serialized size. Total: any input yields a record.
 */
export function boundedToolArgs(value: unknown): Record<string, unknown> {
  const source = record(value);
  if (!source) {
    if (value === undefined || value === null || value === "") return {};
    return boundedToolArgs({ input: value });
  }
  const result: Record<string, unknown> = {};
  let keys = 0;
  for (const [key, raw] of Object.entries(source)) {
    if (keys >= TOOL_ARG_KEY_LIMIT) break;
    let projected: unknown;
    if (typeof raw === "string") projected = clipChars(raw, TOOL_ARG_STRING_LIMIT);
    else if (typeof raw === "number" || typeof raw === "boolean" || raw === null) projected = raw;
    else if (raw === undefined) continue;
    else {
      let serialized: string;
      try { serialized = JSON.stringify(raw) ?? ""; } catch { serialized = ""; }
      if (!serialized) continue;
      projected = clipChars(serialized, TOOL_ARG_STRING_LIMIT);
    }
    result[key] = projected;
    keys += 1;
  }
  /* Drop trailing keys until the serialized projection fits its per-row cap. */
  let entries = Object.entries(result);
  while (entries.length && utf8Length(JSON.stringify(Object.fromEntries(entries))) > LIVE_TURN_TOOL_ARGS_ITEM_LIMIT) {
    entries = entries.slice(0, -1);
  }
  return Object.fromEntries(entries);
}

function argsBytes(tool: RuntimeLiveTurnTool): number {
  if (!Object.keys(tool.args).length) return 0;
  try { return utf8Length(JSON.stringify(tool.args)); } catch { return 0; }
}

interface ToolActivity {
  callId: string;
  name: string | null;
  engine: RuntimeLiveTurnToolEngine;
  status: RuntimeLiveTurnToolStatus;
  args: Record<string, unknown> | null;
  /** A finish report (tool_result / item completed) as opposed to a call start. */
  finished: boolean;
}

const CODEX_TOOL_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabAgentToolCall",
  "webSearch",
  "imageView",
  "imageGeneration",
]);

function codexToolStatus(item: Record<string, unknown>, type: string): RuntimeLiveTurnToolStatus {
  const status = text(item.status).toLowerCase();
  if (status === "inprogress" || status === "in_progress" || status === "running" || status === "pending") return "run";
  if (status === "failed" || status === "error" || status === "errored" || status === "declined" || status === "cancelled" || status === "canceled") return "err";
  if (type === "commandExecution" && typeof item.exitCode === "number" && item.exitCode !== 0) return "err";
  if (type === "mcpToolCall" && item.error !== undefined && item.error !== null) return "err";
  if (type === "dynamicToolCall" && item.success === false) return "err";
  if (type === "imageGeneration" && item.failure !== undefined && item.failure !== null) return "err";
  return "ok";
}

function codexToolActivity(item: Record<string, unknown>, type: string, phase: "started" | "completed"): ToolActivity | null {
  const callId = text(item.id) || text(item.call_id) || text(item.callId);
  if (!callId || !CODEX_TOOL_ITEM_TYPES.has(type)) return null;
  const status = phase === "started" ? "run" : codexToolStatus(item, type);
  const finished = phase === "completed";
  if (type === "commandExecution") {
    const command = text(item.command);
    const cwd = text(item.cwd);
    return {
      callId,
      name: "shell",
      engine: "codex",
      status,
      args: { ...(command ? { cmd: command } : {}), ...(cwd ? { workdir: cwd } : {}) },
      finished,
    };
  }
  if (type === "fileChange") {
    /* The canonical rollout row is an `apply_patch` call, and its summarizer
       reads the patch header lines — so the live row carries a header-only
       patch naming the touched files (no hunk bodies, bounded file count). */
    const changes = Array.isArray(item.changes) ? item.changes.map(record).filter(Boolean) : [];
    const headers = changes.slice(0, 8).flatMap((change) => {
      const filePath = text(change?.path);
      if (!filePath) return [];
      const kind = text(change?.kind).toLowerCase();
      const verb = kind === "add" ? "Add" : kind === "delete" ? "Delete" : "Update";
      return [`*** ${verb} File: ${filePath}`];
    });
    return {
      callId,
      name: "apply_patch",
      engine: "codex",
      status,
      args: headers.length ? { input: ["*** Begin Patch", ...headers, "*** End Patch"].join("\n") } : {},
      finished,
    };
  }
  if (type === "mcpToolCall") {
    const server = text(item.server);
    const tool = text(item.tool) || "tool";
    return {
      callId,
      name: server ? `mcp__${server}__${tool}` : tool,
      engine: "codex",
      status,
      args: record(item.arguments) ?? {},
      finished,
    };
  }
  if (type === "dynamicToolCall") {
    return { callId, name: text(item.tool) || "tool", engine: "codex", status, args: record(item.arguments) ?? {}, finished };
  }
  if (type === "collabAgentToolCall") {
    return {
      callId,
      name: text(item.tool) || "Agent",
      engine: "codex",
      status,
      args: { ...(text(item.prompt) ? { prompt: text(item.prompt) } : {}), ...(text(item.model) ? { model: text(item.model) } : {}) },
      finished,
    };
  }
  if (type === "webSearch") {
    return { callId, name: "WebSearch", engine: "codex", status, args: { ...(text(item.query) ? { query: text(item.query) } : {}) }, finished };
  }
  if (type === "imageView") {
    return { callId, name: "view_image", engine: "codex", status, args: { ...(text(item.path) ? { path: text(item.path) } : {}) }, finished };
  }
  return {
    callId,
    name: "imagegen",
    engine: "codex",
    status,
    args: { ...(text(item.revisedPrompt) ? { prompt: text(item.revisedPrompt) } : {}) },
    finished,
  };
}

/**
 * The tool calls and tool results one host item carries, in content order.
 * Claude: an `assistant` stream message carries `tool_use` blocks (the call was
 * issued), a `user` message carries `tool_result` blocks (the call finished).
 * Codex: one app-server item per call, `started` then `completed`.
 */
function toolActivities(value: unknown, phase: "started" | "completed"): ToolActivity[] {
  const item = record(value);
  if (!item) return [];
  const type = text(item.type);
  const message = record(item.message);
  const role = text(item.role) || text(message?.role);
  const content = Array.isArray(message?.content) ? message.content : Array.isArray(item.content) ? item.content : null;
  if ((type === "assistant" || role === "assistant") && content) {
    if (phase !== "completed") return [];
    return content.flatMap((part): ToolActivity[] => {
      const block = record(part);
      if (!block || text(block.type) !== "tool_use") return [];
      const callId = text(block.id);
      if (!callId) return [];
      return [{
        callId,
        name: text(block.name) || "tool",
        engine: "claude",
        status: "run",
        args: record(block.input) ?? {},
        finished: false,
      }];
    });
  }
  if ((type === "user" || role === "user") && content) {
    return content.flatMap((part): ToolActivity[] => {
      const block = record(part);
      if (!block || text(block.type) !== "tool_result") return [];
      const callId = text(block.tool_use_id);
      if (!callId) return [];
      return [{
        callId,
        name: null,
        engine: "claude",
        status: block.is_error === true ? "err" : "ok",
        args: null,
        finished: true,
      }];
    });
  }
  const codex = codexToolActivity(item, type, phase);
  return codex ? [codex] : [];
}

function normalizedTool(value: unknown): RuntimeLiveTurnTool | null {
  const tool = record(value);
  if (!tool) return null;
  const name = text(tool.name);
  return {
    name: clipChars(name || "tool", TOOL_NAME_LIMIT),
    engine: tool.engine === "codex" ? "codex" : "claude",
    status: tool.status === "ok" ? "ok" : tool.status === "err" ? "err" : "run",
    args: boundedToolArgs(tool.args),
    ...(tool.argsOmitted === true ? { argsOmitted: true } : {}),
  };
}

function normalizedList(value: unknown): RuntimeLiveTurnItem[] {
  if (!Array.isArray(value)) return [];
  return value
      .filter((item) =>
        item
        && typeof item.text === "string"
        && (item.text.length > 0
          || (item.omittedChars ?? 0) > 0
          || (item.omittedItems ?? 0) > 0
          || normalizedTool(item.tool) !== null))
      .map((item) => {
        const tool = normalizedTool(item.tool);
        return {
          itemId: typeof item.itemId === "string" ? item.itemId : null,
          text: tool ? "" : item.text,
          phase: tool ? "awaiting-echo" as const : item.phase === "awaiting-echo" ? "awaiting-echo" as const : "streaming" as const,
          startedAt: typeof item.startedAt === "string" ? item.startedAt : null,
          completedAt: typeof item.completedAt === "string" ? item.completedAt : null,
          ...(typeof item.omittedChars === "number" && item.omittedChars > 0
            ? { omittedChars: Math.floor(item.omittedChars) }
            : {}),
          ...(typeof item.omittedItems === "number" && item.omittedItems > 0
            ? { omittedItems: Math.floor(item.omittedItems) }
            : {}),
          ...(tool ? { tool } : {}),
        };
      });
}

function normalizedItems(value: RuntimeLiveTurn): RuntimeLiveTurnItem[] {
  if (Array.isArray(value.items) || Array.isArray(value.overflow)) {
    return [...normalizedList(value.overflow), ...normalizedList(value.items)];
  }
  return value.text
    ? [{
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
  /* Tool arguments are bounded across the window newest-first: the calls the
     operator is watching keep their detail, older rows fall back to name and
     status and say so. */
  let argsBudget = LIVE_TURN_TOOL_ARGS_LIMIT;
  const stripArgs = new Set<number>();
  for (let index = kept.length - 1; index >= 0; index -= 1) {
    const tool = kept[index]!.tool;
    if (!tool) continue;
    const bytes = argsBytes(tool);
    if (!bytes) continue;
    if (bytes <= argsBudget) {
      argsBudget -= bytes;
      continue;
    }
    stripArgs.add(index);
  }
  if (stripArgs.size) {
    kept = kept.map((item, index) => stripArgs.has(index) && item.tool
      ? { ...item, tool: { ...item.tool, args: {}, argsOmitted: true } }
      : item);
  }
  if (!kept.length) return null;
  const activeStart = Math.max(0, kept.length - LIVE_TURN_ITEM_LIMIT);
  const overflow = kept.slice(0, activeStart);
  const active = kept.slice(activeStart);
  return {
    turnId,
    text: kept.findLast((item) => !item.tool)?.text ?? "",
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
  const items = latest?.phase === "streaming" && !latest.tool
    ? [...current.slice(0, -1), { ...latest, text: latest.text + fragment }]
    : [...current, {
      itemId: null,
      text: fragment,
      phase: "streaming" as const,
      startedAt: occurredAt,
      completedAt: null,
    }];
  return bounded(turnId, items);
}

function projectAssistantText(
  current: RuntimeLiveTurnItem[],
  identity: { itemId: string | null; text: string },
  occurredAt: string | null,
): RuntimeLiveTurnItem[] {
  const existingIndex = identity.itemId
    ? current.findIndex((candidate) => !candidate.tool && candidate.itemId === identity.itemId)
    : -1;
  if (existingIndex >= 0) {
    const existing = current[existingIndex]!;
    const items = current.slice();
    items[existingIndex] = {
      ...existing,
      /* A non-empty completed item is authoritative: it repairs missed streamed
         suffixes and may legitimately rewrite a divergent draft. Engines that
         complete with an empty body leave the observed stream intact. */
      text: identity.text || existing.text,
      ...(identity.text ? { omittedChars: undefined } : {}),
      phase: "awaiting-echo",
      completedAt: occurredAt,
    };
    return items;
  }
  const latest = current.at(-1);
  if (latest?.phase === "streaming" && !latest.tool) {
    return [
      ...current.slice(0, -1),
      {
        ...latest,
        itemId: identity.itemId,
        text: identity.text || latest.text,
        ...(identity.text ? { omittedChars: undefined } : {}),
        phase: "awaiting-echo",
        completedAt: occurredAt,
      },
    ];
  }
  if (!identity.text) return current;
  return [...current, {
    itemId: identity.itemId,
    text: identity.text,
    phase: "awaiting-echo",
    startedAt: occurredAt,
    completedAt: occurredAt,
  }];
}

function projectToolActivity(
  current: RuntimeLiveTurnItem[],
  activity: ToolActivity,
  occurredAt: string | null,
): RuntimeLiveTurnItem[] {
  const existingIndex = current.findIndex((candidate) => candidate.tool && candidate.itemId === activity.callId);
  if (existingIndex >= 0) {
    const existing = current[existingIndex]!;
    const tool = existing.tool!;
    const items = current.slice();
    items[existingIndex] = {
      ...existing,
      completedAt: activity.finished ? occurredAt : existing.completedAt,
      tool: {
        ...tool,
        name: activity.name ? clipChars(activity.name, TOOL_NAME_LIMIT) : tool.name,
        /* A replayed call record never demotes a finished row back to running. */
        status: activity.finished || tool.status === "run" ? activity.status : tool.status,
        /* A finish report carries no arguments and keeps the call's own; a
           repeated call record (replay) refreshes them. */
        ...(activity.args && Object.keys(activity.args).length && !tool.argsOmitted
          ? { args: boundedToolArgs(activity.args) }
          : {}),
      },
    };
    return items;
  }
  /* A finish for a call this projection never saw (its call record was bounded
     away, or predates the snapshot) still tells the operator a tool ran. */
  return [...current, {
    itemId: activity.callId,
    text: "",
    phase: "awaiting-echo",
    startedAt: occurredAt,
    completedAt: activity.finished ? occurredAt : null,
    tool: {
      name: clipChars(activity.name || "tool", TOOL_NAME_LIMIT),
      engine: activity.engine,
      status: activity.status,
      args: boundedToolArgs(activity.args ?? {}),
    },
  }];
}

/**
 * Project one host item into the live turn: assistant prose (completed only)
 * and tool activity (calls and results), in the item's own content order.
 */
export function projectRuntimeLiveTurnItem(
  value: RuntimeLiveTurn | null | undefined,
  turnId: string,
  item: unknown,
  phase: "started" | "completed",
  occurredAt: string | null = null,
): RuntimeLiveTurn | null {
  const identity = phase === "completed" ? itemIdentity(item) : null;
  const activities = toolActivities(item, phase);
  if (!identity && !activities.length) return value ?? null;
  const before = itemsForTurn(value, turnId, occurredAt);
  let current = before;
  /* Claude puts prose before the `tool_use` blocks of the same message, so the
     text projects first and the calls follow it in response order. */
  if (identity) current = projectAssistantText(current, identity, occurredAt);
  for (const activity of activities) current = projectToolActivity(current, activity, occurredAt);
  /* An empty-bodied completion with nothing to settle leaves the turn as is. */
  if (current === before) return value ?? null;
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
