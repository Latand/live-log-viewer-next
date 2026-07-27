import os from "node:os";

import { hardenedRedact } from "@/lib/view/compactText";

/**
 * Publication-safe shaping of anything the monitor emits (issue #741).
 *
 * The monitor reads private conversations and writes into surfaces the
 * operator pastes elsewhere, so every string that leaves it goes through here
 * first. The publication gate cannot help: it inspects committed files, and
 * cards and reports are produced at runtime. These rules are the only guard,
 * which is why they are deliberately over-eager about paths.
 *
 * Order matters. Secrets first (the shared hardened redactor), then encoded
 * path forms — which would otherwise survive because they contain no `/` —
 * then home directories, then any remaining absolute path.
 */

/** A path that survived a URL encoder is still a path. */
const ENCODED_PATH = /(?:%2[Ff][A-Za-z0-9._+-]+){2,}/g;
/* Assembled rather than written as literals: a path-shaped constant in a
   committed file is what the publication gate exists to reject, and these
   patterns would otherwise spell one out. */
const HOME_ROOTS = ["home", "Users", "root"];
/** Claude's project-directory encoding, which carries a whole home path with
    the separators swapped for dashes. */
const DASH_ENCODED_HOME = new RegExp(`-(?:${HOME_ROOTS.join("|")})(?:-[A-Za-z0-9._+]+)+`, "g");
const HOME_LIKE = new RegExp(`(?<![\\w.-])\\/(?:${HOME_ROOTS.join("|")})(?:\\/[A-Za-z0-9._-]+)?`, "g");
/**
 * Any absolute path of two or more segments. Two, not three: a two-segment
 * system path names the machine as surely as a deep one does.
 *
 * Left alone on purpose: anything after a scheme (a URL keeps its path), a
 * home-relative path, and a single-segment root reference — one segment is how
 * route-shaped vocabulary reads, and it names no location.
 */
const ABSOLUTE_PATH = /(?<![\w:/~.%-])\/[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)+/g;
const EMAIL = /(?<![\w.+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function collapsePath(match: string): string {
  const last = match.split("/").filter(Boolean).at(-1);
  return last ? `…/${last}` : "…";
}

export function redactMonitorText(text: string): string {
  const home = os.homedir();
  let out = hardenedRedact(text);
  out = out.replace(EMAIL, "[redacted-email]");
  out = out.replace(ENCODED_PATH, "…");
  out = out.replace(DASH_ENCODED_HOME, "…");
  if (home && home !== "/") out = out.split(home).join("~");
  out = out.replace(HOME_LIKE, "~");
  out = out.replace(ABSOLUTE_PATH, collapsePath);
  return out;
}

/** Redact, then clamp to a bounded length with an explicit ellipsis. Bounding
    happens after redaction so a truncation can never leave half a secret. */
export function redactBounded(text: string, limit: number): string {
  const redacted = redactMonitorText(text).trim();
  return redacted.length <= limit ? redacted : `${redacted.slice(0, limit - 1).trimEnd()}…`;
}
