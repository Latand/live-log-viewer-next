/**
 * The single home of every TUI screen pattern the viewer relies on. Pane
 * scraping is the fragile half of tmux orchestration — when a CLI update
 * shifts wording, this file is the one place to fix. Detection returns a
 * machine-readable reason so the UI and the event log can say *why* a pane
 * was judged ready, gated or blocked instead of a bare boolean.
 */

import type { WaitingMenu, WaitingMenuOption, WaitingMenuTab } from "./types";

/** Composer prompt characters of the two CLIs (claude «❯», codex «›»). */
export const COMPOSER_PROMPT = /^\s*[❯›]/;

/* Bottom-bar hints the CLIs draw once their composer accepts input; the
   «Context N% used» status line is how current Codex builds signal readiness. */
export const READY_MARKERS = /\? for shortcuts|bypass permissions on|Press up to edit|⏎ send|Context \d+% used/;

export const CLAUDE_RESUME_PICKER = /Resume from summary/;

/* First launch of an agent in an untrusted directory asks to trust it. The
   wording drifts across CLIs and releases (folder/directory, files/contents),
   so the net is wide; the safe option is highlighted, so Enter confirms it. */
export const TRUST_FOLDER_PROMPT = /Do you trust|trust this folder|trust the contents of this directory/i;

/* Any other startup question drawn as an option list with an Enter hint —
   e.g. the .mcp.json consent screen — also highlights the safe default. */
export const STARTUP_GATE = /Enter to confirm|Press enter to continue/i;

/* Approval dialogs mid-run (Codex command approval, Claude permission ask).
   These are NOT auto-answerable: the user must decide. */
export const APPROVAL_PROMPT =
  /Allow command\?|Do you want to proceed\?|Press enter to approve|approve this (command|action)|\(y\/n\)|Yes, (allow|proceed|run)/i;

/* Rate-limit / usage-limit walls both CLIs draw as a full-screen notice.
   Full phrases only: a bare «rate limit» substring matched ordinary
   conversation about rate limits on screen and blocked sends into a
   perfectly ready composer. */
export const RATE_LIMIT_SCREEN =
  /You(?:'ve| have) (?:hit|reached) (?:your|the) .{0,24}limit|(?:usage|rate).?limit (?:reached|hit|exceeded)|out of (?:quota|credits)|\d+.hour limit reached|limit resets/i;

export const SHELL_COMMANDS = new Set(["zsh", "bash", "fish", "sh", "dash"]);

export function isShellCommand(command: string | null): boolean {
  return command !== null && SHELL_COMMANDS.has(command);
}

/** Bottom-most composer line of a captured pane — where unsent input sits.
    Transcript echoes reuse the same prompt character, but they always render
    above the composer, so the last such line on screen is the composer. */
export function composerLine(screen: string): string {
  const lines = screen.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    if (COMPOSER_PROMPT.test(line)) return line;
  }
  return "";
}

/**
 * A startup gate the safe default answers: Enter clears it without making a
 * decision for the user. Anything not in this family must never be blind-
 * confirmed — approval prompts carry real consequences.
 */
export type StartupGate = "resume_picker" | "trust_prompt" | "startup_gate";

export function detectStartupGate(screen: string): StartupGate | null {
  if (CLAUDE_RESUME_PICKER.test(screen)) return "resume_picker";
  if (TRUST_FOLDER_PROMPT.test(screen)) return "trust_prompt";
  if (STARTUP_GATE.test(screen)) return "startup_gate";
  return null;
}

/** A state that blocks message delivery and needs the user, not an Enter. */
export type BlockingGate = "approval_prompt" | "rate_limit";

export function detectBlockingGate(screen: string): BlockingGate | null {
  const lines = screen.split("\n");
  let composerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (COMPOSER_PROMPT.test(lines[i] ?? "")) {
      composerIdx = i;
      break;
    }
  }
  /* Ready hints («bypass permissions on», «? for shortcuts») render on the
     status bar *under* the composer box, never on the ❯ line itself. A drawn
     composer with ready hints below accepts input, and any approval/limit
     wording above it is transcript prose — a reply that merely *discussed*
     rate limits used to block sends here. A live dialog or limit note inside
     that below-composer region still wins: there the wording is the screen
     state, not quoted prose. */
  if (composerIdx !== -1) {
    const statusRegion = lines.slice(composerIdx + 1).join("\n");
    if (
      READY_MARKERS.test(statusRegion) &&
      !APPROVAL_PROMPT.test(statusRegion) &&
      !RATE_LIMIT_SCREEN.test(statusRegion)
    ) {
      return null;
    }
  }
  const tail = lines.slice(-14).join("\n");
  if (APPROVAL_PROMPT.test(tail)) return "approval_prompt";
  if (RATE_LIMIT_SCREEN.test(tail)) return "rate_limit";
  return null;
}

/* Prompt shapes of the waiting-input scrape fallback: a numbered option menu
   under a highlight cursor is how both CLIs draw questions the viewer has no
   structured record for. Anchored to the line start — menu options always
   open their row, while prose in a response ("…віддає 200. Онови…") puts
   digit-dot mid-line and must not read as a menu. */
export const NUMBERED_MENU = /^\s*❯?\s*\d+\.\s+\S/m;

const MENU_HINT = /Enter to (select|confirm|submit)/;
const MENU_SEPARATOR = /^\s*[─━—]{6,}\s*$/;
const MENU_TAB_ROW = /[☐☑✔☒]/;
const MENU_OPTION = /^\s*(❯\s*)?(\d{1,2})\.\s+(\S.*)$/;
const RECOMMENDED_SUFFIX = /\s*\(Recommended\)\s*$/i;

