/* Source-agnostic parsing for the harness self-scheduling tools an orchestrator
   calls — `ScheduleWakeup` above all. A wakeup is not a generic tool row: the
   user needs to see WHEN the agent wakes, how long is left, and what it plans to
   check on wake. This module is pure (no React, no DOM) so both the feed card
   and the scanner (board timer chip) derive the same fire time the same way. */

/** The harness tools that get humanized rather than dumped as JSON. Only
    `ScheduleWakeup` earns the full countdown card; the others get a readable
    summary so they never render as a raw arguments blob (issue #161 §4). */
export type HarnessKind = "wakeup" | "cron" | "monitor";

export const HARNESS_TOOLS: Record<string, HarnessKind> = {
  ScheduleWakeup: "wakeup",
  CronCreate: "cron",
  CronDelete: "cron",
  Monitor: "monitor",
};

export function harnessKind(tool: string): HarnessKind | null {
  return HARNESS_TOOLS[tool] ?? null;
}

/** The parsed shape of a `ScheduleWakeup` call. `fireAt` is an absolute epoch
    (ms) when it can be derived; the card falls back to reason-only when it
    cannot. */
export interface WakeupInfo {
  /** Absolute fire time in epoch ms, or null when it could not be derived. */
  fireAt: number | null;
  /** The delay the agent requested (or recovered from the result), in seconds. */
  delaySeconds: number | null;
  /** The one-line "why" — the card's visible summary. */
  reason: string;
  /** The wake plan/report — what the agent intends to check on wake. */
  prompt: string;
}

/* The paired tool result reads e.g.
     "Next wakeup scheduled for 13:30:00 (in 1215s). …"
   The clock is the author's LOCAL time; the "(in Ns)" is the resolved delay,
   which can differ slightly from the requested delaySeconds (processing time). */
const NEXT_WAKEUP_RE = /scheduled for\s+(\d{1,2}:\d{2}:\d{2})(?:\s*\(in\s+(\d+)\s*s\))?/i;
const IN_SECONDS_RE = /\bin\s+(\d+)\s*s\b/i;

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/* Anchors a bare "HH:MM:SS" wall clock to an absolute epoch. The clock is
   interpreted in the viewer's local zone (LLV runs beside the agent, so the two
   share a clock); the day comes from the record timestamp, rolling forward one
   day when the clock already reads earlier than the record (a wakeup that
   crosses midnight). */
function fireAtFromClock(clock: string, tsMs: number | null): number | null {
  const parts = clock.split(":").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const [h, m, s] = parts;
  const base = tsMs !== null ? new Date(tsMs) : new Date();
  base.setHours(h, m, s, 0);
  let fire = base.getTime();
  if (tsMs !== null && fire < tsMs - 60_000) fire += 86_400_000;
  return fire;
}

/**
 * Parse a `ScheduleWakeup` tool call into a fire time, reason, and plan.
 * `tsMs` is the transcript entry's epoch (the moment the call was made);
 * `resultText` is the paired tool_result body, a fallback for the delay when
 * the input carried none. Fire time is derived from `tsMs + delaySeconds`
 * first (issue #161); the result's "(in Ns)" and absolute clock are fallbacks.
 */
export function parseScheduleWakeup(input: unknown, tsMs: number | null, resultText?: string | null): WakeupInfo {
  const rec = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const reason = str(rec.reason);
  const prompt = str(rec.prompt);
  let delaySeconds = num(rec.delaySeconds);

  const match = typeof resultText === "string" ? resultText.match(NEXT_WAKEUP_RE) : null;
  const inMatch = typeof resultText === "string" ? resultText.match(IN_SECONDS_RE) : null;
  if (delaySeconds === null) {
    const recovered = match?.[2] ?? inMatch?.[1];
    if (recovered) delaySeconds = Number(recovered);
  }

  let fireAt: number | null = null;
  if (tsMs !== null && delaySeconds !== null) fireAt = tsMs + delaySeconds * 1000;
  else if (match?.[1]) fireAt = fireAtFromClock(match[1], tsMs);

  return { fireAt, delaySeconds, reason, prompt };
}

/** Refines a parsed wakeup once its tool_result attaches: fills a fire time the
    call alone could not derive (no delay in the input, no valid timestamp). */
export function refineWakeupFromResult(info: WakeupInfo, tsMs: number | null, resultText: string): WakeupInfo {
  if (info.fireAt !== null) return info;
  const refined = parseScheduleWakeup({ reason: info.reason, prompt: info.prompt, delaySeconds: info.delaySeconds }, tsMs, resultText);
  return refined.fireAt !== null ? refined : info;
}

export type WakeupPhase = "pending" | "fired" | "unknown";

/** Whether a wakeup still lies in the future (pending) or has fired (past).
    A wakeup with no known fire time is "unknown" — the card shows its reason
    without a countdown. */
export function wakeupPhase(fireAt: number | null, now: number): WakeupPhase {
  if (fireAt === null) return "unknown";
  return fireAt > now ? "pending" : "fired";
}
