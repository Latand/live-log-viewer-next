"use client";

import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";

/**
 * The operator capability, as the browser holds it (#691 round 6).
 *
 * Operator-only actions — changing the manager designation, opening and closing the
 * voice transport — used to be authorized by request shape: `sec-fetch-site:
 * same-origin` with a matching `Origin`. That is a CSRF signal about where a BROWSER
 * request came from, and a local process can write all three headers, so any worker
 * could omit its own capability and inherit the right to appoint itself the manager.
 *
 * A credential fixes that, and a browser can only hold a server secret if the server
 * puts it there: `page.tsx` reads the capability during the server render and seeds
 * it here. Nothing fetches it over HTTP, because an endpoint that hands it out is the
 * forgeable classification again with extra steps.
 *
 * Held in a module variable rather than storage on purpose. It should live exactly as
 * long as the document does; persisting it would leave the operator's capability in
 * a place every later page — and anything that can read that origin's storage — can
 * pick it up.
 */

let capability: string | null = null;

/** Seeded once, from the server render. */
export function seedOperatorCredential(value: string | null): void {
  if (value) capability = value;
}

export function operatorCredential(): string | null {
  return capability;
}

/**
 * Headers for an operator-only request.
 *
 * Returns nothing when the credential is absent, which makes the call fail closed at
 * the server with a clear refusal rather than appearing to work.
 */
export function operatorHeaders(): Record<string, string> {
  return capability ? { [VIEWER_SPAWN_CAPABILITY_HEADER]: capability } : {};
}

/** Tests only. */
export function resetOperatorCredentialForTests(): void {
  capability = null;
}
