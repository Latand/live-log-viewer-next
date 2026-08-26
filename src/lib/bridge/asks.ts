import type { BridgeAsk, FileEntry } from "@/lib/types";

import {
  bridgeReportOriginLabel,
  isBridgeDecisionRequestClass,
  BRIDGE_ASK_TTL_SECONDS,
  type BridgeReportLogV1,
  type BridgeReportV1,
} from "./types";

/**
 * The bridge log, read as "who is waiting on the operator" (issue #1168).
 *
 * The report log has always had exactly one consumer: the voice gateway, which
 * drains it while a call is live and at the start of its next turn. So with the
 * gateway off — the ordinary state of this machine — a manager that filed
 * `blocked` ("I cannot proceed") or `question` ("I need an answer") reached the
 * operator as prose inside a dock feed and nothing else. No badge, no count, no
 * queue entry, nothing that survives scrolling past it.
 *
 * This module is the missing read. It is pure over the log and derives at
 * read time — no store of its own, no subscription, no second copy of the
 * manager's state that could disagree with the log. Everything it decides comes
 * out of fields the log already carries: the row's class, its key, its seq, and
 * the seqs a directive has answered.
 *
 * ONE open ask per PROJECT, deliberately, and it is that project's NEWEST
 * manager report that decides — whichever seat filed it. Two consequences, both
 * wanted:
 *
 * - The manager talks in sequence, so an earlier `blocked` is superseded by a
 *   newer decision request AND by the manager simply moving on: a `status` or
 *   `completed` since means it is no longer stuck on the old one. The
 *   alternative — every unanswered row, forever — turns a queue that answers
 *   "who needs me right now" into an inbox.
 * - A project has exactly one designated orchestrator at a time, and a report
 *   is routed to that seat at write time. So the project's last word also
 *   settles a ROTATION: the successor's first report retires whatever its
 *   predecessor was still asking, with no second authority to consult and
 *   nothing to go stale.
 */

/**
 * Whether one row speaks in the MANAGER's own voice.
 *
 * `bridge_report` is callable from every session, and this ask points at the
 * orchestrator's own card, which would misattribute a worker's blocker to the
 * seat that never filed it. The origin label is the existing authority on that
 * question (a null label means the manager's own voice, legacy origin-less rows
 * included), so this reuses it rather than minting a second rule.
 */
function isManagerVoice(report: BridgeReportV1): boolean {
  return bridgeReportOriginLabel(report.origin) === null;
}

/**
 * The identity #1168 puts on the attention item: the caller's own report key.
 *
 * Every decision request written since the log kept keys carries one verbatim —
 * a key it could not keep is refused at append rather than reshaped, so there is
 * no live path to the fallback. Rows written BEFORE the field existed still ask,
 * under the derived id that identified them then. Both are stable across
 * re-reads, which is the property the queue needs.
 */
function askIdentity(report: BridgeReportV1): string {
  return report.key ?? report.id;
}

export interface OpenBridgeAskOptions {
  now: Date;
  ttlSeconds?: number;
  /** Resolves a report's recorded seat to the conversation identity the file
      scan carries, so an account migration's rekey does not orphan the ask. */
  canonicalConversationId?: (conversationId: string) => string;
}

/**
 * The open ask of every project the log names, keyed by the conversation id of
 * the seat that filed it — which is the card the operator answers it on.
 *
 * Only rows in the manager's own voice qualify (see {@link isManagerVoice}),
 * and one qualifies while all three clearing signals stay silent:
 * - **answered** — a directive carried `[bridge ref=<seq>]` for it;
 * - **superseded** — the project's manager has filed ANY newer report since;
 * - **expired** — it aged past {@link BRIDGE_ASK_TTL_SECONDS}.
 *
 * Unrouted rows (no project, or no recipient seat) never qualify: they are the
 * log's quarantine, and the drain does not hand them to a conversation either.
 */
export function openBridgeAsks(
  log: BridgeReportLogV1,
  options: OpenBridgeAskOptions,
): Map<string, BridgeAsk> {
  const canonical = options.canonicalConversationId ?? ((id: string) => id);
  const ttlMs = (options.ttlSeconds ?? BRIDGE_ASK_TTL_SECONDS) * 1000;
  const answered = new Set(log.answeredRefs ?? []);

  /* The project's LAST WORD from its manager, whatever class it was and
     whichever seat filed it — supersedence is "the manager has spoken since",
     not "the manager has asked again". */
  const newestByProject = new Map<string, BridgeReportV1>();
  for (const report of log.reports) {
    if (!isManagerVoice(report)) continue;
    if (!report.project || !report.targetSeatConversationId) continue;
    const incumbent = newestByProject.get(report.project);
    if (!incumbent || report.seq > incumbent.seq) newestByProject.set(report.project, report);
  }

  const asks = new Map<string, BridgeAsk>();
  for (const report of newestByProject.values()) {
    const seat = report.targetSeatConversationId;
    if (!seat) continue;
    if (!isBridgeDecisionRequestClass(report.class)) continue;
    if (answered.has(report.seq)) continue;
    const at = Date.parse(report.at);
    /* An unparseable time cannot be aged, and an ask nothing can retire is
       worse than one that never opened. */
    if (!Number.isFinite(at)) continue;
    if (options.now.getTime() - at > ttlMs) continue;
    asks.set(canonical(seat), { id: askIdentity(report), at: report.at });
  }
  return asks;
}

/**
 * Stamp each seat's open ask onto its own scanned entry.
 *
 * A retired round is skipped on purpose. Terminal supersedence (issue #383) and
 * migration both demote a conversation's live attention fields earlier in the
 * projection — `pendingQuestion`, `waitingInput`, the rate-limit wall — because
 * the successor carries the live card. An ask stamped afterwards would be the
 * one signal that survived that demotion and would re-raise a dead round's
 * card. Every other entry is left exactly as it was, including one whose
 * conversation the registry has not identified yet.
 */
export function overlayBridgeAsks(
  files: FileEntry[],
  asks: ReadonlyMap<string, BridgeAsk>,
): void {
  if (asks.size === 0) return;
  for (const file of files) {
    if (file.supersededBy || file.migratedTo) continue;
    const ask = file.conversationId ? asks.get(file.conversationId) : undefined;
    if (ask) file.bridgeAsk = ask;
  }
}
