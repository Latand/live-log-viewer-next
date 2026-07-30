/**
 * The shape of a deploy request that claims the user's authorization (#691 §4).
 *
 * Sealing endpoints one at a time was the wrong shape, and the third door proved it:
 * the MCP binding, `POST /api/runtime/deployments` and a raw runtime-host socket are
 * three ways to ask for the same deploy, and a gate on each closes only that one.
 *
 * The confirmation is verified and CONSUMED in exactly one place — the runtime
 * host's admission, where the MCP binding, the HTTP route and a raw socket client
 * all converge. Everything above that forwards. This module holds only the shape
 * check the forwarding layers use to fail fast with a useful message.
 */

export interface BridgeDeployProof {
  bridgeRef?: unknown;
  bridgeNonce?: unknown;
}

export type BridgeDeployProofShape =
  | { ok: true; sha: string }
  | { ok: false; status: number; error: string; reason: string };

/**
 * Whether this request is even shaped like an authorized deploy.
 *
 * Shape ONLY. Nothing is verified against the bridge and nothing is spent — that
 * happens once, at host admission. A forwarding layer that consumed here would
 * spend the operator's yes before the gate that matters ever saw it, and the real
 * deploy would then be refused as already consumed.
 */
export function describeDeployProof(
  revision: unknown,
  proof: BridgeDeployProof,
): BridgeDeployProofShape {
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
      error: "a deploy requires the operator's recorded deploy authorization: bridgeRef and bridgeNonce from the trailer minted when their deploy intent was accepted (or a legacy confirmation trailer)",
    };
  }
  return { ok: true, sha: revision.toLowerCase() };
}
