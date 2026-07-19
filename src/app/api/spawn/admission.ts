import crypto from "node:crypto";
import type { NextRequest } from "next/server";

import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import type { AgentRegistry } from "@/lib/agent/registry";
import { matchesOperatorSpawnCapability, OperatorSpawnCapabilityError } from "@/lib/agent/operatorCapability";
import { VIEWER_SPAWN_CAPABILITY_HEADER, VIEWER_SPAWN_ENDPOINT } from "@/lib/agent/spawnPolicy";

export const AGENT_SPAWN_LIVE_CHILD_CAP = 20;
export const AGENT_SPAWN_LINEAGE_ERROR = `Agent-initiated spawns require role; reviewer spawns also require reviews (the implementer conversation or transcript). The parent is inferred from the authenticated caller conversation; src stays optional verification. POST ${VIEWER_SPAWN_ENDPOINT} with {engine, model, cwd, prompt, role, src?, reviews?}.`;

export type AuthenticatedSpawnCaller =
  | { kind: "agent"; conversationId: ViewerConversationId; liveChildrenCap: number }
  | { kind: "operator"; conversationId: null; liveChildrenCap: undefined };

export type SpawnLineageSelector = {
  role?: unknown;
  reviews?: unknown;
  src?: unknown;
  parent?: unknown;
  parentConversationId?: unknown;
};

export function spawnLineageSelectorForCaller(
  caller: AuthenticatedSpawnCaller | null,
  body: SpawnLineageSelector,
): SpawnLineageSelector {
  if (caller?.kind === "agent") {
    return { parentConversationId: caller.conversationId, role: body.role, reviews: body.reviews };
  }
  if (caller?.kind === "operator") {
    return { src: body.src, role: body.role, reviews: body.reviews };
  }
  return body;
}

export function isAgentInitiatedSpawn(req: Pick<NextRequest, "headers">): boolean {
  if (req.headers.get("sec-fetch-site") !== "same-origin") return true;
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (!origin || !host) return true;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

/** Lineage no longer gates admission on `src` (#341): the durable parent is
    inferred from the authenticated caller conversation, so agent-initiated
    requests only need their admission identity (`role`, plus `reviews` for
    reviewers). A present `src` stays verified against the caller. */
export function agentSpawnLineageError(
  req: Pick<NextRequest, "headers">,
  body: { src?: unknown; role?: unknown; reviews?: unknown },
): string | null {
  if (!isAgentInitiatedSpawn(req)) return null;
  if (body.src !== undefined && (typeof body.src !== "string" || !body.src.trim())) return AGENT_SPAWN_LINEAGE_ERROR;
  if (typeof body.role !== "string" || !body.role.trim()) return AGENT_SPAWN_LINEAGE_ERROR;
  if (body.role.trim() === "reviewer" && (typeof body.reviews !== "string" || !body.reviews.trim())) {
    return AGENT_SPAWN_LINEAGE_ERROR;
  }
  return null;
}

export function authenticatedAgentSpawnCaller(
  req: Pick<NextRequest, "headers">,
  src: unknown,
  registry: AgentRegistry,
): AuthenticatedSpawnCaller | { error: string; status?: number } {
  const capability = req.headers.get(VIEWER_SPAWN_CAPABILITY_HEADER)?.trim() ?? "";
  const digest = capability && /^[A-Za-z0-9_-]{43}$/.test(capability)
    ? crypto.createHash("sha256").update(capability).digest("hex")
    : "";
  const conversationId = registry.conversationIdForSpawnCapabilityDigest(digest);
  if (conversationId) {
    /* `src` became optional for capability callers (#341): the authenticated
       conversation is the parent either way. When present it must still
       resolve to the caller, so a spoofed selector keeps its rejection. */
    if (src !== undefined && src !== null) {
      const source = typeof src === "string" ? registry.conversationForPath(src.trim()) : null;
      if (!source || source.id !== conversationId) {
        return { error: "src must identify the authenticated caller conversation" };
      }
    }
    return { kind: "agent", conversationId, liveChildrenCap: AGENT_SPAWN_LIVE_CHILD_CAP };
  }
  try {
    if (matchesOperatorSpawnCapability(capability)) {
      return { kind: "operator", conversationId: null, liveChildrenCap: undefined };
    }
  } catch (error) {
    if (error instanceof OperatorSpawnCapabilityError) return { error: error.message, status: 503 };
    throw error;
  }
  return { error: `Agent spawn requests require ${VIEWER_SPAWN_CAPABILITY_HEADER}: $LLV_SPAWN_CAPABILITY from the caller launch.` };
}
