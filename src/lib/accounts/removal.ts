import { agentRegistry } from "@/lib/agent/registry";

export type ManagedAccountEngine = "claude" | "codex";
export type AccountRemovalBlocker = "live_sessions";

const LIVE_ENTRY_STATUSES = new Set(["starting", "live", "idle", "handoff"]);
const LIVE_RECEIPT_STATES = new Set(["starting", "pane-bound", "host-verified", "prompt-delivered", "path-pending"]);

/** Durable Viewer ownership is the authority for account-home removal safety. */
export function accountRemovalBlockers(engine: ManagedAccountEngine, accountId: string): AccountRemovalBlocker[] {
  const snapshot = agentRegistry().snapshot();
  const liveEntry = Object.values(snapshot.entries).some((entry) =>
    entry.key.engine === engine && entry.accountId === accountId && LIVE_ENTRY_STATUSES.has(entry.status));
  const liveReceipt = Object.values(snapshot.receipts).some((receipt) =>
    receipt.engine === engine && receipt.accountId === accountId && LIVE_RECEIPT_STATES.has(receipt.state));
  return liveEntry || liveReceipt ? ["live_sessions"] : [];
}
