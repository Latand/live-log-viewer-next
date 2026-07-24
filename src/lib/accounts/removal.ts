import { accountHasLiveSessions, liveAccountConversationIds, type AccountLivenessOptions, type ManagedAccountEngine } from "@/lib/agent/accountLiveness";
import { agentRegistry } from "@/lib/agent/registry";

export type { ManagedAccountEngine };
export type AccountRemovalBlocker = "live_sessions" | "current_conversations";

/** Durable Viewer ownership is the authority for account-home removal safety.
 *  Only *genuinely live* ownership blocks (issue #643): a registered host whose
 *  process answers a probe, an in-flight launch receipt, an unsettled
 *  migration, or an undelivered held delivery. Terminal, unhosted history and
 *  `starting` entries/receipts whose process is provably gone are registry rot
 *  — they are ignored here, and the removed account's transcripts survive as a
 *  retained archive (see `removeManagedClaudeAccount`), so nothing is lost by
 *  letting the home go.
 *
 *  This reads the agent registry outside any accounts-registry lock, so a
 *  spawn that begins in the gap between this check and the home deletion can
 *  still bind a session to the home mid-removal — the same outcome `force`
 *  already opts into, and the window is milliseconds. Closing it fully would
 *  need cross-store atomicity between the agent and accounts registries. */
export function accountRemovalBlockers(
  engine: ManagedAccountEngine,
  accountId: string,
  options: AccountLivenessOptions = {},
): AccountRemovalBlocker[] {
  const snapshot = agentRegistry().readOnlySnapshot();
  return [
    ...(accountHasLiveSessions(snapshot, engine, accountId, options) ? ["live_sessions" as const] : []),
    ...(liveAccountConversationIds(snapshot, engine, accountId, options).length > 0 ? ["current_conversations" as const] : []),
  ];
}
