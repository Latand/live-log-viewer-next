/*
 * Terminal payload decode for Codex interactive-shell output (issue #141).
 *
 * Codex `wait` / `write_stdin` results arrive as a raw terminal capture: literal
 * `\r\n`, carriage-return progress redraws, and SGR/cursor ANSI escapes, all in
 * one string. Rendered verbatim in a <pre> they read as a single garbled,
 * horizontally-scrolling line. This module normalizes that into plain, vertical
 * monospace text — the same quality bar as a regular Bash card.
 */

/* CSI (`ESC [ … final`, incl. `?`-prefixed private modes and cursor codes),
   OSC (`ESC ] … BEL|ST`), and lone two-byte escapes. */
const ANSI_RE = /\x1b\[[0-9;?]*[\x20-\x2f]*[\x40-\x7e]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[\x40-\x5f]/g;

/** Remove ANSI escape sequences, leaving the visible characters. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

/**
 * Decode a raw terminal capture to plain text: strip ANSI, fold `\r\n` to `\n`,
 * and resolve carriage-return redraws (a progress bar rewriting one line) to the
 * last-written segment — so `foo (1/4)\rfoo (2/4)` reads as just `foo (2/4)`.
 */
export function decodeTerminalText(text: string): string {
  const flat = stripAnsi(text).replace(/\r\n/g, "\n");
  if (!flat.includes("\r")) return flat;
  return flat
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const segments = line.split("\r").filter((segment) => segment.length > 0);
      return segments.length ? segments[segments.length - 1]! : "";
    })
    .join("\n");
}

/**
 * Human-readable rendering of the bytes `write_stdin` sent into a session:
 * control keys as their caret form (`^C`), newlines/returns as `⏎`, tabs as `⇥`,
 * spaces as `␠`, so a card shows WHAT was typed — including whitespace — rather
 * than an invisible or raw-escape blob, and never silently drops sent bytes.
 *
 * This does NOT decide polling: an empty `chars` (a poll of the session, no bytes
 * sent) is the caller's concern (`chars.length === 0`), so a space-only keystroke
 * is rendered as `␠`, never mistaken for a poll (review finding 2).
 */
export function formatStdinKeys(chars: string): string {
  return chars
    .replace(/\r\n|\r|\n/g, "⏎")
    .replace(/\t/g, "⇥")
    .replace(/ /g, "␠")
    /* Remaining C0/DEL control bytes → caret notation (^A … ^_, ^?). */
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (ch) => {
      const code = ch.charCodeAt(0);
      return "^" + String.fromCharCode(code === 127 ? 63 : code + 64);
    });
}
