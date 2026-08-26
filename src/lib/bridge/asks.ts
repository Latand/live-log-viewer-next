import type { BridgeAsk, FileEntry } from "@/lib/types";

import {
  bridgeReportOriginLabel,
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
 * out of three fields the log already carries: the row's class, its seq, and
 * the seqs a directive has answered.
 *
 * ONE open ask per seat, deliberately. The manager talks in sequence, so its
 * newest decision request is the one it is actually sitting on, and the older
 * ones are superseded by it. The alternative — every unanswered row, forever —
 * turns a queue that answers "who needs me right now" into an inbox.
 */

/** How much of a report body the queue shows as its one-line reason. */
const ASK_SUMMARY_MAX = 160;

function askSummary(body: string): string {
  const first = body.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
  return first.length > ASK_SUMMARY_MAX ? `${first.slice(0, ASK_SUMMARY_MAX - 1)}…` : first;
}

/**
 * Whether one row is the MANAGER asking the operator for a decision.
 *
 * `bridge_report` is callable from every session, so the class alone does not
 * make a row the manager's voice — and this ask points at the orchestrator's
 * own card, which would misattribute a worker's blocker to the seat that never
 * filed it. The origin label is the existing authority on that question (a null
 * label means the manager's own voice, legacy origin-less rows included), so
 * this reuses it rather than minting a second rule.
 */
function isManagerAsk(report: BridgeReportV1): boolean {
  if (report.class !== "blocked" && report.class !== "question") return false;
  return bridgeReportOriginLabel(report.origin) === null;
}

export interface OpenBridgeAskOptions {
  now: Date;
  ttlSeconds?: number;
  /** Resolves a report's recorded seat to the conversation identity the file
      scan carries, so an account migration's rekey does not orphan the ask. */
  canonicalConversationId?: (conversationId: string) => string;
}

/**
 * The open ask of every orchestrator seat the log names, keyed by that seat's
 * conversation id.
 *
 * Only rows in the manager's own voice qualify (see {@link isManagerAsk}), and
 * one qualifies while all three clearing signals stay silent:
 * - **answered** — a directive carried `[bridge ref=<seq>]` for it;
 * - **superseded** — the seat filed a newer `blocked`/`question` since;
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

  const newestBySeat = new Map<string, BridgeReportV1>();
  for (const report of log.reports) {
    if (!isManagerAsk(report)) continue;
    if (!report.project || !report.targetSeatConversationId) continue;
    const seat = canonical(report.targetSeatConversationId);
    const incumbent = newestBySeat.get(seat);
    if (!incumbent || report.seq > incumbent.seq) newestBySeat.set(seat, report);
  }

  const asks = new Map<string, BridgeAsk>();
  for (const [seat, report] of newestBySeat) {
    if (answered.has(report.seq)) continue;
    const at = Date.parse(report.at);
    /* An unparseable time cannot be aged, and an ask nothing can retire is
       worse than one that never opened. */
    if (!Number.isFinite(at)) continue;
    if (options.now.getTime() - at > ttlMs) continue;
    asks.set(seat, {
      id: report.id,
      seq: report.seq,
      class: report.class === "blocked" ? "blocked" : "question",
      at: report.at,
      summary: askSummary(report.body),
    });
  }
  return asks;
}

/** Stamp each seat's open ask onto its own scanned entry. Every other entry is
    left exactly as it was, including one whose conversation the registry has
    not identified yet. */
export function overlayBridgeAsks(
  files: FileEntry[],
  asks: ReadonlyMap<string, BridgeAsk>,
): void {
  if (asks.size === 0) return;
  for (const file of files) {
    const ask = file.conversationId ? asks.get(file.conversationId) : undefined;
    if (ask) file.bridgeAsk = ask;
  }
}
