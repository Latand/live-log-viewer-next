import fs from "node:fs";

import { turnStateFromRecords } from "@/lib/accounts/migration/turnState";
import type { FlowEngine } from "@/lib/flows/types";
import { lastAssistantMessageFromRecords } from "@/lib/flows/findings";
import { readStableTailRecords } from "@/lib/scanner/activity";
import { numberValue, recordValue, recordsValue, stringValue } from "@/lib/scanner/json";

type RecordLike = Record<string, unknown>;

/**
 * Turn evidence read straight from the stage transcript artifact — the durable
 * completion authority for a pipeline attempt. Independent of the scanner
 * projection (which can transiently lose the transcript) and of the runtime
 * session ledger (which can stay `running` past the end of the turn). `turn` is
 * "terminal" only on native lifecycle evidence (Claude end-turn stop, Codex
 * task/turn completion with no open tool calls), so a mid-work assistant
 * message can never present as a completed turn.
 */
export type StageTurnEvidence = {
  turn: "terminal" | "busy" | "unknown";
  message: { text: string; ts: number } | null;
  /** The verified read covers the complete artifact and contains only Codex's
      launch metadata record. */
  launchOnly?: boolean;
  /** The provider's own end-of-turn notice, when the record that closed the
      turn is one: a session or model limit, an expired credential, a refusal —
      a message the CLI writes *instead of* the agent's answer, so the turn
      ended with nothing to parse (#1141). Null whenever the turn ended on the
      agent's own message, and null while the turn is still open, so silence
      can never present as one. */
  terminalProviderMessage?: {
    text: string;
    ts: number;
    /** Structured Codex usage-limit evidence from this same terminal turn. */
    usageLimit?: { resetsAt: number | null };
  } | null;
};

function recordTs(record: RecordLike, fallbackTs: number): number {
  return Date.parse(String(record.timestamp ?? "")) || fallbackTs;
}

function claudeAssistantText(record: RecordLike): string {
  return recordsValue(recordValue(record.message)?.content)
    .filter((part) => part.type === "text")
    .map((part) => stringValue(part.text) ?? "")
    .join("\n")
    .trim();
}

/** Codex turn-end records that carry a provider failure instead of a result.
    A clean completion has no error field at all, so it yields nothing here. */
function codexTurnEndFailure(payload: RecordLike): string | null {
  const error = recordValue(payload.error);
  const info = stringValue(payload.codex_error_info) ?? stringValue(error?.codex_error_info);
  const message = stringValue(error?.message)
    ?? stringValue(payload.error)
    ?? (info ? stringValue(payload.message) : null);
  return message ?? info;
}

function codexErrorInfo(payload: RecordLike): string | null {
  return stringValue(payload.codex_error_info)
    ?? stringValue(recordValue(payload.error)?.codex_error_info);
}

function isCodexUsageLimit(payload: RecordLike): boolean {
  const info = codexErrorInfo(payload)?.toLowerCase();
  return info === "usage_limit" || info === "usage_limit_exceeded";
}

const CODEX_TURN_END_TYPES = new Set(["task_complete", "turn_complete", "turn_completed", "turn_aborted"]);
const CODEX_TURN_START_TYPES = new Set(["task_started", "turn_started", "user_message"]);

/** Reset of the governing window in the quota event immediately preceding a
    terminal usage-limit record. A windowless credits event says nothing about
    the reset, so the scan continues to the latest event that carries windows. */
function codexUsageLimitResetAt(records: RecordLike[], endIndex: number): number | null {
  for (let index = endIndex - 1; index >= 0; index -= 1) {
    const payload = recordValue(records[index]?.payload) ?? {};
    const type = stringValue(payload.type) ?? "";
    if (CODEX_TURN_START_TYPES.has(type)) return null;
    const info = recordValue(payload.info);
    const rateLimits = recordValue(payload.rate_limits) ?? recordValue(info?.rate_limits);
    if (!rateLimits) continue;
    const limitId = stringValue(rateLimits.limit_id);
    if (limitId && limitId !== "codex") continue;
    const windows = [recordValue(rateLimits.primary), recordValue(rateLimits.secondary)]
      .filter((window): window is RecordLike => window !== null)
      .flatMap((window) => {
        const usedPercent = numberValue(window.used_percent);
        if (usedPercent === null) return [];
        return [{ usedPercent, resetsAt: numberValue(window.resets_at) }];
      });
    if (windows.length === 0) continue;
    const governingPercent = Math.max(...windows.map((window) => window.usedPercent));
    const governingResets = windows
      .filter((window) => window.usedPercent === governingPercent)
      .map((window) => window.resetsAt);
    return governingResets.every((reset): reset is number => reset !== null)
      ? Math.max(...governingResets)
      : null;
  }
  return null;
}

/**
 * The notice the provider wrote when it ended the turn, read from the record
 * that CLOSED it — the assistant record Claude flags `isApiErrorMessage`, or
 * the Codex turn-end record carrying a failure. Everything after that record
 * on Claude's side is bookkeeping the CLI appends once the turn is over.
 *
 * Read from the closing record rather than from prose, so an agent that merely
 * quotes a limit notice in its answer is not mistaken for one, and a later
 * prompt that reopened the turn withdraws the evidence.
 */
function terminalProviderMessageFromRecords(
  records: RecordLike[],
  codex: boolean,
  fallbackTs: number,
): NonNullable<StageTurnEvidence["terminalProviderMessage"]> | null {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if (codex) {
      const payload = recordValue(record.payload) ?? {};
      const type = stringValue(payload.type) ?? "";
      if (CODEX_TURN_START_TYPES.has(type)) return null;
      if (!CODEX_TURN_END_TYPES.has(type)) continue;
      const failure = codexTurnEndFailure(payload);
      return failure
        ? {
            text: failure,
            ts: recordTs(record, fallbackTs),
            ...(isCodexUsageLimit(payload)
              ? { usageLimit: { resetsAt: codexUsageLimitResetAt(records, index) } }
              : {}),
          }
        : null;
    }
    if (record.type === "user") return null;
    if (record.type !== "assistant") continue;
    if (record.isApiErrorMessage !== true) return null;
    const text = claudeAssistantText(record);
    return text ? { text, ts: recordTs(record, fallbackTs) } : null;
  }
  return null;
}

export async function durableStageTurnEvidence(
  engine: FlowEngine,
  transcriptPath: string,
): Promise<StageTurnEvidence | null> {
  const read = await readStableTailRecords(transcriptPath);
  if (read.integrity !== "complete") return null;
  const codex = engine === "codex";
  const turn = turnStateFromRecords(read.records, codex ? "codex" : "claude");
  let fallbackTs = 0;
  try {
    fallbackTs = fs.statSync(transcriptPath).mtimeMs;
  } catch {
    /* The identity-verified read succeeded; a raced-away stat only loses the
       timestamp fallback for records that carry no timestamp of their own. */
  }
  const message = lastAssistantMessageFromRecords(read.records, codex ? "codex-sessions" : "claude-projects", fallbackTs);
  return {
    turn: turn.state === "terminal" ? "terminal" : turn.state === "busy" ? "busy" : "unknown",
    message,
    launchOnly: codex
      && !read.prefixTruncated
      && read.records.length === 1
      && read.records[0]?.type === "session_meta",
    /* Gated on the same turn reading the rest of the engine trusts: a provider
       error the CLI may still retry inside an open turn keeps the busy
       projection (#516), and so never reads as the end of the turn here. */
    terminalProviderMessage: turn.state === "terminal"
      ? terminalProviderMessageFromRecords(read.records, codex, fallbackTs)
      : null,
  };
}
