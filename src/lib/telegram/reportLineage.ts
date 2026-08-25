/**
 * The durable report-run marker (issue #1091).
 *
 * A report run is a root conversation: no operator typed it, no conversation
 * spawned it, and it deliberately has NO lineage parent — the registry
 * re-decides every stored MCP grant from the row's own evidence, and a
 * `parentConversationId` classifies the row as delegated, which would strip
 * `telegram` from the run at the moment its receipt is written. So the marker
 * has to be something the launch itself carries and the registry keeps.
 *
 * It is two durable facts, both written by the ordinary spawn path and both
 * re-read straight out of registry storage after a reload:
 *
 *  - the receipt's `clientAttemptId`, which spells the run id, so a
 *    conversation can be recognised as report run <id> — and re-linked to the
 *    report text stored under that id — with the Daily Reports history file
 *    absent, corrupt, or evicted;
 *  - explicit project ownership on the conversation, which is what the board
 *    groups cards by, so the runs collect under the Telegram project instead of
 *    landing in a phantom project named after the scratch workspace they run in.
 *
 * Nothing here is a capability: the marker decides how a card is GROUPED and
 * nothing about what the run may read. A conversation that spells the attempt
 * id itself gains no Telegram access from doing so.
 */

/** Durable project ownership stamped on every report run, and the board group
    the runs collect under. */
export const TELEGRAM_REPORT_PROJECT = "telegram-reports";

const ATTEMPT_PREFIX = "telegram-report-";

/** A run id is a UUID the runner mints; the marker is that id behind a fixed
    prefix, so the run id is recoverable from the receipt alone. */
export function reportAttemptId(runId: string): string {
  return `${ATTEMPT_PREFIX}${runId}`;
}

/** The run id a report-run attempt marker spells, or `null` for every other
    launch. The shape is checked, not just the prefix: the id names an
    owner-only file (`report-<runId>.md`), so a marker that is not the id the
    runner mints must not be read as one. */
export function reportRunIdFromAttemptId(clientAttemptId: string | null | undefined): string | null {
  if (typeof clientAttemptId !== "string" || !clientAttemptId.startsWith(ATTEMPT_PREFIX)) return null;
  const runId = clientAttemptId.slice(ATTEMPT_PREFIX.length);
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(runId) ? runId : null;
}

/**
 * Report runs by conversation, read from durable spawn receipts.
 *
 * This is the whole read side of the marker: the board projection walks the
 * receipts it already holds and asks this which conversations are report runs.
 * It needs no Telegram state at all, which is the point — the answer survives a
 * registry reload with nothing else on disk.
 */
export function telegramReportRunsByConversation(
  receipts: Iterable<{ conversationId: string; clientAttemptId: string | null }>,
): Map<string, string> {
  const runs = new Map<string, string>();
  for (const receipt of receipts) {
    const runId = reportRunIdFromAttemptId(receipt.clientAttemptId);
    if (runId) runs.set(receipt.conversationId, runId);
  }
  return runs;
}
