import { BRIDGE_ASK_TTL_SECONDS } from "@/lib/bridge/types";
import type { BridgeAsk, FileEntry } from "@/lib/types";

import { projectKey } from "./projectModel";

/**
 * The attention queue: which agents need operator attention right now, oldest
 * signal first. Pure derived state over the polled file list — every surface
 * (badge, popover, title, N-cycle, push/toast seen-sets) derives identity from
 * the one `attentionId` helper here so counts and dedupe keys cannot drift.
 */

/**
 * Attention severity tiers, highest first:
 * - «unowned» — a hosted approval with no attached owner (a first-class alarm,
 *   issue #25 R10-5); always sorts to the queue head.
 * - «blocked» — a hard question, prompt, or rate-limit wall.
 * - «heuristic» — a low-confidence "possibly waiting" signal (turn-ended +
 *   idle + nothing pending); visually distinct, ranks below hard blocks.
 * - «stalled» — an interrupted agent (FIFO tail segment).
 *
 * The FileEntry-derived queue below only ever emits «blocked»/«stalled» (its
 * historical behavior is byte-identical); «unowned»/«heuristic» come from the
 * runtime bus's structured attentions. An orchestrator's open bridge ask
 * (issue #1168) joins the «blocked» tier: a manager that filed
 * `blocked`/`question` is a hard block by its own declaration.
 */
export type AttentionTier = "unowned" | "blocked" | "heuristic" | "stalled";

/** Sort priority per tier (lower = closer to the queue head). */
export const TIER_RANK: Record<AttentionTier, number> = {
  unowned: 0,
  blocked: 1,
  heuristic: 2,
  stalled: 3,
};

export interface AttentionItem {
  /** attentionId(file) — stable while the underlying signal is unchanged. */
  id: string;
  file: FileEntry;
  project: string;
  tier: AttentionTier;
  /** Epoch seconds the wait started: bridgeAsk.at | askedAt | waitingInput.since | mtime. */
  since: number;
}

/* An interrupted session stops being "yours to answer" after a while: a
   permission prompt from two days ago is dead context. Shared with the
   switchboard's isAwaitingUser so the queue and the «waiting» bucket agree. */
export const STALLED_ATTENTION_TTL = 2 * 3600;

