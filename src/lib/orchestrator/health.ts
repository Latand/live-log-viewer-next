import fs from "node:fs";

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

/** How many tail bytes are scanned for a provider-reported usage record. */
const USAGE_SCAN_TAIL_BYTES = 256 * 1024;

/** Claude context window; the one limit this codebase can state for its own
    managed engines. Codex model limits vary by account tier and are reported
    as unknown rather than guessed. */
const CLAUDE_CONTEXT_LIMIT_TOKENS = 200_000;

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
 * The newest provider-reported context size in the transcript tail.
 *
 * Claude rows carry `message.usage` (input + cache reads/creation is what sat
 * in context for that turn); Codex rollouts carry token-usage info events.
 * Only the tail is scanned, newest line first — this is a status read, not a
 * transcript parse, and it must stay cheap on a multi-megabyte file.
 */
export function lastReportedContextTokens(path: string, totalBytes: number): number | null {
  let tail: string;
  try {
    const descriptor = fs.openSync(path, "r");
    try {
      const start = Math.max(0, totalBytes - USAGE_SCAN_TAIL_BYTES);
      const buffer = Buffer.alloc(Math.min(USAGE_SCAN_TAIL_BYTES, totalBytes));
      fs.readSync(descriptor, buffer, 0, buffer.length, start);
      tail = buffer.toString("utf8");
    } finally {
      fs.closeSync(descriptor);
    }
  } catch {
    return null;
  }
  const lines = tail.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!line.includes("input_tokens")) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const tokens = claudeUsageTokens(row) ?? codexUsageTokens(row);
      if (tokens !== null) return tokens;
    } catch {
      /* a truncated first line of the tail window, or a non-JSON row */
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
 * real number; with nothing reported, the byte-derived guess is returned but
 * LABELLED — `estimated: true`, basis naming the arithmetic — and a limit is
 * only stated for engines whose window this codebase actually knows.
 */
export function contextReading(input: {
  engine: string | null;
  facts: OrchestratorTranscriptFacts;
}): OrchestratorContextReading {
  const limit = input.engine === "claude" ? CLAUDE_CONTEXT_LIMIT_TOKENS : null;
  const reported = input.facts.reportedContextTokens;
  if (reported !== null) {
    return {
      tokens: reported,
      limit,
      percent: limit ? Math.min(100, Math.round((reported / limit) * 100)) : null,
      estimated: false,
      basis: "provider-reported usage from the transcript's newest turn",
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
    };
  }
  return { tokens: null, limit, percent: null, estimated: true, basis: "no transcript to read" };
}

export interface RotationRecommendation {
  /** A recommendation and NOTHING more: no caller may act on it automatically. */
  recommended: boolean;
  reasons: string[];
}

const ROTATION_CONTEXT_PERCENT = 70;
const ROTATION_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const ROTATION_COMPACTIONS = 2;
const MAX_REASONS = 4;

/**
 * Bounded rotation advice. Every reason names its threshold and whether the
 * number behind it is an estimate. Deliberately incapable of acting: rotation
 * happens only when an operator (or an agent the operator directed) calls
 * rotate_orchestrator explicitly.
 */
export function rotationRecommendation(input: {
  context: OrchestratorContextReading;
  facts: OrchestratorTranscriptFacts;
  activity: string | null;
}): RotationRecommendation {
  const reasons: string[] = [];
  if (input.context.percent !== null && input.context.percent >= ROTATION_CONTEXT_PERCENT) {
    reasons.push(`context at ${input.context.percent}% of the window${input.context.estimated ? " (estimate)" : ""}, threshold ${ROTATION_CONTEXT_PERCENT}%`);
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
  return { recommended: reasons.length > 0, reasons: reasons.slice(0, MAX_REASONS) };
}
