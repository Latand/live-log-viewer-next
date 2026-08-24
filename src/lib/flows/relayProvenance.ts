import fs from "node:fs";

import type { DeliveredMessageProvenance } from "@/lib/runtime/messageOrigin";

import { relayPrompt } from "./prompts";
import { loadFlows } from "./store";
import type { Flow } from "./types";

/*
 * Relay provenance from the flow store (#1117), for the delivery paths that
 * leave no per-message evidence of their own: a legacy tmux relay writes only
 * engine input (which provenance must not change), and a pre-#1117 structured
 * relay wrote a ledger record without an origin. The flow record IS existing
 * durable evidence for both — each round persists its findings artifact and
 * its settled `relayDelivery` — so the exact relayed text can be reconstructed
 * and joined to the transcript row that echoes it, the same text-identity
 * convention the feed already uses for launch echoes.
 *
 * Absence stays honest: an unreadable findings artifact or an unsettled round
 * contributes nothing, and an unmatched row keeps today's rendering.
 */

export interface FlowRelayProvenanceDependencies {
  flows?: () => Flow[];
}

const RELAY_SENDER: DeliveredMessageProvenance = { origin: "agent", senderRole: "reviewer" };

/**
 * `trimmed relayed text → provenance` for one implementer transcript. Every
 * failure degrades to an empty or partial map, never an error.
 */
export function flowRelayedMessageProvenance(
  transcriptPath: string,
  dependencies: FlowRelayProvenanceDependencies = {},
): Record<string, DeliveredMessageProvenance> {
  if (!transcriptPath) return {};
  let flows: Flow[];
  try {
    flows = (dependencies.flows ?? loadFlows)();
  } catch {
    return {};
  }
  const relayed: Record<string, DeliveredMessageProvenance> = {};
  for (const flow of flows) {
    for (const round of flow.rounds) {
      /* Only a settled relay is evidence that this text reached a transcript;
         the round records where it landed. The flow's current implementer path
         also matches, so a conversation continued past the relay keeps it. */
      if (!round.relayDelivery || !round.findingsPath) continue;
      if (round.relayDelivery.path !== transcriptPath && flow.implementerPath !== transcriptPath) continue;
      try {
        const findings = fs.readFileSync(round.findingsPath, "utf8");
        relayed[relayPrompt(round, findings).trim()] = RELAY_SENDER;
      } catch {
        /* A pruned findings artifact loses only this round's attribution. */
      }
    }
  }
  return relayed;
}
