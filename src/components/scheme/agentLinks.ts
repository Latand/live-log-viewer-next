import type { Flow, FlowState, Round } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { SchemeRect } from "@/components/scheme/layout";

import { activeLoopLeg, flowByImplementer } from "@/components/flows/flowModel";

/*
 * The scheme's agent-to-agent link family (issue #16): first-class typed
 * connections between two board occupants, separate from the structural
 * parent→child edges and the task edges. Review-loop flows are the first
 * producer; queue/transcript message links (#12) join later as another
 * producer of the same AgentLink shape, rendered through the same layer.
 *
 * Endpoints are board keys (layout.byPath keys), never raw transcript paths:
 * a link exists only when both of its conversations resolve to something the
 * current board actually draws (the approved #16 slice's conservative
 * endpoint resolution). buildAnchorIndex owns that resolution.
 */

export type AgentLinkKind = "flow" | "pipeline" | "message";

/** Rail edge tone into a stage: dim=not-reached, active=busy, ok=passed, amber=parked. */
export type PipelineLinkTone = "dim" | "active" | "ok" | "amber";

/** Tone → CSS color for the pipeline rail (red stays reserved for chips/verdicts). */
export const PIPELINE_RAIL_COLOR: Record<PipelineLinkTone, string> = {
  dim: "var(--color-strong)",
  active: "var(--color-accent)",
  ok: "var(--color-success)",
  amber: "var(--color-warning)",
};

export interface RailSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Repeating chevron `d` marks pointing along the handoff direction. */
  chevrons: string[];
}

/**
 * Straight handoff rail between two board rects, drawn edge-to-edge along the
 * dominant axis and pushed ~offset px off-center so it reads as its own
 * statement beside the spawn bezier that connects the same pair. Chevrons march
 * from→to so direction is unambiguous even at LABEL_Z.
 */
export function pipelineRailSegment(from: SchemeRect, to: SchemeRect, offset = 14): RailSegment {
  const fc = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const tc = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  const horizontal = Math.abs(tc.x - fc.x) >= Math.abs(tc.y - fc.y);
  let x1 = fc.x;
  let y1 = fc.y;
  let x2 = tc.x;
  let y2 = tc.y;
  if (horizontal) {
    x1 = tc.x >= fc.x ? from.x + from.w : from.x;
    x2 = tc.x >= fc.x ? to.x : to.x + to.w;
    y1 += offset;
    y2 += offset;
  } else {
    y1 = tc.y >= fc.y ? from.y + from.h : from.y;
    y2 = tc.y >= fc.y ? to.y : to.y + to.h;
    x1 += offset;
    x2 += offset;
  }
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const chevrons: string[] = [];
  const arm = 5;
  for (let d = 22; d < len - 10; d += 22) {
    const px = x1 + ux * d;
    const py = y1 + uy * d;
    const bx = px - ux * arm;
    const by = py - uy * arm;
    chevrons.push(`M ${(bx + nx * arm).toFixed(1)} ${(by + ny * arm).toFixed(1)} L ${px.toFixed(1)} ${py.toFixed(1)} L ${(bx - nx * arm).toFixed(1)} ${(by - ny * arm).toFixed(1)}`);
  }
  return { x1, y1, x2, y2, chevrons };
}

/** Coarse lifecycle of a flow link — drives the hub tone and pulse. */
export type FlowLinkPhase = "waiting" | "running" | "awaiting_verdict" | "attention" | "paused" | "done";

