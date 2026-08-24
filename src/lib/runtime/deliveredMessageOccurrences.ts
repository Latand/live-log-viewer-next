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
 * (legacy transport, pre-#1117 structured rounds).
 *
 * The two stores describe the same delivery exactly once, joined by identity:
 * a structured relay reserves its registry record under the round's own
 * client-message id, and that id is the only thing that may collapse a flow
 * occurrence into a held one. An operator message that repeats a relay's
 * words minutes apart is a second delivery, and both must survive for the
 * feed to attribute each to its own row.
 *
 * Absence is honest: a record without a stamp, a digest, or a settlement time
 * contributes nothing, and the feed keeps rendering unmatched rows as today.
 */

export interface DeliveredMessageOccurrenceDependencies {
  registrySnapshot?: () => RegistryFile;
  relayOccurrences?: (transcriptPath: string) => DeliveredMessageOccurrence[];
}

const CONTENT_DIGEST = /^[a-f0-9]{64}$/;

/** Delivered, origin-stamped held records of the conversation that owns
    `transcriptPath`, projected as occurrences. Each carries the record's
    client-message id (when the transport reserved one) as its join identity. */
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
      ...(delivery.clientMessageId ? { clientMessageId: delivery.clientMessageId } : {}),
    });
  }
  return occurrences;
}

/** The wire shape of one occurrence: the join identity has done its work. */
function wireOccurrence(occurrence: DeliveredMessageOccurrence): DeliveredMessageOccurrence {
  const { textDigest, deliveredAt, origin, senderRole, selectedContext } = occurrence;
  return {
    textDigest,
    deliveredAt,
    origin,
    ...(senderRole ? { senderRole } : {}),
    ...(selectedContext ? { selectedContext } : {}),
  };
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
  /* A relay whose identity a projected held record carries IS that record:
     the registry settled the same delivery. Every other relay — a legacy tmux
     transport, a pre-#1117 structured round whose record has no origin stamp
     and so projected nothing — is evidence the registry cannot supply. */
  const settled = new Set(held.map((occurrence) => occurrence.clientMessageId).filter(Boolean));
  const merged = [...held];
  for (const relay of relayed) {
    if (relay.clientMessageId && settled.has(relay.clientMessageId)) continue;
    merged.push(relay);
  }
  return merged
    .sort((left, right) => Date.parse(left.deliveredAt) - Date.parse(right.deliveredAt))
    .map(wireOccurrence);
}
