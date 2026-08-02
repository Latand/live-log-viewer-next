import { completedFileScan, type CachedFileScan } from "@/lib/scanner/scanCache";
import type { FileEntry } from "@/lib/types";

/**
 * #860 — bounded selection for project-scoped catalog reads.
 *
 * The stall this exists to remove: `agent_activity(project, liveOnly, limit:10)`
 * ran `listFiles({ fresh: true, persist: false })` first — root discovery, a
 * process-table refresh, a tmux pane map and a tail read for every transcript in
 * the corpus — and only then applied `project`, `liveOnly` and `limit`. Ten rows
 * of answer cost one whole-corpus sweep, and a caller that gave up left the
 * sweep running.
 *
 * Two primitives replace it, both usable by any catalog surface (`agent_activity`
 * today, `list_conversations` next):
 *
 * 1. `selectConversationEntries` — pure. Filters and limits rows from ONE already
 *    completed scanner generation, so the cost of selection is a pass over
 *    metadata the process already holds.
 * 2. `hydrateWithBudget` — everything after selection (a transcript tail per
 *    selected row) runs at bounded concurrency under byte and time budgets and
 *    stops the moment its caller cancels.
 *
 * Neither ever starts a scan of its own. `completedGenerationSelection` reads the
 * published generation through `completedFileScan`, which joins the process-wide
 * single-generation lease rather than opening a private one.
 *
 * `list_conversations` reads the completed generation already but still filters
 * and slices the whole cloned corpus inline in `mcp/bindings.ts`. Its adoption is
 * one call — the filters below are the same set it applies:
 *
 * ```ts
 * const selection = await completedGenerationSelection(
 *   { project, query, limit },
 *   { completedFileScan, signal: deadline.signal },
 * );
 * ```
 *
 * That file belongs to another lane at the time of writing (#859), so the
 * adoption lands with it; nothing here needs to change for it.
 */

export type ConversationEngine = "claude" | "codex";

export interface ConversationSelectionRequest {
  project?: string;
  /** Restrict to rows the scan projects as live/stalled or the runtime hosts. */
  liveOnly?: boolean;
  /** Case-insensitive substring over title, project and path. */
  query?: string;
  limit: number;
  /**
   * Transcript paths the injected registry/runtime projection currently hosts.
   *
   * A completed generation can predate a launch by up to its refresh cadence, so
   * liveness filtered on the scan projection alone would drop a conversation
   * that started a minute ago. Carrying the runtime's own answer here is what
   * makes serving `liveOnly` from a completed generation correct instead of
   * merely fast.
   */
  hostedPaths?: ReadonlySet<string>;
}

export interface ConversationSelection {
  /** At most `limit` rows, in the generation's own newest-first order. */
  entries: FileEntry[];
  /** Rows matching every filter, before the limit truncated them. */
  matched: number;
  /** Conversation rows in the generation. */
  scanned: number;
  generation: number;
  cacheStatus: CachedFileScan["cacheStatus"];
  /** Always false: a selection consumes a completed generation, never a sweep. */
  freshScan: boolean;
  selectionMs: number;
}

function abortError(reason?: unknown): Error {
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  return new DOMException("catalog selection cancelled", "AbortError");
}

function isConversationRow(entry: FileEntry): boolean {
  return entry.engine === "claude" || entry.engine === "codex";
}

/**
 * Project/liveness/query filters and the row limit, applied to a completed
 * generation's rows. Pure and allocation-light: it never copies the corpus, it
 * walks it once and stops collecting at `limit` while it keeps counting matches.
 */
export function selectConversationEntries(
  files: readonly FileEntry[],
  request: ConversationSelectionRequest,
): Pick<ConversationSelection, "entries" | "matched" | "scanned"> {
  const limit = Math.max(0, Math.floor(request.limit));
  const query = request.query ? request.query.toLocaleLowerCase() : "";
  const entries: FileEntry[] = [];
  let matched = 0;
  let scanned = 0;
  for (const entry of files) {
    if (!isConversationRow(entry)) continue;
    scanned += 1;
    if (request.project && entry.project !== request.project) continue;
    if (request.liveOnly
      && entry.activity !== "live"
      && entry.activity !== "stalled"
      && !request.hostedPaths?.has(entry.path)) continue;
    if (query && !`${entry.title}\n${entry.project}\n${entry.path}`.toLocaleLowerCase().includes(query)) continue;
    matched += 1;
    if (entries.length < limit) entries.push(entry);
  }
  return { entries, matched, scanned };
}

