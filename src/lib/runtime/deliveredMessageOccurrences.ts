import { agentRegistry, readOnlyConversationLookupFromSnapshot, type RegistryFile } from "@/lib/agent/registry";
import { flowRelayedMessageOccurrences } from "@/lib/flows/relayProvenance";

import { parseMessageOrigin, type DeliveredMessageOccurrence } from "./messageOrigin";

/*
 * Occurrence evidence for one conversation's delivered messages (#1117): the
 * join for every delivery that left no per-row identity in the transcript.
 *
 * The registry's held-delivery record is the durable receipt of every message
 * admitted through the Viewer — the composer's legacy paste, an MCP
 * `send_message` relayed into a tmux-owned pane, a migration-held send — and
 * it keeps three facts past settlement: the admission-stamped origin, the
 * content digest of the delivered text, and the settlement time. Together
 * they name ONE occurrence: the transcript row carrying that text nearest to
 * that time. The flow store contributes the relays the registry never saw
 * (legacy transport, pre-#1117 structured rounds); a round whose settlement
 * the registry also holds is the same delivery and must not count twice.
 *
 * Absence is honest: a record without a stamp, a digest, or a settlement time
 * contributes nothing, and the feed keeps rendering unmatched rows as today.
 */

export interface DeliveredMessageOccurrenceDependencies {
  registrySnapshot?: () => RegistryFile;
  relayOccurrences?: (transcriptPath: string) => DeliveredMessageOccurrence[];
}

const CONTENT_DIGEST = /^[a-f0-9]{64}$/;

/** A flow round's settlement and the registry record it settled from describe
    one delivery; they agree on the digest and land within this window. */
export const SAME_DELIVERY_WINDOW_MS = 10 * 60 * 1000;

/** Delivered, origin-stamped held records of the conversation that owns
    `transcriptPath`, projected as occurrences. */
export function heldDeliveryOccurrences(transcriptPath: string, snapshot: RegistryFile): DeliveredMessageOccurrence[] {
  const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
  const conversation = lookup.conversationForPath(transcriptPath);
  if (!conversation) return [];
  const occurrences: DeliveredMessageOccurrence[] = [];
  for (const delivery of Object.values(snapshot.heldDeliveries)) {
    if (delivery.state !== "delivered" || !delivery.deliveredAt || !delivery.contentDigest) continue;
    if (lookup.canonicalConversationId(delivery.conversationId) !== conversation.id) continue;
    if (!CONTENT_DIGEST.test(delivery.contentDigest) || !Number.isFinite(Date.parse(delivery.deliveredAt))) continue;
    /* Re-validated here as well as at normalization: a forged or corrupt
       persisted stamp drops, and can never re-author a row. */
    const origin = parseMessageOrigin(delivery.command?.origin);
    if (!origin) continue;
    occurrences.push({
      textDigest: delivery.contentDigest,
      deliveredAt: delivery.deliveredAt,
      origin: origin.kind,
      ...(origin.kind === "agent" && origin.role ? { senderRole: origin.role } : {}),
    });
  }
  return occurrences;
}

/**
 * Every occurrence the feed may join for one transcript, settlement-ordered.
 * Each source degrades to absence on its own, so an unavailable registry
 * still leaves the flow relays and vice versa.
 */
export function deliveredMessageOccurrences(
  transcriptPath: string,
  dependencies: DeliveredMessageOccurrenceDependencies = {},
): DeliveredMessageOccurrence[] {
  if (!transcriptPath) return [];
  let held: DeliveredMessageOccurrence[] = [];
  try {
    const snapshot = (dependencies.registrySnapshot ?? (() => agentRegistry().readOnlySnapshot()))();
    held = heldDeliveryOccurrences(transcriptPath, snapshot);
  } catch {
    held = [];
  }
  let relayed: DeliveredMessageOccurrence[] = [];
  try {
    relayed = (dependencies.relayOccurrences ?? flowRelayedMessageOccurrences)(transcriptPath);
  } catch {
    relayed = [];
  }
  const merged = [...held];
  for (const relay of relayed) {
    const relayedAt = Date.parse(relay.deliveredAt);
    const alreadyHeld = held.some((occurrence) =>
      occurrence.textDigest === relay.textDigest
      && Math.abs(Date.parse(occurrence.deliveredAt) - relayedAt) <= SAME_DELIVERY_WINDOW_MS);
    if (!alreadyHeld) merged.push(relay);
  }
  return merged.sort((left, right) => Date.parse(left.deliveredAt) - Date.parse(right.deliveredAt));
}
