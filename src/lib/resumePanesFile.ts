/**
 * Pure shape + parser for the resume-panes cache. Kept free of imports so a
 * test can exercise it without loading `@/lib/tmux`, whose module init pulls in
 * events/inbox/config and runs the legacy-dir migration as a side effect.
 */

export interface ResumePaneRecord {
  paneId: string;
  windowName: string;
}

export interface ResumePanesFile {
  /** tmux server pid the pane ids below belong to; null when unknown. */
  serverPid: number | null;
  panes: Record<string, ResumePaneRecord>;
}

/**
 * Accepts the current `{serverPid, panes}` shape and the legacy bare
 * `Record<path, record>` file. A legacy file has no server pid, so the first
 * lookup after upgrade treats its ids as belonging to no known server and
 * rebuilds — one extra resume window, never a misroute.
 */
export function normalizeResumePanesFile(parsed: unknown): ResumePanesFile {
  if (parsed && typeof parsed === "object" && "panes" in parsed) {
    const obj = parsed as { serverPid?: unknown; panes?: unknown };
    const serverPid = typeof obj.serverPid === "number" && Number.isInteger(obj.serverPid) ? obj.serverPid : null;
    const panes = obj.panes && typeof obj.panes === "object" ? (obj.panes as Record<string, ResumePaneRecord>) : {};
    return { serverPid, panes };
  }
  const panes = parsed && typeof parsed === "object" ? (parsed as Record<string, ResumePaneRecord>) : {};
  return { serverPid: null, panes };
}
