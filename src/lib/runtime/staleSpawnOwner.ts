import type { AgentRegistry } from "@/lib/agent/registry";
import { procBackend } from "@/lib/proc";

import type { RuntimeHostClient } from "./client";
import {
  reconcileStructuredSpawnReplay,
  STALE_STRUCTURED_SPAWN_ACTUATION_CAP,
  STALE_STRUCTURED_SPAWN_TIMEOUT_MS,
} from "./structuredSpawn";

const TERMINAL_OPERATION_STATUSES = new Set([
  "failed",
  "rejected",
  "uncertain",
  "interrupted",
]);

type AdmissionOwner = { pid: number; startIdentity: string | null };

function admissionOwnerAlive(owner: AdmissionOwner): boolean {
  return Number.isInteger(owner.pid)
    && owner.pid > 0
    && procBackend.pidAlive(owner.pid)
    && (owner.startIdentity === null || procBackend.processIdentity(owner.pid) === owner.startIdentity);
}

/**
 * Reconciles stale structured launches held by a healthy long-lived admission
 * process when the exact runtime operation is terminal or absent. The regular
 * stale-launch pass protects live owners, so this narrow pre-pass supplies the
 * missing per-operation evidence and retains every open operation.
 */
export async function reconcileStaleSpawnsHeldByLiveOwners(
  registry: AgentRegistry,
  client: RuntimeHostClient,
  options: {
    now?: () => number;
    timeoutMs?: number;
    actuationCap?: number;
    ownerAlive?: (owner: AdmissionOwner) => boolean;
    reconcile?: typeof reconcileStructuredSpawnReplay;
  } = {},
): Promise<{ examined: number; terminalized: string[]; recovered: string[] }> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? STALE_STRUCTURED_SPAWN_TIMEOUT_MS;
  const actuationCap = options.actuationCap ?? STALE_STRUCTURED_SPAWN_ACTUATION_CAP;
  const ownerAlive = options.ownerAlive ?? admissionOwnerAlive;
  const reconcile = options.reconcile ?? reconcileStructuredSpawnReplay;
  const snapshot = registry.readOnlySnapshot();
  const terminalized: string[] = [];
  const recovered: string[] = [];
  let examined = 0;

  for (const receipt of Object.values(snapshot.receipts)) {
    if (examined >= actuationCap) break;
    if (receipt.transport !== "structured" || receipt.artifactLifecycle !== "pending") continue;
    if (receipt.state === "completed" || receipt.state === "failed" || receipt.state === "conflicted") continue;
    if (!receipt.admissionOwner || !ownerAlive(receipt.admissionOwner)) continue;
    const createdMs = Date.parse(receipt.createdAt);
    if (!Number.isFinite(createdMs) || now() - createdMs < timeoutMs) continue;

    const operation = await client.operationStatus(receipt.launchId).catch(() => null);
    if (operation && !TERMINAL_OPERATION_STATUSES.has(operation.receipt.status)) continue;
    examined += 1;

    try {
      const result = await reconcile(receipt.launchId, registry, client, { now, timeoutMs });
      if (result.state === "failed") terminalized.push(receipt.launchId);
      else if (result.state === "completed") recovered.push(receipt.launchId);
    } catch (error) {
      console.error("[reaper] terminal structured spawn owner reconciliation failed", {
        launchId: receipt.launchId,
        error,
      });
    }
  }

  return { examined, terminalized, recovered };
}
