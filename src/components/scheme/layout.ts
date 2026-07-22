import type { Flow } from "@/lib/flows/types";
import type { Pipeline, PipelineStage, PipelineStageAttempt } from "@/lib/pipelines/types";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import type { DeckRound } from "@/components/flows/RoundDeck";
import { draftSrc } from "@/components/DraftAgentPane";
import { isDirectReviewFlow } from "@/components/flows/directReviewGroups";
import { claimedReviewerPaths, flowByImplementer, reviewerFilesForRound } from "@/components/flows/flowModel";

import {
  buildAnchorIndex,
  deckKey,
  deriveFlowLinks,
  deriveGroups,
  derivePipelineLinks,
  groupRect,
  hueFromId,
  stageSlotKey,
  type AgentLink,
  type SchemeGroupSpec,
} from "./agentLinks";
import { PIPELINE_PLACEHOLDER_STATES, latestAttempt, pipelinePlaceholderStages, stageAttempts } from "@/components/pipelines/pipelineModel";
import { linkedPipelineTasks } from "./pipelineAnchor";
import { TASK_W, isPlacedTask, taskBoxHeight } from "./taskGeometry";
import { type BranchGroup, descendantsOf, isChildConversation, kidsIndex, projectDescendantsOf } from "@/components/projectModel";
import { cleanTitle, engineColor } from "@/components/utils";
import { conversationIdentity } from "@/lib/accounts/identity";

/* World geometry of the scheme canvas, in unscaled pixels. */
export const NODE_W = 600;
const ROOT_H = 780;
const CHILD_H = 680;
export const GAP_X = 48;
/* Vertical corridor between generations: arrows plus the under-deck chip. */
const GAP_Y = 130;
/* Children start slightly right of the parent's left edge — the requested
   "below and a bit to the side" staircase read. Exported: pipeline stage slots
   anchor on the same offset so an attaching stage window lands exactly on its
   placeholder (issue #196). */
export const INDENT = 64;
const GROUP_GAP = 150;
const PAD = 100;
/** Maximum horizontal span of one rest-band row before whole card trees wrap. */
export const REST_BAND_MAX_W = 10_500;
const REST_BAND_ROW_GAP = 160;
/* Vertical corridor between the pinned favorites band and the rest of the board
   (issue #224): wider than GAP_Y so the crowned row reads as its own region. */
const FAV_BAND_GAP = 220;
/* Corridor between an implementer and its reviewer deck: wide enough for the
   two cycle arcs and the ⟳ hub between the cards. Exported so the flow strip
   can span the whole pair. */
export const LOOP_GAP = 170;
/* Slack between a group halo and the cards it encloses (issue #118): wide
   enough to clear the flow/pipeline strips that hover above each member. */
export const GROUP_PAD = 46;
/* Extra headroom added to the halo's TOP only (issue #136): the flow/pipeline
   strip and its entry buttons hover ~60–92 px above the top member, so the
   frame is lifted to enclose that control band and read as one clean region.
   Bottom/left/right stay at GROUP_PAD, so the enclosure geometry is unchanged. */
export const GROUP_STRIP_HEADROOM = 44;
/* Horizontal gap between two adjacent sibling subtrees that belong to DIFFERENT
   flow/pipeline groups (issue #136): wide enough that each halo's GROUP_PAD on
   both facing sides clears, plus a lane of breathing room, so the two dashed
   outlines never overlap. GAP_X alone (48) leaves a 44px overlap. */
export const GROUP_SIBLING_GAP = GROUP_PAD * 2 + GAP_X;
/* Vertical corridor between a grouped parent and a child generation that starts
   a DIFFERENT flow/pipeline region (#531): the parent halo pads GROUP_PAD below
   its cards and the child halo pads GROUP_PAD + GROUP_STRIP_HEADROOM above its
   own, so GAP_Y (130) leaves the two dashed regions overlapping. This corridor
   clears both pads plus a GAP_X lane of visible daylight. */
export const GROUP_CHILD_GAP = GROUP_PAD * 2 + GROUP_STRIP_HEADROOM + GAP_X;
/* A memberless pipeline docks below existing content. Its top halo edge includes
   strip headroom, while the region above extends through its bottom padding. */
const MEMBERLESS_PIPELINE_GAP = GROUP_PAD * 2 + GROUP_STRIP_HEADROOM + 24;
/* Pipeline stage placeholder windows (issue #196): node-width dashed cards so a
   stage's live chat window later takes the same footprint in place. The gap
   between two slots carries the handoff arrow badge. */
export const SLOT_W = NODE_W;
export const SLOT_H = 620;
export const SLOT_GAP = 72;
/* Completed stage cards (#507 F2): a terminal stage of an ACTIVE pipeline whose
   idle transcript is not surfaced as a live node still stands in at its stage
   position as a FULL conversation card — same footprint (SLOT_H) as the live
   and placeholder cards, so a five-stage graph reads as five real/placeholder
   cards, not one live pane beside compact history stubs. */
/* Quiet-branch mini cards stacked under their parent pane. */
const MINI_W = 360;
const MINI_H = 52;
const MINI_GAP = 6;
const MINI_PAD = 8;
/* Rows visible before the stack starts scrolling internally. */
const MINI_MAX = 8;

/** World-space box of anything the camera can glide to. */
export interface SchemeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SchemeNode extends SchemeRect {
  file: FileEntry;
  /** Live background tasks docked inside the pane as collapsed strips. */
  tasks: FileEntry[];
  /** Quiet history lying "under" the node: previous chats, finished tasks. */
  under: FileEntry[];
  isRoot: boolean;
}

/** Not-yet-spawned conversation drafted straight on the scheme. */
export interface DraftNode extends SchemeRect {
  key: string;
  id: string;
  /** Source transcript when the draft is a handoff hanging under its parent. */
  src?: string;
}

export interface SchemeEdge {
  to: string;
  /** Stable lineage identities used by the optional subagent badge anchor. */
  sourceConversationId?: string;
  targetConversationId?: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  live: boolean;
  /** Dashed connector into a quiet-history stack. */
  dashed?: boolean;
}

export interface MiniItem {
  file: FileEntry;
  /** Direct children of this quiet branch, shown as a «⤷ N» hint. */
  branches: number;
}