/** Epoch seconds an ISO timestamp names, or null when it does not parse. */
function isoSeconds(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

/**
 * The orchestrator's open ask, or null once the clock has retired it (#1168).
 *
 * The age check has to live HERE and not only on the server that stamped it.
 * `/api/files` serves a cached projection whose key is a function of the scan
 * and the state files, so a payload built while the ask was young keeps being
 * served verbatim; nothing in the log moves when a report merely gets old. The
 * queue is the surface that owns "right now", and it is the only place holding
 * a live clock. An expired ask falls THROUGH to the file's own signals rather
 * than dropping the row, so a seat that is also stalled keeps its stalled
 * entry.
 */
export function openBridgeAsk(file: FileEntry, now: number): BridgeAsk | null {
  const ask = file.bridgeAsk;
  if (!ask) return null;
  const at = isoSeconds(ask.at);
  if (at === null) return null;
  return now - at <= BRIDGE_ASK_TTL_SECONDS ? ask : null;
}

/**
 * Epoch seconds at which the queue changes on its own, with nothing polled
 * moving: a stalled entry crossing its TTL, an orchestrator ask crossing its
 * own. `/api/files` keeps the array identity while its body is unchanged, so a
 * surface that wants an expiry to actually take effect has to schedule a tick,
 * and both kinds of expiry are the same kind of event.
 */
export function attentionExpiries(files: readonly FileEntry[]): number[] {
  const expiries: number[] = [];
  for (const file of files) {
    if (file.activity === "stalled") expiries.push(file.mtime + STALLED_ATTENTION_TTL);
    const at = file.bridgeAsk ? isoSeconds(file.bridgeAsk.at) : null;
    if (at !== null) expiries.push(at + BRIDGE_ASK_TTL_SECONDS);
  }
  return expiries;
}

/**
 * The shared attention identity of a file, by signal precedence:
 * an orchestrator's open bridge ask wins, then a structured question, a
 * rate-limit wall, the screen-scrape fallback, and the stalled state. The id
 * doubles as the dedupe key of the toast and push pipelines, so the formats
 * here must stay byte-identical to the historical inline derivations
 * (`push-sent.json` entries survive the refactor).
 */
export function attentionId(file: FileEntry, now: number = Date.now() / 1000): string | null {
  /* First, and above the file's own signals (issue #1168). A bridge ask is the
     manager saying, in as many words, that it cannot go on without the
     operator — the one signal on this board that was ESCALATED rather than
     inferred. The report's own key carries through as the queue identity, so
     re-reading the log cannot enqueue the same decision twice. Nothing
     historical is shadowed: no entry carried this field before. */
  const ask = openBridgeAsk(file, now);
  if (ask) return ask.id;
  if (file.pendingQuestion) return file.pendingQuestion.toolUseId;
  if (file.rateLimit) {
    return `${file.path}:rate-limited:${file.rateLimit.resetAt ?? "unknown"}`;
  }
  if (file.waitingInput) return `${file.path}:waiting:${Math.floor(file.waitingInput.since)}`;
  /* The stalled tier needs a live process behind the transcript: an open turn
     whose agent already exited is an abandoned session, not a pending
     permission prompt — only someone still at the terminal can wait on you. */
  if (file.activity === "stalled" && file.proc === "running" && now - file.mtime <= STALLED_ATTENTION_TTL) {
    return `${file.path}:stalled:${Math.floor(file.mtime)}`;
  }
  return null;
}

/**
 * Ordered queue of every agent needing operator attention: hard-blocked segment
 * first, stalled tail after, oldest signal first inside each segment, id as the
 * tie-breaker. The sort keys are frozen at enqueue (`since` never moves while
 * the id is unchanged), so polls cannot reshuffle the order.
 */
export function buildAttentionQueue(
  files: FileEntry[],
  now: number = Date.now() / 1000,
  project?: string,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const file of files) {
    if (project !== undefined && projectKey(file) !== project) continue;
    const id = attentionId(file, now);
    if (id === null) continue;
    const ask = openBridgeAsk(file, now);
    const tier: AttentionTier = ask || file.pendingQuestion || file.rateLimit || file.waitingInput
      ? "blocked"
      : "stalled";
    /* `openBridgeAsk` already refused an unparseable time, so an ask always
       dates the item it enqueued. */
    const askSince = ask ? isoSeconds(ask.at) : null;
    const since = askSince !== null
      ? askSince
      : file.pendingQuestion
        ? (isoSeconds(file.pendingQuestion.askedAt) ?? file.mtime)
        : file.rateLimit
          ? file.mtime
          : file.waitingInput
            ? file.waitingInput.since
            : file.mtime;
    items.push({ id, file, project: projectKey(file), tier, since });
  }
  return items.sort(
    (a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.since - b.since || a.id.localeCompare(b.id),
  );
}

/**
 * Id-anchored cycle step: the pointer follows its id through reorderings, so
 * an item answered elsewhere silently drops out and the next press serves the
 * next-oldest remaining item (queue head forward, tail backward). Wraps.
 */
export function nextAttention(
  queue: AttentionItem[],
  currentId: string | null,
  dir: 1 | -1,
): AttentionItem | null {
  if (!queue.length) return null;
  const index = currentId === null ? -1 : queue.findIndex((item) => item.id === currentId);
  if (index === -1) return dir === 1 ? queue[0]! : queue[queue.length - 1]!;
  return queue[(index + dir + queue.length) % queue.length]!;
}

/** The one cycle pointer every advancing surface shares — a plain mutable cell
    (a React ref satisfies it as-is). */
export interface AttentionCyclePointer {
  current: string | null;
}

/**
 * Advance the shared cycle pointer over a queue and return the item served.
 * Every advancing surface — the N/Shift-N keys over the project queue, the
 * island's visible Next over the global queue — moves the SAME pointer through
 * this one function, so the routes cannot diverge: whichever advanced last,
 * the next advance continues from that id. Delegates the step itself to
 * `nextAttention` (the sole authority); an empty queue leaves the pointer
 * untouched.
 */
export function advanceAttentionCycle(
  pointer: AttentionCyclePointer,
  queue: AttentionItem[],
  dir: 1 | -1,
): AttentionItem | null {
  const next = nextAttention(queue, pointer.current, dir);
  if (next) pointer.current = next.id;
  return next;
}
