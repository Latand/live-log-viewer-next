import { Database } from "bun:sqlite";

import { statePath } from "@/lib/configDir";

import type { ViewerDeploymentStatus } from "./contracts";

export type DeploymentLedgerRead<T> =
  | { state: "ok"; value: T }
  | { state: "unreadable"; error: string };

const UNREADABLE_LEDGER = "deployment ledger is unreadable";

/**
 * A read-only view of the durable deployment ledger (#790).
 *
 * `deployment_status` reads the ledger over Viewer control HTTP, whose handler
 * asks the runtime host for a snapshot. That is fine ordinarily and is the whole
 * point of #777 — the read must not depend on the calling process holding a
 * socket. It deadlocks in exactly one place: the post-promotion health probe.
 * There the runtime host is synchronously awaiting `verify-promoted`, the probe's
 * MCP asks the promoted web surface for deployments, and that handler waits on
 * the very host that is waiting for the probe. A real deploy sat there for the
 * full 90-second budget with no events and was rolled back.
 *
 * The runtime host writes this table; reading it is therefore reading the same
 * source of truth one step earlier, without asking the writer anything. Opening
 * strictly read-only means this can never block the host, never take a write
 * lock, and never create the table if it is absent.
 */

function ledgerPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.LLV_RUNTIME_JOURNAL?.trim() || statePath("runtime-events.sqlite");
}

function openLedger(env: NodeJS.ProcessEnv = process.env): Database | null {
  try {
    return new Database(ledgerPath(env), { readonly: true, create: false });
  } catch {
    /* No journal on this host, or it is not readable from here. The caller
       reports that as unreadable rather than as an empty ledger. */
    return null;
  }
}

function unreadable<T>(): DeploymentLedgerRead<T> {
  return { state: "unreadable", error: UNREADABLE_LEDGER };
}

function deploymentStatus(raw: string, expectedId: string): ViewerDeploymentStatus | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const status = value as Partial<ViewerDeploymentStatus>;
    if (
      status.deploymentId !== expectedId
      || typeof status.revision !== "string"
      || typeof status.phase !== "string"
    ) return null;
    return status as ViewerDeploymentStatus;
  } catch {
    return null;
  }
}

/**
 * The same tail the runtime snapshot exposes: deployment entities are ordered
 * by id, then the route slices the last `limit` entries from that ordering.
 */
export function ledgerDeployments(
  limit: number,
  env: NodeJS.ProcessEnv = process.env,
): DeploymentLedgerRead<ViewerDeploymentStatus[]> {
  const db = openLedger(env);
  if (!db) return unreadable();
  try {
    const rows = db.query<{ id: string; state_json: string }, [string, number]>(
      "SELECT id, state_json FROM entities WHERE kind = ? ORDER BY id DESC LIMIT ?",
    ).all("deployment", Math.max(1, limit));
    const deployments: ViewerDeploymentStatus[] = [];
    for (const row of rows.reverse()) {
      const status = deploymentStatus(row.state_json, row.id);
      if (!status) return unreadable();
      deployments.push(status);
    }
    return { state: "ok", value: deployments };
  } catch {
    return unreadable();
  } finally {
    db.close();
  }
}

/**
 * How many deployment rows the newest-first window carries before recency is
 * settled in memory. The SQL ordering below is the ledger's own write clock,
 * which is close enough to recency to bound the read; the record's `createdAt`
 * is what actually decides, so the window only has to be wide enough to contain
 * the newest record under any plausible skew between the two.
 */
const LATEST_DEPLOYMENT_WINDOW = 25;

/**
 * The most recently STARTED deployment, or null when the ledger has none.
 *
 * Separate from {@link ledgerDeployments} on purpose. That function mirrors the
 * runtime snapshot's ordering — entity id — which is a random UUID per
 * deployment and therefore says nothing about time; slicing a "tail" from it
 * and reading the last element answers with an arbitrary deployment. A caller
 * that reported the last deployment's outcome from it told an orchestrator that
 * production had rolled back while the four newest deploys had all succeeded
 * (#1262), which invites a rollback hunt against a healthy production.
 *
 * So recency is asked for explicitly here: newest-first by the row's own write
 * clock, then decided on the record's own `createdAt` (its `updatedAt` when a
 * record carries no readable start), with the SQL order breaking a tie between
 * deployments admitted in the same millisecond.
 */
export function latestLedgerDeployment(
  env: NodeJS.ProcessEnv = process.env,
): DeploymentLedgerRead<ViewerDeploymentStatus | null> {
  const db = openLedger(env);
  if (!db) return unreadable();
  try {
    const rows = db.query<{ id: string; state_json: string }, [string, number]>(
      "SELECT id, state_json FROM entities WHERE kind = ? ORDER BY COALESCE(updated_at, 0) DESC, id DESC LIMIT ?",
    ).all("deployment", LATEST_DEPLOYMENT_WINDOW);
    let latest: ViewerDeploymentStatus | null = null;
    let latestAt = Number.NEGATIVE_INFINITY;
    for (const row of rows) {
      const status = deploymentStatus(row.state_json, row.id);
      if (!status) return unreadable();
      const at = Date.parse(status.createdAt);
      const tie = Date.parse(status.updatedAt);
      const rank = Number.isFinite(at) ? at : Number.isFinite(tie) ? tie : Number.NEGATIVE_INFINITY;
      if (latest && rank <= latestAt) continue;
      latest = status;
      latestAt = rank;
    }
    return { state: "ok", value: latest };
  } catch {
    return unreadable();
  } finally {
    db.close();
  }
}

/**
 * One deployment by id. A readable miss is represented by `undefined`;
 * malformed state and storage failures remain an explicit unreadable plane.
 */
export function ledgerDeployment(
  deploymentId: string,
  env: NodeJS.ProcessEnv = process.env,
): DeploymentLedgerRead<ViewerDeploymentStatus | undefined> {
  const db = openLedger(env);
  if (!db) return unreadable();
  try {
    const row = db.query<{ state_json: string }, [string, string]>(
      "SELECT state_json FROM entities WHERE kind = ? AND id = ?",
    ).get("deployment", deploymentId);
    if (!row) return { state: "ok", value: undefined };
    const status = deploymentStatus(row.state_json, deploymentId);
    return status ? { state: "ok", value: status } : unreadable();
  } catch {
    return unreadable();
  } finally {
    db.close();
  }
}
