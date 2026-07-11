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
  dim: "#b4b4bd",
  active: "#5a51e0",
  ok: "#1a8a3e",
  amber: "#e0ae45",
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
  /** Pipeline links: one linear handoff edge between adjacent stage sessions. */
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
 * Pipeline links (#93 §2.2): one straight handoff rail per materialized adjacent
 * stage pair. Each edge is toned by its target stage; exactly one edge per
 * pipeline — the one into the current stage (or the last drawn edge as a
 * fallback) — carries the interactive hub, the rest a stage-index chevron badge.
 */
export function derivePipelineLinks(
  pipelines: Pipeline[],
  anchorOf: (pathOrKey: string) => string | null,
  flowImplementerPath: (flowId: string) => string | null = () => null,
): AgentLink[] {
  const links: AgentLink[] = [];
  for (const pipeline of pipelines) {
    if (pipeline.state === "closed") continue;
    const total = pipeline.stages.length;
    const cursorStageId = pipeline.cursor?.stageId ?? pipeline.stages.at(-1)?.id ?? null;
    const own: AgentLink[] = [];
    /* Every materialized stage's resolved board vertex, kept so a pipeline whose
       edges all collapse still has a node to anchor its control hub on. */
    const vertices: Array<{ stageId: string; index: number; path: string }> = [];
    /* An adjacent pair resolved to the same board node (a review-loop folding
       into its implementer), so a real edge was intended but suppressed. */
    let collapsed = false;
    let previous: { stageId: string; path: string } | null = null;
    for (let index = 0; index < pipeline.stages.length; index += 1) {
      const stage = pipeline.stages[index]!;
      const attempt = pipeline.runs.find((run) => run.stageId === stage.id)?.attempts.at(-1);
      /* A review-loop stage's agentPath is the reviewer transcript, which the
         board folds into the flow's round deck — anchoring a rail there would
         draw an implementer→deck→next chain and drop a PipelineHub on top of the
         FlowHub. Resolve the stage to its flow's implementer node instead; the
         resulting edge from the preceding run collapses (from === to) and is
         suppressed below, leaving the loop's own grammar to represent it. */
      const vertexPath = stage.kind === "review-loop"
        ? (attempt?.flowId ? flowImplementerPath(attempt.flowId) : null)
        : attempt?.agentPath ?? null;
      if (!vertexPath) continue;
      vertices.push({ stageId: stage.id, index, path: vertexPath });
      if (previous) {
        const from = anchorOf(previous.path);
        const to = anchorOf(vertexPath);
        if (from && to && from === to) collapsed = true;
        if (from && to && from !== to) {
          own.push({
            key: `pipelinelink::${pipeline.id}::${previous.stageId}::${stage.id}`,
            kind: "pipeline",
            from,
            to,
            leg: "forward",
            pipeline: {
              pipeline,
              fromStageId: previous.stageId,
              toStageId: stage.id,
              tone: pipelineLinkTone(pipeline, stage.id),
              index: index + 1,
              total,
              hub: false,
              paused: pipeline.state === "paused",
            },
          });
        }
      }
      previous = { stageId: stage.id, path: vertexPath };
    }
    /* One hub per pipeline: the edge into the current stage, else the last edge. */
    const hubLink = own.find((link) => link.pipeline!.toStageId === cursorStageId) ?? own.at(-1);
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
