import type { Flow, Round } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { activityBand, isChildConversation, kidsIndex, projectKey, subtree } from "@/components/projectModel";

/*
 * Worker-class auto-collapse (issue #112).
 *
 * Orchestration sessions breed dozens of short-lived worker conversations —
 * flow implementers, headless reviewer rounds, pipeline stages, agent-spawned
 * subtasks. Each is only interesting while its round is active; once it goes
 * quiet it should fold into a compact per-flow / per-worktree stack instead of
 * holding a full board node.
 *
 * This module is the pure decision layer: given the scanned files, the flow /
 * pipeline lineage, and the durable pin set, it classifies each conversation
 * and derives the stacks the board renders. It writes nothing — the collapsed
 * placement is a deterministic function of the scan, so it survives reloads and
 * redeploys with no stored "collapsed" flag; the only durable state is the
 * user's manual-expand pin, carried by the board store's existing membership
 * lists (`expanded` / `manual`).
 */

export type WorkerClass = "flow-reviewer" | "flow-implementer" | "pipeline-stage" | "spawned-worker" | "spawned-descendant";

/** Default inactivity window before a non-reviewer worker collapses (issue
    #112 asks for ~15 minutes, configurable). Reviewer rounds ignore this and
    collapse the instant their round reaches a verdict. */
export const DEFAULT_WORKER_COLLAPSE_IDLE_MS = 15 * 60 * 1000;

/**
 * Operator-tunable idle window. `NEXT_PUBLIC_*` is inlined into the client
 * bundle by Next, so the threshold can be retuned without touching this code; a
 * missing or malformed value falls back to the 15-minute default.
 */
export function workerCollapseIdleMs(): number {
  const raw = typeof process !== "undefined" ? process.env?.NEXT_PUBLIC_LLV_WORKER_COLLAPSE_MINUTES : undefined;
  const minutes = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : DEFAULT_WORKER_COLLAPSE_IDLE_MS;
}

/** Transcript paths owned by a pipeline stage attempt — pipeline-stage workers. */
export function pipelineStageAgentPaths(pipelines: readonly Pipeline[]): Set<string> {
  const set = new Set<string>();
  for (const pipeline of pipelines) {
    for (const run of pipeline.runs) {
      for (const attempt of run.attempts) {
        if (attempt.agentPath) set.add(attempt.agentPath);
      }
    }
  }
  return set;
}

export interface WorkerLineage {
  flows: readonly Flow[];
  /** Output of {@link pipelineStageAgentPaths} — computed once per render. */
  pipelineStagePaths: ReadonlySet<string>;
}

interface FlowMembership {
  role: "reviewer" | "implementer";
  flow: Flow;
  round: Round | null;
}

/**
 * Flow role of a transcript, derived from the FLOWS list by matching paths —
 * never from a `file.flow` annotation. `/api/files` serializes raw scanner
 * entries and does NOT run `annotateFlowEntries` (only the flow-engine tick
 * does), so `file.flow` is absent on the board's files and cannot be trusted;
 * matching `flow.implementerPath` / `round.reviewerPath` is the same resolution
 * the rest of the board already uses (flowByImplementer, claimedReviewerPaths).
 * A reviewer match wins over an implementer match.
 */
function flowMembership(file: FileEntry, flows: readonly Flow[]): FlowMembership | null {
  for (const flow of flows) {
    for (const round of flow.rounds) {
      if (round.reviewerPath === file.path) return { role: "reviewer", flow, round };
    }
  }
  for (const flow of flows) {
    if (flow.implementerPath === file.path) return { role: "implementer", flow, round: null };
  }
  return null;
}

