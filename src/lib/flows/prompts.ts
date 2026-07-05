import type { Flow, Round } from "./types";

/**
 * Prompt templates for the implement-review loop. Wording changes happen
 * here without touching the state machine that delivers them.
 */

export function kickoffPrompt(): string {
  return [
    "You are now in an implement-review loop controlled by the local log viewer.",
    "",
    "Work normally in this long-lived implementer session. When the work is ready for a fresh independent review, end your final assistant message with a line that starts exactly with:",
    "REVIEW_READY: <one-line note>",
    "Do not print the REVIEW_READY marker now and never quote it at the start of a line when acknowledging these instructions — print it only when the work is actually ready for review.",
    "",
    "Every review round will use a fresh reviewer who sees the full diff from the captured base ref, with no history from earlier rounds. If the reviewer sends findings back, respond to each finding before the next marker using:",
    "FIXED",
    "or",
    "REJECTED — <reason>",
    "",
    "Give concrete arguments for rejections because the next reviewer will be fresh and blind to previous discussion.",
  ].join("\n");
}

export function reviewerPrompt(flow: Flow, round: Round): string {
  return [
    "You are the reviewer in an implement-review loop.",
    "",
    `Working directory: ${flow.cwd}`,
    `Review scope: git diff ${flow.baseRef}...HEAD plus uncommitted changes in the same working tree.`,
    /* The note comes from the implementer's REVIEW_READY line or, on a
       user-triggered round, from the user directly. */
    round.readyNote ? `Ready note: ${round.readyNote}` : "Ready note: none provided.",
    "",
    "Read-only requirement: inspect files and commands as needed, but do not edit files, write notebooks, commit, stage, or mutate the working tree.",
    "",
    "Output exactly this format:",
    "VERDICT: APPROVE | REQUEST_CHANGES | COMMENT",
    "",
    "Then write findings in Markdown. For each finding include severity, file, line, title, and explanation. Use REQUEST_CHANGES for required fixes, COMMENT for non-blocking notes, and APPROVE only when no blocking issues remain.",
  ].join("\n");
}

export function relayPrompt(round: Round, findings: string): string {
  return [
    "Review round findings are below. Address every finding before the next review marker.",
    "",
    findings.trim(),
    "",
    "For each finding, respond with FIXED or REJECTED — <reason>. When the work is reviewable again, end your final assistant message with:",
    "REVIEW_READY: <one-line note>",
  ].join("\n");
}
