import type { FileEntry } from "@/lib/types";

import { projectKey } from "@/components/projectModel";

/*
 * Compact launch history for terminal structured spawn receipts.
 *
 * A pathless spawn receipt (`spawn:<launchId>`) is registry evidence, not a
 * conversation: it has no transcript, so mounting it as a full board pane
 * shows an empty feed. While a launch is moving — starting, binding, queued,
 * or terminal within the scanner's recent horizon — its card stays prominent
 * so recovery and retry read at a glance. Once a terminal receipt ages past
 * that horizon it belongs to the compact launch-history strip: off the board
 * layout and minimap, with its exact failure reason and retry affordance
 * available when the history group is expanded.
 *
 * Receipts whose artifact transcript IS scanned never become synthetic cards
 * at all (spawnProjection suppresses them), so every history row here is a
 * pathless terminal receipt by construction.
 */

/** Mirror of spawnProjection's TERMINAL_SPAWN_RECENT_MS (a server-only module
    this client bundle cannot import): the scanner's 15-minute freshness
    horizon shared by the projection's activity downgrade. */
export const LAUNCH_HISTORY_HORIZON_MS = 15 * 60 * 1_000;

/** A receipt whose launch reached a terminal state: recovered or failed. */
export function isTerminalSpawnReceipt(file: FileEntry): boolean {
  return file.spawn?.state === "failed" || file.spawn?.state === "recovered";
}

/** Terminal AND older than the recent horizon — a launch-history row, no
    longer a board card. */
export function isHistoricalLaunchReceipt(file: FileEntry, nowMs: number): boolean {
  if (!isTerminalSpawnReceipt(file)) return false;
  return nowMs - file.mtime * 1000 >= LAUNCH_HISTORY_HORIZON_MS;
}

/** This project's launch-history rows, freshest first. */
export function launchHistoryFor(files: readonly FileEntry[], project: string, nowMs: number): FileEntry[] {
  return files
    .filter((file) => projectKey(file) === project && isHistoricalLaunchReceipt(file, nowMs))
    .sort((a, b) => b.mtime - a.mtime);
}
