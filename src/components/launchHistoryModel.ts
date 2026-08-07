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
 * at all (spawnProjection suppresses them), so a history row is normally a
 * pathless terminal receipt. That suppression is not a guarantee this module
 * may lean on: a terminal launch record can surface on an entry whose path IS
 * a real scanned transcript (the launch failed its delivery but the
 * conversation materialized anyway). Such a row may still appear on the shelf,
 * but it must never CLAIM its path off the scene — that would erase a live
 * conversation from the board ({@link launchHistoryClaimPaths}).
 */

/** Mirror of spawnProjection's TERMINAL_SPAWN_RECENT_MS (a server-only module
    this client bundle cannot import): the scanner's 15-minute freshness
    horizon shared by the projection's activity downgrade. */
export const LAUNCH_HISTORY_HORIZON_MS = 15 * 60 * 1_000;

/** Mirror of spawnProjection's PLACEHOLDER_RETIREMENT_MS (#342): terminal
    receipts older than this stop being served as FileEntries at all, so the
    strip naturally covers only the 15 min – 24 h window. The durable receipts
    stay fully queryable in the registry — retirement is projection-only. */
export const LAUNCH_HISTORY_RETIREMENT_MS = 24 * 60 * 60 * 1_000;

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

/** Mirror of spawnProjection's `isSpawnPlaceholderPath` (a server-only module
    this client bundle cannot import): the projected placeholder path of a
    launch that has no transcript. */
export function isLaunchPlaceholderPath(pathname: string): boolean {
  return pathname.startsWith("spawn:");
}

/** The paths launch history CLAIMS off the board scene. Only the pathless
    `spawn:<launchId>` placeholder qualifies — it has no transcript to mount, so
    shelving it hides nothing. A terminal launch record keyed on a real scanned
    transcript path is delivery evidence ON a live conversation: it keeps its
    shelf row (the failure stays visible and retryable), but claiming the path
    would erase the conversation itself from the canvas. */
export function launchHistoryClaimPaths(rows: readonly FileEntry[]): Set<string> {
  const claims = new Set<string>();
  for (const row of rows) if (isLaunchPlaceholderPath(row.path)) claims.add(row.path);
  return claims;
}

/** Routes retry back through the owning pipeline, whose durable attempt keeps
    the full launch envelope and provisioned worktree authority. */
export function pipelineRetryTarget(file: FileEntry): { pipelineId: string; stageId: string; launchId: string } | null {
  const membership = file.durableLineage?.memberships.find((item) => item.kind === "pipeline" && item.stageId);
  return membership?.stageId && file.spawn
    ? { pipelineId: membership.containerId, stageId: membership.stageId, launchId: file.spawn.launchId }
    : null;
}

export async function retryPipelineLaunch(
  file: FileEntry,
  retry: (id: string, action: "retry-stage", extra: { stageId: string; launchId: string }) => Promise<string | null>,
): Promise<string | null> {
  const target = pipelineRetryTarget(file);
  if (!target) return "launch is not owned by a pipeline stage";
  return retry(target.pipelineId, "retry-stage", { stageId: target.stageId, launchId: target.launchId });
}
