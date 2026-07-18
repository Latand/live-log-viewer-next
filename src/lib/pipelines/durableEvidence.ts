import fs from "node:fs";

import { turnStateFromRecords } from "@/lib/accounts/migration/turnState";
import type { FlowEngine } from "@/lib/flows/types";
import { lastAssistantMessageFromRecords } from "@/lib/flows/findings";
import { readStableTailRecords } from "@/lib/scanner/activity";

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
};

export async function durableStageTurnEvidence(
  engine: FlowEngine,
  transcriptPath: string,
): Promise<StageTurnEvidence | null> {
  const read = await readStableTailRecords(transcriptPath);
  if (read.integrity !== "complete") return null;
  const codex = engine === "codex";
  const turn = turnStateFromRecords(read.records, codex);
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
  };
}
