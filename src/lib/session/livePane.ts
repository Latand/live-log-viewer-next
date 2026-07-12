import type { FileEntry } from "@/lib/types";

/**
 * The live agent pid hosting a transcript, resolved from a scanner snapshot by
 * the transcript path alone. Used to bind tmux propagation to the *renamed*
 * session's own pane instead of trusting a request-supplied pid (which could be
 * stale, reused, or crafted to point at an unrelated session's window).
 */
export function livePidForPath(entries: readonly Pick<FileEntry, "path" | "proc" | "pid">[], pathname: string): number | null {
  const live = entries.find((entry) => entry.path === pathname && entry.proc === "running" && entry.pid !== null);
  return live?.pid ?? null;
}
