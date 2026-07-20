import { conversationIdentity } from "@/lib/accounts/identity";
import type { Engine, FileEntry } from "@/lib/types";

import { badgeState, currentGenerationChildrenOf, type SubagentBadgeState } from "./subagentTray";

export type { SubagentBadgeState } from "./subagentTray";

/** Badge display rank: active leads, every quiet/dead state trails together —
    ties break by spawn time, unchanged from the pre-#142 ordering. */
function activeRank(state: SubagentBadgeState): number {
  return state === "running" || state === "live" ? 0 : 1;
}

export interface SubagentBadge {
  id: string;
  /** The current non-archived generation's transcript path: navigation opens
      exactly this entry instead of re-resolving the id against file order,
      which can land on a stale earlier generation. */
  path: string;
  title: string;
  engine: Engine;
  model: string | null;
  state: SubagentBadgeState;
  avatarSeed: string;
}

function spawnTime(entry: FileEntry): number {
  const started = entry.sessionStartedAt ? Date.parse(entry.sessionStartedAt) : Number.NaN;
  return Number.isFinite(started) ? started : entry.mtime * 1_000;
}

/**
 * Direct spawned children of one stable conversation, ordered for bottom-up
 * display. `exclude` drops any child already placed on another surface — a tray
 * member folded into the parent card must not also enumerate as a promoted
 * badge (issue #142: a card renders in exactly one place).
 */
export function subagentsOf(
  conversationId: string,
  entries: readonly FileEntry[],
  exclude: ReadonlySet<string> = new Set(),
): SubagentBadge[] {
  return currentGenerationChildrenOf(conversationId, entries)
    .filter((entry) => !exclude.has(entry.path) && !exclude.has(conversationIdentity(entry)))
    .map((entry) => ({ entry, state: badgeState(entry) }))
    .sort((left, right) =>
      activeRank(left.state) - activeRank(right.state)
      || spawnTime(left.entry) - spawnTime(right.entry)
      || conversationIdentity(left.entry).localeCompare(conversationIdentity(right.entry)))
    .map(({ entry, state }) => {
      const id = conversationIdentity(entry);
      return {
        id,
        path: entry.path,
        title: entry.title,
        engine: entry.engine,
        model: entry.model,
        state,
        avatarSeed: id,
      };
    });
}
