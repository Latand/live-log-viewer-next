/**
 * The single home of every TUI screen pattern the viewer relies on. Pane
 * scraping is the fragile half of tmux orchestration — when a CLI update
 * shifts wording, this file is the one place to fix. Detection returns a
 * machine-readable reason so the UI and the event log can say *why* a pane
 * was judged ready, gated or blocked instead of a bare boolean.
 */

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

/* Rate-limit / usage-limit walls both CLIs draw as a full-screen notice. */
export const RATE_LIMIT_SCREEN = /rate.?limit|usage limit (reached|hit)|out of (quota|credits)|limit resets/i;

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
  /* A ready composer showing shortcut hints outranks stale approval wording
     higher up in the scrollback. */
  if (READY_MARKERS.test(composerLine(screen))) return null;
  const tail = screen.split("\n").slice(-14).join("\n");
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