export interface AgentLink {
  key: string;
  kind: AgentLinkKind;
  /** Board key of the sending/implementing side. */
  from: string;
  /** Board key of the receiving/reviewing side. */
  to: string;
  /** The leg traffic is on right now: forward = from → to. */
  leg: "forward" | "back" | null;
  /** Flow links: the loop this link materializes. */
  flow?: { flow: Flow; round: number; phase: FlowLinkPhase };
  /** Pipeline links: one verdict-keyed conversation-graph edge between two
      materialized stage sessions (#353). */
  pipeline?: {
    pipeline: Pipeline;
    fromStageId: string;
    toStageId: string;
    /** Rail tone, keyed off the target stage's latest attempt (§3 state matrix). */
    tone: PipelineLinkTone;
    /** 1-based index of the target stage and stage count, for the chevron badge. */
    index: number;
    total: number;
    /** The single edge that carries the interactive PipelineHub for this pipeline. */
    hub: boolean;
    /** Whole-pipeline pause: freezes chevron drift while keeping tones. */
    paused: boolean;
    /** Which verdict routes along this edge: pass (solid) or fail (dashed
        amber loop). Absent on legacy callers ⇒ pass. */
    edge?: "pass" | "fail";
    /** The edge the engine traverses next (the active cursor stage's pass
        edge) — drives the pulse highlight. */
    isNext?: boolean;
    /** A hub with no drawn rail: `from === to` and it only positions the control
        pill. Emitted when every real edge collapsed (e.g. a 2-stage
        build→review whose sole edge folds into the implementer) so the pipeline
        still keeps a board control surface (AC6). */
    anchorOnly?: boolean;
  };
  /** Message links (#12): one aggregated edge per endpoint pair. */
  message?: { count: number; lastAt: number };
}

/** Board key of a flow's reviewer round deck (owned here, used by layout). */
export function deckKey(flowId: string): string {
  return "deck::" + flowId;
}

export function flowLinkKey(flowId: string): string {
  return "flowlink::" + flowId;
}

export function flowLinkPhase(state: FlowState): FlowLinkPhase {
  switch (state) {
    case "reviewing":
      return "awaiting_verdict";
    case "spawning":
    case "relaying":
    case "fixing":
      return "running";
    case "spawn_pending":
    case "relay_pending":
    case "needs_decision":
    case "done_comment":
      return "attention";
    case "paused":
      return "paused";
    case "approved":
    case "closed":
      return "done";
    case "waiting_ready":
      return "waiting";
  }
}

/** The round the loop is currently on, if any started. */
export function currentRound(flow: Flow): Round | null {
  return flow.rounds.at(-1) ?? null;
}

export interface AnchorDeck {
  key: string;
  flow: Flow;
}

export interface AnchorStack {
  key: string;
  paths: string[];
}

/**
 * Conservative transcript-path → board-key resolution: the rect that visually
 * hosts a conversation on the current board. A full node represents itself; a
 * reviewer transcript claimed by a round deck resolves to that deck; a quiet
 * branch resolves to the mini-stack holding it. Later writes win, so a full
 * node overrides any stack/deck claim of the same path. Deck keys self-resolve
 * so a link can target the deck placeholder before its reviewer transcript
 * exists. Anything absent from the map is off the board — no link endpoint.
 */
export function buildAnchorIndex(nodePaths: Iterable<string>, decks: AnchorDeck[], stacks: AnchorStack[]): Map<string, string> {
  const index = new Map<string, string>();
  for (const stack of stacks) {
    for (const path of stack.paths) index.set(path, stack.key);
  }
  for (const deck of decks) {
    index.set(deck.key, deck.key);
    for (const round of deck.flow.rounds) {
      if (round.reviewerPath) index.set(round.reviewerPath, deck.key);
    }
  }
  for (const path of nodePaths) index.set(path, path);
  return index;
}

/**
 * Flow links: one per active flow, implementer side → current reviewer side.
 * The reviewer endpoint prefers the current round's transcript anchor (its
 * deck once the scanner claims it, or a full node if it ever renders as one)
 * and falls back to the flow's deck placeholder while the round has no
 * transcript yet. Both endpoints must resolve, and a link never points at
 * itself — an unresolved or degenerate pair emits nothing.
 */
export function deriveFlowLinks(flows: Flow[], anchorOf: (pathOrKey: string) => string | null): AgentLink[] {
  const links: AgentLink[] = [];
  for (const flow of flowByImplementer(flows).values()) {
    const from = anchorOf(flow.implementerPath);
    if (!from) continue;
    const round = currentRound(flow);
    const to = (round?.reviewerPath ? anchorOf(round.reviewerPath) : null) ?? anchorOf(deckKey(flow.id));
    if (!to || to === from) continue;
    links.push({
      key: flowLinkKey(flow.id),
      kind: "flow",
      from,
      to,
      leg: activeLoopLeg(flow),
      flow: { flow, round: round?.n ?? 0, phase: flowLinkPhase(flow.state) },
    });
  }
  return links;
}

