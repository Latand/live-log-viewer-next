import { agentRegistry } from "@/lib/agent/registry";

export type ManagedAccountEngine = "claude" | "codex";
export type AccountRemovalBlocker = "live_sessions" | "current_conversations";

const LIVE_ENTRY_STATUSES = new Set(["starting", "live", "idle", "handoff"]);
const LIVE_RECEIPT_STATES = new Set(["starting", "pane-bound", "host-verified", "prompt-delivered", "path-pending"]);

/** Durable Viewer ownership is the authority for account-home removal safety.
 *  This reads the agent registry outside any accounts-registry lock, so a
 *  spawn that begins in the gap between this check and the home deletion can
 *  still bind a session to the home mid-removal — the same outcome `force`
 *  already opts into, and the window is milliseconds. Closing it fully would
 *  need cross-store atomicity between the agent and accounts registries. */
export function accountRemovalBlockers(engine: ManagedAccountEngine, accountId: string): AccountRemovalBlocker[] {
  const snapshot = agentRegistry().snapshot();
  const liveEntry = Object.values(snapshot.entries).some((entry) =>
    entry.key.engine === engine && (entry.accountId === accountId || entry.accountId === null) && LIVE_ENTRY_STATUSES.has(entry.status));
  const liveReceipt = Object.values(snapshot.receipts).some((receipt) =>
    receipt.engine === engine && (receipt.accountId === accountId || receipt.accountId === null) && LIVE_RECEIPT_STATES.has(receipt.state));
  const currentConversation = Object.values(snapshot.conversations).some((conversation) =>
    conversation.engine === engine && conversation.generations.at(-1)?.accountId === accountId);
  return [
    ...(liveEntry || liveReceipt ? ["live_sessions" as const] : []),
    ...(currentConversation ? ["current_conversations" as const] : []),
  ];
}
