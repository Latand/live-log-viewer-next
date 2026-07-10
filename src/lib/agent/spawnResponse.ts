import type { SpawnReceipt } from "@/lib/agent/registry";

export interface SpawnResponse {
  ok: true;
  target: string | null;
  /** Transcript path the fresh session will write, when knowable. */
  path: string | null;
  launchId: string;
  conversationId: string;
  launched: boolean;
  retrySafe: boolean;
  state: "settled" | "path-pending" | "starting" | "conflict";
}

export function spawnResponseForReceipt(receipt: SpawnReceipt, path = receipt.artifactPath): SpawnResponse {
  const conflict = receipt.state === "conflicted";
  const pending = receipt.state === "starting"
    || receipt.state === "pane-bound"
    || receipt.state === "prompt-delivered"
    || receipt.state === "path-pending";
  return {
    ok: true,
    target: receipt.target ?? receipt.pane?.target ?? null,
    path,
    launchId: receipt.launchId,
    conversationId: receipt.conversationId,
    launched: receipt.pane !== null,
    retrySafe: receipt.state === "failed",
    state: conflict
      ? "conflict"
      : pending
        ? (receipt.state === "path-pending" || receipt.state === "prompt-delivered" ? "path-pending" : "starting")
        : "settled",
  };
}
