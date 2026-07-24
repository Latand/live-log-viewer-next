import { recordValue, recordsValue, stringValue } from "@/lib/scanner/json";

import type { TurnState } from "./contracts";

type RecordLike = Record<string, unknown>;

function timestamp(record: RecordLike): string | null {
  const value = record.timestamp;
  return typeof value === "string" ? value : null;
}

/** Structured API-error verdicts after which the Claude CLI surrenders the
    turn for good: no `result` record will ever follow, so the flagged record
    itself is the terminal lifecycle evidence (issue #516). Other error codes
    keep the busy projection because the CLI may retry within the same turn. */
const TERMINAL_API_ERRORS = new Set(["authentication_failed", "rate_limit"]);

function terminalApiError(record: RecordLike): boolean {
  return record.isApiErrorMessage === true
    && typeof record.error === "string"
    && TERMINAL_API_ERRORS.has(record.error);
}

function messageText(record: RecordLike): string {
  const content = recordValue(record.message)?.content;
  if (typeof content === "string") return content;
  return recordsValue(content).map((part) => stringValue(part.text) ?? "").join("\n");
}

/** The synthetic assistant record Claude journals when a queued prompt is
    retired without asking the provider for anything. The `<synthetic>` model id
    alone is not enough — replayed transcripts carry real prose under it — so the
    no-op text has to match too. */
const SYNTHETIC_NO_OP_TEXT = /^no response requested\.?$/i;

function syntheticNoOpAssistant(record: RecordLike): boolean {
  if (record.isApiErrorMessage === true) return false;
  if (stringValue((recordValue(record.message) ?? {}).model) !== "<synthetic>") return false;
  return SYNTHETIC_NO_OP_TEXT.test(messageText(record).trim());
}

/** Claude's interrupt evidence on a user record: the bracket sentinel plus the
    envelope flags an exiting or operator-interrupted host writes. Same shapes
    the turn-duration scanner treats as authoritative failure evidence. */
const INTERRUPT_SENTINEL_TEXT = /^\s*\[Request interrupted by user(?: for tool use)?\]\s*$/;

function interruptionMarker(record: RecordLike): boolean {
  if (record.interruptedByShutdown === true || "interruptedMessageId" in record) return true;
  return INTERRUPT_SENTINEL_TEXT.test(messageText(record));
}

/** Issue #516 — recovery bookkeeping appended to a session that already
    surrendered its turn: the replayed `Continue from where you left off.`
    prompt, the synthetic `No response requested.` no-op that retires a queued
    prompt, and the interrupt sentinel the host writes on its way out. None of
    it is provider work, yet the forward projection below reopens the turn on
    every user and assistant record and leaves an unhosted transcript busy
    forever, which strands account reseat in `waiting-turn`.

    The release stays deliberately narrow. Scanning back from the newest
    record: the run must END on a release marker (interrupt sentinel or
    synthetic no-op), may contain nothing but user records and those markers,
    and must reach a terminal lifecycle boundary — a `result` record or a
    terminal API error. A genuine assistant record anywhere in the run, a run
    that ends on a live prompt still awaiting its first assistant record, or a
    run with no terminal boundary in the tail window all keep the busy
    projection. Host evidence is out of scope here: the migration coordinator
    re-imposes busy while a live host still owns the transcript.

    Returns the boundary's terminal evidence, or null when the tail is not a
    recovery run. */
export function claudeRecoveryTailRelease(records: RecordLike[]): { terminalAt: string | null } | null {
  let closedByMarker = false;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]!;
    if (record.type === "result") return closedByMarker ? { terminalAt: timestamp(record) } : null;
    if (record.type === "assistant") {
      if (terminalApiError(record)) return closedByMarker ? { terminalAt: timestamp(record) } : null;
      if (!syntheticNoOpAssistant(record)) return null;
      closedByMarker = true;
      continue;
    }
    if (record.type !== "user") continue;
    if (!closedByMarker && !interruptionMarker(record)) return null;
    closedByMarker = true;
  }
  return null;
}

/** The newest authoritative lifecycle or tool event wins. Assistant prose
    cannot close an active turn because it commonly precedes tool work. */
export function turnStateFromRecords(records: RecordLike[], codex: boolean, authoritative = false): TurnState {
  if (codex) {
    let turnOpen = false;
    let terminalAt: string | null = null;
    let terminalSeen = false;
    const openTools = new Set<string>();
    let anonymousTools = 0;

    for (const record of records) {
      const payload = recordValue(record.payload) ?? {};
      const type = stringValue(payload.type);
      if (!type) continue;
      if (type === "task_started" || type === "turn_started" || type === "user_message") {
        turnOpen = true;
        terminalAt = null;
        terminalSeen = false;
        continue;
      }
      if (type === "task_complete" || type === "turn_complete" || type === "turn_completed" || type === "turn_aborted") {
        if (openTools.size === 0 && anonymousTools === 0) {
          turnOpen = false;
          terminalAt = timestamp(record);
          terminalSeen = true;
        } else {
          turnOpen = true;
          terminalAt = null;
          terminalSeen = false;
        }
        continue;
      }
      if (type === "agent_message" || type === "token_count" || type === "reasoning") continue;

      const isOutput = type.includes("output") || type.endsWith("_result");
      const isTool = type.includes("tool") || type.includes("function") || type.includes("command");
      if (!isTool) continue;
      const id = stringValue(payload.call_id) ?? stringValue(payload.callId) ?? stringValue(payload.id);
      if (isOutput) {
        if (id) openTools.delete(id);
        else if (anonymousTools > 0) anonymousTools -= 1;
      } else if (id) {
        openTools.add(id);
      } else {
        anonymousTools += 1;
      }
      turnOpen = true;
      terminalAt = null;
      terminalSeen = false;
    }

    if (terminalSeen && !turnOpen && openTools.size === 0 && anonymousTools === 0) {
      return { state: "terminal", source: "lifecycle", terminalAt };
    }
    if (turnOpen || openTools.size > 0 || anonymousTools > 0) {
      return { state: "busy", source: openTools.size > 0 || anonymousTools > 0 ? "tool" : "lifecycle", terminalAt: null };
    }
    return { state: "unknown", source: "empty", terminalAt: null };
  }

  if (authoritative) {
    let state: TurnState = { state: "unknown", source: "empty", terminalAt: null };
    for (const record of records) {
      if (record.type === "result") {
        state = { state: "terminal", source: "lifecycle", terminalAt: timestamp(record) };
      } else if (record.type === "user") {
        state = { state: "busy", source: "lifecycle", terminalAt: null };
      } else if (record.type === "assistant") {
        state = terminalApiError(record)
          ? { state: "terminal", source: "lifecycle", terminalAt: timestamp(record) }
          : { state: "busy", source: "assistant", terminalAt: null };
      }
    }
    if (state.state !== "busy") return state;
    const release = claudeRecoveryTailRelease(records);
    return release ? { state: "terminal", source: "lifecycle", terminalAt: release.terminalAt } : state;
  }

  for (const record of [...records].reverse()) {
    if (record.type === "assistant") {
      if (terminalApiError(record)) return { state: "terminal", source: "lifecycle", terminalAt: timestamp(record) };
      const stop = stringValue((recordValue(record.message) ?? {}).stop_reason);
      if (stop === "end_turn" || stop === "stop_sequence") return { state: "terminal", source: "lifecycle", terminalAt: timestamp(record) };
      return { state: "busy", source: "assistant", terminalAt: null };
    }
    if (record.type === "user") return { state: "busy", source: "lifecycle", terminalAt: null };
  }
  return { state: "unknown", source: "empty", terminalAt: null };
}
