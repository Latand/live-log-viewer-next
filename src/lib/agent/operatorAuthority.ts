import crypto from "node:crypto";

import type { NextRequest } from "next/server";

import { agentRegistry } from "@/lib/agent/registry";
import { ensureOperatorSpawnCapability } from "@/lib/agent/operatorCapability";
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
const INTERNAL_SERVICE_HEADER = "x-llv-internal-service";
const INTERNAL_SERVICE_TAG = /^[a-f0-9]{64}$/;
const INTERNAL_SERVICES = ["monitor", "mcp", "orchestrator"] as const;
export type InternalViewerService = typeof INTERNAL_SERVICES[number];

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
 *   ROTATION IS NOT ONE OF THEM (#1402): see `rotationActor` below, which asks
 *   the same question and answers it with a NAME. It has no refusal to give.
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

const SERVICE_REFUSED: OperatorAuthority = {
  ok: false,
  status: 403,
  error: "background Viewer activity is outside direct operator activity",
};

function internalServiceTag(service: InternalViewerService): string {
  return crypto.createHmac("sha256", ensureOperatorSpawnCapability())
    .update(`llv-internal-service-v1\0${service}`)
    .digest("hex");
}

/** A server-verifiable lane marker for Viewer-owned HTTP producers. */
export function internalServiceHeaders(service: InternalViewerService): Record<string, string> {
  return { [INTERNAL_SERVICE_HEADER]: `${service}.${internalServiceTag(service)}` };
}

function internalServiceClaim(request: Pick<NextRequest, "headers">): "absent" | "valid" | "invalid" {
  const value = request.headers.get(INTERNAL_SERVICE_HEADER)?.trim() ?? "";
  if (!value) return "absent";
  const separator = value.indexOf(".");
  const service = value.slice(0, separator) as InternalViewerService;
  const tag = value.slice(separator + 1);
  if (!(INTERNAL_SERVICES as readonly string[]).includes(service) || !INTERNAL_SERVICE_TAG.test(tag)) return "invalid";
  try {
    const expected = internalServiceTag(service);
    return crypto.timingSafeEqual(Buffer.from(tag), Buffer.from(expected)) ? "valid" : "invalid";
  } catch {
    return "invalid";
  }
}

/** Classifies direct activity while leaving the product authority gate intact. */
export function directOperatorActivityAuthority(request: Pick<NextRequest, "headers">): OperatorAuthority {
  if (internalServiceClaim(request) === "valid") return SERVICE_REFUSED;
  return requireOperatorAuthority(request);
}

/** Who a request says it is. `operator` is the local browser — anything that
    named no conversation; `agent` is a caller that named itself with the
    conversation capability the registry issued it. */
export type ViewerActorKind = "operator" | "agent";

export interface ViewerActor {
  kind: ViewerActorKind;
  /** The conversation the caller named itself with; null for the operator. */
  conversationId: string | null;
}

/**
 * ROTATION AUTHORITY — the one contract, shared by both rotation surfaces (#1402).
 *
 * `POST /api/orchestrator/rotate` and the `rotate_orchestrator` MCP tool used to
 * disagree about the same actor: the route accepted the local caller and performed
 * the rotation, while the tool — which reaches the rotation only through that
 * route, forwarding the calling session's own conversation capability — was refused
 * by `requireOperatorAuthority` as "an agent may not perform it, whatever role it
 * holds". So the surface agents are told to prefer was the one surface that could
 * not do it, and the shell fallback was the only working path.
 *
 * Nobody ever configured that ban, and the operator's rule is that controls are
 * CAPABILITY, not prohibition: their word is the trigger, and whoever acts on it
 * must be able to execute through the first-class tool. So rotation asks who the
 * caller is and never whether they may — this function BANS NOBODY and cannot
 * refuse. Its answer is attribution: the rotation record carries the actor kind and
 * the triggering conversation, so a rotation nobody can be stopped from performing
 * is still a rotation everybody can see the author of.
 *
 * The perimeter is unchanged and is not this function's job: `rejectCrossOrigin`
 * runs first in the route, exactly as it does for every other authority decision
 * here. Because the tool holds no second copy of the rule — it posts to the route
 * and inherits whatever the route decides — the two surfaces cannot drift again.
 */
export function rotationActor(request: Pick<NextRequest, "headers">): ViewerActor {
  const conversationId = callerConversationId(request);
  return conversationId ? { kind: "agent", conversationId } : { kind: "operator", conversationId: null };
}

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
