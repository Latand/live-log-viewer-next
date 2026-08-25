import type { Flow, Round } from "@/lib/flows/types";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";
import { DEFAULT_BOARD_IDLE_COLLAPSE_MINUTES } from "@/lib/board/types";

import { reviewerBindingTargetsForRound } from "@/components/flows/flowModel";
import { activityBand, isChildConversation, projectKey, schemeAgeHorizonSeconds, withinPlacementHorizon } from "@/components/projectModel";
import { IDENTITY_CLAIM_RESOLVER, transcriptClaimResolver, type TranscriptClaimResolver } from "@/components/transcriptClaims";

/*
 * Conversation auto-collapse (issues #112 and #1158).
 *
 * The board keeps active, attention-bearing, delivered-to, cursor-stage, open
 * flow, and operator-pinned conversations expanded. Terminal or expired rows
 * fold into compact origin stacks, including owner roots and reviewers.
 *
 * This module is the pure decision layer: given the scanned files, the flow /
 * pipeline lineage, and the durable pin set, it classifies each conversation
 * and derives the stacks the board renders. It writes nothing — the collapsed
 * placement is a deterministic function of the scan, so it survives reloads and
 * redeploys with no stored "collapsed" flag; the only durable state is the
 * user's pins and idle window, carried by the existing board preference store.
 */

export type WorkerClass = "flow-reviewer" | "flow-implementer" | "pipeline-stage" | "spawned-worker" | "spawned-descendant";

/** Default board inactivity window. Terminal evidence still collapses
    immediately; this window applies only to conversations that have not settled. */
export const DEFAULT_WORKER_COLLAPSE_IDLE_MS = DEFAULT_BOARD_IDLE_COLLAPSE_MINUTES * 60 * 1000;

/**
 * Operator-tunable idle window. `NEXT_PUBLIC_*` is inlined into the client
 * bundle by Next, so the threshold can be retuned without touching this code; a
 * missing or malformed value falls back to the two-hour default.
 */
export function workerCollapseIdleMs(): number {
  const raw = typeof process !== "undefined" ? process.env?.NEXT_PUBLIC_LLV_WORKER_COLLAPSE_MINUTES : undefined;
  const minutes = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : DEFAULT_WORKER_COLLAPSE_IDLE_MS;
}

/** Transcript paths owned by a pipeline stage attempt — pipeline-stage workers.
    An attempt records whatever spelling was current when it ran, so `resolve`
    rewrites it onto the projected corpus before the set is compared against
    `file.path` (#943 follow-up); the default leaves recorded paths untouched. */
export function pipelineStageAgentPaths(
  pipelines: readonly Pipeline[],
  resolve: TranscriptClaimResolver = IDENTITY_CLAIM_RESOLVER,
): Set<string> {
  const set = new Set<string>();
  for (const pipeline of pipelines) {
    for (const run of pipeline.runs) {
      for (const attempt of run.attempts) {
        if (attempt.agentPath) set.add(resolve(attempt.agentPath));
      }
    }
  }
  return set;
}

