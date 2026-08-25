import path from "node:path";

import { agentRegistry, type RegistryFile } from "@/lib/agent/registry";

import { FileClaudeDeliveryLedger, type ClaudeDeliveryLedger, type ClaudeDeliveryState } from "./claudeStreamBrokerHost";
import { messageOriginRole, type DeliveredMessageProvenance } from "./messageOrigin";

export type { DeliveredMessageProvenance };

/*
 * The feed-facing authorship of delivered Claude messages (#1117), keyed by
 * the transcript row's own uuid (the ledger's `engineMessageId`).
 *
 * A Claude transcript row journaled through the structured broker carries only
 * SDK provenance, so the feed cannot tell the operator's words from an
 * inter-agent relay by reading the row. The broker's delivery ledger CAN: each
 * queued record carries the admission-stamped origin (new sends), the
 * operator's selected-context capture (#844 sends), or a spawn operation id
 * whose receipt records the launch's delegation depth (legacy first messages).
 * This module is that join, done server-side where the ledger lives.
 *
 * Absence is honest: an entry with no evidence is omitted, and the feed keeps
 * rendering its row exactly as before.
 */

export interface ClaudeMessageProvenanceDependencies {
  ledger?: ClaudeDeliveryLedger;
  registrySnapshot?: () => RegistryFile;
}

const SPAWN_MESSAGE_PREFIX = "spawn_message_";

function spawnEntryProvenance(
  entryId: string,
  transcriptPath: string,
  snapshot: RegistryFile,
): DeliveredMessageProvenance | null {
  const launchId = entryId.slice(SPAWN_MESSAGE_PREFIX.length);
  const receipt = snapshot.receipts[launchId];
  /* The receipt is the first authority; a conversation that recorded its own
     delegation depth (#393) answers for receipts already pruned. */
  const depth = receipt?.delegationDepth
    ?? Object.values(snapshot.conversations)
      .find((conversation) => conversation.generations.some((generation) => generation.path === transcriptPath))
      ?.delegationDepth
    ?? null;
  if (depth === null) return null;
  if (depth === 0) return { origin: "operator" };
  const parentId = receipt?.parentConversationId;
  const role = messageOriginRole(parentId ? snapshot.conversations[parentId]?.agentRole ?? undefined : undefined);
  return { origin: "agent", ...(role ? { senderRole: role } : {}) };
}

function entryProvenance(
  state: ClaudeDeliveryState,
  transcriptPath: string,
  snapshot: () => RegistryFile,
): DeliveredMessageProvenance | null {
  const entry = state.entry;
  if (entry.origin) {
    const role = entry.origin.kind === "agent" ? messageOriginRole(entry.origin.role) : undefined;
    return {
      origin: entry.origin.kind,
      ...(role ? { senderRole: role } : {}),
      ...(entry.origin.kind === "operator" && entry.selectedContext ? { selectedContext: entry.selectedContext } : {}),
    };
  }
  /* Pre-#1117 evidence. A selected-context capture exists only on operator
     composer sends; a spawn operation id resolves through its launch receipt. */
  if (entry.selectedContext) return { origin: "operator", selectedContext: entry.selectedContext };
  if (entry.id.startsWith(SPAWN_MESSAGE_PREFIX)) return spawnEntryProvenance(entry.id, transcriptPath, snapshot());
  return null;
}

/**
 * `engineMessageId → provenance` for one Claude transcript. Reads only that
 * conversation's own ledger file; every failure (no ledger, malformed ledger,
 * unavailable registry) degrades to an empty or partial map, never an error —
 * missing provenance renders as today's system row.
 */
export function claudeMessageProvenance(
  transcriptPath: string,
  dependencies: ClaudeMessageProvenanceDependencies = {},
): Record<string, DeliveredMessageProvenance> {
  if (!transcriptPath.endsWith(".jsonl")) return {};
  const sessionId = path.basename(transcriptPath, ".jsonl");
  if (!sessionId) return {};
  const ledger = dependencies.ledger ?? new FileClaudeDeliveryLedger();
  let states: ClaudeDeliveryState[];
  try {
    states = ledger.load(sessionId);
  } catch {
    return {};
  }
  let cached: RegistryFile | null = null;
  const snapshot = () => {
    cached ??= (dependencies.registrySnapshot ?? (() => agentRegistry().readOnlySnapshot()))();
    return cached;
  };
  const provenance: Record<string, DeliveredMessageProvenance> = {};
  for (const state of states) {
    if (!state.delivered || !state.engineMessageId) continue;
    let resolved: DeliveredMessageProvenance | null;
    try {
      resolved = entryProvenance(state, transcriptPath, snapshot);
    } catch {
      resolved = null;
    }
    if (resolved) provenance[state.engineMessageId] = resolved;
  }
  return provenance;
}
