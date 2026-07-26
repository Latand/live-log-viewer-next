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
 * The root is named the way the rest of the app already names it: the
 * conversation id the operator configured, and failing that the conversation
 * the registry recorded a `root` role for at admission. Both are durable
 * launch-time facts, so neither can drift onto a worker.
 */

/** The narrow slice of a registry snapshot this needs — passed as data so the
    resolution is testable without the shared registry. */
export interface RootSessionSource {
  conversations: readonly {
    id: string;
    agentRole: string | null;
    generations: readonly { path: string }[];
    updatedAt: string;
  }[];
  /** `LLV_ROOT_CONVERSATION_ID`, the same env the migration coordinator reads
      to stamp the `root` role in the first place. */
  configuredRootId: string | null;
}

export interface RootSessionCandidate {
  conversationId: string;
  path: string | null;
}

export function liveRootSession(source: RootSessionSource): RootSessionCandidate | null {
  const configured = source.configuredRootId
    ? source.conversations.find((conversation) => conversation.id === source.configuredRootId)
    : undefined;
  /* Falling back to the role means a rollover is seen even before the operator
     re-points the env at the successor; the newest such conversation is the one
     they are talking to. */
  const chosen = configured ?? [...source.conversations]
    .filter((conversation) => conversation.agentRole === "root")
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
