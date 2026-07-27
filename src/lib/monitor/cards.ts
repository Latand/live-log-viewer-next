import { redactBounded } from "./redact";
import type { ClassifiedRequest, OperatorRequest, RequestState } from "./types";

/**
 * Board cards the monitor writes (issue #741).
 *
 * A gap that is only reported in chat dies with the conversation, so the
 * monitor's one write is a board card. The card carries a `monitor-ref:` line
 * holding the request's fingerprint, and that line is the whole idempotency
 * story: the next run reads the board back through the API, sees the ref, and
 * correlates the request to its own card instead of minting a second one.
 */

export const MONITOR_REF_PREFIX = "monitor-ref:";
/** Fixed ref of the "no orchestrator could be resolved" card, so the condition
    surfaces once and re-surfaces only after the operator clears it. */
export const ORCHESTRATOR_ALERT_REF = "orchestrator-unresolved";
/** `clientRequestId` for a card create — a second identical create replays. */
export const monitorClientRequestId = (ref: string): string => `monitor-741:${ref}`;

const CARD_TEXT_LIMIT = 5_000;

const STATE_LABEL: Record<RequestState, string> = {
  completed: "completed",
  "in-flight": "in flight",
  stalled: "stalled",
  untracked: "never materialized",
  "awaiting-confirmation": "awaiting operator confirmation",
};

export function stateLabel(state: RequestState): string {
  return STATE_LABEL[state];
}

/** The fingerprint a card was created for, or null for a card the monitor did
    not write. Reading is deliberately lenient: an operator may edit the card
    text above the marker without breaking the correlation. */
export function monitorRefIn(text: string): string | null {
  const match = text.match(/^monitor-ref:\s*([A-Za-z0-9_-]{4,64})\s*$/m);
  return match ? match[1]! : null;
}

function askedLine(request: OperatorRequest): string {
  const when = request.at.slice(0, 16).replace("T", " ");
  return `Asked ${when} UTC in project ${request.project}.`;
}

/** The card body for one classified request. Quoted operator wording is
    already redacted by the extractor; nothing else here reaches outside. */
export function monitorCardText(classified: ClassifiedRequest): string {
  const { request, state, reason } = classified;
  const lines = [
    request.title,
    "",
    `Surfaced by the conversation monitor — ${stateLabel(state)}.`,
    askedLine(request),
    `Correlation: ${reason}.`,
  ];
  if (state === "awaiting-confirmation") {
    lines.push(
      request.asksForGithubIssue
        ? "Unconfirmed: this reads as a request for a GitHub issue. No GitHub issue was created — the monitor never opens one from inferred intent. Confirm with the operator first."
        : "Unconfirmed: confirm with the operator before acting on this.",
    );
  }
  lines.push("", "What the operator asked:", `> ${request.text.split("\n").join("\n> ")}`, "", `${MONITOR_REF_PREFIX} ${request.fingerprint}`);
  return redactBounded(lines.join("\n"), CARD_TEXT_LIMIT);
}

/** The card raised when the monitor cannot resolve a live orchestrator. It is
    the reportable condition made durable: the run also fails loudly, but the
    board is where the operator will actually see it. */
export function orchestratorAlertCardText(detail: string, at: string): string {
  return redactBounded(
    [
      "Conversation monitor cannot resolve a live orchestrator",
      "",
      `The monitor resolves the orchestrator through the durable record, never a transcript path. ${detail}.`,
      "Until a live orchestrator is adopted, monitor runs report their findings on the board only — nothing is delivered in chat.",
      `Observed ${at.slice(0, 16).replace("T", " ")} UTC.`,
      "",
      `${MONITOR_REF_PREFIX} ${ORCHESTRATOR_ALERT_REF}`,
    ].join("\n"),
    CARD_TEXT_LIMIT,
  );
}
