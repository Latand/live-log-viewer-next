/**
 * Who is actually calling the Viewer MCP server.
 *
 * Under B+ this identity ATTRIBUTES rather than gates: every session holds the
 * full tool surface, and what identity decides is the durable origin written
 * on attention requests and bridge reports, plus whether the caller is the
 * designated orchestrator for the one gated operation (minting a deployment
 * confirmation). `rootId` is still resolved server-side, so no caller can name
 * a root of its choosing, and a worker's ask is durably a worker's ask.
 *
 * The caller is identified from facts neither side can restate: this process's
 * own ancestry, the host process ids the registry recorded when it launched
 * each conversation, and the spawn capability the Viewer minted at admission
 * and injected into the launch environment. An MCP server is a child of the
 * agent that started it, so walking up from here reaches that agent's pid, and
 * the registry says which conversation that pid is hosting; the capability
 * digest names the same conversation when every pid is gone.
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
  /** The conversation named by the spawn capability the Viewer minted at
      admission and injected into this launch's environment — immutable launch
      lineage that no caller can restate (only its digest is ever stored) and
      that survives host death, PID change, resume, migration and generation
      change. Null when no capability is present or it resolves to nothing;
      the operator's own terminals are launched by nobody and carry none. */
  capabilityCallerConversationId?(): string | null;
}

export type AttentionCallerAuthority =
  /** The operator's own root session. */
  | { kind: "root"; conversationId: string | null }
  /** A conversation that is positively NOT the root. */
  | { kind: "worker"; conversationId: string; role: string | null }
  /** No evidence named the caller. See {@link attentionCallerAuthority}. */
  | { kind: "unidentified" };

/**
 * The authority of whoever is running this process.
 *
 * `unidentified` is an honest answer, not a failure mode to hide: the root
 * session is frequently a terminal the operator started themselves, which the
 * Viewer observes rather than launches, so there are ordinary setups in which
 * no evidence names it. The label is recorded as-is wherever attribution is
 * written, and the only operation it costs anyone is the orchestrator-only
 * confirmation mint — which an unattributable caller must never hold.
 */
export function attentionCallerAuthority(sources: AttentionCallerSources): AttentionCallerAuthority {
  const hosted = sources.hosted();
  const capabilityConversationId = sources.capabilityCallerConversationId?.() ?? null;

  const byPid = new Map<number, HostedConversation>();
  const byId = new Map<string, HostedConversation>();
  for (const conversation of hosted) {
    byId.set(conversation.conversationId, conversation);
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
  let pidMatch: HostedConversation | null = null;
  for (const pid of sources.ancestry()) {
    const candidate = byPid.get(pid);
    if (!candidate) continue;
    pidMatch = candidate;
    break;
  }

  /* Two independent evidence chains that DISAGREE identify nobody. Neither is
     the caller's to restate, so a disagreement means the registry is racing,
     stale or tampered with — every reading fails closed. */
  if (pidMatch && capabilityConversationId && pidMatch.conversationId !== capabilityConversationId) {
    return { kind: "unidentified" };
  }

  /* The pid walk is physical and ephemeral; the capability is admission
     lineage and durable. Either alone identifies the caller — the capability
     is what keeps a correctly designated conversation identified after its
     host pids were never recorded, changed, or died (the measured null-pid
     manager refusal). */
  const conversation = pidMatch
    ?? (capabilityConversationId
      ? byId.get(capabilityConversationId) ?? { conversationId: capabilityConversationId, pids: [], role: null }
      : null);
  if (!conversation) return { kind: "unidentified" };
  if (isRootConversation(conversation, sources.rootConversationId())) {
    return { kind: "root", conversationId: conversation.conversationId };
  }
  return { kind: "worker", conversationId: conversation.conversationId, role: conversation.role };
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
