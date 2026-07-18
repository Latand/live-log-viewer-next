import { useMemo, useSyncExternalStore } from "react";

import { getLocale, type Locale, type MessageKey, type TFunction, translate } from "@/lib/i18n";
import type { Flow, FlowAction, FlowRoleKey, FlowState, ReviewVerdict, RoleConfig, Round } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";
import { currentConversationFile, withoutArchivedPredecessors } from "@/lib/accounts/identity";

import { isConversation } from "@/components/projectModel";
import { formatRateLimitTime } from "@/components/rateLimit";

/** Fired after any successful flow PATCH so pollers refresh immediately. */
export const FLOWS_CHANGED_EVENT = "llv:flows-changed";

/*
 * Flows closed in this tab but possibly not yet reflected by the /api/files
 * poll (10 s cadence). The close click must clear the reviewer side of the
 * scheme instantly, so consumers overlay this set on the polled flows via
 * useEffectiveFlows. Entries become redundant once the server confirms; the
 * set stays tiny (ids of flows closed this session).
 */
const locallyClosed = new Set<string>();
let locallyClosedSnapshot: ReadonlySet<string> = locallyClosed;
const closeListeners = new Set<() => void>();

function markFlowClosedLocally(id: string): void {
  if (locallyClosed.has(id)) return;
  locallyClosed.add(id);
  locallyClosedSnapshot = new Set(locallyClosed);
  for (const listener of closeListeners) listener();
}

function subscribeLocallyClosed(listener: () => void): () => void {
  closeListeners.add(listener);
  return () => closeListeners.delete(listener);
}

const locallyClosedServerSnapshot: ReadonlySet<string> = new Set();

/**
 * The polled flows with this tab's optimistic closes applied: a flow closed
 * here renders as closed the moment the X is clicked, and the poll catches
 * up later. The overlay maps the flow's state to closed while keeping the
 * flow in the list, so reviewer transcripts stay claimed by their rounds and
 * never resurface as standalone nodes.
 */
export function useEffectiveFlows(flows: Flow[]): Flow[] {
  const closed = useSyncExternalStore(
    subscribeLocallyClosed,
    () => locallyClosedSnapshot,
    () => locallyClosedServerSnapshot,
  );
  return useMemo(() => {
    if (!flows.some((flow) => closed.has(flow.id) && flow.state !== "closed")) return flows;
    return flows.map((flow) =>
      closed.has(flow.id) && flow.state !== "closed"
        ? { ...flow, state: "closed" as FlowState, closedAt: flow.closedAt ?? new Date().toISOString() }
        : flow,
    );
  }, [flows, closed]);
}

