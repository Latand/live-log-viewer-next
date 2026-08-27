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
 * file, the output path, and the read discipline the live connector demands.
 * It is prepended to every run and cannot be edited away, because it is what
 * keeps a run correct, bounded, and readable by the Viewer.
 *
 * The account check is NOT here. `get_me` is verified by the Viewer itself
 * before the run is launched (`reportRunner.ts`), so the identity recorded at
 * Connect never enters a prompt, a transcript or a registry row, and a
 * mismatch is decided by the Viewer rather than self-reported by the agent.
 *
 * The version below moves when the PREAMBLE or the default changes; a run
 * records the version it was launched with.
 */

export const DAILY_REPORT_PROMPT_VERSION = "v1";

/** The marker a run writes instead of a report when the window held nothing
    worth reporting. It is read back by the Viewer, so it is stated in the
    preamble the operator cannot edit. */
export const QUIET_MARKER = "QUIET";

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

Cover every important item in the window. There is no item cap: keep the report short by writing each item once and moving on, and keep every item that matters. Skip bots and service broadcasts unless one is genuinely urgent.

Number every proposal consecutively across the whole report, starting at [1] and counting up without gaps — [1], [2], [3] — so the operator can answer "do 2". Put the number at the start of the item's line.

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
  /** The operator's own analyst brief, appended verbatim. */
  instructions: string;
}

/** The semantic conversation title shared by spawn admission and the prompt's
    first line, with a window that distinguishes one scheduled run from another. */
export function reportConversationTitle(input: Pick<DailyReportPromptInput, "windowStart" | "windowEnd">): string {
  return `Telegram daily report — window ${input.windowStart} → ${input.windowEnd} (UTC).`;
}

/** The half the operator cannot edit: everything a run must do to be correct,
    safe for the connector, and readable by the Viewer afterwards. */
export function reportPromptPreamble(input: Omit<DailyReportPromptInput, "instructions">): string {
  /* The first line is the board card's title (#1086: the run is visible on the
     board), so it names the run rather than opening with instructions. */
  return `${reportConversationTitle(input)}

You have the read-only \`telegram\` MCP connector for the operator's own account. Work through it only; do not install anything and do not write to Telegram — the connector exposes no write tools. The Viewer has already verified with \`get_me\` that the connector holds the account this report belongs to.

RUN RULES (these come from the Viewer and are not negotiable)

1. Your sources are listed in ${input.sourcesPath}: the private dialogs active in this window (already selected by last-message date — the connector's chat-list order is pinned/folder order and is NOT recency, so never re-derive sources from \`get_chats\`/\`list_chats\` yourself) and the groups the operator picked, each marked \`full\` or \`light\`. Start there. Follow a thread, a mentioned chat, or older context beyond that list when your instructions below call for it.

2. Read SEQUENTIALLY. One tool call at a time, never in parallel: the connector dies under concurrent large reads and the run is then lost. Use \`list_messages\` with \`limit\` of 40 or less per call, paging only while messages still fall inside the window. A \`full\` group is read like a private dialog; a \`light\` group yields only mentions of the operator, replies to them, and one or two notable threads.

3. If the connector stops answering, stop and write nothing. A missing report is a failed run the operator can retry; an invented one is worse than silence.

4. The report's FIRST line is the hashtag line your instructions below specify, and nothing else. The Viewer refuses a file that does not start with one.

5. Numbered items are numbered consecutively from [1] with no gaps and no repeats, each number at the start of its line. The Viewer refuses a file that numbers them any other way.

6. If nothing in the window is worth reporting, the whole file is that hashtag line and then:

${QUIET_MARKER}

7. Write the report to ${input.outputPath} — that exact path, plain UTF-8 text, nothing else in the file — and then stop. Do not print the report as your answer; the Viewer reads the file.

YOUR INSTRUCTIONS (from the operator)`;
}

export function renderDailyReportPrompt(input: DailyReportPromptInput): string {
  return `${reportPromptPreamble(input)}\n\n${input.instructions.trim()}`;
}

export type DailyReportOutcome =
  | { kind: "ok"; report: string }
  | { kind: "quiet" }
  | { kind: "invalid" };

/** A numbered item: the number opens its line, after an optional bullet. */
const NUMBERED_ITEM = /^(?:[-*•]\s*)?\[(\d{1,3})\]/;

/**
 * Whether the numbered items are the consecutive run from `[1]` the format
 * requires. A report with no numbered items at all is unconstrained — a window
 * that produced only attention items has nothing to number.
 */
export function reportNumberingIsConsecutive(lines: readonly string[]): boolean {
  const numbers = lines
    .map((line) => NUMBERED_ITEM.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]));
  return numbers.every((value, index) => value === index + 1);
}

/**
 * Classifies what the run wrote.
 *
 * The tag line belongs to the operator's editable brief, so this reads the
 * marker WITHOUT knowing the tag: a leading hashtag line — whatever it says,
 * in whatever language — is skipped, and `QUIET` is matched on what follows. A
 * report that merely mentions "quiet" in its body is still a report, because
 * the marker only counts as the entire remaining body.
 *
 * What is REFUSED, so it cannot be filed as the day's report and advance the
 * window over a day nobody read:
 *
 *  - an empty file, and prose that never got as far as the report format —
 *    the hashtag first line is the issue's own format rule, and a run that
 *    could not read the chats writes exactly this shape;
 *  - numbered items that do not run consecutively from `[1]`, which is the
 *    issue's numbering rule and the one the operator acts on ("do 2").
 *
 * Section ORDER and titles are deliberately not checked. They live in the
 * operator's editable brief — a Ukrainian brief with its own section names is
 * the normal state of this feature — so a Viewer that validated titles it does
 * not own would refuse every report the moment the brief was edited.
 */
export function classifyReportOutput(raw: string | null): DailyReportOutcome {
  const text = (raw ?? "").trim();
  if (!text) return { kind: "invalid" };
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  if (!lines[0].startsWith("#")) return { kind: "invalid" };
  const body = lines.slice(1).filter((line) => line !== "");
  if (body.length === 0) return { kind: "invalid" };
  if (body.length === 1 && body[0].toUpperCase() === QUIET_MARKER) return { kind: "quiet" };
  if (!reportNumberingIsConsecutive(body)) return { kind: "invalid" };
  return { kind: "ok", report: text };
}