export type CompletedGenerationRead = (
  options?: { revalidate?: boolean; signal?: AbortSignal | null },
) => Promise<CachedFileScan>;

export interface CompletedGenerationSelectionDependencies {
  completedFileScan: CompletedGenerationRead;
  signal?: AbortSignal | null;
}

/**
 * The seam a catalog surface consumes: one completed generation, filtered and
 * limited before anything opens a transcript. Cancellation reaches the scanner,
 * so a caller that gives up releases the generation it was waiting on.
 */
export async function completedGenerationSelection(
  request: ConversationSelectionRequest,
  dependencies: CompletedGenerationSelectionDependencies = { completedFileScan },
): Promise<ConversationSelection> {
  const startedAt = performance.now();
  if (dependencies.signal?.aborted) throw abortError(dependencies.signal.reason);
  const scan = await dependencies.completedFileScan({ signal: dependencies.signal ?? null });
  if (dependencies.signal?.aborted) throw abortError(dependencies.signal.reason);
  const selected = selectConversationEntries(scan.snapshot.files, request);
  return {
    ...selected,
    generation: scan.generation,
    cacheStatus: scan.cacheStatus,
    freshScan: false,
    selectionMs: performance.now() - startedAt,
  };
}

export interface HydrationBudget {
  /** Reads in flight at once. */
  concurrency: number;
  /** Ceiling on the bytes this pass may charge itself across all reads. */
  maxBytes: number;
  /** Epoch milliseconds after which no further read starts; null for none. */
  deadlineAt: number | null;
  signal?: AbortSignal | null;
  now?: () => number;
}

export interface HydrationOutcome<R> {
  /** Hydrated values by their index in the input, so skipped rows stay absent
      rather than being represented by a fabricated value. */
  results: Map<number, R>;
  hydrated: number;
  skipped: number;
  bytes: number;
  stopped: "complete" | "byte_budget" | "deadline";
}

/**
 * Runs `hydrate` over `items` at bounded concurrency until the byte budget or
 * the deadline is reached, then reports what it refused instead of silently
 * finishing the list. A caller abort rejects: the work has no consumer left.
 */
export async function hydrateWithBudget<T, R>(
  items: readonly T[],
  cost: (item: T) => number,
  hydrate: (item: T, signal: AbortSignal | null) => Promise<R>,
  budget: HydrationBudget,
): Promise<HydrationOutcome<R>> {
  const now = budget.now ?? Date.now;
  const signal = budget.signal ?? null;
  const results = new Map<number, R>();
  let cursor = 0;
  let bytes = 0;
  let stopped: HydrationOutcome<R>["stopped"] = "complete";

  if (signal?.aborted) throw abortError(signal.reason);

  const worker = async (): Promise<void> => {
    while (true) {
      if (signal?.aborted) throw abortError(signal.reason);
      if (stopped !== "complete") return;
      if (cursor >= items.length) return;
      if (budget.deadlineAt !== null && now() >= budget.deadlineAt) {
        stopped = "deadline";
        return;
      }
      const index = cursor;
      const item = items[index]!;
      const charge = Math.max(0, cost(item));
      if (bytes + charge > budget.maxBytes) {
        stopped = "byte_budget";
        return;
      }
      cursor = index + 1;
      bytes += charge;
      results.set(index, await hydrate(item, signal));
    }
  };

  /* Settled, not raced: when one worker throws on the caller's abort, the others
     are mid-read. Rejecting on the first would leave their rejections without a
     handler — an unhandled rejection per cancelled call. Every worker is
     collected, then the first failure is rethrown. */
  const settled = await Promise.allSettled(Array.from(
    { length: Math.max(1, Math.min(Math.floor(budget.concurrency), items.length || 1)) },
    () => worker(),
  ));
  const failure = settled.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;

  return { results, hydrated: results.size, skipped: items.length - results.size, bytes, stopped };
}