/**
 * Worker lineage of a conversation, or null for an owner-started root. Order
 * matters: a reviewer is unambiguous automation (the flow engine spawns it),
 * then a flow implementer — but ONLY when it was itself spawned by an agent
 * (`file.parent` set). A parentless flow implementer is a top-level conversation
 * the OWNER created and then started a flow on; the issue keeps "root
 * conversations the owner started" out of scope, and this is also the safe side
 * of the authorship discount — an owner's first composer prompt can be discounted
 * as an automated launch, so topology, not message-counting, decides ownership
 * here. Then pipeline stage ownership, then generic spawned lineage.
 *
 * A HANDOFF is never a worker: it is the owner continuing a conversation from
 * the composer (agents spawn through the spawn API, not the handoff flow). Its
 * first composer prompt is the owner's, yet the generic worker-launch allowance
 * would discount it — so, as with a parentless implementer, topology (the
 * `handoff` flag) decides ownership rather than the fragile message count.
 *
 * FAIL TOWARD COLLAPSED (issue #136): the precise classes above miss workers
 * whenever the flow/pipeline attachment can't be resolved by path (a migrated or
 * renamed transcript, a stale flows list, a spawned claude *main* session the
 * `isChildConversation` kinds don't cover). The operator's board floods with
 * exactly those finished-but-uncollapsed cards. So any conversation that was
 * spawned *under something* — it carries a `parent` — is worker-class by
 * default: a `spawned-descendant`. This never overrides the owner exemption
 * (isCollapseExempt still pins user-authored / live / pinned cards) and never
 * touches a parentless root (owner-started conversations stay out of scope), but
 * it means a classification miss now folds the card instead of leaving it as a
 * full node.
 */
export function classifyWorker(file: FileEntry, lineage: WorkerLineage): WorkerClass | null {
  if (file.handoff) return null;
  const membership = flowMembership(file, lineage.flows);
  if (membership?.role === "reviewer") return "flow-reviewer";
  if (membership?.role === "implementer") return file.parent ? "flow-implementer" : null;
  if (lineage.pipelineStagePaths.has(file.path)) return "pipeline-stage";
  if (isChildConversation(file)) return "spawned-worker";
  return file.parent ? "spawned-descendant" : null;
}

/** A reviewer round is finished the moment it reaches a verdict or a terminal
    error — the point the issue's owner comment marks for immediate collapse. */
export function reviewerRoundFinished(round: Round): boolean {
  return round.verdict !== null || round.reviewedAt !== null || round.error !== null || Boolean(round.terminalAt);
}

export interface CollapseContext extends WorkerLineage {
  nowMs: number;
  idleMs: number;
  /** Paths the user manually placed/expanded — a durable pin against collapse. */
  pinnedPaths: ReadonlySet<string>;
}

/**
 * Hard exemptions (issue #112): a conversation that must never auto-collapse
 * regardless of idle time. Owner attention (a human-authored message), any live
 * or mid-turn work, an in-flight account migration, and an explicit manual
 * placement each pin the card. These mirror the reaper's protection reasons so
 * the board and the process side never disagree about what is "just a worker".
 */
export function isCollapseExempt(file: FileEntry, context: CollapseContext): boolean {
  if (file.userAuthored) return true;
  /* Fail closed on unconfirmed authorship: the reaper has not scanned this
     transcript since its latest write, so we cannot yet rule out an owner
     message. Treat it as pinned until a cycle clears it (issue #112). */
  if (file.authorshipUnverified) return true;
  if (file.activity === "live" || file.activity === "stalled") return true;
  if (file.proc === "running") return true;
  if (file.pendingQuestion || file.waitingInput) return true;
  if (file.migration && file.migration.phase !== "committed" && file.migration.phase !== "rolled-back") return true;
  if (context.pinnedPaths.has(file.path)) return true;
  return false;
}

/**
 * Whether a single worker-class conversation should fold into a stack now.
 * Reviewer rounds collapse immediately on verdict; every other worker waits out
 * the idle window. Owner-touched / live / pinned conversations never collapse.
 */
export function shouldCollapseWorker(file: FileEntry, context: CollapseContext): boolean {
  const klass = classifyWorker(file, context);
  if (!klass) return false;
  if (isCollapseExempt(file, context)) return false;
  const membership = flowMembership(file, context.flows);
  if (klass === "flow-reviewer") {
    /* Reviewers collapse exactly on verdict, never on the idle window: a
       still-reviewing round stays put (it is the live loop), and a finished
       round folds immediately. */
    return Boolean(membership?.round && reviewerRoundFinished(membership.round));
  }
  if (klass === "flow-implementer") {
    /* The implementer anchors its flow on the board. While the flow is open —
       spawning, reviewing, or awaiting the owner's decision — it must stay
       expanded even if its own transcript is momentarily idle. Only a closed
       flow's implementer is a candidate, and then only past the idle window. */
    if (!membership || membership.flow.state !== "closed") return false;
  }
  return context.nowMs - file.mtime * 1000 >= context.idleMs;
}

