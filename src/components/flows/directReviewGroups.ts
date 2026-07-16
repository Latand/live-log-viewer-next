import type { Flow, Round } from "@/lib/flows/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";
import { canonicalizeConversationId, currentConversationFile, withoutArchivedPredecessors } from "@/lib/accounts/identity";

import { projectKey } from "@/components/projectModel";

import { claimedReviewerPaths, isActiveFlow } from "./flowModel";

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
 * Grouping identity, in the issue's precedence order:
 *   1. a shared board task, resolved from the reviewer's own assignment first
 *      and the reviewed conversation's assignment second;
 *   2. the alias-resolved `reviewsConversationId` review subject;
 *   3. managed flow/pipeline ownership stays with #112's machinery — any
 *      conversation carrying a container membership (or claimed by a real
 *      flow round) never enters this projection.
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

/** Newest matching assignment timestamp for a conversation across a task. */
function assignmentAt(task: BoardTask, conversationId: string, path: string | null): string | null {
  let newest: string | null = null;
  for (const assignment of task.assignments) {
    const matches = assignment.conversationId === conversationId || (path !== null && assignment.path === path);
    if (!matches) continue;
    if (newest === null || assignment.at > newest) newest = assignment.at;
  }
  return newest;
}

export function directReviewFlows(input: DirectReviewGroupsInput): Flow[] {
  const aliases = input.conversationAliases ?? {};
  const canonical = (id: string) => canonicalizeConversationId(id, aliases);
  const visible = withoutArchivedPredecessors([...input.files]);
  const claimed = claimedReviewerPaths([...input.flows]);
  const tasks = input.tasks ?? [];

  /* The board task owning a conversation: the task with the NEWEST matching
     assignment wins, so a re-assigned conversation follows its latest task. */
  const taskFor = (conversationId: string | null, path: string | null): BoardTask | null => {
    if (!conversationId && !path) return null;
    let best: BoardTask | null = null;
    let bestAt = "";
    for (const task of tasks) {
      const at = assignmentAt(task, conversationId ?? "", path);
      if (at === null) continue;
      if (best === null || at > bestAt || (at === bestAt && task.updatedAt > best.updatedAt)) {
        best = task;
        bestAt = at;
      }
    }
    return best;
  };

  interface Candidate {
    file: FileEntry;
    reviewedId: string;
  }
  const groups = new Map<string, Candidate[]>();
  for (const file of visible) {
    const lineage = file.durableLineage;
    if (!lineage || lineage.role !== "reviewer" || !lineage.reviewsConversationId) continue;
    /* Managed ownership wins (#112): container members and round-claimed paths
       stay with their flow/pipeline projection. */
    if (lineage.memberships.length || claimed.has(file.path)) continue;
    const reviewedId = canonical(lineage.reviewsConversationId);
    const reviewerId = file.conversationId ? canonical(file.conversationId) : null;
    if (reviewerId !== null && reviewerId === reviewedId) continue; // degenerate self-review edge
    const owner = taskFor(reviewerId, file.path) ?? taskFor(reviewedId, null);
    const key = owner ? `task::${owner.id}` : `subject::${reviewedId}`;
    const list = groups.get(key);
    const candidate: Candidate = { file, reviewedId };
    if (list) list.push(candidate);
    else groups.set(key, [candidate]);
  }

  const out: Flow[] = [];
  for (const [key, members] of groups) {
    /* Round order is transcript age: terminal history first, the freshest —
       the actionable round — last, exactly where the deck's front card looks. */
    members.sort((a, b) => a.file.mtime - b.file.mtime || (a.file.path < b.file.path ? -1 : 1));
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
      const isLatest = index === members.length - 1;
      const outcome = file.review ?? null;
      /* A verdict-less reviewer that stopped working failed before its verdict.
         Only history rounds take the aborted read — the latest one stays the
         actionable front card whatever its state. */
      const failed = !outcome && !isLatest && !reviewerStillWorking(file);
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
