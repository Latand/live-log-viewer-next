import type { CtxConfidence, CtxSource, CtxUsage, FileEntry } from "../types";
import { tailRecords } from "./activity";
import { globalCache } from "./caches";
import { numberValue, recordValue, stringValue } from "./json";
import { MODEL_REGISTRY_VERSION, normalizeModelKey, registryWindow } from "./modelRegistry";

const ctxCache = globalCache<[number, CtxUsage | null]>("ctx");
const CLAUDE_1M_MODE = "context-1m-2025-08-07";

interface ContextCapacity {
  windowTokens: number;
  source: Exclude<CtxSource, "unknown">;
  confidence: Exclude<CtxConfidence, "unknown">;
  registryVersion?: string;
}

function unknownUsage(usedTokens: number, observedAt: string): CtxUsage {
  return { usedTokens, windowTokens: null, pct: null, source: "unknown", confidence: "unknown", observedAt };
}

export function contextUsage(usedTokens: number | null, capacity: ContextCapacity | null, observedAt: string): CtxUsage | null {
  if (usedTokens === null || usedTokens <= 0) return null;
  if (!capacity || capacity.windowTokens <= 0) return unknownUsage(usedTokens, observedAt);
  if (capacity.source !== "runtime" && usedTokens > capacity.windowTokens) return unknownUsage(usedTokens, observedAt);
  const cap = capacity.source === "registry" ? 99 : 100;
  return {
    usedTokens,
    windowTokens: capacity.windowTokens,
    pct: Math.min(cap, Math.round((usedTokens / capacity.windowTokens) * 100)),
    source: capacity.source,
    confidence: capacity.confidence,
    ...(capacity.registryVersion ? { registryVersion: capacity.registryVersion } : {}),
    observedAt,
  };
}

function recordObservedAt(obj: Record<string, unknown>, fallback: string): string {
  const raw = stringValue(obj.timestamp);
  const millis = raw ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(millis) ? new Date(millis).toISOString() : fallback;
}

function codexCtx(obj: Record<string, unknown>, fallbackObservedAt: string): CtxUsage | null {
  const payload = recordValue(obj.payload);
  if (!payload || stringValue(payload.type) !== "token_count") return null;
  const info = recordValue(payload.info);
  if (!info) return null;
  const usage = recordValue(info.last_token_usage) ?? recordValue(info.total_token_usage);
  const windowTokens = numberValue(info.model_context_window);
  if (!usage || windowTokens === null || windowTokens <= 0) return null;
  return contextUsage(
    numberValue(usage.total_tokens),
    { windowTokens, source: "runtime", confidence: "exact" },
    recordObservedAt(obj, fallbackObservedAt),
  );
}

function claudeCapacity(message: Record<string, unknown>, model: string, modes: readonly string[]): ContextCapacity | null {
  const runtimeWindow = numberValue(message.context_window) ?? numberValue(message.model_context_window);
  if (runtimeWindow !== null && runtimeWindow > 0) {
    return { windowTokens: runtimeWindow, source: "runtime", confidence: "exact" };
  }
  const normalized = normalizeModelKey(model);
  if (!normalized) return null;
  const mode = modes.some((value) => value.toLowerCase().includes(CLAUDE_1M_MODE)) ? "1m" : normalized.mode;
  const windowTokens = registryWindow(normalized.key, mode);
  return windowTokens === null
    ? null
    : { windowTokens, source: "registry", confidence: "approximate", registryVersion: MODEL_REGISTRY_VERSION };
}

function claudeCtx(obj: Record<string, unknown>, fallbackObservedAt: string): CtxUsage | null {
  if (obj.type !== "assistant") return null;
  const message = recordValue(obj.message);
  const model = stringValue(message?.model);
  if (!message || !model || model === "<synthetic>") return null;
  const usage = recordValue(message.usage);
  if (!usage) return null;
  const used =
    (numberValue(usage.input_tokens) ?? 0) +
    (numberValue(usage.cache_read_input_tokens) ?? 0) +
    (numberValue(usage.cache_creation_input_tokens) ?? 0);
  const modes = [obj.beta, obj.betas, message.beta, message.betas]
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .filter((value): value is string => typeof value === "string");
  return contextUsage(used, claudeCapacity(message, model, modes), recordObservedAt(obj, fallbackObservedAt));
}

/** Context usage from the newest in-band usage record. Capacity resolution is
    synchronous and stays bound to the same record as its token count. */
export function ctxFor(entry: FileEntry): CtxUsage | null {
  const conversationRoot = entry.root === "claude-projects" || entry.root === "codex-sessions";
  if (!conversationRoot || !entry.path.endsWith(".jsonl")) return null;
  const cached = ctxCache.get(entry.path);
  if (cached?.[0] === entry.size) return cached[1];

  const fallbackObservedAt = new Date().toISOString();
  let ctx: CtxUsage | null = null;
  for (const obj of tailRecords(entry.path, entry.size).reverse()) {
    ctx = entry.root === "codex-sessions" ? codexCtx(obj, fallbackObservedAt) : claudeCtx(obj, fallbackObservedAt);
    if (ctx) break;
  }
  ctxCache.set(entry.path, [entry.size, ctx]);
  return ctx;
}
