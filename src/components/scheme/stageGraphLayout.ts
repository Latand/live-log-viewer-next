import type {
  PipelineAttemptState,
  PipelineEdgeKind,
  PipelineStage,
  PipelineStageAttempt,
  PipelineStageRun,
} from "@/lib/pipelines/types";

export const STAGE_GRAPH_NODE_WIDTH = 188;
export const STAGE_GRAPH_NODE_HEIGHT = 104;
export const STAGE_GRAPH_COLUMN_GAP = 76;
export const STAGE_GRAPH_ROW_GAP = 24;
export const STAGE_GRAPH_PADDING = 24;
export const STAGE_GRAPH_RETURN_GUTTER = 64;

export type StageGraphReviewGroup = {
  stage: PipelineStage;
  attempts: PipelineStageAttempt[];
};

export type StageGraphNode = {
  id: string;
  /** Review stages stay declared graph nodes while rendering inside this run's cluster. */
  parentId: string | null;
  stage: PipelineStage;
  attempts: PipelineStageAttempt[];
  reviewGroups: StageGraphReviewGroup[];
  state: PipelineAttemptState;
  layer: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type StageGraphEdge = {
  id: string;
  from: string;
  to: string;
  sourceStageId: string;
  targetStageId: string;
  kind: PipelineEdgeKind;
  returning: boolean;
  taken: boolean;
};

export type StageGraphLayout = {
  nodes: StageGraphNode[];
  edges: StageGraphEdge[];
  size: { width: number; height: number };
};

export function layoutStageGraph(stages: readonly PipelineStage[], runs: readonly PipelineStageRun[]): StageGraphLayout {
  const attemptsByStage = new Map(runs.map((run) => [run.stageId, run.attempts] as const));
  const stageById = new Map(stages.map((stage) => [stage.id, stage] as const));
  const stageIndex = new Map(stages.map((stage, index) => [stage.id, index] as const));
  const passPredecessors = new Map(stages.map((stage) => [stage.id, [] as string[]] as const));
  for (const stage of stages) if (stage.next) passPredecessors.get(stage.next)?.push(stage.id);

  const reviewOwner = (reviewId: string): string | null => {
    const activatedBy = attemptsByStage.get(reviewId)?.at(-1)?.activatedBy?.stageId;
    if (activatedBy && stageById.get(activatedBy)?.kind === "run") return activatedBy;
    const queue = [...(passPredecessors.get(reviewId) ?? [])];
    const seen = new Set([reviewId]);
    while (queue.length) {
      const candidateId = queue.shift()!;
      if (seen.has(candidateId)) continue;
      seen.add(candidateId);
      const candidate = stageById.get(candidateId);
      if (candidate?.kind === "run") return candidate.id;
      queue.push(...(passPredecessors.get(candidateId) ?? []));
    }
    return stages.find((stage) => stage.kind === "run")?.id ?? null;
  };
  const ownerByStage = new Map(stages.map((stage) => [
    stage.id,
    stage.kind === "run" ? stage.id : reviewOwner(stage.id),
  ] as const));
  const layerById = new Map<string, number>();
  const declaredEdges = stages.flatMap((stage) => [
    ...(stage.next ? [{ source: stage.id, target: stage.next, kind: "pass" as const }] : []),
    ...(stage.onFail ? [{ source: stage.id, target: stage.onFail.to, kind: "fail" as const }] : []),
  ]);
  const outgoing = new Map(stages.map((stage) => [stage.id, [] as typeof declaredEdges] as const));
  for (const edge of declaredEdges) outgoing.get(edge.source)?.push(edge);
  const edgeId = (edge: (typeof declaredEdges)[number]) => `${edge.source}:${edge.kind}:${edge.target}`;
  const colors = new Map<string, "visiting" | "done">();
  const returningIds = new Set<string>();
  const visit = (stageId: string) => {
    colors.set(stageId, "visiting");
    for (const edge of outgoing.get(stageId) ?? []) {
      if (edge.target === stageId || colors.get(edge.target) === "visiting") returningIds.add(edgeId(edge));
      else if (!colors.has(edge.target)) visit(edge.target);
    }
    colors.set(stageId, "done");
  };
  for (const stage of stages) if (!colors.has(stage.id)) visit(stage.id);
  const horizontalInset = STAGE_GRAPH_PADDING + (returningIds.size ? STAGE_GRAPH_RETURN_GUTTER : 0);

  const forwardEdges = declaredEdges.filter((edge) => !returningIds.has(edgeId(edge)));
  const forwardOutgoing = new Map(stages.map((stage) => [stage.id, [] as typeof forwardEdges] as const));
  const indegree = new Map<string, number>(stages.map((stage) => [stage.id, 0]));
  for (const edge of forwardEdges) {
    forwardOutgoing.get(edge.source)?.push(edge);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }
  const queue = stages.filter((stage) => indegree.get(stage.id) === 0).map((stage) => stage.id);
  for (const stage of stages) layerById.set(stage.id, 0);
  while (queue.length) {
    const source = queue.shift()!;
    for (const edge of forwardOutgoing.get(source) ?? []) {
      layerById.set(edge.target, Math.max(layerById.get(edge.target) ?? 0, (layerById.get(source) ?? 0) + 1));
      const remaining = (indegree.get(edge.target) ?? 1) - 1;
      indegree.set(edge.target, remaining);
      if (remaining === 0) queue.push(edge.target);
    }
  }

  const positionById = new Map<string, { x: number; y: number }>();
  const yByLayer = new Map<number, number>();
  for (const stage of stages.filter((candidate) => candidate.kind === "run")) {
    const layer = layerById.get(stage.id) ?? 0;
    const y = yByLayer.get(layer) ?? STAGE_GRAPH_PADDING;
    const reviewCount = stages
      .filter((candidate) => candidate.kind === "review-loop" && ownerByStage.get(candidate.id) === stage.id)
      .length;
    const clusterHeight = STAGE_GRAPH_NODE_HEIGHT + reviewCount * (STAGE_GRAPH_NODE_HEIGHT + 12);
    yByLayer.set(layer, y + clusterHeight + STAGE_GRAPH_ROW_GAP);
    positionById.set(stage.id, {
      x: horizontalInset + layer * (STAGE_GRAPH_NODE_WIDTH + STAGE_GRAPH_COLUMN_GAP),
      y,
    });
  }
  for (const stage of stages.filter((candidate) => candidate.kind === "review-loop")) {
    const ownerId = ownerByStage.get(stage.id);
    const ownerPosition = ownerId ? positionById.get(ownerId) : null;
    const siblings = stages
      .filter((candidate) => candidate.kind === "review-loop" && ownerByStage.get(candidate.id) === ownerId)
      .sort((a, b) => (stageIndex.get(a.id) ?? 0) - (stageIndex.get(b.id) ?? 0));
    const siblingIndex = Math.max(0, siblings.findIndex((candidate) => candidate.id === stage.id));
    positionById.set(stage.id, ownerPosition ? {
      x: ownerPosition.x + 12,
      y: ownerPosition.y + STAGE_GRAPH_NODE_HEIGHT + 12 + siblingIndex * (STAGE_GRAPH_NODE_HEIGHT + 12),
    } : {
      x: horizontalInset + (layerById.get(stage.id) ?? 0) * (STAGE_GRAPH_NODE_WIDTH + STAGE_GRAPH_COLUMN_GAP),
      y: STAGE_GRAPH_PADDING,
    });
  }
  const nodes = stages.map((stage) => {
    const layer = layerById.get(stage.id) ?? 0;
    const position = positionById.get(stage.id) ?? { x: STAGE_GRAPH_PADDING, y: STAGE_GRAPH_PADDING };
    const attempts = attemptsByStage.get(stage.id) ?? [];
    const reviewGroups = stage.kind === "run" ? stages
      .filter((candidate) => candidate.kind === "review-loop" && ownerByStage.get(candidate.id) === stage.id)
      .sort((a, b) => (stageIndex.get(a.id) ?? 0) - (stageIndex.get(b.id) ?? 0))
      .map((candidate) => ({ stage: candidate, attempts: attemptsByStage.get(candidate.id) ?? [] })) : [];
    return {
      id: stage.id,
      parentId: stage.kind === "review-loop" ? ownerByStage.get(stage.id) ?? null : null,
      stage,
      attempts,
      reviewGroups,
      state: attempts.at(-1)?.state ?? "pending",
      layer,
      x: position.x,
      y: position.y,
      width: stage.kind === "review-loop" ? STAGE_GRAPH_NODE_WIDTH - 24 : STAGE_GRAPH_NODE_WIDTH,
      height: STAGE_GRAPH_NODE_HEIGHT,
    } satisfies StageGraphNode;
  });
  const edges = declaredEdges.map((edge) => ({
    id: edgeId(edge),
    from: edge.source,
    to: edge.target,
    sourceStageId: edge.source,
    targetStageId: edge.target,
    kind: edge.kind,
    returning: returningIds.has(edgeId(edge)) || (layerById.get(edge.target) ?? 0) <= (layerById.get(edge.source) ?? 0),
    taken: (attemptsByStage.get(edge.target) ?? []).some((attempt) =>
      attempt.activatedBy?.stageId === edge.source && attempt.activatedBy.edge === edge.kind,
    ),
  }));
  const columns = Math.max(1, ...nodes.map((node) => node.layer + 1));
  const contentHeight = Math.max(STAGE_GRAPH_NODE_HEIGHT, ...nodes.map((node) => node.y + node.height - STAGE_GRAPH_PADDING));
  return {
    nodes,
    edges,
    size: {
      width: STAGE_GRAPH_PADDING * 2
        + (returningIds.size ? STAGE_GRAPH_RETURN_GUTTER * 2 : 0)
        + columns * STAGE_GRAPH_NODE_WIDTH
        + (columns - 1) * STAGE_GRAPH_COLUMN_GAP,
      height: STAGE_GRAPH_PADDING * 2 + contentHeight,
    },
  };
}
