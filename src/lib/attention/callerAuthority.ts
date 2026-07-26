/**
 * Who is actually calling `request_attention` (#688 D4).
 *
 * D4 gives the root agent and the operator a claim on the operator's screen,
 * and gives workers none. The record enforces half of that already: `rootId` is
 * resolved server-side, so no caller can name a root of its choosing. The other
 * half was missing. Every Viewer-spawned worker is registered with the same
 * `viewer` MCP server the operator's own session uses, so a worker holding that
 * tool raised a request that landed under `origin: "root-agent"` and the
 * operator's own root identity — indistinguishable, on the record and on the
 * card, from the root agent asking. A reviewer three levels down could take over
 * the operator's screen, and the agent that gets told "they declined" would be
 * one that never asked.
 *
 * The caller is identified from facts neither side can restate: this process's
 * own ancestry, and the host process ids the registry recorded when it launched
 * each conversation. An MCP server is a child of the agent that started it, so
 * walking up from here reaches that agent's pid, and the registry says which
 * conversation that pid is hosting.
 *
 * Deliberately pure over supplied sources: the decision is a function of an
 * ancestry and a registry snapshot, so it is testable without a process tree.
 */

/** Every conversation the registry has a live host process id for. */
export interface HostedConversation {
  conversationId: string;
  /** Recorded host pids — the tmux-hosted agent, the structured host process,
      or both across generations. */
  pids: readonly number[];
  /** The role stamped on the launch profile. `root` is the operator's own
      session; a preset id (`builder`, `reviewer`, …) is a worker; null is a
      conversation nothing recorded a role for. */
  role: string | null;
}

export interface AttentionCallerSources {
  /** This process first, then each ancestor. Bounded by the caller. */
  ancestry(): readonly number[];
  hosted(): readonly HostedConversation[];
  /** The conversation the root lineage currently names, when one is adopted. */
  rootConversationId(): string | null;
}

export type AttentionCallerAuthority =
  /** The operator's own root session. May ask for the screen. */
  | { kind: "root"; conversationId: string | null }
  /** A conversation that is positively NOT the root. May not. */
  | { kind: "worker"; conversationId: string; role: string | null }
  /** No ancestor matched any recorded host. See {@link attentionCallerAuthority}. */
  | { kind: "unidentified" };

/**
 * The authority of whoever is running this process.
 *
 * `unidentified` is allowed through, and that is a deliberate, bounded choice
 * rather than an oversight. The root session is frequently a terminal the
 * operator started themselves, which the Viewer observes rather than launches,
 * so there are ordinary setups in which no host evidence names it. Refusing
 * those would take the feature away from the very person it exists for, to stop
 * an attack that requires already running code as them. Refusing every caller
 * the registry CAN name as a non-root closes the reachable hole: a worker the
 * Viewer spawned is, by construction, a conversation the registry recorded a
 * host for.
 */
export function attentionCallerAuthority(sources: AttentionCallerSources): AttentionCallerAuthority {
  const hosted = sources.hosted();
  if (hosted.length === 0) return { kind: "unidentified" };

  const byPid = new Map<number, HostedConversation>();
  for (const conversation of hosted) {
    for (const pid of conversation.pids) {
      /* First writer wins: the nearest generation to have claimed a pid is the
         one hosting it, and a pid reused across conversations would otherwise
         resolve to whichever happened to be enumerated last. */
      if (!byPid.has(pid)) byPid.set(pid, conversation);
    }
  }

  /* Nearest ancestor first. An agent may itself be a descendant of another
     agent's process tree — a worker started from a pane the root also owns —
     and the conversation actually running this tool is the closest one. */
  for (const pid of sources.ancestry()) {
    const conversation = byPid.get(pid);
    if (!conversation) continue;
    if (isRootConversation(conversation, sources.rootConversationId())) {
      return { kind: "root", conversationId: conversation.conversationId };
    }
    return { kind: "worker", conversationId: conversation.conversationId, role: conversation.role };
  }
  return { kind: "unidentified" };
}

/**
 * The role lives on the LAUNCH PROFILE and `root` is the only value that means
 * the operator's own session — the same fact `@/lib/root/adopt` keys on, read
 * the same way here so the two cannot disagree about who the root is. The
 * adopted lineage wins when it names a conversation, because that is the
 * identity requests are actually written against.
 */
function isRootConversation(conversation: HostedConversation, rootConversationId: string | null): boolean {
  if (rootConversationId) return conversation.conversationId === rootConversationId;
  return conversation.role === "root";
}

/** Walk up from `pid`, stopping at pid 1, a cycle, or `limit` hops. */
export function processAncestry(
  pid: number,
  parentOf: (candidate: number) => number | null,
  limit = 24,
): number[] {
  const chain: number[] = [];
  const seen = new Set<number>();
  let current: number | null = pid;
  while (current !== null && current > 1 && chain.length < limit && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = parentOf(current);
  }
  return chain;
}
