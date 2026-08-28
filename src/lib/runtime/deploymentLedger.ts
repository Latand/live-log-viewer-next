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
 * Recency, expressed to the store rather than guessed at in memory.
 *
 * A deployment's start instant lives in the JSON value, not in a column, so the
 * ordering has to reach into it — which the ledger's own queries already do
 * (`json_extract` over `state_json` is how the runtime snapshot separates live
 * sessions from dead ones). `julianday` turns the ISO-8601 text `createdAt`
 * carries into a number, and answers NULL for anything it cannot read as a
 * time; SQLite sorts NULL last under DESC, which is where a record that cannot
 * say when it started belongs. `updatedAt` stands in only for a record with no
 * readable start at all, and the row's write clock and then the id break a tie
 * between two deployments admitted in the same instant.
 *
 * Ordering on an expression means no index can serve it, so the store sorts the
 * deployment rows to answer. That is the whole cost, it is bounded by how many
 * deployments this host has ever run, and it buys an answer that does not
 * depend on the newest record happening to fall inside a window.
 */
const NEWEST_DEPLOYMENT_FIRST = `
  ORDER BY COALESCE(
      julianday(json_extract(state_json, '$.createdAt')),
      julianday(json_extract(state_json, '$.updatedAt'))
    ) DESC,
    COALESCE(updated_at, 0) DESC,
    id DESC
`;

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
 * A window over that ordering would be the same defect with a larger constant:
 * whichever number it picked, a ledger whose newest record fell outside it
 * would answer with an older deployment again, and nothing about the store
 * makes such a number safe. So the store is asked for the newest record and
 * hands back exactly one — {@link NEWEST_DEPLOYMENT_FIRST} is the ordering it
 * decides on, and `LIMIT 1` is the whole of the read. Only that record has to
 * be readable: a corrupt row further down the ledger is not this answer.
 */
export function latestLedgerDeployment(
  env: NodeJS.ProcessEnv = process.env,
): DeploymentLedgerRead<ViewerDeploymentStatus | null> {
  const db = openLedger(env);
  if (!db) return unreadable();
  try {
    const row = db.query<{ id: string; state_json: string }, [string]>(
      `SELECT id, state_json FROM entities WHERE kind = ?${NEWEST_DEPLOYMENT_FIRST} LIMIT 1`,
    ).get("deployment");
    if (!row) return { state: "ok", value: null };
    const status = deploymentStatus(row.state_json, row.id);
    return status ? { state: "ok", value: status } : unreadable();
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