export interface WorkerStack {
  /** Stable board key, usable as a camera/flash target and a React key. */
  key: string;
  /** One stack per ORIGIN (issue #136): the flow, pipeline, or spawner a worker
      belongs to — never per worker kind. `worktree` is the last-resort bucket for
      a spawnerless worker (no resolvable parent). */
  kind: "flow" | "pipeline" | "origin" | "worktree";
  /** Flow id / pipeline id / spawner (root-ancestor) path / worktree name. */
  id: string;
  /** Collapse-eligible worker conversations, freshest first. */
  items: FileEntry[];
}

/** Flow id owning a transcript, derived from the flows list by path (a flow
    member groups per flow, everything else per worktree). Uses the same
    path-matching as classification — never the absent `file.flow`. */
export function flowIdForPath(file: FileEntry, flows: readonly Flow[]): string | null {
  return flowMembership(file, flows)?.flow.id ?? null;
}

/** Transcript path → the id of the pipeline that owns it, so a pipeline's stage
    workers fold into ONE chip (issue #136). A stage's own `agentPath` is owned;
    for a review-loop stage the embedded flow's implementer + reviewer paths are
    owned too, otherwise the flow bucket would split them off into a second stack
    (a build stage in the pipeline stack, its reviewer in a flow stack). */
export function pipelineStagePipelineIds(pipelines: readonly Pipeline[], flows: readonly Flow[] = []): Map<string, string> {
  const flowById = new Map(flows.map((flow) => [flow.id, flow] as const));
  const map = new Map<string, string>();
  for (const pipeline of pipelines) {
    for (const run of pipeline.runs) {
      for (const attempt of run.attempts) {
        if (attempt.agentPath && !map.has(attempt.agentPath)) map.set(attempt.agentPath, pipeline.id);
        if (attempt.flowId) {
          const flow = flowById.get(attempt.flowId);
          if (flow) {
            if (!map.has(flow.implementerPath)) map.set(flow.implementerPath, pipeline.id);
            for (const round of flow.rounds) {
              if (round.reviewerPath && !map.has(round.reviewerPath)) map.set(round.reviewerPath, pipeline.id);
            }
          }
        }
      }
    }
  }
  return map;
}

/**
 * The pipeline a worker belongs to, resolved through its ANCESTOR chain (issue
 * #136). A pipeline records ownership only for each stage attempt's `agentPath`;
 * a conversation that stage spawns has its own path, so a path-only lookup would
 * miss it and split it into a separate origin stack while the stage stays in the
 * pipeline stack — one pipeline reading as two chips. Walking up `parent` to the
 * nearest pipeline-owned ancestor keeps the whole subtree in one pipeline stack.
 */
export function pipelineOriginOf(
  file: FileEntry,
  filesByPath: ReadonlyMap<string, FileEntry>,
  pipelineIds: ReadonlyMap<string, string>,
): string | null {
  let cursor: FileEntry | undefined = file;
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor.path)) {
    const id = pipelineIds.get(cursor.path);
    if (id) return id;
    seen.add(cursor.path);
    cursor = cursor.parent ? filesByPath.get(cursor.parent) : undefined;
  }
  return null;
}

/** Resolvers that place a worker under its origin (issue #136). Both are pure
    path lookups computed once per render by the caller from the full file set /
    pipeline list, so grouping stays a deterministic function of the scan. */
export interface StackOriginResolvers {
  /** Pipeline id owning a stage attempt on this path, if any. */
  pipelineIdOf?: (path: string) => string | null;
  /** The spawner: the root-ancestor conversation path a worker descends from
      (walked through `file.parent`), or null when it has no in-scope ancestor. */
  originOf?: (file: FileEntry) => string | null;
}