/*
 * Flow/pipeline GROUP overlay (issue #118): every session belonging to a
 * running flow or pipeline — implementer, reviewer round deck, run-stage
 * children — reads as ONE marked region (a tinted halo with the flow/pipeline
 * name). The membership derivation below reuses the same anchor resolution the
 * links do, so the halo can never enclose a board key that isn't drawn; the
 * geometry (union bounding box) lives in layout.ts where the rects are known.
 * A group dissolves the moment its flow/pipeline closes (both are skipped here),
 * honoring PR #115 tombstone/close semantics without touching them.
 */

/** A group's membership + identity, before geometry (owned by the layout). */
export interface SchemeGroupSpec {
  key: string;
  kind: "flow" | "pipeline";
  /** The flow or pipeline id — stable across polls, seeds the halo hue. */
  id: string;
  /** Deterministic hue [0,360): a distinct, reload-stable tint per group. */
  hue: number;
  /** Board keys (layout.byPath keys) enclosed by the halo. */
  members: string[];
  flow?: Flow;
  pipeline?: Pipeline;
}

/** Deterministic hue [0,360) from an id: each flow/pipeline gets a distinct,
    stable tint so two concurrent groups never read as the same region. */
export function hueFromId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) % 360;
  return ((hash % 360) + 360) % 360;
}

/** Union bounding box of the resolvable member rects, padded so the halo sits
    clear of the cards. Null when nothing resolves (an off-board group). */
export function groupRect(
  members: Iterable<string>,
  rectOf: (key: string) => SchemeRect | null,
  pad: number,
): SchemeRect | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let found = false;
  for (const key of members) {
    const rect = rectOf(key);
    if (!rect) continue;
    found = true;
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
  }
  if (!found) return null;
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

/**
 * One group per active flow and per active pipeline (issue #118). A pipeline
 * that embeds a review-loop owns the flow it drives, so that flow's own group is
 * suppressed (its implementer/deck already sit inside the pipeline halo) to avoid
 * a double outline. Members resolve through the same anchorOf as the links:
 * a run stage → its agent node, a review-loop → the flow's implementer node plus
 * its round deck, a flow → implementer plus deck. A group with no resolvable
 * member is dropped so the caller never draws an empty halo.
 */
export function deriveGroups(
  flows: Flow[],
  pipelines: Pipeline[],
  anchorOf: (pathOrKey: string) => string | null,
  flowImplementerPath: (flowId: string) => string | null = () => null,
): SchemeGroupSpec[] {
  const specs: SchemeGroupSpec[] = [];
  /* Flows a pipeline drives through a review-loop stage: their halo is the
     pipeline's, so skip their standalone group below. */
  const embeddedFlowIds = new Set<string>();
  for (const pipeline of pipelines) {
    if (pipeline.state === "closed" && !pipeline.restored) continue;
    for (const run of pipeline.runs) {
      for (const attempt of run.attempts) {
        if (attempt.flowId) embeddedFlowIds.add(attempt.flowId);
      }
    }
  }
  for (const pipeline of pipelines) {
    if (pipeline.state === "closed" && !pipeline.restored) continue;
    const members = new Set<string>();
    for (const stage of pipeline.stages) {
      /* Every materialized attempt, not just the latest: a retried stage can
         leave earlier attempt transcripts as sibling nodes still on the board,
         and the halo must enclose them too. Links/controls keep latest-attempt
         semantics — this is membership only. */
      for (const attempt of pipeline.runs.find((run) => run.stageId === stage.id)?.attempts ?? []) {
        if (stage.kind === "review-loop") {
          const implPath = attempt.flowId ? flowImplementerPath(attempt.flowId) : null;
          const impl = implPath ? anchorOf(implPath) : null;
          if (impl) members.add(impl);
          if (attempt.flowId) {
            const deck = anchorOf(deckKey(attempt.flowId));
            if (deck) members.add(deck);
          }
        } else if (attempt.agentPath) {
          const at = anchorOf(attempt.agentPath);
          if (at) members.add(at);
        }
      }
    }
    if (members.size) {
      specs.push({ key: `group::pipeline::${pipeline.id}`, kind: "pipeline", id: pipeline.id, hue: hueFromId(pipeline.id), members: [...members], pipeline });
    }
  }
  for (const flow of flowByImplementer(flows).values()) {
    if (embeddedFlowIds.has(flow.id)) continue;
    const members = new Set<string>();
    const impl = anchorOf(flow.implementerPath);
    if (impl) members.add(impl);
    const deck = anchorOf(deckKey(flow.id));
    if (deck) members.add(deck);
    if (members.size) {
      specs.push({ key: `group::flow::${flow.id}`, kind: "flow", id: flow.id, hue: hueFromId(flow.id), members: [...members], flow });
    }
  }
  return specs;
}

