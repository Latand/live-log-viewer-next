import fs from "node:fs";

import { ROTATION_THRESHOLD_FRACTION, type ContextWindowPolicy } from "./contextPolicy";

/* get_orchestrator's reporting core (two-axis contract).
 *
 * Everything here is a READ and a RECOMMENDATION. Context pressure produces a
 * recommendation with reasons and nothing else: no heuristic in this module —
 * or anywhere downstream of it — may retire, rotate or replace an orchestrator
 * on its own. Numbers that are inferred rather than measured are CLEARLY
 * labelled estimates, with the basis spelled out, so an operator never mistakes
 * a bytes-derived guess for a provider-reported token count.
 *
 * Pure over gathered facts; the transcript-reading helpers are the only I/O and
 * are separately injectable.
 */

/** Bounded reads and total search depth for provider-reported usage records. */
const USAGE_SCAN_CHUNK_BYTES = 256 * 1024;
const USAGE_SCAN_MAX_BYTES = 4 * 1024 * 1024;

export interface OrchestratorContextReading {
  /** Tokens currently in context, or null when nothing could be read at all. */
  tokens: number | null;
  limit: number | null;
  /** 0-100, when both tokens and limit are known. */
  percent: number | null;
  /** TRUE means at least one component is inferred, not provider-reported. */
  estimated: boolean;
  /** Where the numbers came from, operator-readable. */
  basis: string;
  /** Which context-window policy row supplied the limit; null when none is
      configured for this model — in which case no window was assumed. */
  policy: string | null;
}

export interface OrchestratorTranscriptFacts {
  transcriptBytes: number | null;
  messageCount: number | null;
  toolCount: number | null;
  /** Compaction records observed in the transcript. Engine-dependent: what the
      transcript records is what is counted. */
  compactionCount: number | null;
  /** Provider-reported context tokens from the newest usage record, if any. */
  reportedContextTokens: number | null;
}

/** Bytes and provider usage from the transcript on disk; null facts when the
    file is missing or unreadable — absence is reported, never guessed. */
export function readOrchestratorTranscriptFacts(
  path: string | null,
  session: { messages: number; tools: number; compactions: number } | null,
): OrchestratorTranscriptFacts {
  let bytes: number | null = null;
  if (path) {
    try {
      bytes = fs.statSync(path).size;
    } catch {
      bytes = null;
    }
  }
  return {
    transcriptBytes: bytes,
    messageCount: session?.messages ?? null,
    toolCount: session?.tools ?? null,
    compactionCount: session?.compactions ?? null,
    reportedContextTokens: path && bytes !== null ? lastReportedContextTokens(path, bytes) : null,
  };
}

/**
 * The newest provider-reported context size near the end of the transcript.
 *
 * Claude rows carry `message.usage` (input + cache reads/creation is what sat
 * in context for that turn); Codex rollouts carry token-usage info events.
 * Bounded chunks are scanned backwards, newest line first, up to a fixed cap.
 * Incomplete rows are carried as bytes so a chunk boundary cannot corrupt JSON
 * or split a multi-byte character before the row is parsed.
 */
