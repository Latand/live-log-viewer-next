import {
  indexTranscriptSources,
  type TranscriptIndexSource,
} from "./transcriptSearch";

export interface TranscriptIndexFeed {
  sources: readonly TranscriptIndexSource[];
  complete: boolean;
}

type TranscriptIndexRun = (
  sources: readonly TranscriptIndexSource[],
  complete: boolean,
) => Promise<void>;

interface ScheduledFeed {
  feed: TranscriptIndexFeed;
  run: TranscriptIndexRun;
}

interface TranscriptFeedState {
  pending?: ScheduledFeed;
  active?: Promise<void>;
  scheduled: boolean;
  idleWaiters: Array<() => void>;
}

const host = globalThis as typeof globalThis & {
  __llvTranscriptFeed?: TranscriptFeedState;
};

function state(): TranscriptFeedState {
  return host.__llvTranscriptFeed ??= { scheduled: false, idleWaiters: [] };
}

async function productionRun(
  sources: readonly TranscriptIndexSource[],
  complete: boolean,
): Promise<void> {
  const indexed = await indexTranscriptSources(sources, { complete });
  if (indexed.failures.length) {
    throw new Error(`${indexed.failures.length} transcript file(s) could not be indexed`);
  }
}

function settleIdle(current: TranscriptFeedState): void {
  if (current.scheduled || current.active || current.pending) return;
  for (const resolve of current.idleWaiters.splice(0)) resolve();
}

async function drain(current: TranscriptFeedState): Promise<void> {
  while (current.pending) {
    const scheduled = current.pending;
    delete current.pending;
    try {
      await scheduled.run(scheduled.feed.sources, scheduled.feed.complete);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`[transcript search] background indexing failed: ${detail}; a later scan will retry`);
    }
  }
}

function start(current: TranscriptFeedState): void {
  current.scheduled = false;
  if (current.active) return;
  const active = drain(current);
  current.active = active;
  void active.finally(() => {
    if (current.active === active) delete current.active;
    if (current.pending && !current.scheduled) {
      current.scheduled = true;
      setImmediate(() => start(current));
    } else {
      settleIdle(current);
    }
  });
}

/**
 * Publishes the latest complete scanner inventory to the durable body index.
 * Scheduling is synchronous and performs no transcript or SQLite reads; the
 * first file is opened on a later event-loop turn.
 */
export function scheduleTranscriptIndex(
  feed: TranscriptIndexFeed,
  options: { force?: boolean; run?: TranscriptIndexRun } = {},
): void {
  if (process.env.NODE_ENV === "test" && !options.force) return;
  const current = state();
  current.pending = { feed, run: options.run ?? productionRun };
  if (current.active || current.scheduled) return;
  current.scheduled = true;
  setImmediate(() => start(current));
}

/** Test-only observation seam for focused fixture runs. */
export function waitForTranscriptIndexIdleForTests(): Promise<void> {
  const current = state();
  if (!current.scheduled && !current.active && !current.pending) return Promise.resolve();
  return new Promise((resolve) => current.idleWaiters.push(resolve));
}