/**
 * Structured read of a live select dialog (AskUserQuestion, plan approval and
 * friends): a question paragraph, numbered options with indented description
 * lines and an «Enter to select» hint. While the dialog is open the transcript
 * holds nothing — newer Claude Code flushes the assistant tool_use record only
 * after the tool resolves — so the screen is the only source the viewer can
 * build answer buttons from.
 */
export function parseScreenMenu(screen: string): WaitingMenu | null {
  const lines = screen.split("\n").map((line) => line.replace(/\s+$/, ""));
  let hintIdx = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (MENU_HINT.test(lines[i] ?? "")) {
      hintIdx = i;
      break;
    }
  }
  if (hintIdx === -1) return null;

  /* First option row: the last «1.» line above the hint. Only the block
     between the two is read — the reply above often ends with its own
     numbered list and must never leak into the menu. */
  let firstIdx = -1;
  for (let i = hintIdx - 1; i >= Math.max(0, hintIdx - 40); i -= 1) {
    const match = MENU_OPTION.exec(lines[i] ?? "");
    if (match && Number(match[2]) === 1) {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) return null;

  const options: WaitingMenuOption[] = [];
  for (let i = firstIdx; i < hintIdx; i += 1) {
    const line = lines[i] ?? "";
    if (!line.trim() || MENU_SEPARATOR.test(line)) continue;
    const match = MENU_OPTION.exec(line);
    if (match) {
      const raw = match[3].trim();
      const label = raw.replace(RECOMMENDED_SUFFIX, "").trim();
      options.push({
        value: Number(match[2]),
        label: label || raw,
        description: "",
        recommended: RECOMMENDED_SUFFIX.test(raw),
      });
      continue;
    }
    const last = options[options.length - 1];
    if (last && /^\s{2,}\S/.test(line)) {
      last.description = last.description ? `${last.description} ${line.trim()}` : line.trim();
    }
  }
  /* Digits answer these menus, so the numbering must be exactly 1..N — a
     misread here would press the wrong key into a live agent. */
  if (options.length < 2 || options.some((option, index) => option.value !== index + 1)) return null;

  /* Question paragraph: contiguous non-blank lines right above option 1. */
  const questionLines: string[] = [];
  let qEnd = firstIdx - 1;
  while (qEnd >= 0 && !(lines[qEnd] ?? "").trim()) qEnd -= 1;
  for (let i = qEnd; i >= 0 && questionLines.length < 8; i -= 1) {
    const line = lines[i] ?? "";
    if (!line.trim() || MENU_SEPARATOR.test(line) || MENU_TAB_ROW.test(line) || MENU_OPTION.test(line)) break;
    questionLines.unshift(line.trim());
  }
  const question = questionLines.join(" ").trim();
  if (!question) return null;

  /* Tab strip of a multi-question dialog: «←  ☐ Build error  ✔ Submit  →». */
  const tabs: WaitingMenuTab[] = [];
  let tabIdx = qEnd - questionLines.length;
  while (tabIdx >= 0 && !(lines[tabIdx] ?? "").trim()) tabIdx -= 1;
  const tabLine = tabIdx >= 0 ? (lines[tabIdx] ?? "") : "";
  if (MENU_TAB_ROW.test(tabLine)) {
    for (const cell of tabLine.replace(/[←→]/g, " ").split(/\s{2,}/)) {
      const label = cell.replace(/[☐☑✔☒]/g, "").trim();
      if (label) tabs.push({ label, done: /[☑✔]/.test(cell) });
    }
  }

  return { question, tabs, options };
}

/**
 * Screen-level judgement for a live pane whose transcript went quiet. Used by
 * the waiting-input probe: `waiting` means a human answer is likely expected.
 */
export function screenWaitsForInput(screen: string): boolean {
  if (detectBlockingGate(screen) !== null) return true;
  if (TRUST_FOLDER_PROMPT.test(screen)) return true;
  const tail = screen.split("\n").slice(-14).join("\n");
  /* Ready hints live on the status bar under the composer box, never on the
     composer line itself, so the veto reads the whole tail: an idle pane
     showing «bypass permissions on» / «? for shortcuts» is not a menu, even
     when the response above ends with a numbered list. */
  return NUMBERED_MENU.test(tail) && !READY_MARKERS.test(tail);
}

/* A running turn keeps the interrupt hint on the status region in both CLIs;
   its absence is what separates an idle composer from a busy agent whose
   screen merely lacks a menu. */
export const BUSY_MARKERS = /esc to interrupt|ctrl\+c to (?:stop|cancel)|Interrupting/i;

/**
 * Positive idle-composer detection: the composer prompt is drawn, the ready
 * hints are on the status bar, and no busy/interrupt hint remains. A quiet
 * screen that merely lacks a menu (a long-running command, streamed output)
 * matches none of this and must never read as "parked at the prompt".
 */
export function screenAtIdleComposer(screen: string): boolean {
  if (screenWaitsForInput(screen)) return false;
  const tail = screen.split("\n").slice(-14).join("\n");
  return composerLine(screen) !== "" && READY_MARKERS.test(tail) && !BUSY_MARKERS.test(tail);
}

/** Short readable tail of a captured screen, for error messages and logs. */
export function screenTail(screen: string): string {
  return screen.split("\n").filter((line) => line.trim()).slice(-3).join(" | ").slice(0, 300);
}
