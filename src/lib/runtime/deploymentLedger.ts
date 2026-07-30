import { Database } from "bun:sqlite";

import { statePath } from "@/lib/configDir";

import type { ViewerDeploymentStatus } from "./contracts";

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

function parse(rows: { status_json: string }[]): ViewerDeploymentStatus[] {
  const parsed: ViewerDeploymentStatus[] = [];
  for (const row of rows) {
    try {
      parsed.push(JSON.parse(row.status_json) as ViewerDeploymentStatus);
    } catch {
      /* One unreadable row must not lose the rest of the ledger. */
    }
  }
  return parsed;
}

/** The most recent deployments, oldest-first to match the control surface. */
export function ledgerDeployments(limit: number, env: NodeJS.ProcessEnv = process.env): ViewerDeploymentStatus[] | null {
  const db = openLedger(env);
  if (!db) return null;
  try {
    const rows = db.query<{ status_json: string }, [number]>(
      "SELECT status_json FROM viewer_deployments ORDER BY updated_at DESC LIMIT ?",
    ).all(Math.max(1, limit));
    return parse(rows).reverse();
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** One deployment by id. `null` means the ledger is unreadable; `undefined`
    means it is readable and that deployment is genuinely absent. */
export function ledgerDeployment(
  deploymentId: string,
  env: NodeJS.ProcessEnv = process.env,
): ViewerDeploymentStatus | null | undefined {
  const db = openLedger(env);
  if (!db) return null;
  try {
    const row = db.query<{ status_json: string }, [string]>(
      "SELECT status_json FROM viewer_deployments WHERE deployment_id = ?",
    ).get(deploymentId);
    if (!row) return undefined;
    return parse([row])[0] ?? undefined;
  } catch {
    return null;
  } finally {
    db.close();
  }
}
