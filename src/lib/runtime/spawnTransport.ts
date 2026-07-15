import type { AgentEngine } from "@/lib/agent/cli";
import { codexModelSupportsImages } from "@/lib/agent/models";
import { CODEX_STRUCTURED_IMAGE_REASON } from "./structuredContent";

export type SpawnTransport = "tmux" | "structured";

export function spawnTransport(env: Readonly<Record<string, string | undefined>> = process.env): SpawnTransport {
  const value = env.LLV_SPAWN_TRANSPORT?.trim() || "tmux";
  if (value !== "tmux" && value !== "structured") {
    throw new Error("LLV_SPAWN_TRANSPORT must be tmux or structured");
  }
  return value;
}

export function structuredSpawnGap(
  request: { engine: AgentEngine; model: string | null; hasImages: boolean; fast: boolean | null },
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  if (env.LLV_STRUCTURED_HOSTS !== "1") return "structured spawn requires LLV_STRUCTURED_HOSTS=1";
  if (env.LLV_RUNTIME_EVENTS !== "1") return "structured spawn requires LLV_RUNTIME_EVENTS=1";
  if (!env.LLV_RUNTIME_HOST_SOCKET?.trim()) return "structured spawn requires LLV_RUNTIME_HOST_SOCKET";
  if (env.NEXT_PUBLIC_RUNTIME_UI !== "1") return "structured spawn requires NEXT_PUBLIC_RUNTIME_UI=1 for viewer controls";
  if (request.hasImages && request.engine === "codex" && !codexModelSupportsImages(request.model)) {
    return CODEX_STRUCTURED_IMAGE_REASON;
  }
  if (request.engine === "codex" && request.fast !== null) {
    return "structured Codex spawn does not support an explicit Codex service tier";
  }
  return null;
}
