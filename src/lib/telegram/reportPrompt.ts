import type { TelegramIdentity } from "./contracts";

/**
 * The analyst prompt for a Daily Report run (issue #1086), in two halves.
 *
 * The OPERATOR half is the analyst brief — language, tag line, sections, the
 * repository issue proposals are shaped for, tone. It is settings, not code:
 * {@link DEFAULT_DAILY_REPORT_PROMPT} is only its default, the operator edits
 * it in the Telegram panel, and the edited text is what the run is launched
 * with. Changing what the report says is a settings edit, never a pull request.
 *
 * The VIEWER half is {@link reportPromptPreamble}: the window, the sources
 * file, the output path, the account check, and the read discipline the live
 * connector demands. It is prepended to every run and cannot be edited away,
 * because it is what keeps a run correct, bounded, and readable by the Viewer.
 *
 * The version below moves when the PREAMBLE or the default changes; a run
 * records the version it was launched with.
 */

export const DAILY_REPORT_PROMPT_VERSION = "v1";

/** Markers the run writes instead of a report. Both are read back by the
    Viewer, so they are stated in the preamble the operator cannot edit. */
export const QUIET_MARKER = "QUIET";
export const ACCOUNT_MISMATCH_MARKER = "ACCOUNT-MISMATCH";

/** The default analyst brief: the format issue #1086 specifies. Everything in
    it — including the tag line and the language of the items — is the
    operator's to change in the panel. */
export const DEFAULT_DAILY_REPORT_PROMPT = `Write one report on the operator's Telegram for this window.

The first line of the report is exactly:

#daily_report

Then these sections, in this order, and only the ones that have content:

⏳ Awaiting your reply — someone asked the operator something and has had no answer: who, what they asked, and how long it has been waiting.
📌 You promised — commitments the operator made with no visible follow-through.
🐙 Proposed issues — anything that should become a tracked task in the operator's product repository: a ready title plus one or two sentences of body.
📅 Proposed calendar items — anything with a concrete date and time.
👀 Worth attention — urgent, important, or easy to miss.

Cover every important item in the window. There is no item cap — brevity comes from writing each item once, not from dropping items. Skip bots and service broadcasts unless one is genuinely urgent.

Number every proposal consecutively across the whole report — [1], [2], [3] — so the operator can answer "do 2".

Every item states its substance, the person or chat it came from, and a link https://t.me/c/<internal_id>/<message_id> when the chat is a supergroup (use get_message_link when unsure). Private chats have no message links; name the person instead.

Write the items in the language their conversation used, and keep the section titles exactly as written above. Full sentences: no abbreviations, no compressed jargon, no telegraphic style. Each item must be understandable without opening Telegram.

No methodology preamble, no closing summary, no "not X but Y" constructions, no praise of the operator.`;

export const MAX_DAILY_REPORT_PROMPT_LENGTH = 20_000;

export interface DailyReportPromptInput {
  windowStart: string;
  windowEnd: string;
  /** Owner-only file holding the pre-planned private dialogs and groups. */
  sourcesPath: string;
  /** Where the finished report must be written. */
  outputPath: string;
  /** The identity recorded when the operator connected the account. */
  identity: TelegramIdentity | null;
  /** The operator's own analyst brief, appended verbatim. */
  instructions: string;
}

function identityLine(identity: TelegramIdentity | null): string {
  if (!identity) return "the account recorded at connect time";
  return identity.username ? `${identity.name} (@${identity.username})` : identity.name;
}

/** The half the operator cannot edit: everything a run must do to be correct,
    safe for the connector, and readable by the Viewer afterwards. */
export function reportPromptPreamble(input: Omit<DailyReportPromptInput, "instructions">): string {
  return `Telegram daily report for the window ${input.windowStart} → ${input.windowEnd} (UTC).

You have the read-only \`telegram\` MCP connector for the operator's own account. Work through it only; do not install anything and do not write to Telegram — the connector exposes no write tools.

RUN RULES (these come from the Viewer and are not negotiable)

1. Call \`get_me\` first. The connected account must be ${identityLine(input.identity)}. If it is anyone else, write exactly this to ${input.outputPath} and stop, with no report and no further reads:

${ACCOUNT_MISMATCH_MARKER}

2. Your sources are listed in ${input.sourcesPath}: the private dialogs active in this window (already selected by last-message date — the connector's chat-list order is pinned/folder order and is NOT recency, so never re-derive sources from \`get_chats\`/\`list_chats\` yourself) and the groups the operator picked, each marked \`full\` or \`light\`. Start there. Follow a thread, a mentioned chat, or older context beyond that list when your instructions below call for it.

3. Read SEQUENTIALLY. One tool call at a time, never in parallel: the connector dies under concurrent large reads and the run is then lost. Use \`list_messages\` with \`limit\` of 40 or less per call, paging only while messages still fall inside the window. A \`full\` group is read like a private dialog; a \`light\` group yields only mentions of the operator, replies to them, and one or two notable threads.

4. If the connector stops answering, stop and write nothing. A missing report is a failed run the operator can retry; an invented one is worse than silence.

5. If nothing in the window is worth reporting, the whole file is your tag line and then:

${QUIET_MARKER}

6. Write the report to ${input.outputPath} — that exact path, plain UTF-8 text, nothing else in the file — and then stop. Do not print the report as your answer; the Viewer reads the file.

YOUR INSTRUCTIONS (from the operator)`;
}

export function renderDailyReportPrompt(input: DailyReportPromptInput): string {
  return `${reportPromptPreamble(input)}\n\n${input.instructions.trim()}`;
}

export type DailyReportOutcome =
  | { kind: "ok"; report: string }
  | { kind: "quiet" }
  | { kind: "account-mismatch" }
  | { kind: "invalid" };

/**
 * Classifies what the run wrote.
 *
 * The tag line belongs to the operator's editable brief, so this reads the
 * markers WITHOUT knowing the tag: a leading hashtag line — whatever it says,
 * in whatever language — is skipped, and the markers are matched on what
 * follows. A report that merely mentions "quiet" in its body is still a
 * report, because `QUIET` only counts as the entire remaining body.
 */
export function classifyReportOutput(raw: string | null): DailyReportOutcome {
  const text = (raw ?? "").trim();
  if (!text) return { kind: "invalid" };
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const body = (lines[0].startsWith("#") ? lines.slice(1) : lines).filter((line) => line !== "");
  const first = body[0] ?? "";
  if (first.toUpperCase().startsWith(ACCOUNT_MISMATCH_MARKER)) return { kind: "account-mismatch" };
  if (body.length === 1 && first.toUpperCase() === QUIET_MARKER) return { kind: "quiet" };
  if (body.length === 0) return { kind: "invalid" };
  return { kind: "ok", report: text };
}
