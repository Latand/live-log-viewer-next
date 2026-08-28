import { MONITOR_REF_PREFIX } from "@/lib/monitor/cards";
import { redactBounded } from "@/lib/monitor/redact";

import type { SeatTickItem, SeatTickSignalInput, SeatTickWakeReason } from "./types";
import type { ProposalIssue } from "./githubProposal";

/**
 * What the seat actually receives (issue #1245).
 *
 * Short and structural on purpose. The prompt this replaces was a hand-written
 * plan the agent re-typed into every schedule it made for itself, so the plan
 * lived only in the prompt text and died with the session; here the Viewer says
 * what it found and the seat supplies the judgement.
 *
 * The contract at the foot is the same in both briefs, and each clause answers
 * a way the session-scheduled version actually failed: it acted outside the
 * items it was woken for, it left outcomes only in its own transcript, it kept
 * re-running an action that had already failed, it re-armed its own schedule,
 * and it once stopped inside a tick to ask the operator a question.
 */

const MESSAGE_LIMIT = 4_000;

const CONTRACT = [
  "Act on the listed items only, and nothing else this turn.",
  "Record every outcome where it belongs — on the board card or on the pipeline — not only in this conversation.",
  "If an item cannot be done, mark its task blocked with the reason. That is the stop, and it is the only one.",
  "Do not schedule yourself. The Viewer ticks this seat; a self-scheduled monitor is refused practice.",
  "Do not wait on the operator inside this turn.",
];

function bullet(item: SeatTickItem): string {
  return `- [${item.kind}] ${item.id} — ${item.label}`;
}

export function seatTickWakeMessage(input: {
  project: string;
  reasons: readonly SeatTickWakeReason[];
  items: readonly SeatTickItem[];
  deferred: number;
  signals: readonly SeatTickSignalInput[];
}): string {
  const lines = [
    `Seat tick — ${input.project}.`,
    "",
    "Why you were woken:",
    ...input.reasons.map((reason) => `- ${reason.kind}: ${reason.detail}`),
    "",
    "Items:",
    ...input.items.map(bullet),
  ];
  if (input.deferred > 0) {
    lines.push(`(${input.deferred} more item(s) held back for the next wake.)`);
  }
  if (input.signals.length > 0) {
    lines.push("", "Signals:", ...input.signals.map((signal) => `- ${signal.label}`));
  }
  lines.push("", "Contract:", ...CONTRACT.map((clause) => `- ${clause}`));
  return redactBounded(lines.join("\n"), MESSAGE_LIMIT);
}

/**
 * The proactive brief: with nothing assigned, the Viewer gathers what a model
 * needs and the model does the ranking.
 *
 * The gathering is code and the judgement is the seat's, deliberately — #746
 * settled that the semantic call belongs to a model. Nothing here opens an
 * issue or a pipeline: the proposal lands as one board card the operator moves
 * to `assigned` when they want it, and that move is what starts the work.
 */
export function seatTickProposalMessage(input: {
  project: string;
  issues: readonly ProposalIssue[];
  signals: readonly SeatTickSignalInput[];
  items: number;
  slot: string;
}): string {
  const lines = [
    `Seat tick — ${input.project}. No lane is open and no board task is waiting, and the proposal slot is due.`,
    "",
    "Open issues:",
    ...(input.issues.length > 0
      ? input.issues.map((issue) => `- #${issue.number} ${issue.title}${issue.labels.length > 0 ? ` [${issue.labels.join(", ")}]` : ""}`)
      : ["- (none readable; rank from the board and the signals below)"]),
  ];
  if (input.signals.length > 0) {
    lines.push("", "Signals:", ...input.signals.map((signal) => `- ${signal.label}`));
  }
  lines.push(
    "",
    `Produce ONE ranked list of at most ${input.items} actions, each with the evidence behind it, and post it as a single board card in inbox for this project.`,
    "Rank by what actually matters now: what is blocking, what is cheap and finishes something, what has been waiting longest.",
    `Put this exact line at the foot of the card so the next tick recognizes it: ${MONITOR_REF_PREFIX} ${proposalRef(input.slot)}`,
    "Open no GitHub issue and start no pipeline from this — the operator moves a card to assigned when they want it, and the next tick starts it.",
    "",
    "Contract:",
    ...CONTRACT.map((clause) => `- ${clause}`),
  );
  return redactBounded(lines.join("\n"), MESSAGE_LIMIT);
}

/** The `monitor-ref:` value a proposal card carries. Colon-free, because that
    is what {@link import("@/lib/monitor/cards").monitorRefIn} will read back. */
export function proposalRef(slot: string): string {
  return `seat-tick-proposal-${slot}`;
}
