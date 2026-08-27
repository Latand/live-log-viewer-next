import { recordValue, stringValue } from "./json";

/**
 * OpenClaw's own record shapes, in one place: the sessions directory is shared
 * with several sidecar formats, and its assistant records are not all provider
 * work. Every reader that has to tell one from the other — discovery, model,
 * effort, turn state, the feed — goes through here so a single definition
 * decides what an OpenClaw transcript is and which of its records count.
 */

/**
 * The provider value OpenClaw stamps on assistant records it synthesised
 * itself — a channel delivery mirrored back into the transcript, a Gateway
 * injection — rather than on a model's answer. They always carry
 * `stopReason: "stop"`, so a synthetic record appended in the middle of a tool
 * call would read as a finished turn and would replace the displayed model
 * with a label no provider ever served. The model labels vary between
 * versions; the provider value is what identifies them.
 */
export const OPENCLAW_SYNTHETIC_PROVIDER = "openclaw";

/** Basenames that are not the sessions directory's own sidecars or wreckage. */
const NON_TRANSCRIPT_SEGMENTS = [".trajectory.", ".checkpoint.", ".acp-stream.", ".deleted.", ".bak"];

/**
 * Whether a basename inside an OpenClaw sessions directory is a conversation.
 *
 * Beside the transcripts that directory holds runtime traces
 * (`<id>.trajectory.jsonl`), ACP stream logs, self-contained checkpoint forks,
 * JSON sidecars, a `sessions.json` index and dated repair backups. Admitting
 * them would multiply the board's OpenClaw cards by the number of sidecar
 * formats and surface dead backups as live conversations.
 *
 * Checkpoints are excluded rather than merged: each carries its own `session`
 * header and a complete `parentId` chain, so folding one into the session it
 * names would duplicate that whole history.
 */
export function isOpenclawTranscript(basename: string): boolean {
  if (!basename.endsWith(".jsonl")) return false;
  return !NON_TRANSCRIPT_SEGMENTS.some((segment) => basename.includes(segment));
}

/**
 * The inner message of an OpenClaw `message` record, or null for anything else.
 * The transcript wraps every role — including tool results — in a top-level
 * `{type:"message", message:{role,…}}` envelope.
 */
export function openclawMessage(record: Record<string, unknown>): Record<string, unknown> | null {
  return record.type === "message" ? recordValue(record.message) : null;
}

/**
 * The inner message of an assistant record that a real provider produced, or
 * null. Both the model display and the turn state read the newest such record,
 * so a synthetic delivery mirror can neither rename the model nor end a turn.
 */
export function openclawProviderAssistant(record: Record<string, unknown>): Record<string, unknown> | null {
  const message = openclawMessage(record);
  if (!message || message.role !== "assistant") return null;
  return stringValue(message.provider) === OPENCLAW_SYNTHETIC_PROVIDER ? null : message;
}
