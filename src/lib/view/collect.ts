import { agentRegistry, type RegistryFile } from "@/lib/agent/registry";
import { completedFileScan } from "@/lib/scanner/scanCache";
import { overlaySessionTitles } from "@/lib/session/titleProjection";

import { composeSnapshot } from "./snapshot";
import { resolveSiblings } from "./siblings";
import type { SnapshotRequestV1 } from "./types";

/**
 * One completed scan and one registry projection per snapshot (#845).
 *
 * The file route, MCP reads, and snapshots all consume the scanner cache's latest
 * completed generation. A warm snapshot therefore stays independent of an unhealthy
 * refresh, while a cold caller joins the cache's one real refresh. The registry
 * projection remains injected so an MCP caller that already holds it does not
 * materialise a second projection.
 */
export async function collectSnapshot(
  body: SnapshotRequestV1,
  dependencies: {
    completedFileScan: typeof completedFileScan;
    resolveSiblings: typeof resolveSiblings;
    registrySnapshot?: () => RegistryFile;
    signal?: AbortSignal | null;
  } = { completedFileScan, resolveSiblings },
): Promise<Awaited<ReturnType<typeof composeSnapshot>>> {
  const started = Date.now();
  const scan = await dependencies.completedFileScan({ signal: dependencies.signal ?? null });
  const files = scan.snapshot.files;
  // Custom session titles (issue #33) are the last word on `title` for the agent
  // snapshot surface too — applied before siblings resolve and the snapshot
  // composes, so renamed conversations and their siblings show the human title.
  overlaySessionTitles(files);
  const siblings = await dependencies.resolveSiblings(body.caller, files);
  /* The completed scanner projection never appends spawn placeholder cards
     (#342), so visible `spawn:` paths resolve against the durable registry. */
  const registry = (dependencies.registrySnapshot ?? (() => agentRegistry().readOnlySnapshot()))();
  return composeSnapshot({
    request: body,
    files,
    siblings,
    registry,
    scannerDurationMs: scan.lastScan?.durationMs ?? Date.now() - started,
    scannerScannedAt: scan.refreshedAt ?? Date.now(),
  });
}