const PIPELINE_BUSY_LINK_STATES: ReadonlySet<Pipeline["state"]> = new Set(["provisioning", "running"]);

/** The cursor stage stays active while paused: `state` is `paused` but the
    pre-pause busy state survives in `pausedState`. The rail keeps its active
    tone; the `paused` link flag freezes the chevron drift (see nodes.tsx). */
function pipelineCursorActive(pipeline: Pipeline): boolean {
  if (PIPELINE_BUSY_LINK_STATES.has(pipeline.state)) return true;
  return pipeline.state === "paused" && pipeline.pausedState !== null && PIPELINE_BUSY_LINK_STATES.has(pipeline.pausedState);
}

/** Rail tone into a stage from the target stage's latest attempt + the cursor,
    a straight read of the §3 matrix that avoids importing the strip's helpers. */
function pipelineLinkTone(pipeline: Pipeline, stageId: string): PipelineLinkTone {
  const attempt = pipeline.runs.find((run) => run.stageId === stageId)?.attempts.at(-1) ?? null;
  if (attempt?.state === "passed" || attempt?.state === "skipped") return "ok";
  if (attempt?.state === "failed" || attempt?.state === "needs_decision") return "amber";
  if (pipeline.cursor?.stageId === stageId && pipelineCursorActive(pipeline)) return "active";
  return "dim";
}

/**
 * Pipeline links (#93 §2.2, graph-aware since #353): one straight handoff rail
 * per materialized conversation-graph edge — the stage's pass edge (`next`,
 * solid, toned by its target) plus its fail edge (`onFail`, dashed amber loop).
 * Exactly one edge per pipeline — the one into the current stage (or the last
 * drawn edge as a fallback) — carries the interactive hub, the rest a
 * stage-index chevron badge. The active cursor stage's outgoing pass edge is
 * flagged `isNext` so the board can show which edge runs next.
 */
