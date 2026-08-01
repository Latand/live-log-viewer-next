import { agentRegistry, type RegistryFile, type SnapshotSpawnProjection, type SnapshotTitleConversationProjection } from "@/lib/agent/registry";
import { completedFileScan } from "@/lib/scanner/scanCache";
import { overlaySnapshotSessionTitles } from "@/lib/session/titleProjection";

import { composeSnapshot } from "./snapshot";
import { resolveSiblings } from "./siblings";
import type { SnapshotRequestV1 } from "./types";

export type SnapshotPhaseName = "completed-scan" | "session-titles" | "siblings" | "compose";
export interface SnapshotPhaseTiming {
  name: SnapshotPhaseName;
  durationMs: number;
  cardinality: Readonly<Record<string, number>>;
}
export type SnapshotPhaseObserver = (timing: SnapshotPhaseTiming) => void;

function observePhase(
  observer: SnapshotPhaseObserver | undefined,
  name: SnapshotPhaseName,
  startedAt: number,
  cardinality: SnapshotPhaseTiming["cardinality"],
): void {
  observer?.({ name, durationMs: performance.now() - startedAt, cardinality });
}

/**
 * One completed scan and at most one bounded spawn projection per snapshot (#845).
 *
 * The file route, MCP reads, and snapshots all consume the scanner cache's latest
 * completed generation. A warm snapshot therefore stays independent of an unhealthy
 * refresh, while a cold caller joins the cache's one real refresh. The registry
 * Spawn lookup stays injected so a caller that already holds registry evidence can
 * reuse it, while transcript-only scopes never open the registry.
 */
export async function collectSnapshot(
  body: SnapshotRequestV1,
  dependencies: {
    completedFileScan: typeof completedFileScan;
    resolveSiblings: typeof resolveSiblings;
    /** Compatibility seam for callers compiled against the completed-registry
        projection. Snapshot composition leaves it untouched. */
    registrySnapshot?: () => RegistryFile;
    snapshotSpawns?: (launchIds: readonly string[]) => SnapshotSpawnProjection;
    snapshotTitleConversations?: (conversationIds: readonly string[]) => SnapshotTitleConversationProjection;
    overlaySnapshotSessionTitles?: typeof overlaySnapshotSessionTitles;
    observePhase?: SnapshotPhaseObserver;
    signal?: AbortSignal | null;
  } = { completedFileScan, resolveSiblings },
): Promise<Awaited<ReturnType<typeof composeSnapshot>>> {
  const started = Date.now();
  let phaseStartedAt = performance.now();
  const scan = await dependencies.completedFileScan({ signal: dependencies.signal ?? null });
  const files = scan.snapshot.files;
  observePhase(dependencies.observePhase, "completed-scan", phaseStartedAt, { files: files.length });
  // Custom session titles (issue #33) are the last word on `title` for the agent
  // snapshot surface too — applied before siblings resolve and the snapshot
  // composes, so renamed conversations and their siblings show the human title.
  phaseStartedAt = performance.now();
  (dependencies.overlaySnapshotSessionTitles ?? overlaySnapshotSessionTitles)(
    files,
    dependencies.snapshotTitleConversations
      ?? ((conversationIds) => agentRegistry().snapshotTitleConversations(conversationIds)),
  );
  observePhase(dependencies.observePhase, "session-titles", phaseStartedAt, { files: files.length });
  phaseStartedAt = performance.now();
  const siblings = await dependencies.resolveSiblings(body.caller, files);
  observePhase(dependencies.observePhase, "siblings", phaseStartedAt, { agents: siblings.agents.length });
  phaseStartedAt = performance.now();
  const snapshot = await composeSnapshot({
    request: body,
    files,
    siblings,
    snapshotSpawns: dependencies.snapshotSpawns ?? ((launchIds) => agentRegistry().snapshotSpawns(launchIds)),
    scannerDurationMs: scan.lastScan?.durationMs ?? Date.now() - started,
    scannerScannedAt: scan.refreshedAt ?? Date.now(),
  });
  observePhase(dependencies.observePhase, "compose", phaseStartedAt, {
    scopePaths: snapshot.scope.totalPaths,
    conversations: snapshot.conversations.length,
    stubs: snapshot.stubs.length,
  });
  return snapshot;
}
