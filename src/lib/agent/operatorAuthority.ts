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
 * A CREDENTIAL, NOT A HEADER SHAPE. The first version of this accepted
 * `sec-fetch-site: same-origin` with a matching `Origin`/`Host` as proof of being the
 * operator's browser. That was wrong, and wrong in the way that matters most here: a
 * forbidden header name is forbidden to page JavaScript, not to a local process, so
 * any worker could omit its own capability, write those three headers, and inherit
 * the right to appoint itself the manager. Same-origin is a CSRF signal about where a
 * browser request came from; it is not an identity, and every gate in this feature
 * ultimately resolves here.
 *
 * So authority is possession of the operator capability — the 0600 secret
 * `operatorCapability.ts` already mints for exactly this purpose, and which
 * `spawn/admission.ts` already treats as operator proof. Agents are issued their own
 * per-conversation capability instead; presenting one names the caller as a worker
 * and is refused outright.
 *
 * The operator's browser gets it the only way a browser can hold a server secret: the
 * server renders it into the page it serves. That is a possession check an agent
 * cannot satisfy by writing headers.
 *
 * Not isolation against a process running as the operator's own uid, which could read
 * the file — nothing in this app is, and that is the repo's standing boundary. What it
 * does close is the gap the review found: authority derived from evidence the caller
 * can simply write.
 */

export type OperatorAuthority =
  | { ok: true }
  | { ok: false; status: number; error: string };

const AGENT_CAPABILITY = /^[A-Za-z0-9_-]{43}$/;

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

const MISSING: OperatorAuthority = {
  ok: false,
  status: 403,
  error: "this is an operator-only action and requires the operator capability; header shape and same-origin do not authorize it",
};

export function requireOperatorAuthority(request: Pick<NextRequest, "headers">): OperatorAuthority {
  const capability = request.headers.get(VIEWER_SPAWN_CAPABILITY_HEADER)?.trim() ?? "";
  if (!capability) return MISSING;

  /* An agent that presented its own capability has named itself. Refused before the
     operator comparison so the answer cannot depend on anything else about the
     request. */
  if (callerConversationId(request)) {
    return {
      ok: false,
      status: 403,
      error: "this is an operator-only action; an agent may not perform it, whatever role it holds",
    };
  }
  try {
    if (matchesOperatorSpawnCapability(capability)) return { ok: true };
  } catch (error) {
    if (error instanceof OperatorSpawnCapabilityError) {
      return { ok: false, status: 503, error: error.message };
    }
    throw error;
  }
  return MISSING;
}