/** Flows that still occupy their implementer's node on the scheme. */
export function isActiveFlow(flow: Flow): boolean {
  return flow.state !== "closed" || flow.restored === true;
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
export function claimedReviewerPaths(flows: Flow[], files: readonly FileEntry[] = []): Set<string> {
  const set = new Set<string>();
  for (const flow of flows) {
    for (const round of flow.rounds) {
      for (const { path } of reviewerBindingTargetsForRound(flow, round, files)) set.add(path);
    }
  }
  return set;
}

/** Resolve the current transcript generation for a durable review round. */
export function reviewerFileForRound(flow: Flow, round: Round, files: readonly FileEntry[]): FileEntry | null {
  if (round.reviewerBindingId) {
    const currentSlot = `reviewer:${round.n}:${round.reviewerBindingId}`;
    const byBinding = withoutArchivedPredecessors([...files]).find((file) => file.durableLineage?.memberships.some((membership) =>
      membership.kind === "flow"
      && membership.containerId === flow.id
      && membership.role === "reviewer"
      && membership.round === round.n
      && membership.slot === currentSlot
    ));
    if (byBinding) {
      return byBinding.conversationId ? (currentConversationFile(files, byBinding.conversationId) ?? byBinding) : byBinding;
    }
  }
  if (round.reviewerConversationId) {
    const byConversation = currentConversationFile(files, round.reviewerConversationId);
    if (byConversation) return byConversation;
  }
  const byMembership = withoutArchivedPredecessors([...files]).find((file) => file.durableLineage?.memberships.some((membership) =>
    membership.kind === "flow"
    && membership.containerId === flow.id
    && membership.role === "reviewer"
    && membership.round === round.n
  ));
  if (byMembership) return byMembership;
  const byPath = round.reviewerPath ? (files.find((file) => file.path === round.reviewerPath) ?? null) : null;
  return byPath?.conversationId ? (currentConversationFile(files, byPath.conversationId) ?? byPath) : byPath;
}

/** Resolve every durable reviewer binding for one logical round, current last. */
export function reviewerFilesForRound(flow: Flow, round: Round, files: readonly FileEntry[]): FileEntry[] {
  const visibleFiles = withoutArchivedPredecessors([...files]);
  const current = reviewerFileForRound(flow, round, files);
  const history = visibleFiles.filter((file) => file.durableLineage?.memberships.some((membership) =>
    membership.kind === "flow"
    && membership.containerId === flow.id
    && membership.role === "reviewer"
    && membership.round === round.n
  )).filter((file) => file !== current);
  return current ? [...history, current] : history;
}

export type ReviewerBindingTarget = {
  path: string;
  conversationId: string | null;
};

/**
 * Every navigable transcript bound to one logical review round. Durable
 * membership slots survive same-round retries, while conversation identity
 * folds archived generations into their current path. The active binding is
 * always last so compact history keeps a stable chronological tail.
 */
export function reviewerBindingTargetsForRound(
  flow: Flow,
  round: Round,
  files: readonly FileEntry[] = [],
): ReviewerBindingTarget[] {
  const resolved = reviewerFilesForRound(flow, round, files);
  const targets = resolved.map((file) => ({ path: file.path, conversationId: file.conversationId ?? null }));
  const seen = new Set(targets.map((target) => target.path));
  if (!round.reviewerPath || seen.has(round.reviewerPath)) return targets;

  const pathFile = files.find((file) => file.path === round.reviewerPath) ?? null;
  const current = reviewerFileForRound(flow, round, files);
  const currentReplacedPath = Boolean(
    current
    && current.path !== round.reviewerPath
    && current.conversationId
    && (
      current.conversationId === round.reviewerConversationId
      || current.conversationId === pathFile?.conversationId
    ),
  );
  if (currentReplacedPath) return targets;

  targets.push({
    path: round.reviewerPath,
    conversationId: round.reviewerConversationId ?? pathFile?.conversationId ?? null,
  });
  return targets;
}

/**
 * Descendants spawned by folded reviewer sessions should remain expanded on
 * the scheme. The reviewer card itself lives in the round deck; its children
 * still carry real conversation structure below the implementer.
 */
export function claimedReviewerDescendantPaths(files: FileEntry[], flows: Flow[]): Set<string> {
  const claimed = claimedReviewerPaths(flows, files);
  for (const file of files) {
    if (file.durableLineage?.role === "reviewer" || file.durableLineage?.memberships.some((membership) => membership.kind === "flow" && membership.role === "reviewer")) {
      claimed.add(file.path);
    }
  }
  const children = new Map<string, FileEntry[]>();
  for (const file of files) {
    if (!file.parent) continue;
    const list = children.get(file.parent);
    if (list) list.push(file);
    else children.set(file.parent, [file]);
  }
  const out = new Set<string>();
  const stack = [...claimed];
  const seen = new Set(stack);
  while (stack.length) {
    const parent = stack.pop()!;
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.path)) continue;
      seen.add(child.path);
      out.add(child.path);
      stack.push(child.path);
    }
  }
  return out;
}

/**
 * Reviewer sessions are folded into the flow strip (see claimedReviewerPaths),
 * so they are dropped from the board. But a reviewer often spawns its own
 * subtasks; with the reviewer gone from the file set those children lose their
 * on-board parent and `rootOf` promotes each to a detached top-level node. Drop
 * the reviewer itself and re-home its direct children onto the flow's
 * implementer — a node that stays visible — so the subtasks render as connected
 * children of the flow instead of floating loose.
 *
 * Explicitly-opened and authorship-protected reviewers that have no round deck
 * are recovered separately by `protectedReviewerNodes` and materialized as
 * standalone nodes (issue #112), so folding here stays unconditional.
 */