/** Column of collapsed quiet branches hanging under a pane on the diagram. */
export interface MiniStack {
  key: string;
  parent: string;
  items: MiniItem[];
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Review-round deck of a flow, sitting beside its implementer as the pair. */
export interface DeckNode {
  key: string;
  flow: Flow;
  rounds: DeckRound[];
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A flow/pipeline group halo on the scheme (issue #118): the union region of
    every session belonging to one running flow or pipeline, plus its label. */
export interface SchemeGroup extends SchemeGroupSpec, SchemeRect {
  /** Display name shown on the halo's label chip (flow: implementer title;
      pipeline: task), pre-cleaned so the component only sizes and tints it. */
  label: string;
}

/** A planned pipeline stage without a live agent yet, drawn as a dashed
    placeholder chat window in stage order (issue #196). Materializing a stage
    (its agent node / review deck placing) dissolves exactly its slot. */
export interface StageSlot extends SchemeRect {
  key: string;
  pipeline: Pipeline;
  stage: PipelineStage;
  /** 0-based position of this stage within the pipeline's full chain. */
  index: number;
  total: number;
  /** How this stage renders: `placeholder` = a future or still-forming
      (pending/spawning) stage as a conversation-shaped shell; `completed` = a
      terminal stage of an active pipeline whose idle transcript is not a live
      node, standing in as a FULL conversation card (#507 F2) so its edges, halo
      membership, and real-card footprint survive. */
  presentation: "placeholder" | "completed";
  /** Completed slots: the terminal attempt whose transcript the card opens. */
  attempt?: PipelineStageAttempt;
  /** Render an incoming handoff badge on this slot's left edge: set when the
      previous stage's slot sits directly beside it in the same row. */
  incoming?: "run" | "review-loop";
}

/** A board task card owned by a pipeline region (#531): the layout places it
    inside the pipeline's colored halo (after the stage chain), overriding the
    sticky note's lattice position so the pipeline's work item can never sit
    detached from — or inside a neighbor of — the region it belongs to. */
export interface RegionTask extends SchemeRect {
  /** Board key, `task::<id>` — the same key the camera/minimap already use. */
  key: string;
  taskId: string;
  pipelineId: string;
}

/** Implement↔review pair on the scheme: the corridor the cycle arcs live in. */
export interface FlowLoop {
  key: string;
  flow: Flow;
  /** Right edge of the implementer card. */
  x1: number;
  /** Left edge of the reviewer deck. */
  x2: number;
  /** Shared top of the two cards. */
  y: number;
}

export interface SchemeLayout {
  nodes: SchemeNode[];
  edges: SchemeEdge[];
  stacks: MiniStack[];
  decks: DeckNode[];
  loops: FlowLoop[];
  /** Flow/pipeline group halos (issue #118), each a padded region enclosing all
      of one running flow/pipeline's board occupants. */
  groups: SchemeGroup[];
  /** Agent-to-agent links between board occupants (flow links today, message
      links from #12 later), endpoints resolved against byPath keys. */
  links: AgentLink[];
  drafts: DraftNode[];
  /** Dashed placeholder windows for planned pipeline stages (issue #196). */
  slots: StageSlot[];
  /** Task cards placed inside their pipeline regions (#531). */
  regionTasks: RegionTask[];
  byPath: Map<string, SchemeRect>;
  width: number;
  height: number;
}

/**
 * Tidy top-down tree per branch group: the root conversation on top, every
 * spawned agent one generation below, indented to the right of its parent.
 * Groups line up left-to-right in the freshness order they arrive in;
 * manual standalone columns trail as top-level nodes.
 */
const stackHeight = (count: number) => MINI_PAD * 2 + Math.min(count, MINI_MAX) * (MINI_H + MINI_GAP) - MINI_GAP;

/** Which quiet branch a world-space y lands on inside a stack (the mobile map
    resolves taps by geometry). Internal scrolling is ignored — a scrolled
    stack maps to the nearest unscrolled row, clamped to the list. */
export function stackItemAt(stack: MiniStack, wy: number): FileEntry | null {
  const idx = Math.floor((wy - stack.y - MINI_PAD) / (MINI_H + MINI_GAP));
  return stack.items[Math.max(0, Math.min(idx, stack.items.length - 1))]?.file ?? null;
}

/* Card spines under a deck's front card (mirrors RoundDeck's TAB_STEP/TAB_MAX). */
const DECK_TAB_STEP = 30;
const DECK_TAB_MAX = 6;
/* The deck's front card matches its implementer's height — the pair reads as
   two equal halves of one loop; spines extend below. */
const deckHeight = (roundCount: number, baseH: number) => baseH + Math.min(Math.max(roundCount - 1, 0), DECK_TAB_MAX) * DECK_TAB_STEP;

export function buildSchemeLayout(
  groups: BranchGroup[],
  manual: FileEntry[],
  files: FileEntry[],
  flows: Flow[] = [],
  draftIds: string[] = [],
  pipelines: Pipeline[] = [],
  /** Active project pipelines are accepted for call-site compatibility. The
      caller owns their board projection outside this conversation layout. */
  surfacePipelines: Pipeline[] = [],
  /** Durable identities (`conversationIdentity`) the user has crowned (issue
      #224). A group/manual root whose identity is favorited is lifted into a
      dedicated band PINNED at the very top of the scheme, ordered within the band
      by activity recency; everything else flows below. Empty ⇒ prior behavior. */
  favorites: ReadonlySet<string> = new Set(),
  /** Explicit compact-history inspections render as one pane. Their descendant
      chain remains represented by the pipeline evidence rail. */
  isolatedManualPaths: ReadonlySet<string> = new Set(),
  /** Board task cards; the ones linked to a surfaced pipeline are placed inside
      that pipeline's region (#531) and returned as `regionTasks`. */
  tasks: readonly BoardTask[] = [],
  /** Session-only expanded-text task ids — an expanded card grows taller, and
      the region reserves that footprint so containment holds live. */
  taskTextExpanded: ReadonlySet<string> = new Set(),
): SchemeLayout {
  const byAll = new Map(files.map((file) => [file.path, file]));
  const kids = kidsIndex(files);
  const nodes: SchemeNode[] = [];
  const edges: SchemeEdge[] = [];
  const stacks: MiniStack[] = [];
  const decks: DeckNode[] = [];
  const loops: FlowLoop[] = [];
  const deckFor = flowByImplementer(flows);
  const claimed = claimedReviewerPaths(flows, files);
  /* Direct one-shot review groups (issue #325) are synthetic client-side flows:
     they place a deck, a loop and folded reviewers exactly like a managed flow,
     but no /api/flows PATCH may ever target them — so every interactive control
     surface (flow links → FlowHub, group halos → override panel, sibling halo
     spacing) derives from the REAL flows only. */
  const actionableFlows = flows.filter((flow) => !isDirectReviewFlow(flow));
  let cursor = PAD;

  /* Which flow/pipeline group owns each placed path (issue #136 spacing). Two
     sibling subtrees that belong to DIFFERENT groups must sit far enough apart
     that their padded halos never overlap; same-group and ungrouped siblings keep
     the tight gap. Membership mirrors deriveGroups: a pipeline owns its run-stage
     agent paths and its embedded review-loop implementer; a standalone flow owns
     its implementer + reviewers. */
  const groupKeyOfPath = new Map<string, string>();
  const implOfFlow = (flowId: string) => flows.find((flow) => flow.id === flowId)?.implementerPath ?? null;
  for (const pipeline of pipelines) {
    if (pipeline.state === "closed" && !pipeline.restored) continue;
    const key = "pipe:" + pipeline.id;
    for (const run of pipeline.runs) {
      for (const attempt of run.attempts) {
        if (attempt.agentPath) groupKeyOfPath.set(attempt.agentPath, key);
        if (attempt.flowId) {
          const impl = implOfFlow(attempt.flowId);
          if (impl) groupKeyOfPath.set(impl, key);
        }
      }
    }
  }
  for (const flow of actionableFlows) {
    const key = "flow:" + flow.id;
    if (!groupKeyOfPath.has(flow.implementerPath)) groupKeyOfPath.set(flow.implementerPath, key);
    for (const round of flow.rounds) {
      if (round.reviewerPath && !groupKeyOfPath.has(round.reviewerPath)) groupKeyOfPath.set(round.reviewerPath, key);
    }
  }
  /* The set of flow/pipeline groups a sibling SUBTREE carries — the root plus
     every descendant, not just the root path (issue #136 finding 2): a group
     stage nested deep inside an otherwise-ungrouped child still grows a halo out
     to that child's edge, so the boundary must see it. Memoized per root. */
  const subtreeGroupsCache = new Map<string, Set<string>>();
  const subtreeGroups = (root: FileEntry): Set<string> => {
    const cached = subtreeGroupsCache.get(root.path);
    if (cached) return cached;
    const keys = new Set<string>();
    const own = groupKeyOfPath.get(root.path);
    if (own) keys.add(own);
    for (const row of descendantsOf(root, files)) {
      const key = groupKeyOfPath.get(row.file.path);
      if (key) keys.add(key);
    }
    subtreeGroupsCache.set(root.path, keys);
    return keys;
  };
  /* A boundary between two adjacent sibling subtrees that both carry a group and
     don't carry the SAME set — exactly when two padded halos would collide. A
     grouped subtree beside an ungrouped one is fine (GAP_X clears a single
     GROUP_PAD); two subtrees of one group span into a single halo, so they stay
     tight. */
  const isGroupBoundary = (a: FileEntry, b: FileEntry): boolean => {
    const ga = subtreeGroups(a);
    const gb = subtreeGroups(b);
    if (ga.size === 0 || gb.size === 0) return false;
    if (ga.size !== gb.size) return true;
    for (const key of ga) if (!gb.has(key)) return true;
    return false;
  };

  /* ── Pipeline stage chains, classified BEFORE placement (#531) ───────────────
     Every declared stage resolves to exactly one surface (#507 F2): a live full
     pane (its transcript will be a placed node), a completed full card, or a
     placeholder. What the pass will place is fully knowable up front — nodes are
     exactly the branch-group columns plus the manual roots, and a deck lays out
     exactly when its flow's implementer is such a node — so each pipeline's
     stage chain is planned here and RESERVED inside the tree layout. Reserving
     the chain's footprint during placement (instead of dropping it onto the
     finished board and nudging it around collisions) is what keeps two
     neighboring pipeline regions from ever intersecting: sibling subtree widths
     include the chains, so the existing group-boundary gaps apply.

     Anchoring (#531 round 1 — stable per-stage positions from lineage): stage
     transcripts materialize as children of the pipeline's lineage host — the
     conversation the pipeline was launched from (srcPath), which is also the
     tree parent of every already-placed stage. When that host is a placed node,
     the WHOLE chain lives in the host's child band at stage-indexed pitch
     (SLOT_W + SLOT_GAP): stage i's surface — placeholder, completed card, or
     the live pane the tree places for it — owns the anchor
     `chainStart + i·pitch` from the very first unscanned render, so a
     materializing stage lands exactly on its placeholder's coordinates and no
     neighbor stage's surface moves (unscanned → materialized → host-loss keep
     identical world anchors), and history reads chronologically left→right:
     completed → live → future. A wide stage subtree (a spawned agent tree or a
     folded review deck beside the pane) pushes later anchors right rather than
     ever overlapping. Without a placed host the chain keeps the round-1
     behavior: a row reserved under the chain's tip, or a docked row below all
     content when nothing of the pipeline is placed yet. */
  const prePlacedNodePaths = new Set<string>([
    ...groups.flatMap((group) => group.columns.map((column) => column.file.path)),
    ...manual.map((file) => file.path),
  ]);
  const prePlacedDeckFlowIds = new Set<string>();
  for (const candidate of deckFor.values()) {
    if (prePlacedNodePaths.has(candidate.implementerPath)) prePlacedDeckFlowIds.add(candidate.id);
  }
  type SlotStage = { stage: PipelineStage; index: number; presentation: "placeholder" | "completed"; attempt?: PipelineStageAttempt };
  type ChainEntry =
    | { kind: "node"; index: number; path: string }
    | { kind: "slot"; index: number; slotStage: SlotStage };
  interface StageChainPlan {
    pipeline: Pipeline;
    /** Stage surfaces in stage order: placed child nodes of the host + slots. */
    entries: ChainEntry[];
    /** Linked board tasks (#531): placed after the chain, inside the region. */
    tasks: Array<{ task: BoardTask; h: number }>;
    placed: boolean;
  }
  const chainPlansByHost = new Map<string, StageChainPlan[]>();
  const rowPlansByTip = new Map<string, StageChainPlan[]>();
  const stageChainPlans: StageChainPlan[] = [];
  {
    /* Only THIS project's pipelines may grow memberless slot rows — the global
       list serves cross-project stage membership, so without this fence a
       foreign draft would drop its slots + halo on every project's canvas. A
       global pipeline still gets slots once it has a placed member here. */
    const surfaceIds = new Set(surfacePipelines.map((pipeline) => pipeline.id));
    const seen = new Set<string>();
    const pool = [...surfacePipelines, ...pipelines].filter((pipeline) => {
      if (pipeline.state === "closed" || seen.has(pipeline.id)) return false;
      seen.add(pipeline.id);
      return true;
    });
    /* Each placed task card belongs to at most one pipeline region. */
    const claimedTaskIds = new Set<string>();
    for (const pipeline of pool) {
      const placeholderIds = new Set(pipelinePlaceholderStages(pipeline, prePlacedNodePaths, prePlacedDeckFlowIds).map((stage) => stage.id));
      /* Completed cards only grow on an active pipeline, and never for the cursor
         stage itself: a cursor stage whose only transcript is quiet history
         (folded into an under-deck) has no live pane and shelves (#343), rather
         than resurfacing as a card. */
      const growsHistory = PIPELINE_PLACEHOLDER_STATES.has(pipeline.state);
      const stageEntries: ChainEntry[] = [];
      const memberPaths = new Set<string>();
      /* The chain's tip: the LAST stage (in chain order) whose live pane will be
         a placed node. */
      let tipPath: string | null = null;
      for (let index = 0; index < pipeline.stages.length; index += 1) {
        const stage = pipeline.stages[index]!;
        const attempt = latestAttempt(pipeline, stage.id);
        /* The stage's own live transcript — a run session or the live reviewer. */
        const livePath = attempt?.agentPath ?? null;
        if (livePath && prePlacedNodePaths.has(livePath)) {
          memberPaths.add(livePath);
          tipPath = livePath;
          stageEntries.push({ kind: "node", index, path: livePath });
          continue;
        }
        /* A folded review-loop resolves to its flow implementer node (deck laid
           out): still a live pane, not a slot. */
        const implPath = stage.kind === "review-loop" && attempt?.flowId ? implOfFlow(attempt.flowId) : null;
        if (implPath && prePlacedNodePaths.has(implPath)) {
          memberPaths.add(implPath);
          tipPath = implPath;
          stageEntries.push({ kind: "node", index, path: implPath });
          continue;
        }
        if (placeholderIds.has(stage.id)) {
          stageEntries.push({ kind: "slot", index, slotStage: { stage, index, presentation: "placeholder" } });
          continue;
        }
        /* Any materialized attempt (the operational latest or a folded historical
           one) on a NON-cursor stage is a completed stage whose idle transcript is
           not a live node: it stands in as a full conversation card at its
           position. */
        if (!growsHistory || stage.id === pipeline.cursor?.stageId) continue;
        const materialized = stageAttempts(pipeline, stage.id).findLast((candidate) => candidate.agentPath || candidate.flowId);
        if (materialized) {
          stageEntries.push({ kind: "slot", index, slotStage: { stage, index, presentation: "completed", attempt: materialized } });
        }
      }
      if (!surfaceIds.has(pipeline.id) && !memberPaths.size) continue;
      const slotCount = stageEntries.filter((entry) => entry.kind === "slot").length;
      const linkedTasks = linkedPipelineTasks(pipeline, tasks)
        .filter((task) => isPlacedTask(task) && !claimedTaskIds.has(task.id))
        .map((task) => ({ task, h: taskBoxHeight(task, taskTextExpanded.has(task.id)) }));
      if (!slotCount && !linkedTasks.length) continue;
      for (const { task } of linkedTasks) claimedTaskIds.add(task.id);
      const plan: StageChainPlan = { pipeline, entries: stageEntries, tasks: linkedTasks, placed: false };
      stageChainPlans.push(plan);
      /* The lineage host: the placed conversation the stage transcripts hang
         under — the tip's tree parent once anything is placed, else the src
         conversation the pipeline was launched from. */
      const tipParent = tipPath ? byAll.get(tipPath)?.parent ?? null : null;
      const hostPath =
        tipPath && tipParent && prePlacedNodePaths.has(tipParent)
          ? tipParent
          : !tipPath && pipeline.srcPath && prePlacedNodePaths.has(pipeline.srcPath)
            ? pipeline.srcPath
            : null;
      if (hostPath) {
        const list = chainPlansByHost.get(hostPath);
        if (list) list.push(plan);
        else chainPlansByHost.set(hostPath, [plan]);
      } else if (tipPath) {
        const list = rowPlansByTip.get(tipPath);
        if (list) list.push(plan);
        else rowPlansByTip.set(tipPath, [plan]);
      }
    }
  }
  const slots: StageSlot[] = [];
  const regionTasks: RegionTask[] = [];
  const regionKeysByPipeline = new Map<string, string[]>();
  const regionKeys = (pipelineId: string): string[] => {
    const list = regionKeysByPipeline.get(pipelineId);
    if (list) return list;
    const fresh: string[] = [];
    regionKeysByPipeline.set(pipelineId, fresh);
    return fresh;
  };
  const emitSlot = (plan: StageChainPlan, slotStage: SlotStage, x: number, y: number, previous: SlotStage | null) => {
    const { stage, index, presentation, attempt } = slotStage;
    /* The handoff badge renders only between chain-adjacent slots — a gap (a
       live pane between them) breaks the visual chain. */
    const adjacent = previous !== null && plan.pipeline.stages[index - 1]?.id === previous.stage.id;
    const slot: StageSlot = {
      key: stageSlotKey(plan.pipeline.id, stage.id),
      pipeline: plan.pipeline,
      stage,
      index,
      total: plan.pipeline.stages.length,
      presentation,
      ...(attempt ? { attempt } : {}),
      ...(adjacent ? { incoming: stage.kind } : {}),
      x,
      y,
      w: SLOT_W,
      /* Every slot is a full-size card — completed and placeholder alike share
         the live conversation's footprint (#507 F2). */
      h: SLOT_H,
    };
    slots.push(slot);
    regionKeys(plan.pipeline.id).push(slot.key);
  };
  const emitRegionTask = (plan: StageChainPlan, task: BoardTask, h: number, x: number, y: number) => {
    const rect: RegionTask = { key: "task::" + task.id, taskId: task.id, pipelineId: plan.pipeline.id, x, y, w: TASK_W, h };
    regionTasks.push(rect);
    regionKeys(plan.pipeline.id).push(rect.key);
  };
  /* A tip-anchored or docked plan: slots in a compact row, tasks trailing. */
  const emitCompactRow = (plan: StageChainPlan, sx: number, sy: number) => {
    plan.placed = true;
    let x = sx;
    let previous: SlotStage | null = null;
    for (const entry of plan.entries) {
      if (entry.kind !== "slot") continue;
      emitSlot(plan, entry.slotStage, x, sy, previous);
      previous = entry.slotStage;
      x += SLOT_W + SLOT_GAP;
    }
    for (const { task, h } of plan.tasks) {
      emitRegionTask(plan, task, h, x, sy);
      x += TASK_W + SLOT_GAP;
    }
    /* Right edge of the emitted block (the trailing gap excluded). */
    return x - SLOT_GAP;
  };

  /* Handoff drafts hang under their source pane like a child; drafts whose
     source is not on the scheme (or plain «+ Agent» ones) trail the row. */
  const drafts: DraftNode[] = [];
  const draftsBySrc = new Map<string, string[]>();
  for (const id of draftIds) {
    const src = draftSrc(id);
    if (!src) continue;
    const list = draftsBySrc.get(src);
    if (list) list.push(id);
    else draftsBySrc.set(src, [id]);
  }
  const placedDrafts = new Set<string>();

  const toMini = (file: FileEntry): MiniItem => ({ file, branches: kids.get(file.path)?.length ?? 0 });

  /* One deck per implementer node: rounds resolve their reviewer transcripts
     through the full file list, so headless runs join as soon as the scanner
     sees them. */
  const placeDeck = (flow: Flow, x: number, y: number, baseH: number): DeckNode => {
    const rounds = flow.rounds.flatMap<DeckRound>((round) => {
      const reviewers = reviewerFilesForRound(flow, round, files);
      if (!reviewers.length) return [{ key: `round:${round.n}:${round.reviewerBindingId ?? "pending"}`, round, file: null }];
      return reviewers.map((file) => ({ key: `round:${round.n}:${file.conversationId ?? file.path}`, round, file }));
    });
    const deck: DeckNode = { key: deckKey(flow.id), flow, rounds, x, y, w: NODE_W, h: deckHeight(rounds.length, baseH) };
    decks.push(deck);
    return deck;
  };

  /* Places a pane, its pane children and its quiet-branch stack; returns the
     subtree width. The stack takes the last child slot, so live branches stay
     next to the trunk. */
  const placeTree = (
    top: { file: FileEntry; tasks: FileEntry[] },
    childrenOf: Map<string, { file: FileEntry; tasks: FileEntry[] }[]>,
    stackFor: Map<string, FileEntry[]>,
    deck: Map<string, FileEntry[]>,
    rootPath: string,
    bandTop: number,
  ) => {
    const place = (col: { file: FileEntry; tasks: FileEntry[] }, x: number, y: number, depth: number): number => {
      const h = depth === 0 ? ROOT_H : CHILD_H;
      nodes.push({
        file: col.file,
        tasks: col.tasks,
        under: deck.get(col.file.path) ?? [],
        x,
        y,
        w: NODE_W,
        h,
        isRoot: col.file.path === rootPath,
      });
      /* The reviewer deck sits beside its implementer at the same level: the
         two cards read as one implement↔review pair, and the LOOP_GAP corridor
         between them carries the cycle arcs. Children drop below whichever of
         the two cards is taller. */
      const flow = deckFor.get(col.file.path);
      let rowH = h;
      if (flow) {
        const deck = placeDeck(flow, x + NODE_W + LOOP_GAP, y, h);
        loops.push({ key: "loop::" + flow.id, flow, x1: x + NODE_W, x2: deck.x, y });
        rowH = Math.max(rowH, deck.h);
      }
      const children = childrenOf.get(col.file.path) ?? [];
      /* A child generation that starts a DIFFERENT flow/pipeline region drops
         through the wider corridor, so the parent's halo pad and the child
         region's pad + headroom never overlap (#531). Same-region and ungrouped
         children keep the tight corridor. */
      const ownGroupKey = groupKeyOfPath.get(col.file.path) ?? null;
      const boundaryChild =
        ownGroupKey !== null &&
        children.some((child) => {
          for (const key of subtreeGroups(child.file)) if (key !== ownGroupKey) return true;
          return false;
        });
      const childTop = y + rowH + (boundaryChild ? GROUP_CHILD_GAP : GAP_Y);
      let cx = x + INDENT;
      const placeChild = (child: { file: FileEntry; tasks: FileEntry[] }, atX: number): number => {
        edges.push({
          to: child.file.path,
          sourceConversationId: conversationIdentity(col.file),
          targetConversationId: conversationIdentity(child.file),
          x1: x + 40,
          y1: y + h,
          x2: atX + NODE_W / 2,
          y2: childTop,
          color: engineColor(child.file),
          live: child.file.activity === "live",
        });
        return place(child, atX, childTop, depth + 1);
      };
      /* This pane is a pipeline chain's LINEAGE HOST: the whole stage chain —
         placed stage children, placeholder/completed slots, and the linked task
         cards — lays out in this child band at stage-indexed pitch, RESERVING
         its footprint inside the subtree width. Anchoring stage i at
         `chainStart + i·pitch` keeps every stage's world anchor identical from
         the first unscanned render through materialization and host loss
         (#531 round 1), keeps the hand-off positionally exact (#196: the live
         window the tree places for a stage lands on its placeholder's own
         coordinates), and reads chronologically completed → live → future. A
         stage subtree wider than one card (a spawned agent tree, a folded review
         deck) pushes the later anchors right instead of overlapping. The
         group-sibling gap after each chain keeps any foreign child subtree —
         and the next pipeline's chain — clear of this region. */
      const chainPlans = chainPlansByHost.get(col.file.path) ?? [];
      const chainChildPaths = new Set<string>();
      for (const plan of chainPlans) {
        for (const entry of plan.entries) if (entry.kind === "node") chainChildPaths.add(entry.path);
      }
      const childByPath = new Map(children.map((child) => [child.file.path, child] as const));
      for (const plan of chainPlans) {
        plan.placed = true;
        const baseIndex = plan.entries[0]?.index ?? 0;
        const chainX0 = cx;
        let localCx = cx;
        let previous: SlotStage | null = null;
        for (const entry of plan.entries) {
          const ex = Math.max(chainX0 + (entry.index - baseIndex) * (SLOT_W + SLOT_GAP), localCx);
          if (entry.kind === "slot") {
            emitSlot(plan, entry.slotStage, ex, childTop, previous);
            previous = entry.slotStage;
            localCx = ex + SLOT_W + SLOT_GAP;
          } else {
            const child = childByPath.get(entry.path);
            if (!child) continue;
            const width = placeChild(child, ex);
            localCx = ex + Math.max(width, SLOT_W) + SLOT_GAP;
          }
        }
        for (const { task, h: taskH } of plan.tasks) {
          emitRegionTask(plan, task, taskH, localCx, childTop);
          localCx += TASK_W + SLOT_GAP;
        }
        cx = localCx - SLOT_GAP + GROUP_SIBLING_GAP;
      }
      /* This pane is a chain's tip WITHOUT a placed lineage host: the remaining
         stage row reserves the first child block below, exactly like round 1. */
      for (const plan of rowPlansByTip.get(col.file.path) ?? []) {
        cx = emitCompactRow(plan, cx, childTop) + GROUP_SIBLING_GAP;
      }
      const looseChildren = children.filter((child) => !chainChildPaths.has(child.file.path));
      for (let i = 0; i < looseChildren.length; i += 1) {
        const child = looseChildren[i]!;
        /* Widen the gap only at a flow/pipeline group boundary so two sibling
           halos never overlap (issue #136); the last slot keeps GAP_X, which the
           `used` width below subtracts back off. */
        const nextChild = looseChildren[i + 1];
        const gap = nextChild && isGroupBoundary(child.file, nextChild.file) ? GROUP_SIBLING_GAP : GAP_X;
        cx += placeChild(child, cx) + gap;
      }
      const quiet = stackFor.get(col.file.path)?.filter((entry) => !claimed.has(entry.path));
      if (quiet?.length) {
        stacks.push({
          key: col.file.path + "::stack",
          parent: col.file.path,
          items: quiet.map(toMini),
          x: cx,
          y: childTop,
          w: MINI_W,
          h: stackHeight(quiet.length),
        });
        edges.push({
          to: col.file.path + "::stack",
          x1: x + 40,
          y1: y + h,
          x2: cx + MINI_W / 2,
          y2: childTop,
          color: "var(--color-muted)",
          live: false,
          dashed: true,
        });
        cx += MINI_W + GAP_X;
      }
      /* Handoff drafts of this conversation take the next child slots: the
         not-yet-spawned agent already reads as a branch of its parent. */
      for (const id of draftsBySrc.get(col.file.path) ?? []) {
        placedDrafts.add(id);
        drafts.push({ key: "draft::" + id, id, src: col.file.path, x: cx, y: childTop, w: NODE_W, h: CHILD_H });
        edges.push({
          to: "draft::" + id,
          x1: x + 40,
          y1: y + h,
          x2: cx + NODE_W / 2,
          y2: childTop,
          color: "var(--color-accent)",
          live: false,
          dashed: true,
        });
        cx += NODE_W + GAP_X;
      }
      const used = cx - GAP_X - (x + INDENT);
      const subtree = used > 0 ? Math.max(NODE_W, INDENT + used) : NODE_W;
      return Math.max(subtree, flow ? NODE_W + LOOP_GAP + NODE_W : NODE_W);
    };
    return place(top, cursor, bandTop, 0);
  };

  const placeGroup = (group: BranchGroup, bandTop: number) => {
    const cols = group.columns;
    if (!cols.length) return;
    const topPath = cols[0]!.file.path;
    const inGroup = new Set(cols.map((col) => col.file.path));

    /* Nearest displayed ancestor: intermediate quiet nodes are skipped, an
       unresolvable chain attaches to the group top. */
    const hostOf = (file: FileEntry): string => {
      let up: string | null = file.parent;
      const seen = new Set<string>([file.path]);
      while (up && !seen.has(up) && !inGroup.has(up)) {
        seen.add(up);
        up = byAll.get(up)?.parent ?? null;
      }
      return up && inGroup.has(up) && up !== file.path ? up : topPath;
    };

    const childrenOf = new Map<string, typeof cols>();
    for (const col of cols) {
      if (col.file.path === topPath) continue;
      const parent = hostOf(col.file);
      const list = childrenOf.get(parent);
      if (list) list.push(col);
      else childrenOf.set(parent, [col]);
    }

    /* Quiet child conversations stay visible on the diagram as mini cards
       wired to their parent; everything else (bash tasks, codex job logs,
       compaction predecessors) lies in the top pane's under-deck. */
    const stackFor = new Map<string, FileEntry[]>();
    const deckItems: FileEntry[] = [];
    for (const file of [...group.returnable, ...group.finished]) {
      if (claimed.has(file.path)) continue;
      if (isChildConversation(file)) {
        const host = hostOf(file);
        const list = stackFor.get(host);
        if (list) list.push(file);
        else stackFor.set(host, [file]);
      } else {
        deckItems.push(file);
      }
    }
    const deck = new Map<string, FileEntry[]>([[topPath, deckItems]]);
    cursor += placeTree(cols[0]!, childrenOf, stackFor, deck, group.key, bandTop) + GROUP_GAP;
  };

  const placeManual = (file: FileEntry, bandTop: number) => {
    const descendants = isolatedManualPaths.has(file.path)
      ? []
      : projectDescendantsOf(file, files)
        .map((row) => row.file)
        .filter((entry) => !claimed.has(entry.path));
    const quiet = descendants.filter((entry) => isChildConversation(entry));
    const deckItems = descendants.filter((entry) => !isChildConversation(entry));
    cursor +=
      placeTree(
        { file, tasks: [] },
        new Map(),
        new Map(quiet.length ? [[file.path, quiet]] : []),
        new Map([[file.path, deckItems]]),
        file.parent ? "" : file.path,
        bandTop,
      ) + GROUP_GAP;
  };

  /* ── Favorites band (issue #224) ──────────────────────────────────────────
     Crowned roots lift into their own row pinned at the very top, ordered
     within the band purely by activity recency (freshest mtime first). Their
     subtrees (edges, decks, quiet stacks) grow exactly as usual — only the row
     they sit in is fixed. Everything else lays out in a second band below the
     deepest favorite. With no favorites, `restTop` collapses to PAD and the
     board is laid out in one band exactly as before. */
  const isFavoriteRoot = (file: FileEntry) => favorites.has(conversationIdentity(file));
  const recency = (file: FileEntry) => file.mtime;
  const favGroups: BranchGroup[] = [];
  const restGroups: BranchGroup[] = [];
  for (const group of groups) {
    const top = group.columns[0]?.file;
    (top && isFavoriteRoot(top) ? favGroups : restGroups).push(group);
  }
  const favManual: FileEntry[] = [];
  const restManual: FileEntry[] = [];
  for (const file of manual) (isFavoriteRoot(file) ? favManual : restManual).push(file);
  favGroups.sort((a, b) => recency(b.columns[0]!.file) - recency(a.columns[0]!.file));
  favManual.sort((a, b) => recency(b) - recency(a));
  const fileWorkRank = (file: FileEntry): number => {
    if (file.pendingQuestion || file.waitingInput) return 5;
    const owner = groupKeyOfPath.get(file.path);
    if (owner?.startsWith("pipe:")) {
      const pipeline = pipelines.find((candidate) => candidate.id === owner.slice(5));
      if (pipeline?.state === "needs_decision" || pipeline?.state === "paused") return 4;
    }
    if (owner?.startsWith("flow:")) {
      const flow = actionableFlows.find((candidate) => candidate.id === owner.slice(5));
      if (flow?.state === "needs_decision" || flow?.state === "paused") return 4;
    }
    if (file.activity === "live" || file.activity === "stalled" || file.proc === "running") return 3;
    if (owner?.startsWith("pipe:")) {
      const pipeline = pipelines.find((candidate) => candidate.id === owner.slice(5));
      if (pipeline && pipeline.state !== "closed") return 1;
    }
    if (owner?.startsWith("flow:")) {
      const flow = actionableFlows.find((candidate) => candidate.id === owner.slice(5));
      if (flow && flow.state !== "closed") return 1;
    }
    return 0;
  };
  const groupWorkRank = (group: BranchGroup): number => Math.max(0, ...group.columns.map((column) => fileWorkRank(column.file)));
  restGroups.sort((a, b) => groupWorkRank(b) - groupWorkRank(a) || recency(b.columns[0]!.file) - recency(a.columns[0]!.file) || a.key.localeCompare(b.key));
  restManual.sort((a, b) => fileWorkRank(b) - fileWorkRank(a) || recency(b) - recency(a) || a.path.localeCompare(b.path));
  const hasFavorites = favGroups.length + favManual.length > 0;

  for (const group of favGroups) placeGroup(group, PAD);
  for (const file of favManual) placeManual(file, PAD);

  /* The favorites band's deepest edge — the second band starts just below it. */
  let bandBottom = PAD;
  if (hasFavorites) {
    for (const node of nodes) bandBottom = Math.max(bandBottom, node.y + node.h);
    for (const deck of decks) bandBottom = Math.max(bandBottom, deck.y + deck.h);
    for (const stack of stacks) bandBottom = Math.max(bandBottom, stack.y + stack.h);
    for (const draft of drafts) bandBottom = Math.max(bandBottom, draft.y + draft.h);
    for (const slot of slots) bandBottom = Math.max(bandBottom, slot.y + slot.h);
    for (const rect of regionTasks) bandBottom = Math.max(bandBottom, rect.y + rect.h);
  }
  const restTop = hasFavorites ? bandBottom + FAV_BAND_GAP : PAD;

  type PlacementMark = { nodes: number; edges: number; stacks: number; decks: number; loops: number; drafts: number; slots: number; regionTasks: number };
  const markPlacement = (): PlacementMark => ({
    nodes: nodes.length,
    edges: edges.length,
    stacks: stacks.length,
    decks: decks.length,
    loops: loops.length,
    drafts: drafts.length,
    slots: slots.length,
    regionTasks: regionTasks.length,
  });
  const shiftPlacement = (mark: PlacementMark, dx: number, dy: number) => {
    for (const rect of nodes.slice(mark.nodes)) { rect.x += dx; rect.y += dy; }
    for (const edge of edges.slice(mark.edges)) { edge.x1 += dx; edge.x2 += dx; edge.y1 += dy; edge.y2 += dy; }
    for (const rect of stacks.slice(mark.stacks)) { rect.x += dx; rect.y += dy; }
    for (const rect of decks.slice(mark.decks)) { rect.x += dx; rect.y += dy; }
    for (const loop of loops.slice(mark.loops)) { loop.x1 += dx; loop.x2 += dx; loop.y += dy; }
    for (const rect of drafts.slice(mark.drafts)) { rect.x += dx; rect.y += dy; }
    for (const rect of slots.slice(mark.slots)) { rect.x += dx; rect.y += dy; }
    for (const rect of regionTasks.slice(mark.regionTasks)) { rect.x += dx; rect.y += dy; }
  };
  const placementBottom = (mark: PlacementMark): number => {
    let value = 0;
    for (const rect of nodes.slice(mark.nodes)) value = Math.max(value, rect.y + rect.h);
    for (const rect of stacks.slice(mark.stacks)) value = Math.max(value, rect.y + rect.h);
    for (const rect of decks.slice(mark.decks)) value = Math.max(value, rect.y + rect.h);
    for (const rect of drafts.slice(mark.drafts)) value = Math.max(value, rect.y + rect.h);
    for (const rect of slots.slice(mark.slots)) value = Math.max(value, rect.y + rect.h);
    for (const rect of regionTasks.slice(mark.regionTasks)) value = Math.max(value, rect.y + rect.h);
    return value;
  };

  let rowTop = restTop;
  let rowBottom = restTop;
  let rowStartX = PAD;
  cursor = rowStartX;
  const placeRestItem = (place: (top: number) => void) => {
    const mark = markPlacement();
    const startX = cursor;
    place(rowTop);
    const endCursor = cursor;
    if (startX > rowStartX && endCursor - GROUP_GAP > PAD + REST_BAND_MAX_W) {
      const nextTop = rowBottom + REST_BAND_ROW_GAP;
      shiftPlacement(mark, PAD - startX, nextTop - rowTop);
      cursor = PAD + (endCursor - startX);
      rowTop = nextTop;
      rowStartX = PAD;
      rowBottom = placementBottom(mark);
      return;
    }
    rowBottom = Math.max(rowBottom, placementBottom(mark));
  };

  for (const group of restGroups) placeRestItem((top) => placeGroup(group, top));
  for (const file of restManual) placeRestItem((top) => placeManual(file, top));

  /* Remaining drafts join the same bounded band as fresh top-level cards. */
  for (const id of draftIds) {
    if (placedDrafts.has(id)) continue;
    placeRestItem((top) => {
      drafts.push({ key: "draft::" + id, id, x: cursor, y: top, w: NODE_W, h: ROOT_H });
      cursor += NODE_W + GROUP_GAP;
    });
  }

  /* Planned stages render as conversation-shaped placeholder cards INSIDE the
     pipeline's colored halo, at their real stage positions (#353 desktop
     ownership): the halo is the sole pipeline region, so every yet-to-launch
     stage sits beside the materialized conversations it hands off to — never a
     detached rail or a duplicate stage graph. A slot dissolves the instant its
     stage materializes a live window (the solid card takes its position).
     Tip-anchored rows were reserved and emitted during tree placement (#531);
     what remains here are the rows of pipelines with no placed member yet
     (drafts, or every stage still unscanned). They dock in their own band BELOW
     everything placed, one row beside the next, so a memberless region can never
     sit on top of a laid-out card or another pipeline's region. */
  {
    let contentBottom = 0;
    for (const rect of [...nodes, ...stacks, ...decks, ...drafts, ...slots, ...regionTasks]) {
      contentBottom = Math.max(contentBottom, rect.y + rect.h);
    }
    let dockX = PAD;
    const dockY = contentBottom > 0 ? contentBottom + MEMBERLESS_PIPELINE_GAP : restTop;
    for (const plan of stageChainPlans) {
      if (plan.placed) continue;
      dockX = emitCompactRow(plan, dockX, dockY) + GROUP_GAP;
    }
  }

  let bottom = 0;
  let right = 0;
  for (const node of nodes) { bottom = Math.max(bottom, node.y + node.h); right = Math.max(right, node.x + node.w); }
  for (const stack of stacks) { bottom = Math.max(bottom, stack.y + stack.h); right = Math.max(right, stack.x + stack.w); }
  for (const deck of decks) { bottom = Math.max(bottom, deck.y + deck.h); right = Math.max(right, deck.x + deck.w); }
  for (const draft of drafts) { bottom = Math.max(bottom, draft.y + draft.h); right = Math.max(right, draft.x + draft.w); }
  for (const slot of slots) { bottom = Math.max(bottom, slot.y + slot.h); right = Math.max(right, slot.x + slot.w); }
  for (const rect of regionTasks) { bottom = Math.max(bottom, rect.y + rect.h); right = Math.max(right, rect.x + rect.w); }
  /* Links resolve against what this pass actually placed, so geometry and
     link endpoints can never disagree. */
  const anchors = buildAnchorIndex(
    nodes.map((node) => node.file.path),
    decks.map((deck) => ({ key: deck.key, flow: deck.flow })),
    stacks.map((stack) => ({ key: stack.key, paths: stack.items.map((item) => item.file.path) })),
  );
  /* Planned-stage placeholder slots self-resolve, so a pipeline's pass/fail/loop
     edge can route into (or out of) a future stage that has no materialized node
     yet — the rail stays continuous inside the halo (#353). */
  for (const slot of slots) anchors.set(slot.key, slot.key);
  const byPath = new Map<string, SchemeRect>([
    ...nodes.map((node) => [node.file.path, node] as const),
    ...drafts.map((draft) => [draft.key, draft] as const),
    ...stacks.map((stack) => [stack.key, stack] as const),
    ...decks.map((deck) => [deck.key, deck] as const),
    ...slots.map((slot) => [slot.key, slot] as const),
    ...regionTasks.map((rect) => [rect.key, rect] as const),
  ]);
  const flowImplementerPath = (flowId: string) => flows.find((flow) => flow.id === flowId)?.implementerPath ?? null;

  /* A pipeline halo also encloses the children hanging below its run stages, so a
     spawned stage subtree reads as part of the same region. Expansion is limited
     to pipeline stage roots on purpose: a standalone flow's halo stays the
     implementer + reviewer deck, so an unrelated agent spawned below the
     implementer never stretches the flow region across the board.
     Two #531 containment/separation rules govern the walk:
     — every surface ATTACHED to a member pane (its review deck — managed or
       direct one-shot, its quiet-history stack, its handoff drafts) joins the
       region, so no conversation surface of the pipeline pokes out of the halo;
     — a descendant OWNED by a different flow/pipeline is never absorbed (nor is
       its subtree), so one colored region can never swallow another's cards and
       force the two dashed outlines to intersect. */
  const placedNodePaths = new Set(nodes.map((node) => node.file.path));
  const deckKeyByImplementer = new Map(decks.map((deck) => [deck.flow.implementerPath, deck.key] as const));
  const attachmentKeysOf = (path: string): string[] => {
    const keys: string[] = [];
    const deckAt = deckKeyByImplementer.get(path);
    if (deckAt) keys.push(deckAt);
    if (byPath.has(path + "::stack")) keys.push(path + "::stack");
    for (const id of draftsBySrc.get(path) ?? []) {
      if (byPath.has("draft::" + id)) keys.push("draft::" + id);
    }
    return keys;
  };
  const expandMembers = (members: string[], ownKey: string): string[] => {
    const out = new Set(members);
    const visited = new Set<string>();
    const walk = (path: string) => {
      if (visited.has(path)) return;
      visited.add(path);
      for (const child of kids.get(path) ?? []) {
        const owner = groupKeyOfPath.get(child.path);
        if (owner && owner !== ownKey) continue;
        if (placedNodePaths.has(child.path)) {
          out.add(child.path);
          for (const key of attachmentKeysOf(child.path)) out.add(key);
        }
        walk(child.path);
      }
    };
    for (const key of members) {
      const file = byAll.get(key);
      if (!file) continue; // deck/stack/draft/slot keys aren't transcript files
      for (const attachment of attachmentKeysOf(key)) out.add(attachment);
      walk(key);
    }
    return [...out];
  };
  const groupLabel = (spec: SchemeGroupSpec): string => {
    if (spec.pipeline) return cleanTitle(spec.pipeline.task, 60);
    if (spec.flow) return cleanTitle(byAll.get(spec.flow.implementerPath)?.title ?? spec.flow.project, 60);
    return spec.key;
  };
  /* Every planned stage's placeholder is a member of its pipeline halo, so the
     colored region grows to enclose the future stages that sit beside the live
     conversations (#353). A draft with no materialized window yet is still a
     region: its halo is derived from its placeholder members alone. */
  const specs = deriveGroups(actionableFlows, pipelines, (key) => anchors.get(key) ?? null, flowImplementerPath);
  const pipelineSpecById = new Map(specs.filter((spec) => spec.pipeline).map((spec) => [spec.pipeline!.id, spec] as const));
  const pipelineById = new Map<string, Pipeline>();
  for (const pipeline of [...surfacePipelines, ...pipelines]) if (!pipelineById.has(pipeline.id)) pipelineById.set(pipeline.id, pipeline);
  for (const [pipelineId, keys] of regionKeysByPipeline) {
    const existing = pipelineSpecById.get(pipelineId);
    if (existing) {
      existing.members = [...existing.members, ...keys];
      continue;
    }
    const pipeline = pipelineById.get(pipelineId);
    if (!pipeline) continue;
    const spec: SchemeGroupSpec = {
      key: `group::pipeline::${pipeline.id}`,
      kind: "pipeline",
      id: pipeline.id,
      hue: hueFromId(pipeline.id),
      members: keys,
      pipeline,
    };
    specs.push(spec);
    pipelineSpecById.set(pipelineId, spec);
  }
  const groupHalos: SchemeGroup[] = [];
  for (const spec of specs) {
    const members = spec.kind === "pipeline" ? expandMembers(spec.members, "pipe:" + spec.id) : spec.members;
    const rect = groupRect(members, (key) => byPath.get(key) ?? null, GROUP_PAD);
    if (!rect) continue;
    /* Lift the top edge to enclose the hovering compact header; bottom stays put,
       so the y shrinks up and h grows by the same amount (issue #136). */
    const framed = { x: rect.x, y: rect.y - GROUP_STRIP_HEADROOM, w: rect.w, h: rect.h + GROUP_STRIP_HEADROOM };
    groupHalos.push({ ...spec, ...framed, label: groupLabel(spec) });
  }

  return {
    nodes,
    edges,
    stacks,
    decks,
    loops,
    groups: groupHalos,
    links: [
      ...deriveFlowLinks(actionableFlows, (key) => anchors.get(key) ?? null),
      ...derivePipelineLinks(pipelines, (key) => anchors.get(key) ?? null, flowImplementerPath),
    ],
    drafts,
    slots,
    regionTasks,
    byPath,
    width: Math.max(
      right + PAD,
      PAD * 2 + NODE_W,
    ),
    /* Extra room under the last generation for decks and expanded panels. */
    height: bottom + PAD + 140,
  };
}
