import { conversationIdentity, isArchivedPredecessor } from "@/lib/accounts/identity";
import type { Engine, FileEntry } from "@/lib/types";

export type SubagentBadgeState = "running" | "live" | "closed" | "dead";

export interface SubagentBadge {
  id: string;
  title: string;
  engine: Engine;
  model: string | null;
  state: SubagentBadgeState;
  avatarSeed: string;
}

function badgeState(entry: FileEntry): SubagentBadgeState {
  if (entry.path.startsWith("spawn:")) return "dead";
  if (entry.spawn?.state === "failed") return "dead";
  if (entry.proc === "done" || entry.proc === "killed" || entry.supersededBy || entry.activity === "idle") return "closed";
  if (entry.proc === "running" || entry.spawn?.state === "starting" || entry.spawn?.state === "binding" || entry.spawn?.state === "queued") {
    return "running";
  }
  return "live";
}

function spawnTime(entry: FileEntry): number {
  const started = entry.sessionStartedAt ? Date.parse(entry.sessionStartedAt) : Number.NaN;
  return Number.isFinite(started) ? started : entry.mtime * 1_000;
}

function activeRank(state: SubagentBadgeState): number {
  return state === "running" || state === "live" ? 0 : 1;
}

/** Direct spawned children of one stable conversation, ordered for bottom-up display. */
export function subagentsOf(conversationId: string, entries: readonly FileEntry[]): SubagentBadge[] {
  const parentPaths = new Set(
    entries
      .filter((entry) => conversationIdentity(entry) === conversationId)
      .map((entry) => entry.path),
  );
  const currentById = new Map<string, FileEntry>();
  for (const entry of entries) {
    if (isArchivedPredecessor(entry)) continue;
    if (entry.engine === "shell") continue;
    const id = conversationIdentity(entry);
    const durableParent = entry.durableLineage?.parentConversationId;
    if (durableParent !== conversationId && (!entry.parent || !parentPaths.has(entry.parent))) continue;
    if (id === conversationId) continue;
    const current = currentById.get(id);
    const generation = entry.generation ?? 0;
    const currentGeneration = current?.generation ?? 0;
    if (!current || generation > currentGeneration || (generation === currentGeneration && entry.mtime > current.mtime)) {
      currentById.set(id, entry);
    }
  }

  return [...currentById.values()]
    .map((entry) => ({ entry, state: badgeState(entry) }))
    .sort((left, right) =>
      activeRank(left.state) - activeRank(right.state)
      || spawnTime(left.entry) - spawnTime(right.entry)
      || conversationIdentity(left.entry).localeCompare(conversationIdentity(right.entry)))
    .map(({ entry, state }) => {
      const id = conversationIdentity(entry);
      return {
        id,
        title: entry.title,
        engine: entry.engine,
        model: entry.model,
        state,
        avatarSeed: id,
      };
    });
}
