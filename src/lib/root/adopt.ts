import { headSession } from "./lineage";
import { readRootLineage, recordRootSession, rootLineageFile } from "./store";
import type { RootAdoption } from "./types";

/**
 * Who the live root session actually is, and recording it (#688 D5).
 *
 * The lineage module can already fold a session into the chain; what was
 * missing was anything that tells it which session that is. Without this the
 * file carries a minted `rootId` over an empty session list — the stable
 * identity exists, but the chain it is supposed to survive is never written, so
 * a rollover leaves no link and the continuity marker has nothing to point at.
 *
 * The root is named the way the registry already names it: the conversation id
 * the operator configured, and failing that the conversation whose launch
 * profile carries the `root` role. Both are durable launch-time facts, so
 * neither can drift onto a worker.
 *
 * The role lives on the LAUNCH PROFILE, not on `agentRole`. `agentRole` is the
 * role-PRESET id (`builder`, `reviewer`, …) and has no `root` member at all —
 * the operator's own session is precisely the one with no preset — so keying on
 * it would adopt nothing, and would adopt a worker outright if anyone ever
 * defined a preset by that name.
 */

/**
 * The slice of a registry snapshot this reads, described structurally so a
 * `RegistryConversation` satisfies it as-is and nothing here has to import the
 * registry. The resolution stays a pure function of data.
 */
export interface RootConversationSlice {
  id: string;
  updatedAt: string;
  generations: readonly { path: string; launchProfile?: { role?: string | null } | null }[];
}

export interface RootSessionSource {
  conversations: readonly RootConversationSlice[];
  /** `LLV_ROOT_CONVERSATION_ID`, the same env the migration coordinator reads
      to stamp the `root` role in the first place. */
  configuredRootId: string | null;
}

export interface RootSessionCandidate {
  conversationId: string;
  path: string | null;
}

/**
 * The role the registry stamped on this conversation, read from the newest
 * generation that carries a launch profile.
 *
 * Newest, because a resume or a migration writes a fresh generation and the
 * role is copied forward onto it; older generations are history. A generation
 * with no profile at all is legacy and says nothing either way, so it is
 * skipped rather than read as "worker".
 */
export function conversationRole(conversation: RootConversationSlice): string | null {
  for (let index = conversation.generations.length - 1; index >= 0; index -= 1) {
    const role = conversation.generations[index]?.launchProfile?.role;
    if (role) return role;
  }
  return null;
}

export function liveRootSession(source: RootSessionSource): RootSessionCandidate | null {
  const configured = source.configuredRootId
    ? source.conversations.find((conversation) => conversation.id === source.configuredRootId)
    : undefined;
  /* Falling back to the role means a rollover is seen even before the operator
     re-points the env at the successor; the newest such conversation is the one
     they are talking to. */
  const chosen = configured ?? [...source.conversations]
    .filter((conversation) => conversationRole(conversation) === "root")
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    .at(-1);
  if (!chosen) return null;
  return { conversationId: chosen.id, path: chosen.generations.at(-1)?.path ?? null };
}

/**
 * Record the live root session, or do nothing when it is already the head.
 *
 * The unchanged case is answered from a plain read, before the file
 * transaction: this runs on the path that raises a request, and taking a lock
 * to conclude that nothing moved would put a serialized write in front of every
 * one of them.
 */
export function adoptLiveRootSession(
  source: RootSessionSource,
  options: { filePath?: string; now?: Date } = {},
): RootAdoption | null {
  const candidate = liveRootSession(source);
  if (!candidate) return null;
  const filePath = options.filePath ?? rootLineageFile();
  const head = headSession(readRootLineage(filePath));
  if (head?.conversationId === candidate.conversationId && (candidate.path === null || head.path === candidate.path)) {
    return null;
  }
  return recordRootSession(candidate, { filePath, ...(options.now ? { now: options.now } : {}) });
}
