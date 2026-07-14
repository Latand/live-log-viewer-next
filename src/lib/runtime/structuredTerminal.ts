import path from "node:path";

import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { shellQuote } from "@/lib/agent/cli";
import { sessionKeyId } from "@/lib/agent/sessionKey";
import { spawnCommandWindow } from "@/lib/tmux";

export interface StructuredTerminalResult {
  target: string;
  display: string;
}

export async function materializeStructuredTerminal(
  artifactPath: string,
  dependencies: {
    registry?: AgentRegistry;
    spawn?: typeof spawnCommandWindow;
  } = {},
): Promise<StructuredTerminalResult> {
  const registry = dependencies.registry ?? agentRegistry();
  const conversation = registry.conversationForPath(artifactPath);
  const generation = conversation?.generations.at(-1);
  if (!conversation || !generation) throw new Error("structured conversation is unavailable");
  const entry = registry.snapshot().entries[sessionKeyId({ engine: conversation.engine, sessionId: generation.id })];
  if (!entry?.structuredHost || entry.status === "dead" || entry.status === "unhosted") {
    throw new Error("structured conversation has no live host to attach");
  }
  const pane = await (dependencies.spawn ?? spawnCommandWindow)({
    command: `while [ ! -e ${shellQuote(artifactPath)} ]; do sleep 0.2; done; exec tail -n 200 -F -- ${shellQuote(artifactPath)}`,
    cwd: entry.cwd,
    windowName: `view-${path.basename(artifactPath, ".jsonl").slice(0, 18)}`,
  });
  return { target: pane.paneId, display: pane.display };
}