export function lastReportedContextTokens(path: string, totalBytes: number): number | null {
  try {
    const descriptor = fs.openSync(path, "r");
    try {
      const scanStart = Math.max(0, totalBytes - USAGE_SCAN_MAX_BYTES);
      const precedingByte = Buffer.alloc(1);
      const scanStartsAtRowBoundary = scanStart === 0
        || (fs.readSync(descriptor, precedingByte, 0, 1, scanStart - 1) === 1 && precedingByte[0] === 0x0a);
      let cursor = totalBytes;
      let newerRowSuffix = Buffer.alloc(0);

      while (cursor > scanStart) {
        const start = Math.max(scanStart, cursor - USAGE_SCAN_CHUNK_BYTES);
        const buffer = Buffer.alloc(cursor - start);
        const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, start);
        const combined = newerRowSuffix.length > 0
          ? Buffer.concat([buffer.subarray(0, bytesRead), newerRowSuffix])
          : buffer.subarray(0, bytesRead);
        const firstNewline = combined.indexOf(0x0a);
        const reachedCompleteRowBoundary = start === scanStart && scanStartsAtRowBoundary;

        if (reachedCompleteRowBoundary || firstNewline >= 0) {
          const completeRows = reachedCompleteRowBoundary ? combined : combined.subarray(firstNewline + 1);
          const tokens = lastReportedContextTokensInRows(completeRows);
          if (tokens !== null) return tokens;
        }

        if (reachedCompleteRowBoundary) {
          newerRowSuffix = Buffer.alloc(0);
        } else if (firstNewline >= 0) {
          newerRowSuffix = combined.subarray(0, firstNewline);
        } else {
          newerRowSuffix = combined;
        }
        cursor = start;
      }
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return null;
  }
  return null;
}

function lastReportedContextTokensInRows(rows: Buffer): number | null {
  let lineEnd = rows.length;
  while (lineEnd > 0) {
    const newline = rows.lastIndexOf(0x0a, lineEnd - 1);
    const line = rows.subarray(newline + 1, lineEnd);
    lineEnd = Math.max(0, newline);
    if (!line.includes("input_tokens")) continue;
    try {
      const row = JSON.parse(line.toString("utf8")) as Record<string, unknown>;
      const tokens = claudeUsageTokens(row) ?? codexUsageTokens(row);
      if (tokens !== null) return tokens;
    } catch {
      /* a non-JSON row that happens to mention input_tokens */
    }
  }
  return null;
}

function usageObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function tokenSum(usage: Record<string, unknown>, keys: string[]): number | null {
  const primary = usage[keys[0]!];
  if (typeof primary !== "number") return null;
  return keys.reduce((sum, key) => sum + (typeof usage[key] === "number" ? usage[key] as number : 0), 0);
}

function claudeUsageTokens(row: Record<string, unknown>): number | null {
  const usage = usageObject(usageObject(row.message)?.usage) ?? usageObject(row.usage);
  if (!usage) return null;
  return tokenSum(usage, ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]);
}

function codexUsageTokens(row: Record<string, unknown>): number | null {
  const info = usageObject(usageObject(row.payload)?.info);
  const usage = usageObject(info?.last_token_usage) ?? usageObject(info?.total_token_usage);
  if (!usage) return null;
  return tokenSum(usage, ["input_tokens", "cached_input_tokens"]);
}

/**
 * The context reading, with its provenance. A provider-reported count is the
 * real number and always beats a derived one; with nothing reported, the
 * byte-derived guess is returned but LABELLED — `estimated: true`, basis
 * naming the arithmetic. The limit comes from the named window policy
 * (`./contextPolicy`) and is never assumed for a model with no entry.
 */
export function contextReading(input: {
  policy: ContextWindowPolicy | null;
  facts: OrchestratorTranscriptFacts;
}): OrchestratorContextReading {
  const limit = input.policy?.windowTokens ?? null;
  const policy = input.policy?.policy ?? null;
  const reported = input.facts.reportedContextTokens;
  if (reported !== null) {
    return {
      tokens: reported,
      limit,
      percent: limit ? Math.min(100, Math.round((reported / limit) * 100)) : null,
      estimated: false,
      basis: "provider-reported usage from the transcript's newest turn",
      policy,
    };
  }
  if (input.facts.transcriptBytes !== null) {
    const guess = Math.round(input.facts.transcriptBytes / 4);
    return {
      tokens: guess,
      limit,
      percent: limit ? Math.min(100, Math.round((guess / limit) * 100)) : null,
      estimated: true,
      basis: "ESTIMATE: transcript bytes / 4 — no provider-reported usage found",
      policy,
    };
  }
  return { tokens: null, limit, percent: null, estimated: true, basis: "no transcript to read", policy };
}

/** The prominent advisory marker (operator decision): present in the payload
    exactly when usage reached the configured threshold, and never anything
    but a string. */
