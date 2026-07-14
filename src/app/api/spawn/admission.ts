import crypto from "node:crypto";
import type { NextRequest } from "next/server";

import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import type { AgentRegistry } from "@/lib/agent/registry";
import { VIEWER_SPAWN_CAPABILITY_HEADER, VIEWER_SPAWN_ENDPOINT } from "@/lib/agent/spawnPolicy";

export const AGENT_SPAWN_LIVE_CHILD_CAP = 3;
export const AGENT_SPAWN_LINEAGE_ERROR = `Agent-initiated spawns require src (the caller transcript path) and role; reviewer spawns also require reviews (the implementer conversation or transcript). POST ${VIEWER_SPAWN_ENDPOINT} with {engine, model, cwd, prompt, src, role, reviews?}.`;

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

export function agentSpawnLineageError(
  req: Pick<NextRequest, "headers">,
  body: { src?: unknown; role?: unknown; reviews?: unknown },
): string | null {
  if (!isAgentInitiatedSpawn(req)) return null;
  if (typeof body.src !== "string" || !body.src.trim()) return AGENT_SPAWN_LINEAGE_ERROR;
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
): { conversationId: ViewerConversationId } | { error: string } {
  const capability = req.headers.get(VIEWER_SPAWN_CAPABILITY_HEADER)?.trim() ?? "";
  const digest = capability && /^[A-Za-z0-9_-]{43}$/.test(capability)
    ? crypto.createHash("sha256").update(capability).digest("hex")
    : "";
  const conversationId = registry.conversationIdForSpawnCapabilityDigest(digest);
  if (!conversationId) {
    return { error: `Agent spawn requests require ${VIEWER_SPAWN_CAPABILITY_HEADER}: $LLV_SPAWN_CAPABILITY from the caller launch.` };
  }
  const source = typeof src === "string" ? registry.conversationForPath(src.trim()) : null;
  if (!source || source.id !== conversationId) {
    return { error: "src must identify the authenticated caller conversation" };
  }
  return { conversationId };
}
