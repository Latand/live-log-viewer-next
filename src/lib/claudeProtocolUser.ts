/**
 * The meta/command classification contracts for Claude `type:"user"`
 * transcript records, shared by feed rendering and turn-duration scanning
 * (issue #406).
 *
 * Two predicates on the same envelope facts, because the two consumers ask
 * different questions:
 *
 *  - `isClaudeProtocolUser` — the FEED contract: "should this render as a
 *    system row instead of a user bubble?" Every harness envelope qualifies,
 *    including SDK and peer/coordinator deliveries, because the operator did
 *    not type them into THIS pane.
 *  - `isClaudeTurnWindowMeta` — the TIMER contract: "is this journaled
 *    metadata that must never initiate or steer a work window?" Only records
 *    that cannot start work qualify: command echoes and caveats, task
 *    notifications, interrupt sentinels, compaction summaries. SDK-sourced
 *    prompts (`promptSource:"sdk"` — headless/conveyor lanes) and
 *    idle-delivered peer/coordinator messages (`origin.kind:"peer"` /
 *    `"coordinator"`, journaled with `isMeta:true`) are genuine turn
 *    initiators and stay valid (issue #406 review).
 *
 * Human provenance (`origin.kind:"human"`, `promptSource:"typed"`) outranks
 * every wrapper shape in both contracts.
 *
 * Pure and dependency-free on purpose: the feed parser bundles for the
 * client, so this module must not pull in `node:fs`-backed scanner helpers.
 */

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function arr(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(rec) : [];
}

/** Flattened text of a Claude user record's `message.content` — a plain
    string or the joined `text` parts of a content array. */
export function claudeUserText(content: unknown): string {
  return typeof content === "string" ? content : arr(content).map((part) => str(part.text)).filter(Boolean).join("\n");
}

/** `origin` appears both as a bare string (`"task"`) and as an object
    (`{kind:"peer"}`); normalize to the kind string. */
function originKindOf(record: Record<string, unknown>): string {
  return typeof record.origin === "string" ? record.origin : str(rec(record.origin).kind);
}

function isInterruptSentinelText(text: string): boolean {
  return /^\[Request interrupted by user\]$/.test(text);
}

function isCommandCaveatText(text: string): boolean {
  return /^<local-command-caveat>\s*Caveat:[\s\S]*<\/local-command-caveat>$/.test(text);
}

function isTaskNotificationText(text: string): boolean {
  return /^<task-notification\b[^>]*>[\s\S]*<\/task-notification>$/.test(text);
}

/** True when a Claude user record renders as a system row in the feed rather
    than a user bubble. See the module doc for the contract. */
export function isClaudeProtocolUser(record: Record<string, unknown>): boolean {
  /* Claude records queued human input with the same envelope fields that its
     harness uses. Explicit human provenance and typed prompts keep their
     transcript role through any wrapper text. */
  if (originKindOf(record) === "human" || str(record.promptSource) === "typed") return false;
  if (
    record.isMeta === true ||
    record.isCompactSummary === true ||
    "interruptedMessageId" in record ||
    "promptSource" in record ||
    "origin" in record
  ) {
    return true;
  }
  const text = claudeUserText(rec(record.message).content).trim();
  return (
    isInterruptSentinelText(text) ||
    isCommandCaveatText(text) ||
    isTaskNotificationText(text) ||
    /^This came from another Claude session\b[\s\S]*not typed by your user[\s\S]*$/.test(text)
  );
}

/** True when a Claude user record is journaled metadata that must never open
    or steer a work-duration window. Narrower than the feed contract: SDK and
    idle-delivered peer/coordinator prompts render as system rows but DO
    initiate turns, so they stay valid here. See the module doc. */
export function isClaudeTurnWindowMeta(record: Record<string, unknown>): boolean {
  const originKind = originKindOf(record);
  // Provenances that initiate work outrank every metadata shape.
  if (originKind === "human" || originKind === "peer" || originKind === "coordinator") return false;
  const promptSource = str(record.promptSource);
  if (promptSource === "typed" || promptSource === "sdk") return false;
  if (record.isCompactSummary === true || "interruptedMessageId" in record) return true;
  // Command echoes and system-sourced notifications are journal entries, not
  // prompts. Task notifications resume the agent, but no one prompted it.
  if (promptSource === "command" || promptSource === "system") return true;
  if (originKind === "task" || originKind === "task-notification") return true;
  // Remaining isMeta records are injected context (caveats, command output).
  if (record.isMeta === true) return true;
  const text = claudeUserText(rec(record.message).content).trim();
  return isInterruptSentinelText(text) || isCommandCaveatText(text) || isTaskNotificationText(text);
}
