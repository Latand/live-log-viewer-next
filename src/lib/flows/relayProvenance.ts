import fs from "node:fs";

import type { DeliveredMessageOccurrence } from "@/lib/runtime/messageOrigin";
import { messageTextDigest } from "@/lib/runtime/messageTextDigest";

import { relayClientMessageId } from "./engine";
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
 * and its digest joined, together with the settlement time, to the ONE
 * transcript row that echoes that delivery.
 *
 * Each occurrence also names the round's own relay identity — the client-
 * message id a structured relay reserves its registry record under — so the
 * projector can tell a relay the registry also settled (one delivery, two
 * stores) from one it never saw, without comparing text or time.
 *
 * Absence stays honest: an unreadable findings artifact or an unsettled round
 * contributes nothing, and an unmatched row keeps today's rendering.
 */

export interface FlowRelayProvenanceDependencies {
  flows?: () => Flow[];
}

/**
 * One occurrence per settled relay round of one implementer transcript.
 * Every failure degrades to an empty or partial list, never an error.
 */
export function flowRelayedMessageOccurrences(
  transcriptPath: string,
  dependencies: FlowRelayProvenanceDependencies = {},
): DeliveredMessageOccurrence[] {
  if (!transcriptPath) return [];
  let flows: Flow[];
  try {
    flows = (dependencies.flows ?? loadFlows)();
  } catch {
    return [];
  }
  const occurrences: DeliveredMessageOccurrence[] = [];
  for (const flow of flows) {
    for (const round of flow.rounds) {
      /* Only a settled relay is evidence that this text reached a transcript;
         the round records where and when it landed. The flow's current
         implementer path also matches, so a conversation continued past the
         relay keeps it. */
      const delivery = round.relayDelivery;
      if (!delivery?.deliveredAt || !Number.isFinite(Date.parse(delivery.deliveredAt)) || !round.findingsPath) continue;
      if (delivery.path !== transcriptPath && flow.implementerPath !== transcriptPath) continue;
      try {
        const findings = fs.readFileSync(round.findingsPath, "utf8");
        occurrences.push({
          textDigest: messageTextDigest(relayPrompt(round, findings)),
          deliveredAt: delivery.deliveredAt,
          origin: "agent",
          senderRole: "reviewer",
          clientMessageId: relayClientMessageId(flow, round),
        });
      } catch {
        /* A pruned findings artifact loses only this round's attribution. */
      }
    }
  }
  return occurrences;
}
