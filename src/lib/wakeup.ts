/* Source-agnostic parsing for the harness self-scheduling tools an orchestrator
   calls — `ScheduleWakeup` above all. A wakeup card exists to surface WHEN the
   agent wakes, how long is left, and what it plans to check on wake, which a
   generic tool row hides. This module is pure (no React, no DOM) so both the
   feed card and the scanner (board timer chip) derive the same fire time. */

/** The harness tools that get a human summary. Only `ScheduleWakeup` earns the
    full countdown card; the others get a readable summary so their arguments
    render as prose and never as a raw JSON blob (issue #161 §4). */
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

/* Anchors a bare "HH:MM:SS" wall clock to an absolute epoch.

   TIMEZONE CONTRACT: the clock is interpreted as UTC, so the scanner (a Node
   server whose container may leave TZ unset, defaulting to UTC) and the feed
   (the browser, in the user's local zone) resolve the SAME epoch and never
   disagree. This path only runs for a clock-only result with no "(in Ns)" — a
   degenerate shape a real `ScheduleWakeup` result never emits, so the primary
   `tsMs + delay` derivation (below) carries every real call and is itself
   timezone-independent. The day comes from the record timestamp, rolling
   forward one day when the UTC clock already reads earlier than the record. */
function fireAtFromClock(clock: string, tsMs: number | null): number | null {
  const parts = clock.split(":").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const [h, m, s] = parts;
  const base = tsMs !== null ? new Date(tsMs) : new Date();
  base.setUTCHours(h, m, s, 0);
  let fire = base.getTime();
  if (tsMs !== null && fire < tsMs - 60_000) fire += 86_400_000;
  return fire;
}

/**
 * Parse a `ScheduleWakeup` tool call into a fire time, reason, and plan.
 * `tsMs` is the transcript entry's epoch (the moment the call was made);
 * `resultText` is the paired tool_result body.
 *
 * The harness may adjust the requested `delaySeconds` (processing time), so its
 * result — "Next wakeup scheduled for HH:MM:SS (in Ns)" — carries the RESOLVED
 * schedule that actually fires. The fire time is derived from `tsMs` plus the
 * resolved "(in Ns)" delay: authoritative over the requested delay AND
 * timezone-independent, so the Node scanner and the browser feed agree
 * regardless of either runtime's zone. The requested `delaySeconds` applies
 * before the result attaches (a live card); the bare absolute clock is a last
 * resort (see the UTC contract on `fireAtFromClock`).
 */
export function parseScheduleWakeup(input: unknown, tsMs: number | null, resultText?: string | null): WakeupInfo {
  const rec = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const reason = str(rec.reason);
  const prompt = str(rec.prompt);
  const requestedDelay = num(rec.delaySeconds);

  const match = typeof resultText === "string" ? resultText.match(NEXT_WAKEUP_RE) : null;
  const inMatch = typeof resultText === "string" ? resultText.match(IN_SECONDS_RE) : null;
  const resolvedRaw = match?.[2] ?? inMatch?.[1];
  const resolvedDelay = resolvedRaw ? Number(resolvedRaw) : null;
  const clock = match?.[1] ?? null;

  // The resolved schedule wins over the requested delay when the result is in.
  const delaySeconds = resolvedDelay ?? requestedDelay;

  // `tsMs + delay` is timezone-independent and authoritative once the resolved
  // delay is known; the bare clock is a last resort, anchored to UTC by contract.
  let fireAt: number | null = null;
  if (tsMs !== null && resolvedDelay !== null) fireAt = tsMs + resolvedDelay * 1000;
  else if (clock) fireAt = fireAtFromClock(clock, tsMs);
  else if (tsMs !== null && requestedDelay !== null) fireAt = tsMs + requestedDelay * 1000;

  return { fireAt, delaySeconds, reason, prompt };
}

/** Refines a parsed wakeup once its tool_result attaches. The result carries the
    RESOLVED schedule, so it overrides the requested-delay fire time computed at
    call time (issue #161 review); the original is kept only if the result yields
    no schedule of its own. */
export function refineWakeupFromResult(info: WakeupInfo, tsMs: number | null, resultText: string): WakeupInfo {
  const refined = parseScheduleWakeup({ reason: info.reason, prompt: info.prompt }, tsMs, resultText);
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
