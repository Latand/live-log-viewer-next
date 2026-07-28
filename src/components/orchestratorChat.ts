import { ORCHESTRATOR_SPAWN_CONFIG, ORCHESTRATOR_SYSTEM_PROMPT } from "@/lib/orchestrator/prompt";

/* The chat button's resolve-or-spawn flow (issue #182), as a pure module the
 * button renders from: GET the single-instance record, spawn a fresh
 * orchestrator only when none is live, adopt it first-write-wins, and hand
 * back the canonical conversation id to navigate to. */

export interface OrchestratorStatusBody {
  record: { conversationId: string; path: string | null } | null;
  exists: boolean;
  defaultCwd: string;
}

/** The exact /api/spawn body a fresh orchestrator launches with. */
export function orchestratorSpawnBody(cwd: string): Record<string, unknown> {
  return { ...ORCHESTRATOR_SPAWN_CONFIG, cwd, prompt: ORCHESTRATOR_SYSTEM_PROMPT };
}

/** Canonical deep link the Viewer hash router resolves and pins. */
export function orchestratorHash(conversationId: string): string {
  return "#c=" + encodeURIComponent(conversationId);
}

import { operatorHeaders } from "./operatorCredential";

const JSON_HEADERS = { "content-type": "application/json" };

async function bodyOf<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Resolve THE orchestrator conversation, spawning one when needed. Returns the
 * canonical conversation id — when another tab won the adoption race, that is
 * the winner's id, so every button lands on the same conversation.
 */
export async function openOrchestratorConversation(fetchFn: typeof fetch = fetch): Promise<string> {
  const statusResponse = await fetchFn("/api/orchestrator");
  const status = await bodyOf<OrchestratorStatusBody>(statusResponse);
  if (!statusResponse.ok || !status) throw new Error("orchestrator status unavailable");
  if (status.record && status.exists) return status.record.conversationId;

  /* NO SPAWN WITHOUT THE AUTHORITY TO ADOPT. The spawn is the side effect and
     the adoption is the gate, so their old order inverted the invariant for an
     unauthorized browser: the spawn succeeded, the operator-only adoption was
     refused, no record was written — and the NEXT click saw an empty slot and
     spawned again. Four stalled managers on the hosted stage came from exactly
     that loop. The single-instance guarantee still lives in first-write-wins
     adoption; this check just refuses to create anything it could never seat. */
  const authorityResponse = await fetchFn("/api/operator/session", {
    cache: "no-store",
    headers: operatorHeaders(),
  });
  const authority = await bodyOf<{ operator?: boolean }>(authorityResponse);
  if (!authorityResponse.ok || authority?.operator !== true) {
    throw new Error("orchestrator spawn requires operator authority in this browser");
  }

  const spawnResponse = await fetchFn("/api/spawn", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(orchestratorSpawnBody(status.defaultCwd)),
  });
  const spawn = await bodyOf<{ ok?: boolean; conversationId?: string; path?: string | null; error?: string }>(spawnResponse);
  if (!spawnResponse.ok || !spawn?.ok || typeof spawn.conversationId !== "string") {
    throw new Error(spawn?.error || "orchestrator spawn failed");
  }

  const adoptResponse = await fetchFn("/api/orchestrator", {
    method: "POST",
    /* Designation is operator-only and needs the capability, not a request that
       merely looks same-origin (#691 round 6). */
    headers: { ...JSON_HEADERS, ...operatorHeaders() },
    body: JSON.stringify({ conversationId: spawn.conversationId, path: spawn.path ?? null }),
  });
  const adopt = await bodyOf<{ ok?: boolean; record?: { conversationId: string } }>(adoptResponse);
  if (!adoptResponse.ok || !adopt?.ok || !adopt.record) throw new Error("orchestrator adoption failed");
  return adopt.record.conversationId;
}
