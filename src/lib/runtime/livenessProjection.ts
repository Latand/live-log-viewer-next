import { readOnlyConversationLookupFromSnapshot, type AgentRegistry, type RegistryFile } from "@/lib/agent/registry";
import { registeredHostForPath } from "@/lib/conversation/registeredHost";
import type { FileEntry } from "@/lib/types";

import { conversationTurnLiveness, type TurnLivenessDependencies } from "./liveness";

const RECENT_TRANSCRIPT_SECONDS = 15 * 60;
const LIVENESS_PROJECTION_CONCURRENCY = 16;

function quietActivity(file: FileEntry, now: number): "recent" | "idle" {
  return now / 1_000 - file.mtime < RECENT_TRANSCRIPT_SECONDS ? "recent" : "idle";
}

/** Projects the board's activity and process readouts from the turn verdict's
    evidence. Structured rows used to retain the scanner's transcript-only
    `live` word and a briefly cached pid, so the card disagreed with the recovery
    decision operators had to reconstruct by hand (#1296). */
export async function projectStructuredFileLiveness(
  files: FileEntry[],
  registry: AgentRegistry,
  snapshot: RegistryFile = registry.readOnlySnapshot(),
  dependencies: TurnLivenessDependencies = {},
): Promise<void> {
  const now = (dependencies.now ?? Date.now)();
  const stableDependencies = { ...dependencies, now: () => now };
  const conversationByCurrentPath = new Map(Object.values(snapshot.conversations).flatMap((conversation) => {
    const generation = conversation.generations.at(-1);
    if (!generation || conversation.supersededBy) return [];
    const entry = snapshot.entries[`${conversation.engine}:${generation.id}`];
    return !entry?.host && entry?.structuredHost && entry.status !== "dead" && entry.status !== "unhosted"
      ? [[generation.path, conversation] as const]
      : [];
  }));

  // The scanner and journal can arrive in either order after host succession.
  // Expose the current registry transport without copying a PID into authority.
  const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
  for (const file of files) {
    delete file.controlHost;
    delete file.rootControlHost;
    const conversation = file.conversationId ? lookup.conversation(file.conversationId as `conversation_${string}`) : null;
    const generation = conversation?.generations.at(-1);
    if (!conversation || generation?.path !== file.path || conversation.supersededBy) continue;
    if (lookup.conversationForPath(file.path)?.id !== conversation.id) continue;

    // Native children have no process of their own. Resolve the scanner parent
    // through the same snapshot's aliases and historical paths, then inspect
    // its CURRENT generation. The root need not be among the selected files.
    if (file.root === "claude-projects" && file.kind === "subagent" && file.parent) {
      const root = lookup.conversationForPath(file.parent);
      const rootGeneration = root?.generations.at(-1);
      const lineage = snapshot.lineageEdges[conversation.id];
      const parentMatches = [lineage?.parentConversationId, generation.launchProfile.parentConversationId]
        .every((id) => !id || lookup.canonicalConversationId(id) === root?.id);
      if (root && rootGeneration && root.id !== conversation.id && !root.supersededBy
        && root.engine === conversation.engine && parentMatches && lineage?.source !== "viewer-spawn") {
        const owner = registeredHostForPath(snapshot, rootGeneration.path);
        if (owner && owner.key.engine === root.engine && owner.key.sessionId === rootGeneration.id
          && (owner.status === "live" || owner.status === "idle") && !owner.pendingAction) {
          file.rootControlHost = { conversationId: root.id, parentPath: file.parent, transport: "legacy" };
        }
      }
    }
    const entry = snapshot.entries[`${conversation.engine}:${generation.id}`];
    if (!entry || (entry.status !== "live" && entry.status !== "idle")) continue;
    if (entry.host || entry.structuredHost) file.controlHost = {
      conversationId: conversation.id,
      transport: entry.host ? "legacy" : "structured",
    };
  }

  const candidates = files.filter((file) => conversationByCurrentPath.has(file.path));
  for (let start = 0; start < candidates.length; start += LIVENESS_PROJECTION_CONCURRENCY) {
    await Promise.all(candidates.slice(start, start + LIVENESS_PROJECTION_CONCURRENCY).map(async (file) => {
      const conversation = conversationByCurrentPath.get(file.path);
      if (!conversation) return;
      const liveness = await conversationTurnLiveness(registry, conversation.id, {
        ...stableDependencies,
        snapshot,
      });
      if (!liveness) return;

      if (liveness.state === "working") file.activity = "live";
      else if (liveness.state === "severed") file.activity = "stalled";
      else file.activity = quietActivity(file, now);
      file.activityReason = `turn_evidence_${liveness.state}`;

      const host = liveness.hostEvidence;
      const expected = host.expected;
      const verified = expected !== null
        && host.present
        && expected.startIdentity !== null
        && host.observedIdentity === expected.startIdentity;
      const replaced = expected !== null
        && host.present
        && expected.startIdentity !== null
        && host.observedIdentity !== null
        && host.observedIdentity !== expected.startIdentity;
      if (verified && expected) {
        file.pid = expected.pid;
        file.proc = "running";
      } else if (expected !== null && (!host.present || replaced)) {
        file.pid = null;
        file.proc = "killed";
      } else {
        file.pid = null;
        file.proc = null;
      }
    }));
  }
}
