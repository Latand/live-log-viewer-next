import {
  readOnlyConversationLookupFromSnapshot,
  type AgentHostStatus,
  type RegistryFile,
} from "@/lib/agent/registry";
import { sessionKeyId } from "@/lib/agent/sessionKey";

export type ConversationDeliverabilityCondition =
  | "deliverable"
  | "synchronizing"
  | "reclaimed"
  | "superseded"
  | "unknown";

interface ConversationDeliverabilityRecord {
  conversationId: string | null;
  transcriptPath: string | null;
  transport: "structured" | "legacy" | null;
  hostStatus: AgentHostStatus | null;
  pendingAction: "spawn" | "resume" | "handoff" | null;
  processRecorded: boolean;
  reason: string;
}

export type ConversationDeliverability = ConversationDeliverabilityRecord & (
  | { deliverable: true; condition: "deliverable"; resumeRequired: false }
  | { deliverable: false; condition: "reclaimed"; resumeRequired: true }
  | {
      deliverable: false;
      condition: Exclude<ConversationDeliverabilityCondition, "deliverable" | "reclaimed">;
      resumeRequired: false;
    }
);

export interface ConversationDeliverabilityTarget {
  conversationId?: string | null;
  transcriptPath?: string | null;
}

/**
 * Current delivery readiness from the durable registry only. The result never
 * reuses a resume response or a runtime snapshot, so an accepted resume stays
 * `synchronizing` until its current generation records a claimed process.
 */
export function conversationDeliverabilityFromRecord(
  snapshot: RegistryFile,
  target: ConversationDeliverabilityTarget,
): ConversationDeliverability {
  const lookup = readOnlyConversationLookupFromSnapshot(snapshot);
  const requestedId = target.conversationId?.trim() ?? "";
  const requestedPath = target.transcriptPath?.trim() ?? "";
  const conversation = requestedId
    ? lookup.conversation(requestedId as `conversation_${string}`)
    : lookup.conversationForPath(requestedPath);
  const generation = conversation?.generations.at(-1);
  if (!conversation || !generation) {
    return {
      conversationId: null,
      transcriptPath: requestedPath || null,
      deliverable: false,
      condition: "unknown",
      resumeRequired: false,
      transport: null,
      hostStatus: null,
      pendingAction: null,
      processRecorded: false,
      reason: "the durable registry has no current generation for this conversation",
    };
  }
  if (conversation.supersededBy) {
    return {
      conversationId: conversation.id,
      transcriptPath: generation.path,
      deliverable: false,
      condition: "superseded",
      resumeRequired: false,
      transport: null,
      hostStatus: null,
      pendingAction: null,
      processRecorded: false,
      reason: "the conversation was superseded by a successor",
    };
  }

  const entry = snapshot.entries[sessionKeyId({
    engine: conversation.engine,
    sessionId: generation.id,
  })];
  if (!entry) {
    return {
      conversationId: conversation.id,
      transcriptPath: generation.path,
      deliverable: false,
      condition: "reclaimed",
      resumeRequired: true,
      transport: null,
      hostStatus: null,
      pendingAction: null,
      processRecorded: false,
      reason: "the current generation has no recorded host and requires a resume before delivery",
    };
  }

  const processRecorded = entry.structuredHost?.process !== null
    && entry.structuredHost?.process !== undefined;
  let transport: ConversationDeliverability["transport"] = null;
  if (entry.host) transport = "legacy";
  else if (entry.structuredHost) transport = "structured";
  const base = {
    conversationId: conversation.id,
    transcriptPath: generation.path,
    transport,
    hostStatus: entry.status,
    pendingAction: entry.pendingAction,
    processRecorded,
  };

  if (entry.pendingAction !== null || entry.status === "starting" || entry.status === "handoff") {
    return {
      ...base,
      deliverable: false,
      condition: "synchronizing",
      resumeRequired: false,
      reason: "the durable host record is still publishing ownership",
    };
  }
  if (entry.status === "dead" || entry.status === "unhosted") {
    return {
      ...base,
      deliverable: false,
      condition: "reclaimed",
      resumeRequired: true,
      reason: "the durable host record says that no deliverable host remains",
    };
  }
  if (entry.host) {
    return {
      ...base,
      deliverable: true,
      condition: "deliverable",
      resumeRequired: false,
      reason: "the durable record names a current legacy host",
    };
  }
  if (processRecorded
    && entry.claimOwner !== null) {
    return {
      ...base,
      deliverable: true,
      condition: "deliverable",
      resumeRequired: false,
      reason: "the durable record names a claimed structured host process",
    };
  }
  if (!processRecorded) {
    return {
      ...base,
      deliverable: false,
      condition: "reclaimed",
      resumeRequired: true,
      reason: "the durable record shows that the conversation host was reclaimed",
    };
  }
  return {
    ...base,
    deliverable: false,
    condition: "synchronizing",
    resumeRequired: false,
    reason: "the durable record has no publish-ready host ownership yet",
  };
}

export function deliverabilityFailureMessage(
  deliverability: Pick<ConversationDeliverability, "condition">,
): string {
  if (deliverability.condition === "reclaimed") {
    return "conversation host was reclaimed; automatic resume did not establish a deliverable host";
  }
  if (deliverability.condition === "synchronizing") {
    return "conversation host ownership is synchronizing; no deliverable process is recorded yet";
  }
  if (deliverability.condition === "superseded") {
    return "conversation was superseded by a successor";
  }
  return "conversation deliverability is unavailable from the durable record";
}
