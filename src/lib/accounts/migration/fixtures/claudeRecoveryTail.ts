/**
 * The record shapes behind issue #516: a Claude transcript whose terminal OAuth
 * failure is followed by the recovery bookkeeping a dying session appends.
 * Modelled field by field on the affected production transcript so the turn
 * projection and the migration coordinator regress against the real envelope
 * shape; every identifier and prompt body here is synthetic.
 */

export type TranscriptRecord = Record<string, unknown>;

const OAUTH_FAILURE_UUID = "rec-oauth-failure";
const CONTINUATION_UUID = "rec-continuation-prompt";
const SYNTHETIC_NO_OP_UUID = "rec-synthetic-no-op";
const INHERITED_PROMPT_UUID = "rec-inherited-prompt";
const INTERRUPT_UUID = "rec-shutdown-interrupt";
const RECOVERY_PROMPT_ID = "prompt-recovery-attempt";
const INHERITED_PROMPT_TEXT = "Report on the reseat probe: read the live transcript first, then summarise.";

/** The structured API-error assistant record that ends the provider turn. */
export function oauthFailureRecord(timestamp: string): TranscriptRecord {
  return {
    parentUuid: "rec-reseat-probe-prompt",
    isSidechain: false,
    type: "assistant",
    uuid: OAUTH_FAILURE_UUID,
    timestamp,
    error: "authentication_failed",
    isApiErrorMessage: true,
    apiErrorStatus: 401,
    message: {
      id: "msg-oauth-failure",
      model: "<synthetic>",
      role: "assistant",
      stop_reason: "stop_sequence",
      stop_sequence: "",
      type: "message",
      content: [{ type: "text", text: "Failed to authenticate: OAuth session expired and could not be refreshed" }],
    },
    userType: "external",
    entrypoint: "sdk-cli",
  };
}

/** `Continue from where you left off.` — the replayed continuation prompt a
    recovery attempt injects, journaled as harness meta. */
export function continuationPromptRecord(timestamp: string): TranscriptRecord {
  return {
    parentUuid: INTERRUPT_UUID,
    isSidechain: false,
    promptId: RECOVERY_PROMPT_ID,
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "Continue from where you left off." }] },
    isMeta: true,
    uuid: CONTINUATION_UUID,
    timestamp,
    userType: "external",
    entrypoint: "sdk-cli",
  };
}

/** The synthetic assistant no-op that retires a queued prompt without asking
    the provider for anything. */
export function syntheticNoOpRecord(timestamp: string): TranscriptRecord {
  return {
    parentUuid: CONTINUATION_UUID,
    isSidechain: false,
    type: "assistant",
    uuid: SYNTHETIC_NO_OP_UUID,
    timestamp,
    message: {
      id: "msg-synthetic-no-op",
      model: "<synthetic>",
      role: "assistant",
      stop_reason: "stop_sequence",
      stop_sequence: "",
      type: "message",
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [{ type: "text", text: "No response requested." }],
    },
    isApiErrorMessage: false,
    userType: "external",
    entrypoint: "sdk-cli",
  };
}

/** The inherited reporting prompt the recovery host replayed into the dead
    session — a genuine SDK prompt that never reached the provider. */
export function inheritedPromptRecord(timestamp: string): TranscriptRecord {
  return {
    parentUuid: SYNTHETIC_NO_OP_UUID,
    isSidechain: false,
    promptId: RECOVERY_PROMPT_ID,
    type: "user",
    message: { role: "user", content: INHERITED_PROMPT_TEXT },
    isMeta: true,
    uuid: INHERITED_PROMPT_UUID,
    timestamp,
    permissionMode: "bypassPermissions",
    promptSource: "sdk",
    userType: "external",
    entrypoint: "sdk-cli",
  };
}

/** `[Request interrupted by user]` with the shutdown flag the exiting host sets. */
export function shutdownInterruptRecord(timestamp: string): TranscriptRecord {
  return {
    parentUuid: INHERITED_PROMPT_UUID,
    isSidechain: false,
    promptId: RECOVERY_PROMPT_ID,
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
    uuid: INTERRUPT_UUID,
    timestamp,
    interruptedByShutdown: true,
    userType: "external",
    entrypoint: "sdk-cli",
  };
}

/** A real in-flight assistant record: ordinary model, no stop reason. */
export function workingAssistantRecord(timestamp: string): TranscriptRecord {
  return {
    type: "assistant",
    timestamp,
    isApiErrorMessage: false,
    message: {
      model: "claude-opus-4-8",
      role: "assistant",
      stop_reason: null,
      type: "message",
      content: [{ type: "text", text: "Reading the migration controller now." }],
    },
  };
}

/** The bookkeeping rows Claude interleaves with conversation records; the turn
    projection must keep ignoring them. */
export function queueOperationRecords(timestamp: string): TranscriptRecord[] {
  return [
    { type: "queue-operation", operation: "enqueue", timestamp, content: INHERITED_PROMPT_TEXT },
    { type: "queue-operation", operation: "dequeue", timestamp },
  ];
}

export function lastPromptRecord(): TranscriptRecord {
  return { type: "last-prompt", lastPrompt: INHERITED_PROMPT_TEXT, leafUuid: INHERITED_PROMPT_UUID };
}

/** One recovery attempt: replayed continuation, synthetic no-op, the inherited
    prompt, and the interrupt sentinel written as the host shut down. */
export function recoveryAttemptRecords(base: string): TranscriptRecord[] {
  return [
    ...queueOperationRecords(`${base}:23.764Z`),
    continuationPromptRecord(`${base}:23.736Z`),
    syntheticNoOpRecord(`${base}:23.736Z`),
    inheritedPromptRecord(`${base}:23.804Z`),
    lastPromptRecord(),
    shutdownInterruptRecord(`${base}:25.176Z`),
  ];
}

export const OAUTH_FAILURE_AT = "2026-07-24T06:36:50.079Z";
export const SHUTDOWN_INTERRUPT_UUID = INTERRUPT_UUID;

/** The full production tail: the terminal OAuth failure followed by the
    recovery attempt observed on the stuck migration source. */
export function oauthFailureWithRecoveryTail(attempts = 1): TranscriptRecord[] {
  const records: TranscriptRecord[] = [
    { type: "user", timestamp: "2026-07-24T06:36:44.000Z", message: { role: "user", content: [{ type: "text", text: "Continue the reseat probe." }] } },
    oauthFailureRecord(OAUTH_FAILURE_AT),
  ];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    records.push(...recoveryAttemptRecords(`2026-07-24T07:0${4 + attempt}`));
  }
  return records;
}
