import crypto from "node:crypto";

import type { NextRequest } from "next/server";

import { agentRegistry } from "@/lib/agent/registry";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/spawnPolicy";

/**
 * "Is this the operator, or an agent?" — for the decisions only the operator may make.
 *
 * #691 round 5 found the shape of the hole: every gate in the bridge keys off *is
 * this the designated manager*, so anything able to APPOINT the manager inherits all
 * of that authority at once. Designation therefore needs a different question
 * answered — not "which conversation are you" but "are you a conversation at all".
 *
 * That question is answered below, and it is the ONLY question asked. Rounds 5–10
 * answered a second one — "does the caller possess the operator session secret" —
 * and the whole apparatus that made possession possible (a printed key, a paste
 * field, a per-tab volatile credential, a reload that lost it) was built, shipped to
 * stage, and rejected by the operator. See `voiceTransportOperator` below for the
 * reasoning that replaced it.
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

/**
 * THE OPERATOR IS THE LOCAL BROWSER. There is no ceremony, anywhere.
 *
 * The question every gate in this feature actually needs answered is
 * AGENT-versus-OPERATOR, and it never was human authentication. This application
 * is single-user and bound to loopback; its routes reject cross-origin before
 * consulting authority, and that rejection is the perimeter. A same-origin request
 * therefore IS the operator by construction. An agent is distinguishable on
 * entirely different grounds: it names itself by presenting the conversation
 * capability the registry issued it. That self-naming is the only disqualifier
 * here.
 *
 * The operator's final decision, after the ceremony was built and rejected on
 * stage: no key, no secret, no cookie, no paste, no unlock, on ANY operator
 * surface. Opening the manager with one click, and starting a call from a card
 * with one click, are the two gestures that made it unusable — a tab that had not
 * been through a paste could do neither, and a reload put it back where it
 * started. The mechanism that made those clicks work also made the product wrong.
 *
 * What is NOT relaxed, and must not be:
 *
 * - INJECTION into a live call. `permitRealtimeAction` grants `appendSpeech` and
 *   `deliverWorkerResponse` to the peer that established the call — proven by the
 *   realtime session id the backend minted for it — and to nobody else, whatever
 *   this function returns. Speaking in the assistant's voice is not a transport
 *   act and does not follow transport rules.
 * - AGENTS. A caller presenting a conversation capability is refused every
 *   operator-only action, including designation, whatever role it holds.
 *
 * Residual, stated plainly rather than papered over: a local process running as
 * the operator's uid can send the same same-origin-shaped request the browser
 * sends, so it can now reach designation too. Five rounds of credential designs
 * established that no arrangement of software on one uid excludes such a process —
 * every place a browser can hold a value at rest is a file that process can read —
 * and the operator has chosen the working product over a gate that raised the cost
 * without closing the hole.
 */
export function voiceTransportOperator(request: Pick<NextRequest, "headers">): boolean {
  return callerConversationId(request) === null;
}

const AGENT_REFUSED: OperatorAuthority = {
  ok: false,
  status: 403,
  error: "this is an operator-only action; an agent may not perform it, whatever role it holds",
};

/**
 * Whether this request may perform an operator-only action.
 *
 * One rule, the same one the transport uses: anything that is not an agent. The
 * caller is responsible for having rejected cross-origin first — that is where the
 * perimeter lives, and this function cannot see it.
 */
export function requireOperatorAuthority(request: Pick<NextRequest, "headers">): OperatorAuthority {
  /* An agent that presented its own capability has named itself. Nothing else about
     the request is consulted, because nothing else about it is evidence. */
  return callerConversationId(request) ? AGENT_REFUSED : { ok: true };
}
