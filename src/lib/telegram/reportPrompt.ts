import type { TelegramIdentity } from "./contracts";

/**
 * The analyst prompt template for a Daily Report run (issue #1086), versioned
 * in the repository so a report's format is a reviewable artifact rather than
 * whatever a launcher happened to string together. A run records the version
 * it was launched with; changing the rules below means minting the next one.
 *
 * The template carries the issue's format contract verbatim — the tag line,
 * the five sections in order, consecutive numbering, links, full sentences,
 * QUIET on an empty window — plus the three run rules that come from the live
 * connector: verify the account first, never trust chat-list order, and read
 * sequentially with small pages.
 */

export const DAILY_REPORT_PROMPT_VERSION = "v1";

/** First line of every report, so past reports stay findable by search. */
export const DAILY_REPORT_TAG = "#daily_report";

/** Markers the run writes instead of a report; the Viewer maps them to a
    history status and stores no report text for either. */
export const QUIET_MARKER = "QUIET";
export const ACCOUNT_MISMATCH_MARKER = "ACCOUNT-MISMATCH";

export interface DailyReportPromptInput {
  windowStart: string;
  windowEnd: string;
  /** Owner-only file holding the private dialogs and groups to read. */
  sourcesPath: string;
  /** Where the finished report must be written. */
  outputPath: string;
  /** The identity recorded when the operator connected the account. */
  identity: TelegramIdentity | null;
  /** Repository the operator wants issue proposals shaped for, if any. */
  issueRepo?: string | null;
}

function identityLine(identity: TelegramIdentity | null): string {
  if (!identity) return "the account recorded at connect time";
  return identity.username ? `${identity.name} (@${identity.username})` : identity.name;
}

export function renderDailyReportPrompt(input: DailyReportPromptInput): string {
  const issueSection = input.issueRepo
    ? `🐙 Proposed issues — for ${input.issueRepo}: a ready title plus one or two sentences of body.`
    : "🐙 Proposed issues — anything that should become a tracked task: a ready title plus one or two sentences of body.";
  return `Telegram daily report for the window ${input.windowStart} → ${input.windowEnd} (UTC).

You have the read-only \`telegram\` MCP connector for the operator's own account. Work through it only; do not install anything, do not write to Telegram, and do not read anything outside the sources below.

RUN RULES

1. Call \`get_me\` first. The connected account must be ${identityLine(input.identity)}. If it is anyone else, write exactly this to ${input.outputPath} and stop, with no report and no further reads:

${DAILY_REPORT_TAG}
${ACCOUNT_MISMATCH_MARKER}

2. Read your sources from ${input.sourcesPath}. It lists the private dialogs active in this window (already selected by last-message date — the connector's chat-list order is pinned/folder order and is not recency, so never re-derive sources from \`get_chats\`/\`list_chats\` yourself) and the groups the operator picked, each marked \`full\` or \`light\`.

3. Read SEQUENTIALLY. One tool call at a time, never in parallel: the connector dies under concurrent large reads and the run is then lost. Use \`list_messages\` with \`limit\` of 40 or less per call, paging only while messages still fall inside the window. A \`full\` group is read like a private dialog; a \`light\` group yields only mentions of the operator, replies to them, and one or two notable threads.

4. If the connector stops answering, stop and write nothing. A missing report is a failed run the operator can retry; an invented one is worse than silence.

WHAT TO REPORT

Cover every important item in the window. There is no item cap — brevity comes from writing each item once, not from dropping items. Skip bots and service broadcasts unless one is genuinely urgent.

Sections, in this order, and only the ones that have content:

⏳ Awaiting your reply — someone asked the operator something and has had no answer: who, what they asked, and how long it has been waiting.
📌 You promised — commitments the operator made with no visible follow-through.
${issueSection}
📅 Proposed calendar items — anything with a concrete date and time.
👀 Worth attention — urgent, important, or easy to miss.

FORMAT

- The first line of the file is exactly \`${DAILY_REPORT_TAG}\`.
- Then the sections, each starting with its emoji and title on its own line.
- Number every proposal consecutively across the whole report — \`[1]\`, \`[2]\`, \`[3]\` — so the operator can answer "do 2".
- Every item states its substance, the person or chat it came from, and a link \`https://t.me/c/<internal_id>/<message_id>\` when the chat is a supergroup (use \`get_message_link\` when unsure). Private chats have no message links; name the person instead.
- Full sentences. No abbreviations, no compressed jargon, no telegraphic style. Each item must be understandable without opening Telegram.
- No methodology preamble, no closing summary, no "not X but Y" constructions, no praise of the operator.
- If nothing in the window is worth reporting, the whole file is:

${DAILY_REPORT_TAG}
${QUIET_MARKER}

FINISH

Write the report to ${input.outputPath} — that exact path, plain UTF-8 text, nothing else in the file — and then stop. Do not print the report as your answer; the Viewer reads the file.`;
}

export type DailyReportOutcome =
  | { kind: "ok"; report: string }
  | { kind: "quiet" }
  | { kind: "account-mismatch" }
  | { kind: "invalid" };

/**
 * Classifies what the run wrote. The markers are matched on the first
 * non-empty line after the tag, so a report that merely mentions "quiet"
 * somewhere in its body is still a report.
 */
export function classifyReportOutput(raw: string | null): DailyReportOutcome {
  const text = (raw ?? "").trim();
  if (!text) return { kind: "invalid" };
  const lines = text.split(/\r?\n/);
  const tagged = lines[0].trim().startsWith(DAILY_REPORT_TAG);
  const body = (tagged ? lines.slice(1) : lines).map((line) => line.trim()).filter((line) => line !== "");
  const first = body[0] ?? "";
  if (first.toUpperCase().startsWith(ACCOUNT_MISMATCH_MARKER)) return { kind: "account-mismatch" };
  if (body.length === 1 && first.toUpperCase() === QUIET_MARKER) return { kind: "quiet" };
  if (!tagged || body.length === 0) return { kind: "invalid" };
  return { kind: "ok", report: text };
}
