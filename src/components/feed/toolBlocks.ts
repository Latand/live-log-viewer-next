import { getLocale, translate } from "@/lib/i18n";

import type { ToolEvent } from "./parse";

/* Pure helpers behind the readable expanded tool block (issue #475): the
   parent/child nesting of Codex interactive-shell follow-ups, and the duration
   formatter. Kept apart from the React card so both can be unit-tested against
   synthetic ToolEvent fixtures without a DOM. */

export type ToolBlock = { parent: ToolEvent; children: ToolEvent[] };

/* Codex interactive-shell control calls that trail a parent exec: a `wait`
   tails the running cell and a `write_stdin` (including an empty poll) feeds it.
   They read as follow-ups of the exec that opened the session, never as peers. */
const FOLLOW_UP_TOOLS = new Set(["wait", "write_stdin"]);

export function isFollowUpCall(event: ToolEvent): boolean {
  return FOLLOW_UP_TOOLS.has(event.tool);
}

/**
 * Folds a group's flat call list into ordered blocks: each non-follow-up call
 * owns the wait/write_stdin polls that immediately trail it, so nested waits
 * render under their parent exec while keeping their own individual state. A
 * leading follow-up with no parent yet stands as its own block.
 */
export function groupNestedCalls(calls: readonly ToolEvent[]): ToolBlock[] {
  const blocks: ToolBlock[] = [];
  for (const call of calls) {
    const last = blocks[blocks.length - 1];
    if (last && isFollowUpCall(call)) last.children.push(call);
    else blocks.push({ parent: call, children: [] });
  }
  return blocks;
}

/** Human wall-clock duration: sub-second in ms, then `N.Ns`, then `Mm Ss`. */
export function formatDuration(ms: number): string {
  const locale = getLocale();
  const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate(locale, key, params);
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return t("tools.durationMs", { n: Math.round(ms) });
  const totalSec = ms / 1000;
  if (totalSec < 60) {
    const n = totalSec < 10 ? Math.round(totalSec * 10) / 10 : Math.round(totalSec);
    return t("tools.durationSec", { n });
  }
  const m = Math.floor(totalSec / 60);
  const s = Math.round(totalSec % 60);
  return t("tools.durationMin", { m, s: s === 60 ? 0 : s });
}
