import { getLocale, type TFunction, translate } from "@/lib/i18n";
import type { Flow, FlowAction, FlowRoleKey, FlowState, ReviewVerdict } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

import { isConversation } from "@/components/projectModel";

/** Flows that still occupy their implementer's node on the scheme. */
export function isActiveFlow(flow: Flow): boolean {
  return flow.state !== "closed";
}

export function flowByImplementer(flows: Flow[]): Map<string, Flow> {
  const map = new Map<string, Flow>();
  for (const flow of flows) {
    if (!isActiveFlow(flow)) continue;
    /* One active flow per implementer; the newest wins if the server ever
       sends stale duplicates. */
    const prev = map.get(flow.implementerPath);
    if (!prev || flow.createdAt > prev.createdAt) map.set(flow.implementerPath, flow);
  }
  return map;
}

/**
 * Reviewer transcripts claimed by a round deck: they render inside the deck
 * and must never appear as standalone scheme nodes or switchboard noise.
 */
export function claimedReviewerPaths(flows: Flow[]): Set<string> {
  const set = new Set<string>();
  for (const flow of flows) {
    for (const round of flow.rounds) {
      if (round.reviewerPath) set.add(round.reviewerPath);
    }
  }
  return set;
}

/** A conversation that can host a new flow: a root claude/codex session without one. */
export function canStartFlow(file: FileEntry, activeByImplementer: ReadonlyMap<string, Flow>): boolean {
  if (activeByImplementer.has(file.path)) return false;
  if (file.engine !== "claude" && file.engine !== "codex") return false;
  return isConversation(file);
}

/** Localized lifecycle-state label; keys live under flowState.* in the dicts. */
export function stateLabel(t: TFunction, state: FlowState): string {
  return t(`flowState.${state}`);
}

/** States that ask for the user's attention on the strip and the switchboard. */
export const ATTENTION_STATES: ReadonlySet<FlowState> = new Set([
  "spawn_pending",
  "relay_pending",
  "needs_decision",
  "paused",
  "approved",
]);

/** Flow states in which one of the loop sides is visibly doing work. */
export const BUSY_FLOW_STATES: ReadonlySet<FlowState> = new Set(["spawning", "reviewing", "relaying", "fixing"]);

/** The loop side working right now — drives the role tags on the scheme. */
export function activeLoopRole(flow: Flow): FlowRoleKey | null {
  if (flow.state === "spawning" || flow.state === "reviewing") return "reviewer";
  if (flow.state === "waiting_ready" || flow.state === "relaying" || flow.state === "fixing") return "implementer";
  return null;
}

/** The cycle leg traffic is on: forward = implementer → reviewer. */
export function activeLoopLeg(flow: Flow): "forward" | "back" | null {
  if (flow.state === "spawn_pending" || flow.state === "spawning" || flow.state === "reviewing") return "forward";
  if (flow.state === "relay_pending" || flow.state === "relaying" || flow.state === "fixing") return "back";
  if (flow.state === "waiting_ready") return flow.rounds.length ? "back" : null;
  return null;
}

export const VERDICT_GLYPHS: Record<ReviewVerdict, string> = {
  APPROVE: "✓",
  REQUEST_CHANGES: "✖",
  COMMENT: "◆",
};

/** Text/background pair per verdict, in the dashboard's token palette. */
export function verdictTone(verdict: ReviewVerdict | null): { color: string; soft: string } {
  if (verdict === "APPROVE") return { color: "#1a8a3e", soft: "#e7f4ea" };
  if (verdict === "REQUEST_CHANGES") return { color: "#c62828", soft: "#fbeaea" };
  if (verdict === "COMMENT") return { color: "#b07d1f", soft: "#fdf3dd" };
  return { color: "#8b8b95", soft: "#efeff3" };
}

export async function patchFlow(
  id: string,
  body: { action: FlowAction; mode?: "auto" | "manual"; rounds?: number; note?: string },
): Promise<string | null> {
  try {
    const res = await fetch(`/api/flows/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return null;
    const json = (await res.json().catch(() => null)) as { error?: string } | null;
    return json?.error ?? translate(getLocale(), "flowModel.failed", { status: res.status });
  } catch {
    return translate(getLocale(), "common.serverUnavailable");
  }
}