export interface ProtectedReviewerNodesInput {
  files: readonly FileEntry[];
  flows: readonly Flow[];
  /** Paths the scheme actually PLACES as nodes (visible group columns, manual
      nodes, ephemeral-revealed nodes) — hidden group columns already excluded by
      the caller. Both skips an already-drawn reviewer and decides whether a
      flow's implementer is placed (hence renders a round deck). */
  renderedNodePaths: ReadonlySet<string>;
  /** Closed/tombstoned paths — a manual close still wins over materialization. */
  hiddenPaths: ReadonlySet<string>;
  /** Durable manual placements/expansions — a reviewer the owner opened out of a
      worker stack must render even though it carries no authorship protection. */
  pinnedPaths: ReadonlySet<string>;
}

/**
 * Reviewer transcripts that must be materialized as standalone board nodes
 * because their owning flow has NO rendered round deck (issue #112).
 *
 * A reviewer the owner must keep — one carrying authorship protection (a real
 * user message, or unconfirmed authorship that fails closed) OR one the owner
 * explicitly opened out of a worker stack (a durable pin) — must never vanish.
 * An active flow normally renders it in its round deck, but a deck exists ONLY
 * when the flow's implementer is itself a PLACED node. The dashboard may hide or
 * leave the implementer unplaced (a closed flow never has a deck at all),
 * leaving the reviewer with no deck, excluded from worker stacks, and filtered
 * from the switchboard (a claimed reviewer). Deck presence is therefore read
 * from `renderedNodePaths` — the set the caller has already reduced to what is
 * actually drawn, so a hidden-but-ephemerally-revealed implementer counts as
 * decked (its reviewer stays in that deck and is NOT duplicated here), while a
 * hidden-and-unrevealed implementer does not. Reviewers whose deck is absent,
 * that are not already drawn, and are not manually closed are returned for
 * materialization, resolved from the full (unfolded) file set.
 */
export function protectedReviewerNodes(input: ProtectedReviewerNodesInput): FileEntry[] {
  const byPath = new Map(input.files.map((file) => [file.path, file] as const));
  const decked = new Set<string>();
  for (const flow of input.flows) {
    if (flow.state === "closed") continue;
    if (!input.renderedNodePaths.has(flow.implementerPath)) continue;
    for (const round of flow.rounds) if (round.reviewerPath) decked.add(round.reviewerPath);
  }
  const out: FileEntry[] = [];
  const seen = new Set<string>();
  for (const flow of input.flows) {
    for (const round of flow.rounds) {
      const path = round.reviewerPath;
      if (!path || seen.has(path) || decked.has(path)) continue;
      if (input.renderedNodePaths.has(path) || input.hiddenPaths.has(path)) continue;
      const file = byPath.get(path);
      if (file && (file.userAuthored || file.authorshipUnverified || input.pinnedPaths.has(path))) {
        out.push(file);
        seen.add(path);
      }
    }
  }
  return out;
}

function stackKeyFor(
  file: FileEntry,
  flows: readonly Flow[],
  resolvers: StackOriginResolvers = {},
): { key: string; kind: WorkerStack["kind"]; id: string } {
  /* Pipeline ownership wins over the flow bucket (issue #136): a pipeline that
     embeds a review-loop owns that flow's implementer + reviewers, so a whole
     architect→builder→review pipeline is ONE stack instead of splitting into a
     pipeline stack (architect) plus a flow stack (builder/reviewer). The
     resolver covers pipeline-owned paths AND their ancestors. */
  const pipelineId = resolvers.pipelineIdOf?.(file.path) ?? null;
  if (pipelineId) return { key: "wstack::pipeline::" + pipelineId, kind: "pipeline", id: pipelineId };
  const flowId = flowIdForPath(file, flows);
  if (flowId) return { key: "wstack::flow::" + flowId, kind: "flow", id: flowId };
  const origin = resolvers.originOf?.(file) ?? null;
  if (origin) return { key: "wstack::origin::" + origin, kind: "origin", id: origin };
  const worktree = file.worktree ?? "";
  return { key: "wstack::worktree::" + worktree, kind: "worktree", id: worktree };
}

