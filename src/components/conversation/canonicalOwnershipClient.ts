"use client";

import type { CanonicalOwnershipClaim } from "@/lib/runtime/canonicalOwnership";

export async function acknowledgeCanonicalOwnership(
  claim: CanonicalOwnershipClaim,
): Promise<boolean> {
  try {
    const response = await fetch("/api/runtime/canonical-ownership", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(claim),
    });
    return response.ok;
  } catch {
    return false;
  }
}
