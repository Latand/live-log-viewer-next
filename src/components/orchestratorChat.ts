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
    headers: JSON_HEADERS,
    body: JSON.stringify({ conversationId: spawn.conversationId, path: spawn.path ?? null }),
  });
  const adopt = await bodyOf<{ ok?: boolean; record?: { conversationId: string } }>(adoptResponse);
  if (!adoptResponse.ok || !adopt?.ok || !adopt.record) throw new Error("orchestrator adoption failed");
  return adopt.record.conversationId;
}
