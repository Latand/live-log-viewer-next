"use client";

import type { ReturnPoint } from "@/lib/attention/types";

/**
 * The durable half of one tab's directed-handoff execution (#873 review,
 * finding 2).
 *
 * A directed request is executed by exactly one browser session, and the two
 * facts that execution stands on — "this tab already owns the move" and "this
 * is the viewport the operator is leaving" — used to live only in component
 * refs. React remounts the host (strict-mode double mounts, shell reshuffles)
 * without ending the tab, and every remount forgot both: a duplicate mount
 * re-ran the navigation, and a remount mid-handoff re-captured the viewport
 * AFTER the camera had moved, writing the destination down as the way back.
 *
 * sessionStorage is exactly the right lifetime: per tab (two tabs on one
 * device never share a claim, matching the record's own `directedSessionId`),
 * and surviving remounts within the tab while dying with it.
 */

export type ClaimedViewport = Pick<ReturnPoint, "mode" | "camera" | "focusedPath"> & { project: string | null };

interface StoredClaim {
  viewport: ClaimedViewport;
  claimedAt: string;
}

const CLAIM_PREFIX = "llvAttentionHandoff:";

type ClaimStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function parseClaim(raw: string | null): StoredClaim | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredClaim>;
    if (!parsed.viewport || typeof parsed.viewport !== "object") return null;
    return parsed as StoredClaim;
  } catch {
    return null;
  }
}

/**
 * Claim this tab's execution of one request, capturing the pre-move viewport
 * exactly once. `first` is true only for the writer that created the claim;
 * every later caller — a duplicate mount, a remount — gets the ORIGINAL
 * viewport back, never a recapture of wherever the camera is now.
 *
 * With no usable storage (private mode), execution falls back to in-memory
 * refs: `first` is true and the viewport is the captured one, which is the
 * pre-claim behavior.
 */
export function claimHandoff(
  storage: ClaimStorage | null,
  requestId: string,
  capture: () => ClaimedViewport,
): { first: boolean; viewport: ClaimedViewport } {
  const key = CLAIM_PREFIX + requestId;
  try {
    const held = parseClaim(storage?.getItem(key) ?? null);
    if (held) return { first: false, viewport: held.viewport };
  } catch {
    /* unreadable storage — treat as unclaimed */
  }
  const viewport = capture();
  try {
    storage?.setItem(key, JSON.stringify({ viewport, claimedAt: new Date().toISOString() } satisfies StoredClaim));
  } catch {
    /* unwritable storage — the claim lives only in this mount's refs */
  }
  return { first: true, viewport };
}

/** The claimed pre-move viewport, when this tab holds one for the request. */
export function readHandoffClaim(storage: ClaimStorage | null, requestId: string): ClaimedViewport | null {
  try {
    return parseClaim(storage?.getItem(CLAIM_PREFIX + requestId) ?? null)?.viewport ?? null;
  } catch {
    return null;
  }
}

/** Drop the claim once the record itself carries the outcome — the arrival
    (with its return point) or a refusal both mean the durable copy has taken
    over from this tab's scratch one. */
export function clearHandoffClaim(storage: ClaimStorage | null, requestId: string): void {
  try {
    storage?.removeItem(CLAIM_PREFIX + requestId);
  } catch {
    /* nothing to clear */
  }
}
