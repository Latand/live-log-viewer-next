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
  error?: string;
}

export function spawnResponseForReceipt(receipt: SpawnReceipt, path = receipt.artifactPath): SpawnResponse {
  const conflict = receipt.state === "conflicted";
  const pending = receipt.state === "starting"
    || receipt.state === "pane-bound"
    || receipt.state === "host-verified"
    || receipt.state === "prompt-delivered"
    || receipt.state === "path-pending";
  const launched = receipt.verifiedHost !== null && receipt.state !== "failed" && receipt.state !== "conflicted";
  return {
    ok: true,
    target: receipt.pane?.paneId ?? receipt.target ?? null,
    path,
    launchId: receipt.launchId,
    conversationId: receipt.conversationId,
    launched,
    retrySafe: receipt.state === "failed",
    ...(receipt.error ? { error: receipt.error } : {}),
    state: conflict
      ? "conflict"
      : pending
        ? (receipt.state === "path-pending" || receipt.state === "prompt-delivered" || receipt.state === "host-verified" ? "path-pending" : "starting")
        : "settled",
  };
}
