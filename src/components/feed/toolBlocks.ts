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

/* The exec block a wait/write_stdin follow-up belongs to. A follow-up that names
   its session folds under the exec that owns that exact session — scanning back
   so the right exec wins even when several sessions interleave; a session that
   matches no exec in the run stays standalone. A follow-up with no session id
   (a single-session run, or an older payload that never carried the id) falls
   back to the most recent block, the pre-#475 positional behavior. */
function ownerBlock(blocks: readonly ToolBlock[], followUp: ToolEvent): ToolBlock | undefined {
  if (followUp.session !== undefined) {
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      if (blocks[i].parent.session === followUp.session) return blocks[i];
    }
    return undefined;
  }
  return blocks[blocks.length - 1];
}

/**
 * Folds a group's flat call list into ordered blocks: each non-follow-up call
 * owns the wait/write_stdin polls that belong to its session, so nested waits
 * render under the exec that actually owns them — matched by session so
 * interleaved sessions never cross-attach (#475). A follow-up that matches no
 * exec (a leading follow-up, or one for an unknown session) stands as its own
 * block, keeping its own individual state.
 */
export function groupNestedCalls(calls: readonly ToolEvent[]): ToolBlock[] {
  const blocks: ToolBlock[] = [];
  for (const call of calls) {
    if (isFollowUpCall(call)) {
      const owner = ownerBlock(blocks, call);
      if (owner) {
        owner.children.push(call);
        continue;
      }
    }
    blocks.push({ parent: call, children: [] });
  }
  return blocks;
}

/* A poll worth collapsing (issue #497): a bare `wait`/empty `write_stdin` with
   empty output, empty stderr, and a successful status. Output and failures keep
   their own readable rows. */
export function isCollapsiblePoll(event: ToolEvent): boolean {
  return event.poll === true && event.status !== "err" && !event.outputPreview.trim() && event.stderr === undefined;
}

/** One rendered child under an exec block: either a full follow-up call row, or
    a coalesced run of consecutive empty polls shown as one compact counted row
    (issue #497). */
export type ToolChild =
  | { kind: "call"; event: ToolEvent }
  | { kind: "polls"; events: ToolEvent[]; session?: string; elapsedMs?: number };

/**
 * Folds a block's flat follow-up children into render children: consecutive
 * collapsible polls coalesce into one `polls` run that carries the shared
 * session and the summed elapsed wall-time, while a keystroke `write_stdin` or a
 * poll that captured output stays its own readable `call` (issue #497). A single
 * empty poll also forms a run of one and omits empty output/raw-record fields.
 */
export function coalesceFollowUps(children: readonly ToolEvent[]): ToolChild[] {
  const out: ToolChild[] = [];
  for (const event of children) {
    if (isCollapsiblePoll(event)) {
      const last = out[out.length - 1];
      const ms = typeof event.durationMs === "number" && Number.isFinite(event.durationMs) ? event.durationMs : 0;
      if (last && last.kind === "polls") {
        last.events.push(event);
        if (last.session === undefined && event.session !== undefined) last.session = event.session;
        last.elapsedMs = (last.elapsedMs ?? 0) + ms;
        continue;
      }
      out.push({ kind: "polls", events: [event], session: event.session, elapsedMs: ms });
      continue;
    }
    out.push({ kind: "call", event });
  }
  return out;
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