export interface WorkerLineage {
  flows: readonly Flow[];
  pipelines?: readonly Pipeline[];
  /** Output of {@link pipelineStageAgentPaths} — computed once per render. */
  pipelineStagePaths: ReadonlySet<string>;
  /** Resolves a flow's recorded member paths onto the projected spelling before
      they are matched (#943 follow-up). Built once per render from the file set
      by {@link transcriptClaimResolver}; absent means compare recorded paths raw,
      which is only correct when records and corpus share one spelling. */
  resolveClaimPath?: TranscriptClaimResolver;
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
 *
 * Both sides of that match are canonical (#943 follow-up): a durable record
 * holds the spelling that was current when the round ran, and the projection
 * publishes the root discovery walked, so `resolve` rewrites the recorded path
 * onto the corpus before the comparison. Without it every round of a flow that
 * predates its account's cut-over misses and renders as a free node.
 */
function flowMembership(
  file: FileEntry,
  flows: readonly Flow[],
  resolve: TranscriptClaimResolver = IDENTITY_CLAIM_RESOLVER,
): FlowMembership | null {
  const durable = file.durableLineage?.memberships.find((membership) => membership.kind === "flow");
  if (durable) {
    const flow = flows.find((candidate) => candidate.id === durable.containerId);
    if (flow && durable.role === "reviewer") {
      const round = flow.rounds.find((candidate) => candidate.n === durable.round) ?? null;
      return { role: "reviewer", flow, round };
    }
    if (flow && durable.role === "implementer") return { role: "implementer", flow, round: null };
  }
  for (const flow of flows) {
    for (const round of flow.rounds) {
      if (round.reviewerPath && resolve(round.reviewerPath) === file.path) return { role: "reviewer", flow, round };
    }
  }
  for (const flow of flows) {
    if (resolve(flow.implementerPath) === file.path) return { role: "implementer", flow, round: null };
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
 * Durable flow and pipeline membership is checked before the legacy handoff
 * marker. That ordering keeps orchestration stages worker-class even when an old
 * compatibility record still carries a polluted handoff flag.
 *
 * FAIL TOWARD COLLAPSED (issue #136): the precise classes above miss workers
 * whenever the flow/pipeline attachment can't be resolved by path (a migrated or
 * renamed transcript, a stale flows list, a spawned claude *main* session the
 * `isChildConversation` kinds don't cover). The operator's board floods with
 * exactly those finished-but-uncollapsed cards. So any conversation that was
 * spawned *under something* — it carries a `parent` — is worker-class by
 * default: a `spawned-descendant`. Classification remains useful for stack labels;
 * the view-collapse decision itself applies to every conversation through
 * {@link keepExpanded}.
 */
export function classifyWorker(file: FileEntry, lineage: WorkerLineage): WorkerClass | null {
  const durableFlow = file.durableLineage?.memberships.find((membership) => membership.kind === "flow");
  if (durableFlow?.role === "reviewer") return "flow-reviewer";
  if (durableFlow?.role === "implementer") return "flow-implementer";
  if (file.durableLineage?.memberships.some((membership) => membership.kind === "pipeline")) return "pipeline-stage";
  const membership = flowMembership(file, lineage.flows, lineage.resolveClaimPath);
  if (membership?.role === "reviewer") return "flow-reviewer";
  if (membership?.role === "implementer") return file.parent ? "flow-implementer" : null;
  if (lineage.pipelineStagePaths.has(file.path)) return "pipeline-stage";
  if (file.handoff) return null;
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
  /** Null disables age-only collapse. Settled conversations still fold. */
  idleMs: number | null;
  /** Paths the user manually placed/expanded — a durable pin against collapse. */
  pinnedPaths: ReadonlySet<string>;
  /** Current cursor-stage transcripts of provisioning/running/needs-decision
      pipelines. Completed prior stages follow the ordinary settled/idle rule. */
  protectedPaths?: ReadonlySet<string>;
  /** Structured sends that are queued, held, or still being delivered. */
  activeDeliveryConversationIds?: ReadonlySet<string>;
}

/**
 * Terminal evidence used by the board projection. When the pipeline list loaded,
 * a missing durable pipeline record counts as closed because closed pipelines are
 * intentionally omitted while their transcript membership remains durable.
 */
export function conversationSettled(file: FileEntry, context: WorkerLineage): boolean {
  if (file.proc === "killed" || file.proc === "done") return true;
  if (file.authoritativeTurn?.state === "terminal") return true;
  if (file.supersededBy) return true;
  if (file.spawn?.state === "failed" || file.spawn?.state === "recovered") return true;
  if (file.review?.verdict) return true;

  const pipelineMembership = file.durableLineage?.memberships.find((membership) => membership.kind === "pipeline");
  if (pipelineMembership && context.pipelines !== undefined) {
    const pipeline = context.pipelines.find((candidate) => candidate.id === pipelineMembership.containerId);
    if (!pipeline || pipeline.state === "completed" || pipeline.state === "closed") return true;
  }

  const membership = flowMembership(file, context.flows, context.resolveClaimPath);
  return Boolean(membership?.role === "reviewer" && membership.round && reviewerRoundFinished(membership.round));
}

/**
 * The board's single expansion decision. Authorship fields belong to reaper
 * safety and deliberately do not participate in this view projection.
 */
export function keepExpanded(file: FileEntry, context: CollapseContext): boolean {
  if (file.activity === "live" || file.proc === "running") return true;
  if (file.pendingQuestion || file.waitingInput) return true;
  if ((file.migration?.heldDeliveries ?? 0) > 0) return true;
  if (file.conversationId && context.activeDeliveryConversationIds?.has(file.conversationId)) return true;
  if (context.protectedPaths?.has(file.path)) return true;
  if (context.pinnedPaths.has(file.path)) return true;
  if (conversationSettled(file, context)) return false;

  const membership = flowMembership(file, context.flows, context.resolveClaimPath);
  if (membership && membership.flow.state !== "closed") {
    if (membership?.role === "reviewer" && membership.round && !reviewerRoundFinished(membership.round)) return true;
    if (membership?.role === "implementer"
      && membership.flow.state !== "approved"
      && membership.flow.state !== "done_comment") return true;
  }

  if (context.idleMs === null) return true;
  return context.nowMs - file.mtime * 1000 < context.idleMs;
}

/**
 * Whether a conversation should fold into a stack now. Reviewer rounds collapse
 * on terminal evidence; every unsettled conversation follows the idle window.
 */
export function shouldCollapseWorker(file: FileEntry, context: CollapseContext): boolean {
  /* Engine-native subagents (#142 S2) are owned by the tray projection, which
     decides their promoted/folded surface — generic age-based worker collapse
     must not also fold them into an origin stack, or a tray member would render
     in two places. S2 claims them before this classifier ever runs. */
  if (file.spawnOrigin === "engine") return false;
  if (file.spawn && file.spawn.state !== "failed" && file.spawn.state !== "recovered") return false;
  if (file.migratedTo) return false;
  if (file.engine !== "claude" && file.engine !== "codex") return false;
  return !keepExpanded(file, context);
}

/** The one pipeline stage path protected by each active execution cursor. */
export function pipelineCursorStagePaths(pipelines: readonly Pipeline[]): Set<string> {
  const paths = new Set<string>();
  for (const pipeline of pipelines) {
    if (!pipeline.cursor || !["provisioning", "running", "needs_decision"].includes(pipeline.state)) continue;
    const run = pipeline.runs.find((candidate) => candidate.stageId === pipeline.cursor!.stageId);
    const attempt = run?.attempts.filter((candidate) => !candidate.historical).at(-1);
    if (attempt?.agentPath) paths.add(attempt.agentPath);
  }
  return paths;
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
  /** Collapse-eligible conversations, freshest first. */
  items: FileEntry[];
}

/** Flow id owning a transcript, derived from the flows list by path (a flow
    member groups per flow, everything else per worktree). Uses the same
    path-matching as classification — never the absent `file.flow`. */
export function flowIdForPath(
  file: FileEntry,
  flows: readonly Flow[],
  resolve: TranscriptClaimResolver = IDENTITY_CLAIM_RESOLVER,
): string | null {
  return flowMembership(file, flows, resolve)?.flow.id ?? null;
}

/** Transcript path → the id of the pipeline that owns it, so a pipeline's stage
    workers fold into ONE chip (issue #136). A stage's own `agentPath` is owned;
    for a review-loop stage the embedded flow's implementer + reviewer paths are
    owned too, otherwise the flow bucket would split them off into a second stack
    (a build stage in the pipeline stack, its reviewer in a flow stack). */
export function pipelineStagePipelineIds(
  pipelines: readonly Pipeline[],
  flows: readonly Flow[] = [],
  files: readonly FileEntry[] = [],
): Map<string, string> {
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
              for (const { path } of reviewerBindingTargetsForRound(flow, round, files)) {
                if (!map.has(path)) map.set(path, pipeline.id);
              }
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
  /** Result of the shared board expansion predicate. When present, legacy
      authorship flags cannot rematerialize a reviewer that the rule collapsed. */
  keepExpandedPaths?: ReadonlySet<string>;
  /** Board clock in epoch seconds for the automatic-placement age horizon.
      `0` (the default, and the server render) bounds nothing. */
  now?: number;
  /** Placement age horizon in seconds; defaults to the env-tunable board value. */
  ageHorizonSeconds?: number;
}

/**
 * Reviewer transcripts that must be materialized as standalone board nodes
 * because their owning flow has NO rendered round deck (issue #112).
 *
 * A reviewer admitted by the shared keep-expanded result still needs a surface.
 * A durable operator pin always qualifies; legacy callers without that result
 * retain the older authorship fallback.
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
  const durableReviewerPaths = new Map<string, string[]>();
  for (const file of input.files) {
    const membership = file.durableLineage?.memberships.find((candidate) => candidate.kind === "flow" && candidate.role === "reviewer");
    if (!membership) continue;
    const rows = durableReviewerPaths.get(membership.containerId) ?? [];
    rows.push(file.path);
    durableReviewerPaths.set(membership.containerId, rows);
  }
  const decked = new Set<string>();
  for (const flow of input.flows) {
    if (flow.state === "closed" && !flow.restored) continue;
    if (!input.renderedNodePaths.has(flow.implementerPath)) continue;
    for (const round of flow.rounds) if (round.reviewerPath) decked.add(round.reviewerPath);
    for (const pathname of durableReviewerPaths.get(flow.id) ?? []) decked.add(pathname);
  }
  const out: FileEntry[] = [];
  const seen = new Set<string>();
  for (const flow of input.flows) {
    const reviewerPaths = [...flow.rounds.map((round) => round.reviewerPath), ...(durableReviewerPaths.get(flow.id) ?? [])];
    for (const path of reviewerPaths) {
      if (!path || seen.has(path) || decked.has(path)) continue;
      if (input.renderedNodePaths.has(path) || input.hiddenPaths.has(path)) continue;
      const file = byPath.get(path);
      if (!file) continue;
      const admittedBySharedRule = input.keepExpandedPaths?.has(path) ?? false;
      if (input.keepExpandedPaths && !admittedBySharedRule) continue;
      /* An owner pin is explicit intent and stays unbounded. Other legacy
         materialization reasons remain inside the placement horizon. */
      const owned = input.pinnedPaths.has(path);
      if (!owned && !withinPlacementHorizon(file, input.now ?? 0, input.ageHorizonSeconds ?? schemeAgeHorizonSeconds())) continue;
      if (admittedBySharedRule || owned || file.userAuthored || file.authorshipUnverified) {
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
  resolveClaimPath: TranscriptClaimResolver = IDENTITY_CLAIM_RESOLVER,
): { key: string; kind: WorkerStack["kind"]; id: string } {
  /* Pipeline ownership wins over the flow bucket (issue #136): a pipeline that
     embeds a review-loop owns that flow's implementer + reviewers, so a whole
     architect→builder→review pipeline is ONE stack instead of splitting into a
     pipeline stack (architect) plus a flow stack (builder/reviewer). The
     resolver covers pipeline-owned paths AND their ancestors. */
  const pipelineId = resolvers.pipelineIdOf?.(file.path) ?? null;
  if (pipelineId) return { key: "wstack::pipeline::" + pipelineId, kind: "pipeline", id: pipelineId };
  const flowId = flowIdForPath(file, flows, resolveClaimPath);
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
  /** Active cursor-stage transcripts protected from collapse. */
  protectedPaths?: ReadonlySet<string>;
  activeDeliveryConversationIds?: ReadonlySet<string>;
  nowMs: number;
  idleMs?: number | null;
}

const EMPTY_PATHS: ReadonlySet<string> = new Set();

function collapseContext(input: CollapsibleInput): CollapseContext {
  /* One resolver per pass: durable flow/pipeline records are matched against the
     projected corpus, whatever spelling each side happens to carry (#943). */
  const resolveClaimPath = transcriptClaimResolver(input.files);
  return {
    flows: input.flows,
    pipelines: input.pipelines,
    resolveClaimPath,
    pipelineStagePaths: pipelineStageAgentPaths(input.pipelines ?? [], resolveClaimPath),
    nowMs: input.nowMs,
    idleMs: input.idleMs === undefined ? workerCollapseIdleMs() : input.idleMs,
    pinnedPaths: input.pinnedPaths,
    protectedPaths: input.protectedPaths ?? EMPTY_PATHS,
    activeDeliveryConversationIds: input.activeDeliveryConversationIds ?? EMPTY_PATHS,
  };
}

/**
 * The conversations of a project that should fold off the board now.
 *
 * Each conversation is decided independently. A settled ancestor can fold while
 * a live descendant opens its own group, which prevents idle lineage roots from
 * consuming columns merely because active work exists below them.
 */
export function collapsibleWorkerFiles(input: CollapsibleInput): FileEntry[] {
  const context = collapseContext(input);
  const out: FileEntry[] = [];
  for (const file of input.files) {
    if (projectKey(file) !== input.project) continue;
    if (!shouldCollapseWorker(file, context)) continue;
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
  /* Anchored on the stacked files themselves: a recorded member path resolves to
     the projected spelling of the very card being placed, so a pre-cut-over flow
     record still buckets its worker under that flow (#943 follow-up). */
  const resolveClaimPath = transcriptClaimResolver(files);
  for (const file of files) {
    if (exclude.has(file.path)) continue;
    const { key, kind, id } = stackKeyFor(file, flows, resolvers, resolveClaimPath);
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
