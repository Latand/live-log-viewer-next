import type { AgentEngine } from "@/lib/agent/cli";
import { codexModelSupportsImages } from "@/lib/agent/models";
import { runtimeEventsEnabled, runtimeHostSocket, structuredHostsEnabled } from "./flags";
import { CODEX_STRUCTURED_IMAGE_REASON } from "./structuredContent";

export type SpawnTransport = "tmux" | "structured";

/** A deployment that carries a runtime host is structured-capable: no tmux
    server sits between the viewer and the agent. */
function structuredTransportAvailable(env: Readonly<Record<string, string | undefined>>): boolean {
  return structuredHostsEnabled(env as NodeJS.ProcessEnv) && runtimeEventsEnabled(env as NodeJS.ProcessEnv);
}

/** Structured is the default wherever it can actually run: pane-less spawns are
    the faster path, so a deployment with a runtime host takes it without being
    told to. Environments without a host still spawn through tmux instead of
    failing, and an explicit `LLV_SPAWN_TRANSPORT` always wins — asking for
    structured without a host keeps returning the gap that names what is
    missing, rather than silently downgrading a deliberate choice. */
export function spawnTransport(env: Readonly<Record<string, string | undefined>> = process.env): SpawnTransport {
  const requested = env.LLV_SPAWN_TRANSPORT?.trim();
  if (!requested) return structuredTransportAvailable(env) ? "structured" : "tmux";
  if (requested !== "tmux" && requested !== "structured") {
    throw new Error("LLV_SPAWN_TRANSPORT must be tmux or structured");
  }
  return requested;
}

export function structuredSpawnGap(
  request: { engine: AgentEngine; model: string | null; hasImages: boolean; fast: boolean | null },
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  if (!structuredHostsEnabled(env as NodeJS.ProcessEnv)) return "structured spawn is rolled back by LLV_STRUCTURED_HOSTS=0";
  if (env.LLV_RUNTIME_EVENTS === "0") return "structured spawn is rolled back by LLV_RUNTIME_EVENTS=0";
  if (!runtimeHostSocket(env as NodeJS.ProcessEnv)) return "structured spawn requires a runtime host socket (LLV_RUNTIME_HOST_SOCKET)";
  if (env.NEXT_PUBLIC_RUNTIME_UI === "0") return "structured spawn requires the runtime UI (NEXT_PUBLIC_RUNTIME_UI=0 removes the viewer controls)";
  if (request.hasImages && request.engine === "codex" && !codexModelSupportsImages(request.model)) {
    return CODEX_STRUCTURED_IMAGE_REASON;
  }
  if (request.engine === "codex" && request.fast !== null) {
    return "structured Codex spawn does not support an explicit Codex service tier";
  }
  return null;
}