export function foldClaimedReviewers(files: FileEntry[], flows: Flow[]): FileEntry[] {
  const anchorByReviewer = new Map<string, string>();
  for (const flow of flows) {
    for (const round of flow.rounds) {
      if (round.reviewerPath) anchorByReviewer.set(round.reviewerPath, flow.implementerPath);
    }
  }
  const pathByConversationId = new Map(withoutArchivedPredecessors(files).flatMap((file) =>
    file.conversationId ? [[file.conversationId, file.path] as const] : []));
  for (const file of files) {
    const membership = file.durableLineage?.memberships.find((candidate) => candidate.kind === "flow" && candidate.role === "reviewer");
    if (!membership) continue;
    const flow = flows.find((candidate) => candidate.id === membership.containerId);
    const reviewedPath = file.durableLineage?.reviewsConversationId
      ? pathByConversationId.get(file.durableLineage.reviewsConversationId)
      : undefined;
    const anchor = reviewedPath ?? file.parent ?? flow?.implementerPath;
    if (anchor) anchorByReviewer.set(file.path, anchor);
  }
  if (!anchorByReviewer.size) return files;
  const out: FileEntry[] = [];
  for (const file of files) {
    if (anchorByReviewer.has(file.path)) continue; // the reviewer stays folded in the flow strip
    const anchor = file.parent ? anchorByReviewer.get(file.parent) : undefined;
    out.push(anchor ? { ...file, parent: anchor } : file);
  }
  return out;
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

/** The one action the current state is waiting on, rendered prominent on the
    strip and in the loop hub's controls. */
export const PENDING_ACTIONS: Partial<Record<FlowState, { labelKey: MessageKey; action: FlowAction }>> = {
  waiting_ready: { labelKey: "flowStrip.startReview", action: "advance" },
  spawn_pending: { labelKey: "flowStrip.spawnReviewer", action: "advance" },
  relay_pending: { labelKey: "flowStrip.relayNotes", action: "advance" },
  needs_decision: { labelKey: "flowStrip.retryRound", action: "retry-round" },
  done_comment: { labelKey: "flowStrip.anotherRound", action: "another-round" },
};

export function flowPresentation(t: TFunction, flow: Flow, locale: Locale) {
  if (flow.block?.reason === "rate_limited") {
    return {
      label: t("flowState.blocked_rate_limited"),
      detail: flow.block.resetAt
        ? t("flowState.rate_limit_until", { time: formatRateLimitTime(flow.block.resetAt, locale) })
        : t("flowState.rate_limit_wait"),
      attention: true,
      pending: null,
    };
  }
  return {
    label: stateLabel(t, flow.state),
    detail: flow.stateDetail,
    attention: ATTENTION_STATES.has(flow.state),
    pending: PENDING_ACTIONS[flow.state] ?? null,
  };
}

/** The loop side working right now — drives the role tags on the scheme. */
export function activeLoopRole(flow: Flow): FlowRoleKey | null {
  if (flow.block) return null;
  if (flow.state === "spawning" || flow.state === "reviewing") return "reviewer";
  if (flow.state === "waiting_ready" || flow.state === "relaying" || flow.state === "fixing") return "implementer";
  return null;
}

/** The cycle leg traffic is on: forward = implementer → reviewer. */
export function activeLoopLeg(flow: Flow): "forward" | "back" | null {
  if (flow.block) return null;
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
  if (verdict === "APPROVE") return { color: "var(--color-success)", soft: "var(--color-success-soft)" };
  if (verdict === "REQUEST_CHANGES") return { color: "var(--color-danger)", soft: "var(--color-danger-soft)" };
  if (verdict === "COMMENT") return { color: "var(--color-warning)", soft: "var(--color-warning-soft)" };
  return { color: "var(--color-muted)", soft: "var(--color-sunken)" };
}

export async function patchFlow(
  id: string,
  body: {
    action: FlowAction;
    mode?: "auto" | "manual";
    rounds?: number;
    note?: string;
    roles?: { reviewer?: Partial<RoleConfig> };
  },
): Promise<string | null> {
  try {
    const res = await fetch(`/api/flows/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      /* A close clears the reviewer side optimistically; every mutation asks
         the poller to refresh now instead of waiting out its interval. */
      if (body.action === "close") markFlowClosedLocally(id);
      window.dispatchEvent(new Event(FLOWS_CHANGED_EVENT));
      return null;
    }
    const json = (await res.json().catch(() => null)) as { error?: string } | null;
    return json?.error ?? translate(getLocale(), "flowModel.failed", { status: res.status });
  } catch {
    return translate(getLocale(), "common.serverUnavailable");
  }
}
