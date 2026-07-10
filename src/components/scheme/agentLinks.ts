import type { Flow, FlowState, Round } from "@/lib/flows/types";

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

export type AgentLinkKind = "flow" | "message";

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
