import { agentRegistry, readOnlyConversationLookupFromSnapshot, type RegistryFile } from "@/lib/agent/registry";
import { flowRelayedMessageOccurrences } from "@/lib/flows/relayProvenance";
import { readOrchestratorSeatFile } from "@/lib/orchestrator/seats";

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
 *
 * One more fact rides the same projection (#1166): an orchestrator seat is
 * created by DELIVERING its mandate, and the seat record names that delivery by
 * its client-message identity. An occurrence the seats claim carries the
 * mandate says so, and the feed renders the row as the seat's own card instead
 * of quoting 8 KB back at the operator as something they typed.
 */

export interface DeliveredMessageOccurrenceDependencies {
  registrySnapshot?: () => RegistryFile;
  relayOccurrences?: (transcriptPath: string) => DeliveredMessageOccurrence[];
  orchestratorSeats?: () => OrchestratorSeatFile;
}

type OrchestratorSeatFile = ReturnType<typeof readOrchestratorSeatFile>;

/** What one seat's mandate delivery projects onto the row it produced. */
export interface MandateDelivery {
  version: number | null;
}

/** The identity `seatCommand.ts` reserves the adoption-mode mandate delivery
    under, derived from the designation's own client request id. */
const MANDATE_CLIENT_MESSAGE_PREFIX = "orchmandate_";

/** The identity `structuredSpawn.ts` reserves a launch's first prompt under.
    In spawn mode that first prompt IS the mandate, so the seat's recorded
    launch id names the same delivery the adoption prefix names. */
const SPAWN_CLIENT_MESSAGE_PREFIX = "spawn_";

/**
 * The client-message ids the orchestrator seats say carry a mandate, mapped to
 * what each seat recorded about it (#1166).
 *
 * A seat is created by DELIVERING its mandate, so those 8 KB reach the
 * transcript as an ordinary message and the feed rendered them as the
 * operator's own bubble. Recognition is delivery IDENTITY, never a signature of
 * the text: only the exact delivery a seat reserved is a mandate, so an
 * operator who pastes the same bytes by hand still owns their own words. Both
 * delivery modes are named by the seat itself — the adoption message by the
 * designation's client request id, the spawn's first prompt by its launch id.
 *
 * Ordered oldest authority first: a terminalized intent may share nothing with
 * the seat that eventually took the project, and the live seat wins any tie.
 */
export function orchestratorMandateDeliveries(file: OrchestratorSeatFile): Map<string, MandateDelivery> {
  const byClientMessageId = new Map<string, MandateDelivery>();
  const seats = [
    ...file.history.map((entry) => entry.seat),
    ...Object.values(file.pending),
    ...Object.values(file.seats),
  ];
  for (const seat of seats) {
    const mandate: MandateDelivery = { version: seat.promptVersion };
    byClientMessageId.set(`${MANDATE_CLIENT_MESSAGE_PREFIX}${seat.intent.clientRequestId}`, mandate);
    if (seat.intent.launchId) {
      byClientMessageId.set(`${SPAWN_CLIENT_MESSAGE_PREFIX}${seat.intent.launchId}`, mandate);
    }
  }
  return byClientMessageId;
}

const NO_MANDATES: ReadonlyMap<string, MandateDelivery> = new Map();

const CONTENT_DIGEST = /^[a-f0-9]{64}$/;

/** Delivered, origin-stamped held records of the conversation that owns
    `transcriptPath`, projected as occurrences. Each carries the record's
    client-message id (when the transport reserved one) as its join identity. */
export function heldDeliveryOccurrences(
  transcriptPath: string,
  snapshot: RegistryFile,
  mandates: ReadonlyMap<string, MandateDelivery> = NO_MANDATES,
): DeliveredMessageOccurrence[] {
  const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
  const conversation = lookup.conversationForPath(transcriptPath);
  if (!conversation) return [];
  const occurrences: DeliveredMessageOccurrence[] = [];
  for (const delivery of Object.values(snapshot.heldDeliveries)) {
    if (delivery.state !== "delivered" || !delivery.deliveredAt || !delivery.contentDigest) continue;
    if (lookup.canonicalConversationId(delivery.conversationId) !== conversation.id) continue;
    if (!CONTENT_DIGEST.test(delivery.contentDigest) || !Number.isFinite(Date.parse(delivery.deliveredAt))) continue;
    const mandate = delivery.clientMessageId ? mandates.get(delivery.clientMessageId) ?? null : null;
    /* Re-validated here as well as at normalization: a forged or corrupt
       persisted stamp drops, and can never re-author a row. A seat mandate
       stands without one: the seat command predates the authorship stamp, and
       the delivery identity the seat recorded IS the stamp. It resolves to
       `agent` because whatever else the mandate is, the operator did not type
       it — the very thing the operator's bubble was claiming. */
    const origin = parseMessageOrigin(delivery.command?.origin) ?? (mandate ? { kind: "agent" as const } : null);
    if (!origin) continue;
    occurrences.push({
      textDigest: delivery.contentDigest,
      deliveredAt: delivery.deliveredAt,
      origin: origin.kind,
      ...(origin.kind === "agent" && origin.role ? { senderRole: origin.role } : {}),
      ...(mandate ? { mandate } : {}),
      ...(delivery.clientMessageId ? { clientMessageId: delivery.clientMessageId } : {}),
    });
  }
  return occurrences;
}

/** The wire shape of one occurrence: the join identity has done its work. */
function wireOccurrence(occurrence: DeliveredMessageOccurrence): DeliveredMessageOccurrence {
  const { textDigest, deliveredAt, origin, senderRole, selectedContext, mandate } = occurrence;
  return {
    textDigest,
    deliveredAt,
    origin,
    ...(senderRole ? { senderRole } : {}),
    ...(selectedContext ? { selectedContext } : {}),
    ...(mandate ? { mandate } : {}),
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
  let mandates: ReadonlyMap<string, MandateDelivery> = NO_MANDATES;
  try {
    mandates = orchestratorMandateDeliveries((dependencies.orchestratorSeats ?? readOrchestratorSeatFile)());
  } catch {
    /* No readable seat file: a mandate row keeps rendering as it does today. */
    mandates = NO_MANDATES;
  }
  let held: DeliveredMessageOccurrence[] = [];
  try {
    const snapshot = (dependencies.registrySnapshot ?? (() => agentRegistry().readOnlySnapshot()))();
    held = heldDeliveryOccurrences(transcriptPath, snapshot, mandates);
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
