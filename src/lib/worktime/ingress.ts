import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { resolveProjectAttribution, type ProjectAttributionSource } from "@/lib/session/projectResolution";

import { upsertOperatorOccurrence } from "./ledger";
import { mutateWorktimeState } from "./store";
import type { CanonicalOperatorEvent, OperatorEventProvenance, WorktimeStateV1 } from "./types";

export interface WorktimeProjectEvidence {
  project: string;
  rank: number;
  evidence: string;
}

function projectRank(source: ProjectAttributionSource | null): number {
  switch (source) {
    case "ownership": return 4;
    case "cwd": return 3;
    case "launch-profile": return 2;
    case "fallback": return 1;
    default: return 0;
  }
}

function productionProjectEvidence(
  conversationId: string | null,
  transcriptPath: string | null,
  registry: AgentRegistry = agentRegistry(),
): WorktimeProjectEvidence | null {
  const conversation = conversationId?.startsWith("conversation_")
    ? registry.conversation(conversationId as `conversation_${string}`)
    : transcriptPath
      ? registry.conversationForPath(transcriptPath)
      : null;
  const generation = conversation?.generations.at(-1);
  if (!conversation || !generation) return null;
  const attribution = resolveProjectAttribution({
    projectOwnership: conversation.projectOwnership,
    cwd: generation.launchProfile.cwd,
    launchProfileProject: generation.launchProfile.project,
  });
  if (!attribution.project || !attribution.source) return null;
  return {
    project: attribution.project,
    rank: projectRank(attribution.source),
    evidence: `conversation-project:${attribution.source}:${attribution.project}`,
  };
}

export interface OperatorIngressInput {
  provenance: OperatorEventProvenance;
  conversationId?: string | null;
  transcriptPath?: string | null;
  occurredAtMs: number;
  occurrenceId?: string;
}

export interface OperatorIngressDependencies {
  mutate<T>(operation: (state: WorktimeStateV1) => T): T;
  projectEvidence(conversationId: string | null, transcriptPath: string | null): WorktimeProjectEvidence | null;
}

const PRODUCTION_DEPENDENCIES: OperatorIngressDependencies = {
  mutate: (operation) => mutateWorktimeState(undefined, Date.now(), operation),
  projectEvidence: productionProjectEvidence,
};

export function recordOperatorIngress(
  input: OperatorIngressInput,
  dependencies: OperatorIngressDependencies = PRODUCTION_DEPENDENCIES,
): CanonicalOperatorEvent {
  const conversationId = input.conversationId ?? null;
  const transcriptPath = input.transcriptPath ?? null;
  const project = input.provenance.relation === "direct"
    ? dependencies.projectEvidence(conversationId, transcriptPath)
    : null;
  return dependencies.mutate((state) => upsertOperatorOccurrence(state, {
    sourceId: input.provenance.id,
    occurrenceId: input.occurrenceId
      ?? `${input.provenance.id}:${conversationId ?? transcriptPath ?? "ingress"}`,
    origin: input.provenance.origin,
    relation: input.provenance.relation,
    occurredAtMs: input.occurredAtMs,
    projectCandidates: project ? [project] : [],
  }));
}
