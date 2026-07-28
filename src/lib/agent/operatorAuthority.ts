import crypto from "node:crypto";

import type { NextRequest } from "next/server";

import { agentRegistry } from "@/lib/agent/registry";
import {
  matchesOperatorBrowserSession,
  OPERATOR_SESSION_COOKIE,
} from "@/lib/agent/operatorBrowserSession";
import { matchesOperatorSession } from "@/lib/agent/operatorSession";
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
 * So authority is possession of the OPERATOR SESSION SECRET — see
 * `operatorSession.ts` — which exists only in this server process's memory. Not the
 * spawn capability: that one lives in a file, and every worker runs as the operator's
 * uid, so a file the Viewer can read is a file every worker can read. Agents are
 * issued their own per-conversation capability; presenting one names the caller as a
 * worker and is refused outright.
 *
 * The operator's browser gets the secret out of band, in the URL fragment of the
 * startup link, and it appears in no response and no file.
 */

export type OperatorAuthority =
  | { ok: true }
  | { ok: false; status: number; error: string };

/* Shape of a per-conversation spawn capability, used only to decide whether the
   registry is worth asking about the presented value. */
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
  error: "this is an operator-only action and requires the operator session secret from the startup link; header shape, same-origin and the on-disk spawn capability do not authorize it",
};

/** The browser-session cookie, read straight off the header so this primitive
    keeps its narrow `Pick<NextRequest, "headers">` surface. */
function browserSessionCookie(request: Pick<NextRequest, "headers">): string {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== OPERATOR_SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return part.slice(separator + 1).trim();
    }
  }
  return "";
}

export function requireOperatorAuthority(request: Pick<NextRequest, "headers">): OperatorAuthority {
  /* An agent that presented its own capability has named itself. Refused before
     every acceptance path — including the browser cookie — so the answer cannot
     depend on anything else about the request. */
  if (callerConversationId(request)) {
    return {
      ok: false,
      status: 403,
      error: "this is an operator-only action; an agent may not perform it, whatever role it holds",
    };
  }
  /* Compared against a secret that exists only in this process's memory. The spawn
     capability deliberately is NOT accepted here: it lives in a file, and every
     worker runs as the operator's uid, so a file the Viewer can read is a file every
     worker can read. That was the fourth way into this gate. */
  const capability = request.headers.get(VIEWER_SPAWN_CAPABILITY_HEADER)?.trim() ?? "";
  if (capability && matchesOperatorSession(capability)) return { ok: true };
  /* The browser session: an httpOnly cookie the server set for a browser that
     once presented the startup link (`operatorBrowserSession.ts`). Possession
     still, in a place page JavaScript cannot read and a local process cannot
     write; `SameSite=Strict` keeps foreign origins from riding it. */
  if (matchesOperatorBrowserSession(browserSessionCookie(request))) return { ok: true };
  return MISSING;
}
