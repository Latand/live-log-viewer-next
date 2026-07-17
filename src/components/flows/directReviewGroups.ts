import type { Flow, Round } from "@/lib/flows/types";
import { groupDirectReviewers } from "@/lib/flows/directReviewGrouping";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { currentConversationFile, withoutArchivedPredecessors } from "@/lib/accounts/identity";

import { projectKey } from "@/components/projectModel";

import { isActiveFlow } from "./flowModel";

/*
 * Direct one-shot review groups (issue #325).
 *
 * Viewer-managed reviewers spawned straight through /api/spawn carry a durable
 * `role=reviewer` edge plus `reviewsConversationId`, but no flow or pipeline
 * membership. Repeated rounds for one board task or review subject used to land
 * as separate full-size cards; this module projects them into SYNTHETIC
 * review-loop flows so the entire existing deck grammar — folding, round
 * spines, verdict chips, loop placement, worker-collapse, mobile deck chips,
 * minimap rects — applies unchanged.
 *
 * Group membership and round order come from the shared grouping core in
 * lib/flows/directReviewGrouping (task first, alias-resolved review subject
 * second, managed flow/pipeline ownership excluded) — the same core the
 * server's role-title projection numbers review rounds with, so a deck spine
 * and its card title can never disagree.
 *
 * The projection is a pure function of the scan + tasks + alias map, so
 * restart, migration, generation changes and project relocation follow the
 * durable registry data with no stored state of their own.
 */

/** Synthetic flow id namespace. These flows exist only in the client read
    model: no /api/flows PATCH may ever target them, so every action surface
    (FlowStrip, FlowHub, group-override halos) is gated on this predicate. */
export const DIRECT_REVIEW_FLOW_PREFIX = "direct-review::";

export function isDirectReviewFlow(flow: Pick<Flow, "id">): boolean {
  return flow.id.startsWith(DIRECT_REVIEW_FLOW_PREFIX);
}

/**
 * Split direct review groups into the ones that still carry an actionable
 * latest round (they place a deck + loop beside the reviewed conversation)
 * and terminal HISTORY groups — every round ended with a verdict or a
 * failure. A history group renders NO deck at all: its reviewers fold into a
 * compact per-group worker stack (the terminal review-history stack), leaving
 * the board layout and minimap until one is explicitly expanded. Both halves
 * keep claiming their reviewers, so a folded round never resurfaces as a
 * standalone card.
 */
export function splitDirectReviewGroups(groups: readonly Flow[]): { active: Flow[]; history: Flow[] } {
  const active: Flow[] = [];
  const history: Flow[] = [];
  for (const group of groups) (group.state === "reviewing" ? active : history).push(group);
  return { active, history };
}

export interface DirectReviewGroupsInput {
  files: readonly FileEntry[];
  /** Real (server) flows — used only to exclude reviewers they already claim. */
  flows: readonly Flow[];
  tasks?: readonly BoardTask[];
  /** Durable registry alias map (old id → canonical id). */
  conversationAliases?: Readonly<Record<string, string>>;
}

/** An activity read that must not mislabel a still-working reviewer as failed:
    anything live, mid-turn, or waiting on input is not terminal. */
function reviewerStillWorking(file: FileEntry): boolean {
  return (
    file.activity === "live"
    || file.activity === "stalled"
    || file.proc === "running"
    || Boolean(file.pendingQuestion)
    || Boolean(file.waitingInput)
  );
}

export function directReviewFlows(input: DirectReviewGroupsInput): Flow[] {
  const visible = withoutArchivedPredecessors([...input.files]);
  const groups = groupDirectReviewers(input);

  const out: Flow[] = [];
  for (const { key, members } of groups) {
    const latest = members[members.length - 1]!;
    /* The deck anchors beside the reviewed conversation of the newest round,
       at its CURRENT generation. No anchor in the scan → nothing to attach the
       deck to; the reviewers keep today's worker-stack behavior. */
    const anchor = currentConversationFile(visible, latest.reviewedId);
    if (!anchor) continue;
    /* Existing flow ownership wins (#112): one node hosts one deck, and an
       active managed loop on the reviewed conversation must keep its deck and
       controls. The direct reviewers then keep today's worker-stack behavior. */
    if (input.flows.some((flow) => isActiveFlow(flow) && flow.implementerPath === anchor.path)) continue;
    const rounds = members.map<Round>((member, index) => {
      const { file } = member;
      const outcome = file.review ?? null;
      /* A verdict-less reviewer that stopped working failed before its verdict —
         the LATEST round included (production regression on 66ef346): a
         days-old stopped reviewer parks its group as compact history, keeping
         quiet reviewed anchors off the board. Anything live, mid-turn, or
         waiting on input stays the actionable front card. */
      const failed = !outcome && !reviewerStillWorking(file);
      return {
        n: index + 1,
        reviewerPath: file.path,
        reviewerConversationId: file.conversationId ?? null,
        findingsPath: null,
        triggeredBy: "button",
        readyNote: null,
        verdict: outcome?.verdict ?? null,
        findingsCount: outcome?.findingsCount ?? null,
        startedAt: new Date(file.mtime * 1000).toISOString(),
        reviewedAt: outcome?.observedAt ?? null,
        terminalAt: outcome?.observedAt ?? null,
        relayedAt: null,
        error: failed ? "no verdict" : null,
      };
    });
    const last = rounds[rounds.length - 1]!;
    const reviewerRole = {
      engine: (latest.file.engine === "codex" ? "codex" : "claude") as "claude" | "codex",
      model: latest.file.model,
      effort: latest.file.effort ?? null,
    };
    out.push({
      id: DIRECT_REVIEW_FLOW_PREFIX + key,
      template: "implement-review-loop",
      project: projectKey(anchor),
      cwd: anchor.cwd ?? "",
      implementerPath: anchor.path,
      implementerConversationId: anchor.conversationId ?? null,
      roles: {
        implementer: { engine: (anchor.engine === "codex" ? "codex" : "claude") as "claude" | "codex", model: anchor.model, effort: anchor.effort ?? null },
        reviewer: reviewerRole,
      },
      baseRef: "",
      baseMode: "head",
      mode: "manual",
      /* Pane semantics keep the front card's composer usable on a still-open
         reviewer; finished rounds drop it via the deck's own `finished` gate. */
      reviewerMode: "pane",
      roundLimit: 0,
      /* An unfinished latest round is the actionable loop; an all-terminal
         group parks as compact history and never forces its reviewed
         conversation onto the board (see ProjectDashboard's expansion gate). */
      state: last.verdict === null && last.error === null ? "reviewing" : "done_comment",
      stateDetail: null,
      rounds,
      createdAt: rounds[0]!.startedAt,
      closedAt: null,
    });
  }
  /* Deterministic output order: stable group key. */
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}