export function derivePipelineLinks(
  pipelines: Pipeline[],
  anchorOf: (pathOrKey: string) => string | null,
  flowImplementerPath: (flowId: string) => string | null = () => null,
): AgentLink[] {
  const links: AgentLink[] = [];
  for (const pipeline of pipelines) {
    if (pipeline.state === "closed" && !pipeline.restored) continue;
    const total = pipeline.stages.length;
    const cursorStageId = pipeline.cursor?.stageId ?? pipeline.stages.at(-1)?.id ?? null;
    const cursorActive = pipelineCursorActive(pipeline);
    const own: AgentLink[] = [];
    /* Every materialized stage's resolved board vertex, kept so a pipeline whose
       edges all collapse still has a node to anchor its control hub on. */
    const vertices: Array<{ stageId: string; index: number; path: string }> = [];
    /* An edge pair resolved to the same board node (a review-loop folding
       into its implementer), so a real edge was intended but suppressed. */
    let collapsed = false;
    /* A review-loop stage's agentPath is the reviewer transcript, which the
       board folds into the flow's round deck — anchoring a rail there would
       draw an implementer→deck→next chain and drop a PipelineHub on top of the
       FlowHub. Resolve the stage to its flow's implementer node instead; the
       resulting edge from the preceding run collapses (from === to) and is
       suppressed below, leaving the loop's own grammar to represent it. */
    const vertexPathOf = (stage: Pipeline["stages"][number]): string | null => {
      const attempt = pipeline.runs.find((run) => run.stageId === stage.id)?.attempts.at(-1);
      return stage.kind === "review-loop"
        ? (attempt?.flowId ? flowImplementerPath(attempt.flowId) : null)
        : attempt?.agentPath ?? null;
    };
    const stageIndex = new Map(pipeline.stages.map((stage, index) => [stage.id, index] as const));
    for (let index = 0; index < pipeline.stages.length; index += 1) {
      const stage = pipeline.stages[index]!;
      const vertexPath = vertexPathOf(stage);
      if (vertexPath) vertices.push({ stageId: stage.id, index, path: vertexPath });
    }
    const vertexByStage = new Map(vertices.map((vertex) => [vertex.stageId, vertex] as const));
    for (const stage of pipeline.stages) {
      const fromVertex = vertexByStage.get(stage.id);
      if (!fromVertex) continue;
      const graphEdges: Array<{ toStageId: string; edge: "pass" | "fail" }> = [
        ...(stage.next ? [{ toStageId: stage.next, edge: "pass" as const }] : []),
        ...(stage.onFail ? [{ toStageId: stage.onFail.to, edge: "fail" as const }] : []),
      ];
      for (const graphEdge of graphEdges) {
        const toVertex = vertexByStage.get(graphEdge.toStageId);
        if (!toVertex) continue;
        const from = anchorOf(fromVertex.path);
        const to = anchorOf(toVertex.path);
        if (from && to && from === to) collapsed = true;
        if (!from || !to || from === to) continue;
        own.push({
          key: `pipelinelink::${pipeline.id}::${stage.id}::${graphEdge.toStageId}::${graphEdge.edge}`,
          kind: "pipeline",
          from,
          to,
          leg: "forward",
          pipeline: {
            pipeline,
            fromStageId: stage.id,
            toStageId: graphEdge.toStageId,
            tone: graphEdge.edge === "fail" ? "amber" : pipelineLinkTone(pipeline, graphEdge.toStageId),
            index: (stageIndex.get(graphEdge.toStageId) ?? 0) + 1,
            total,
            hub: false,
            paused: pipeline.state === "paused",
            edge: graphEdge.edge,
            isNext: graphEdge.edge === "pass" && cursorActive && pipeline.cursor?.stageId === stage.id,
          },
        });
      }
    }
    /* One hub per pipeline: the pass edge into the current stage, else the last
       drawn edge. */
    const hubLink = own.find((link) => link.pipeline!.toStageId === cursorStageId && link.pipeline!.edge !== "fail") ?? own.at(-1);
    if (hubLink) {
      hubLink.pipeline!.hub = true;
      links.push(...own);
      continue;
    }
    links.push(...own);
    /* No drawn edge carries the hub, and a real edge collapsed into a single
       node (the canonical case: a 2-stage build→review whose only edge folds
       into the implementer). Anchor a rail-less control hub on the current
       stage's node so the pipeline keeps board-level pause/retry/skip/close
       (AC6). A chain that is merely still spawning (no adjacent pair yet) has no
       collapse and draws nothing, as before. */
    if (own.length || !collapsed) continue;
    const anchor = vertices.find((vertex) => vertex.stageId === cursorStageId) ?? vertices.at(-1);
    const at = anchor ? anchorOf(anchor.path) : null;
    if (anchor && at) {
      links.push({
        key: `pipelinehub::${pipeline.id}`,
        kind: "pipeline",
        from: at,
        to: at,
        leg: null,
        pipeline: {
          pipeline,
          fromStageId: anchor.stageId,
          toStageId: anchor.stageId,
          tone: pipelineLinkTone(pipeline, cursorStageId ?? anchor.stageId),
          index: anchor.index + 1,
          total,
          hub: true,
          paused: pipeline.state === "paused",
          anchorOnly: true,
        },
      });
    }
  }
  return links;
}