export const STRONGLY_RECOMMEND_ROTATION = "STRONGLY_RECOMMEND_ROTATION" as const;

export interface RotationRecommendation {
  /** A recommendation and NOTHING more: no caller may act on it automatically. */
  recommended: boolean;
  /** `strongly_recommend` exactly when usage reached the configured threshold;
      `recommend` for secondary wear signals; `none` otherwise. */
  level: "none" | "recommend" | "strongly_recommend";
  /** {@link STRONGLY_RECOMMEND_ROTATION} at strongly_recommend, else null. */
  advisory: typeof STRONGLY_RECOMMEND_ROTATION | null;
  reasons: string[];
  /** The policy that was applied, spelled out, or null when none is
      configured for this model. */
  threshold: { windowTokens: number; thresholdTokens: number; fraction: number; policy: string } | null;
  /** TRUE when usage is known but no window policy exists to judge it by —
      stated plainly instead of inventing a window. */
  thresholdUnknown: boolean;
}

const ROTATION_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const ROTATION_COMPACTIONS = 2;
const MAX_REASONS = 4;

/**
 * Bounded rotation advice (operator decision). Reaching the configured
 * context threshold changes exactly ONE thing: what this function SAYS —
 * `strongly_recommend` with the {@link STRONGLY_RECOMMEND_ROTATION} advisory.
 * The return value is plain serializable data with no action, no target and
 * no side effect on any path; rotation happens only when rotate_orchestrator
 * is explicitly called. Every reason names its threshold and whether the
 * number behind it is an estimate.
 */
export function rotationRecommendation(input: {
  context: OrchestratorContextReading;
  facts: OrchestratorTranscriptFacts;
  activity: string | null;
  policy: ContextWindowPolicy | null;
}): RotationRecommendation {
  const reasons: string[] = [];
  let level: RotationRecommendation["level"] = "none";

  if (input.policy && input.context.tokens !== null && input.context.tokens >= input.policy.rotationThresholdTokens) {
    level = "strongly_recommend";
    reasons.push(
      `context usage ${input.context.tokens.toLocaleString("en-US")} tokens${input.context.estimated ? " (estimate)" : ""} has reached the rotation threshold of ${input.policy.rotationThresholdTokens.toLocaleString("en-US")} tokens (${input.policy.policy}: ${Math.round(ROTATION_THRESHOLD_FRACTION * 100)}% of a ${input.policy.windowTokens.toLocaleString("en-US")}-token window)`,
    );
  }
  if (input.facts.compactionCount !== null && input.facts.compactionCount >= ROTATION_COMPACTIONS) {
    reasons.push(`${input.facts.compactionCount} compaction(s) recorded in the transcript, threshold ${ROTATION_COMPACTIONS}`);
  }
  if (input.facts.transcriptBytes !== null && input.facts.transcriptBytes >= ROTATION_TRANSCRIPT_BYTES) {
    reasons.push(`transcript is ${(input.facts.transcriptBytes / (1024 * 1024)).toFixed(1)} MB, threshold ${ROTATION_TRANSCRIPT_BYTES / (1024 * 1024)} MB`);
  }
  if (input.activity === "dead") {
    reasons.push("the designated conversation's host is gone; rotate, or resume it with send_message_to_orchestrator");
  }
  if (level === "none" && reasons.length > 0) level = "recommend";

  return {
    recommended: reasons.length > 0,
    level,
    advisory: level === "strongly_recommend" ? STRONGLY_RECOMMEND_ROTATION : null,
    reasons: reasons.slice(0, MAX_REASONS),
    threshold: input.policy
      ? {
        windowTokens: input.policy.windowTokens,
        thresholdTokens: input.policy.rotationThresholdTokens,
        fraction: ROTATION_THRESHOLD_FRACTION,
        policy: input.policy.policy,
      }
      : null,
    thresholdUnknown: !input.policy && input.context.tokens !== null,
  };
}