/** Stack-kind ordering: origins that name a running orchestration (flow,
    pipeline) lead, then spawner groups, then the worktree catch-all. */
const STACK_KIND_RANK: Record<WorkerStack["kind"], number> = { flow: 0, pipeline: 1, origin: 2, worktree: 3 };

export interface CollapsibleInput {
  files: readonly FileEntry[];
  project: string;
  flows: readonly Flow[];
  pipelines?: readonly Pipeline[];
  /** Durable manual placements/expansions — pinned against collapse. */
  pinnedPaths: ReadonlySet<string>;
  nowMs: number;
  idleMs?: number;
}

function collapseContext(input: CollapsibleInput): CollapseContext {
  return {
    flows: input.flows,
    pipelineStagePaths: pipelineStageAgentPaths(input.pipelines ?? []),
    nowMs: input.nowMs,
    idleMs: input.idleMs ?? workerCollapseIdleMs(),
    pinnedPaths: input.pinnedPaths,
  };
}

/**
 * The worker conversations of a project that should fold off the board now.
 *
 * A worker is collapsible only when it {@link shouldCollapseWorker} AND nothing
 * in its subtree is exempt — no live/mid-turn descendant, and no owner-authored
 * or pinned one. That subtree guard is the safety net for removing the card
 * from the scheme: folding a parent must never bury a child that is still
 * working or that the owner has touched (the hard exemption applies to the
 * whole subtree, not just the root).
 */
export function collapsibleWorkerFiles(input: CollapsibleInput): FileEntry[] {
  const context = collapseContext(input);
  const kids = kidsIndex(input.files as FileEntry[]);
  const out: FileEntry[] = [];
  for (const file of input.files) {
    if (projectKey(file) !== input.project) continue;
    if (!shouldCollapseWorker(file, context)) continue;
    if (subtree(file, kids).some((descendant) => isCollapseExempt(descendant, context))) continue;
    out.push(file);
  }
  return out;
}

const freshness = (file: FileEntry) => activityBand(file) * 1e13 - file.mtime;

/**
 * Group already-selected collapsible worker files into ONE stack per origin
 * (issue #136): a flow, a pipeline, a spawner (root-ancestor conversation), or —
 * only for a spawnerless worker — its worktree. Flow stacks lead, then pipeline,
 * then spawner, then the worktree catch-all; within each, and between stacks,
 * freshest first. `exclude` drops anything the scheme still draws in a retained
 * form (an active flow's reviewer round deck) so a card never appears twice.
 */
export function groupWorkerStacks(
  files: readonly FileEntry[],
  flows: readonly Flow[],
  exclude: ReadonlySet<string> = new Set(),
  resolvers: StackOriginResolvers = {},
): WorkerStack[] {
  const byKey = new Map<string, WorkerStack>();
  for (const file of files) {
    if (exclude.has(file.path)) continue;
    const { key, kind, id } = stackKeyFor(file, flows, resolvers);
    const stack = byKey.get(key) ?? { key, kind, id, items: [] };
    stack.items.push(file);
    byKey.set(key, stack);
  }
  const stacks = [...byKey.values()];
  for (const stack of stacks) stack.items.sort((a, b) => freshness(a) - freshness(b));
  return stacks.sort((a, b) => {
    if (a.kind !== b.kind) return STACK_KIND_RANK[a.kind] - STACK_KIND_RANK[b.kind];
    return freshness(a.items[0]!) - freshness(b.items[0]!);
  });
}

export interface WorkerStacksInput extends CollapsibleInput {
  /** Conversations already drawn on the scheme (nodes, mini-stack rows, reviewer
      decks): excluded so a card is never rendered in two places at once. */
  renderedPaths: ReadonlySet<string>;
}

/**
 * Convenience composition: the per-flow / per-worktree stacks of every
 * collapse-eligible worker the scheme is not already drawing. Equivalent to
 * grouping {@link collapsibleWorkerFiles} minus `renderedPaths`.
 */
export function computeWorkerStacks(input: WorkerStacksInput): WorkerStack[] {
  return groupWorkerStacks(collapsibleWorkerFiles(input), input.flows, input.renderedPaths);
}
