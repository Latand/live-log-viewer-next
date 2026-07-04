import type { CtxUsage, FileEntry } from "../types";
import { tailRecords } from "./activity";
import { globalCache } from "./caches";
import { numberValue, recordValue, stringValue } from "./json";

const ctxCache = globalCache<[number, CtxUsage | null]>("ctx");

/** Claude context windows. The map is deliberately tiny: "[1m]"-suffixed
    model ids and Fable run the 1M-token window, everything else ships the
    standard 200k. Transcripts do not record the window, so a usage total that
    exceeds the assumed window proves the session runs the larger one. */
const CLAUDE_WINDOW = 200_000;
const CLAUDE_WINDOW_1M = 1_000_000;

function buildCtx(usedTokens: number | null, windowTokens: number | null): CtxUsage | null {
  if (usedTokens === null || usedTokens <= 0 || windowTokens === null || windowTokens <= 0) return null;
  return { usedTokens, windowTokens, pct: Math.min(100, Math.round((usedTokens / windowTokens) * 100)) };
}

/** Codex: token_count events carry per-request usage plus the model context
    window — the numbers behind the TUI footer «Context N% used». The last
    request's total (prompt incl. cache reads + output) is the current context
    size; the cumulative total_token_usage overshoots across turns. */
function codexCtx(obj: Record<string, unknown>): CtxUsage | null {
  const payload = recordValue(obj.payload);
  if (!payload || stringValue(payload.type) !== "token_count") return null;
  const info = recordValue(payload.info);
  if (!info) return null;
  const usage = recordValue(info.last_token_usage) ?? recordValue(info.total_token_usage);
  if (!usage) return null;
  return buildCtx(numberValue(usage.total_tokens), numberValue(info.model_context_window));
}

/** Claude: the newest assistant record's message.usage. Context size is the
    full prompt of that call: fresh input + cache reads + cache writes. */
function claudeCtx(obj: Record<string, unknown>): CtxUsage | null {
  if (obj.type !== "assistant") return null;
  const message = recordValue(obj.message);
  const model = stringValue(message?.model);
  if (!message || model === "<synthetic>") return null;
  const usage = recordValue(message.usage);
  if (!usage) return null;
  const used =
    (numberValue(usage.input_tokens) ?? 0) +
    (numberValue(usage.cache_read_input_tokens) ?? 0) +
    (numberValue(usage.cache_creation_input_tokens) ?? 0);
  let window = model?.includes("[1m]") || model?.includes("fable") ? CLAUDE_WINDOW_1M : CLAUDE_WINDOW;
  if (used > window) window = CLAUDE_WINDOW_1M;
  return buildCtx(used, window);
}

/**
 * Context-window fullness from the newest usage record in the transcript
 * tail. Size-keyed cache like turn state — no reads beyond the tail, and an
 * unchanged file costs nothing. Tails with no usage record return null (the
 * chip disappears rather than showing a stale number).
 */
export function ctxFor(entry: FileEntry): CtxUsage | null {
  const conversationRoot = entry.root === "claude-projects" || entry.root === "codex-sessions";
  if (!conversationRoot || !entry.path.endsWith(".jsonl")) return null;
  const cached = ctxCache.get(entry.path);
  if (cached?.[0] === entry.size) return cached[1];

  let ctx: CtxUsage | null = null;
  for (const obj of tailRecords(entry.path, entry.size).reverse()) {
    ctx = entry.root === "codex-sessions" ? codexCtx(obj) : claudeCtx(obj);
    if (ctx) break;
  }
  ctxCache.set(entry.path, [entry.size, ctx]);
  return ctx;
}
