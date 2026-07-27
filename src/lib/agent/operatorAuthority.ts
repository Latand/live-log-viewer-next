import crypto from "node:crypto";

import type { NextRequest } from "next/server";

import { agentRegistry } from "@/lib/agent/registry";
import { matchesOperatorSpawnCapability, OperatorSpawnCapabilityError } from "@/lib/agent/operatorCapability";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";

/**
 * "Is this the operator, or an agent?" — for the decisions only the operator may make.
 *
 * #691 round 5 found the shape of the hole: every gate in the bridge keys off *is
 * this the designated manager*, so anything able to APPOINT the manager inherits all
 * of that authority at once. Designation change, and transport mutation on the
 * operator's own call, therefore need a different question answered — not "which
 * conversation are you" but "are you a conversation at all".
 *
 * Two signals, in the order that matters:
 *
 * 1. A caller presenting a spawn capability the registry can NAME is a worker, and is
 *    refused outright. This is the positive identification, and it is the one that
 *    closes the reported hole: a local worker holds exactly this.
 * 2. Otherwise the request must look like the operator's own browser — `sec-fetch-site:
 *    same-origin` with a matching `Origin`/`Host` — or carry the operator capability.
 *    `sec-fetch-site` is a forbidden header name, so page JavaScript cannot forge it,
 *    and this is the same discrimination `spawn/admission.ts` already trusts to decide
 *    whether a spawn needs a capability at all.
 *
 * Not cryptographic isolation against a process running as the operator — nothing in
 * this app is, since the capability file is readable by the same uid. What it does do
 * is stop an agent from making these calls with the credentials it actually has.
 */

export type OperatorAuthority =
  | { ok: true; via: "browser" | "capability" }
  | { ok: false; status: number; error: string };

const AGENT_CAPABILITY = /^[A-Za-z0-9_-]{43}$/;

/** A genuine same-origin browser request. Mirrors `isAgentInitiatedSpawn`, inverted. */
function fromOperatorBrowser(request: Pick<NextRequest, "headers">): boolean {
  if (request.headers.get("sec-fetch-site") !== "same-origin") return false;
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

type ConversationResolver = (digest: string) => string | null;

const productionResolver: ConversationResolver = (digest) =>
  agentRegistry().conversationIdForSpawnCapabilityDigest(digest);

let resolveConversation: ConversationResolver = productionResolver;

/** Tests only; `null` restores the registry lookup. Seamed here rather than in a
    route, because a route module may export only route fields. */
export function setCallerConversationResolverForTests(resolver: ConversationResolver | null): void {
  resolveConversation = resolver ?? productionResolver;
}

/** The conversation a presented capability names, or null when it names none. */
export function callerConversationId(request: Pick<NextRequest, "headers">): string | null {
  const capability = request.headers.get(VIEWER_SPAWN_CAPABILITY_HEADER)?.trim() ?? "";
  if (!capability || !AGENT_CAPABILITY.test(capability)) return null;
  return resolveConversation(crypto.createHash("sha256").update(capability).digest("hex"));
}

export function requireOperatorAuthority(request: Pick<NextRequest, "headers">): OperatorAuthority {
  const capability = request.headers.get(VIEWER_SPAWN_CAPABILITY_HEADER)?.trim() ?? "";

  /* An agent that presented its own capability has named itself. Refused before
     anything else, so a worker cannot reach the browser branch by ALSO looking like
     a browser. */
  if (capability) {
    if (callerConversationId(request)) {
      return {
        ok: false,
        status: 403,
        error: "this is an operator-only action; an agent may not perform it, whatever role it holds",
      };
    }
    try {
      if (matchesOperatorSpawnCapability(capability)) return { ok: true, via: "capability" };
    } catch (error) {
      if (error instanceof OperatorSpawnCapabilityError) {
        return { ok: false, status: 503, error: error.message };
      }
      throw error;
    }
    return {
      ok: false,
      status: 403,
      error: "the presented capability does not authorize this operator-only action",
    };
  }

  if (fromOperatorBrowser(request)) return { ok: true, via: "browser" };
  return {
    ok: false,
    status: 403,
    error: "this is an operator-only action: call it from the Viewer, or present the operator capability",
  };
}
