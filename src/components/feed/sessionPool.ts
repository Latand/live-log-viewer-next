/**
 * Parsed feed sessions of conversations that are not on screen (#1432).
 *
 * A `FeedSession` is an incremental parser over one transcript window: it
 * keeps every item it has produced and parses only lines it has not seen. Its
 * owner used to be one `LogFeed` mount, so every switch that unmounted a pane
 * (the phone's focus view, a project switch on the desktop board) threw the
 * parse away and redid it — the whole retained window — the moment the same
 * conversation came back, even though `useLogTail` had kept the raw lines.
 *
 * This pool keeps a session across those unmounts. A mounting feed TAKES the
 * session for its key, so at most one live feed owns a session at a time: two
 * panes reading the same transcript with different windows would otherwise
 * drive one parser back and forth and re-parse on every render. A feed that
 * unmounts (or changes key) RELEASES its session back here. Bounded and
 * least-recently-released, like the tail cache it mirrors.
 */
import type { FeedSession } from "./parse";

const POOL_CAP = 16;
const pool = new Map<string, FeedSession>();

/** Take a pooled session for `key`; it leaves the pool until released. */
export function takeFeedSession(key: string): FeedSession | null {
  const session = pool.get(key);
  if (!session) return null;
  pool.delete(key);
  return session;
}

/** Re-assert ownership of a session a mount already holds. StrictMode runs an
    effect's cleanup and re-runs it on mount; the cleanup released the session
    while the feed still uses it, so the re-run takes it back out of the pool. */
export function claimFeedSession(key: string, session: FeedSession): void {
  if (pool.get(key) === session) pool.delete(key);
}

/** Return a session for later reuse under `key`. */
export function releaseFeedSession(key: string, session: FeedSession): void {
  pool.delete(key);
  pool.set(key, session);
  while (pool.size > POOL_CAP) {
    const oldest = pool.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    pool.delete(oldest);
  }
}

export function pooledFeedSessionCountForTests(): number {
  return pool.size;
}

export function resetFeedSessionPoolForTests(): void {
  pool.clear();
}
