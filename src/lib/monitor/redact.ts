import os from "node:os";

import { hardenedRedact } from "@/lib/view/compactText";

/**
 * Publication-safe shaping of anything the monitor emits (issue #741).
 *
 * The monitor reads private conversations and writes into surfaces the
 * operator pastes elsewhere, so every string that leaves it goes through here
 * first: secrets by the shared hardened redactor, then home directories and
 * absolute filesystem paths, which name the machine and its accounts.
 */

const HOME_LIKE = /(?<![\w.-])\/(?:home|Users|root)\/[A-Za-z0-9._-]+/g;
/* An absolute path of two or more segments, not preceded by a scheme separator
   (so `https://host/a/b` and `~/a/b` survive intact) and not a bare `/api/x`
   route reference, which is vocabulary rather than a location. */
const ABSOLUTE_PATH = /(?<![\w:/~.])\/(?:[A-Za-z0-9._+-]+\/){2,}[A-Za-z0-9._+-]*/g;

export function redactMonitorText(text: string): string {
  const home = os.homedir();
  let out = hardenedRedact(text);
  if (home && home !== "/") out = out.split(home).join("~");
  out = out.replace(HOME_LIKE, "~");
  out = out.replace(ABSOLUTE_PATH, (match) => {
    const segments = match.split("/").filter(Boolean);
    const last = segments.at(-1);
    return last ? `…/${last}` : "…";
  });
  return out;
}

/** Redact, then clamp to a bounded length with an explicit ellipsis. */
export function redactBounded(text: string, limit: number): string {
  const redacted = redactMonitorText(text).trim();
  return redacted.length <= limit ? redacted : `${redacted.slice(0, limit - 1).trimEnd()}…`;
}
