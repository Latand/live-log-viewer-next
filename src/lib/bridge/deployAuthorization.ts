import { authorizeBridgeDeploy } from "./service";

/**
 * The single gate between a spoken yes and a production deploy (#691 §4, §7.7).
 *
 * There is exactly one place this may be enforced, and it is the last door before
 * the runtime host — not the MCP binding. A gate in the binding stops the manager's
 * tool call and nothing else: `POST /api/runtime/deployments` is reachable by any
 * local caller, so a gate one layer up is a lock on the front door of a room with
 * two doors.
 *
 * It is also the only place the confirmation may be CONSUMED. A nonce spent in the
 * binding and re-presented here would be refused as `consumed` and the real deploy
 * would never happen; a nonce spent in both places would be spent twice for one
 * deploy. So the binding validates shape and forwards, and the spending happens
 * here, atomically, immediately before the deployment is requested.
 */

export interface BridgeDeployProof {
  bridgeRef?: unknown;
  bridgeNonce?: unknown;
}

export type BridgeDeployAuthorization =
  | { ok: true; sha: string }
  | { ok: false; status: number; error: string; reason: string };

/**
 * Verify and spend the authorization for exactly this revision.
 *
 * Every refusal leaves the confirmation unspent, so a malformed or mistaken request
 * never costs the operator the ability to answer correctly.
 */
export function authorizeDeployRequest(
  revision: unknown,
  proof: BridgeDeployProof,
  now = new Date(),
): BridgeDeployAuthorization {
  if (typeof revision !== "string" || !/^[0-9a-f]{40}$/i.test(revision)) {
    return {
      ok: false,
      status: 400,
      reason: "revision_invalid",
      error: "revision must be a full 40-character commit SHA",
    };
  }
  const ref = proof.bridgeRef;
  const nonce = typeof proof.bridgeNonce === "string" ? proof.bridgeNonce.trim() : "";
  if (!Number.isInteger(ref) || (ref as number) < 1 || !nonce) {
    return {
      ok: false,
      status: 403,
      reason: "bridge_confirmation_required",
      error: "a deploy requires the bridge confirmation the user authorized: bridgeRef (the confirmation_request's seq) and bridgeNonce from the trailer the gateway relayed",
    };
  }

  const outcome = authorizeBridgeDeploy({ ref: ref as number, nonce, sha: revision.toLowerCase() }, now);
  if (!outcome.ok) {
    return {
      ok: false,
      status: 403,
      reason: outcome.reason,
      error: `the bridge confirmation for this deploy was refused (${outcome.reason}); ask the user again and deploy nothing`,
    };
  }
  return { ok: true, sha: outcome.sha };
}
