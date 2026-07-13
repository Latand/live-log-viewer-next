import type { Flow } from "@/lib/flows/types";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import type { DeckRound } from "@/components/flows/RoundDeck";
import { draftSrc } from "@/components/DraftAgentPane";
import { claimedReviewerPaths, flowByImplementer, reviewerFilesForRound } from "@/components/flows/flowModel";
import { pipelinePlaceholderStages } from "@/components/pipelines/pipelineModel";

import {
  buildAnchorIndex,
  deckKey,
  deriveFlowLinks,
  deriveGroups,
  derivePipelineLinks,
  groupRect,
  hueFromId,
  type AgentLink,
  type SchemeGroupSpec,
} from "./agentLinks";
import { type BranchGroup, descendantsOf, isChildConversation, kidsIndex } from "@/components/projectModel";
import { cleanTitle, engineColor } from "@/components/utils";

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
/* Pipeline stage placeholder windows (issue #196): node-width dashed cards so a
   stage's live chat window later takes the same footprint in place. The gap
   between two slots carries the handoff arrow badge. */
export const SLOT_W = NODE_W;
export const SLOT_H = 620;
export const SLOT_GAP = 72;
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
  /** Render an incoming handoff badge on this slot's left edge: set when the
      previous stage's slot sits directly beside it in the same row. */
  incoming?: "run" | "review-loop";
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
  /** Active project pipelines that must have a scheme surface even with no
      materialized/placed stage node yet (issue #136): each such pipeline that
      `deriveGroups` did not already frame gets a docked placeholder group
      carrying its plan, so a provisioning pipeline is never surfaceless. */
  surfacePipelines: Pipeline[] = [],
): SchemeLayout {
  const byAll = new Map(files.map((file) => [file.path, file]));
  const kids = kidsIndex(files);
  const nodes: SchemeNode[] = [];
  const edges: SchemeEdge[] = [];
  const stacks: MiniStack[] = [];
  const decks: DeckNode[] = [];
  const loops: FlowLoop[] = [];
  const deckFor = flowByImplementer(flows);
  const claimed = claimedReviewerPaths(flows);
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
  for (const flow of flows) {
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
      const childTop = y + rowH + GAP_Y;
      const children = childrenOf.get(col.file.path) ?? [];
      let cx = x + INDENT;
      for (let i = 0; i < children.length; i += 1) {
        const child = children[i]!;
        edges.push({
          to: child.file.path,
          x1: x + 40,
          y1: y + h,
          x2: cx + NODE_W / 2,
          y2: childTop,
          color: engineColor(child.file),
          live: child.file.activity === "live",
        });
        /* Widen the gap only at a flow/pipeline group boundary so two sibling
           halos never overlap (issue #136); the last slot keeps GAP_X, which the
           `used` width below subtracts back off. */
        const nextChild = children[i + 1];
        const gap = nextChild && isGroupBoundary(child.file, nextChild.file) ? GROUP_SIBLING_GAP : GAP_X;
        cx += place(child, cx, childTop, depth + 1) + gap;
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
    return place(top, cursor, PAD, 0);
  };

  for (const group of groups) {
    const cols = group.columns;
    if (!cols.length) continue;
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
    cursor += placeTree(cols[0]!, childrenOf, stackFor, deck, group.key) + GROUP_GAP;
  }

  for (const file of manual) {
    const descendants = descendantsOf(file, files)
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
      ) + GROUP_GAP;
  }

  /* Remaining drafts trail the row like fresh top-level nodes: root-sized, no edges. */
  for (const id of draftIds) {
    if (placedDrafts.has(id)) continue;
    drafts.push({ key: "draft::" + id, id, x: cursor, y: PAD, w: NODE_W, h: ROOT_H });
    cursor += NODE_W + GROUP_GAP;
  }

  /* ── Pipeline stage placeholders (issue #196) ──────────────────────────────
     Every active pipeline's not-yet-materialized stages render as dashed
     placeholder windows in stage order, so the whole chain is visible from the
     moment a template lands as a draft. A memberless pipeline (draft /
     provisioning) docks its full row after the tree columns; once stages
     materialize, the remaining placeholders continue from the chain's tip at
     the exact spot the tree will hand the next stage window (tip + INDENT, one
     generation below) — so an attaching agent's live window takes over its
     placeholder's position and card: dashed becomes solid IN PLACE.
     TODO(#197 follow-up): with durable membership (#199) landed, slots can next
     be pinned to their materialized windows across scan gaps. */
  const rectsIntersect = (a: SchemeRect, b: SchemeRect) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const slots: StageSlot[] = [];
  const slotKeysByPipeline = new Map<string, string[]>();
  const slotPipelines: Pipeline[] = [];
  {
    const placedPaths = new Set(nodes.map((node) => node.file.path));
    const placedFlowIds = new Set(decks.map((deck) => deck.flow.id));
    const nodeRectByPath = new Map<string, SchemeRect>(nodes.map((node) => [node.file.path, node]));
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
    let slotDockY = PAD;
    for (const pipeline of pool) {
      const pending = pipelinePlaceholderStages(pipeline, placedPaths, placedFlowIds);
      if (!pending.length) continue;
      const memberRects: SchemeRect[] = [];
      const memberPaths = new Set<string>();
      /* The chain's tip: the LAST stage (in chain order) with a placed window —
         a run stage's agent node, or a review-loop's implementer. The next
         stage's live window lands as the tip's child, so the slot row anchors
         there. */
      let tip: SchemeRect | null = null;
      for (const stage of pipeline.stages) {
        const attempt = pipeline.runs.find((run) => run.stageId === stage.id)?.attempts.at(-1);
        if (!attempt) continue;
        if (attempt.agentPath) {
          const rect = nodeRectByPath.get(attempt.agentPath);
          if (rect) {
            memberRects.push(rect);
            memberPaths.add(attempt.agentPath);
            if (stage.kind !== "review-loop") tip = rect;
          }
        }
        if (attempt.flowId) {
          const impl = implOfFlow(attempt.flowId);
          const rect = impl ? nodeRectByPath.get(impl) : null;
          if (impl && rect) {
            memberRects.push(rect);
            memberPaths.add(impl);
            if (stage.kind === "review-loop") tip = rect;
          }
          const deck = decks.find((candidate) => candidate.flow.id === attempt.flowId);
          if (deck) memberRects.push(deck);
        }
      }
      if (!surfaceIds.has(pipeline.id) && !memberRects.length) continue;
      const rowW = pending.length * SLOT_W + (pending.length - 1) * SLOT_GAP;
      let sx: number;
      let sy: number;
      if (tip) {
        /* The tree indents a child one INDENT right of its parent and one
           generation (GAP_Y) below — anchoring the first slot exactly there
           makes the attach hand-off positionally exact: the live window the
           tree places for the next stage lands on the slot's own coordinates
           (review finding 3 reproduced a 64px INDENT mismatch), so the dashed
           card becomes the solid window in place. */
        sx = tip.x + INDENT;
        sy = tip.y + tip.h + GAP_Y;
        /* Step below any unrelated card the row would cover — bounded, so a
           pathological board can never loop forever. */
        const row = (): SchemeRect => ({ x: sx, y: sy, w: rowW, h: SLOT_H });
        const blocked = () =>
          nodes.some((node) => !memberPaths.has(node.file.path) && rectsIntersect(node, row())) ||
          stacks.some((stack) => rectsIntersect(stack, row())) ||
          decks.some((deck) => !memberRects.includes(deck) && rectsIntersect(deck, row()));
        for (let guard = 0; guard < 40 && blocked(); guard += 1) sy += SLOT_H / 2;
      } else {
        sx = cursor;
        sy = slotDockY;
        slotDockY += SLOT_H + GROUP_GAP;
      }
      const keys: string[] = [];
      pending.forEach((stage, i) => {
        const index = pipeline.stages.findIndex((candidate) => candidate.id === stage.id);
        const previous = i > 0 ? pending[i - 1]! : null;
        /* The handoff badge renders only between chain-adjacent slots — a gap
           (a materialized stage between them) breaks the visual chain there. */
        const adjacent = previous !== null && pipeline.stages[index - 1]?.id === previous.id;
        const slot: StageSlot = {
          key: `slot::${pipeline.id}::${stage.id}`,
          pipeline,
          stage,
          index,
          total: pipeline.stages.length,
          ...(adjacent ? { incoming: stage.kind } : {}),
          x: sx + i * (SLOT_W + SLOT_GAP),
          y: sy,
          w: SLOT_W,
          h: SLOT_H,
        };
        slots.push(slot);
        keys.push(slot.key);
      });
      slotKeysByPipeline.set(pipeline.id, keys);
      slotPipelines.push(pipeline);
    }
  }

  let bottom = 0;
  for (const node of nodes) bottom = Math.max(bottom, node.y + node.h);
  for (const stack of stacks) bottom = Math.max(bottom, stack.y + stack.h);
  for (const deck of decks) bottom = Math.max(bottom, deck.y + deck.h);
  for (const draft of drafts) bottom = Math.max(bottom, draft.y + draft.h);
  for (const slot of slots) bottom = Math.max(bottom, slot.y + slot.h);
  /* Links resolve against what this pass actually placed, so geometry and
     link endpoints can never disagree. */
  const anchors = buildAnchorIndex(
    nodes.map((node) => node.file.path),
    decks.map((deck) => ({ key: deck.key, flow: deck.flow })),
    stacks.map((stack) => ({ key: stack.key, paths: stack.items.map((item) => item.file.path) })),
  );
  const byPath = new Map<string, SchemeRect>([
    ...nodes.map((node) => [node.file.path, node] as const),
    ...drafts.map((draft) => [draft.key, draft] as const),
    ...stacks.map((stack) => [stack.key, stack] as const),
    ...decks.map((deck) => [deck.key, deck] as const),
    ...slots.map((slot) => [slot.key, slot] as const),
  ]);
  const flowImplementerPath = (flowId: string) => flows.find((flow) => flow.id === flowId)?.implementerPath ?? null;

  /* A pipeline halo also encloses the children hanging below its run stages, so a
     spawned stage subtree reads as part of the same region. Expansion is limited
     to pipeline stage roots on purpose: a standalone flow's halo stays the
     implementer + reviewer deck, so an unrelated agent spawned below the
     implementer never stretches the flow region across the board. */
  const placedNodePaths = new Set(nodes.map((node) => node.file.path));
  const expandMembers = (members: string[]): string[] => {
    const out = new Set(members);
    for (const key of members) {
      const file = byAll.get(key);
      if (!file) continue; // deck/stack/draft keys aren't transcript files
      for (const row of descendantsOf(file, files)) {
        if (placedNodePaths.has(row.file.path)) out.add(row.file.path);
      }
    }
    return [...out];
  };
  const groupLabel = (spec: SchemeGroupSpec): string => {
    if (spec.pipeline) return cleanTitle(spec.pipeline.task, 60);
    if (spec.flow) return cleanTitle(byAll.get(spec.flow.implementerPath)?.title ?? spec.flow.project, 60);
    return spec.key;
  };
  const groupHalos: SchemeGroup[] = [];
  for (const spec of deriveGroups(flows, pipelines, (key) => anchors.get(key) ?? null, flowImplementerPath)) {
    /* A pipeline halo also encloses its dashed stage placeholders (issue #196),
       so live windows and upcoming slots read as one region. */
    const members = spec.kind === "pipeline"
      ? [...expandMembers(spec.members), ...(slotKeysByPipeline.get(spec.id) ?? [])]
      : spec.members;
    const rect = groupRect(members, (key) => byPath.get(key) ?? null, GROUP_PAD);
    if (!rect) continue;
    /* Lift the top edge to enclose the hovering control strip; bottom stays put,
       so the y shrinks up and h grows by the same amount (issue #136). */
    const framed = { x: rect.x, y: rect.y - GROUP_STRIP_HEADROOM, w: rect.w, h: rect.h + GROUP_STRIP_HEADROOM };
    groupHalos.push({ ...spec, ...framed, label: groupLabel(spec) });
  }

  /* Halos for pipelines `deriveGroups` did not frame (no materialized/placed
     stage node yet): the placeholder slots ARE the region (issue #196) — the
     halo wraps the full dashed stage row, so a fresh template draft lands as a
     complete visible pipeline before anything spawns. */
  const framedPipelineIds = new Set(groupHalos.filter((halo) => halo.pipeline).map((halo) => halo.id));
  let dockRight = 0;
  let dockBottom = 0;
  for (const pipeline of slotPipelines) {
    if (framedPipelineIds.has(pipeline.id)) continue;
    const keys = slotKeysByPipeline.get(pipeline.id)!;
    const rect = groupRect(keys, (key) => byPath.get(key) ?? null, GROUP_PAD);
    if (!rect) continue;
    framedPipelineIds.add(pipeline.id);
    groupHalos.push({
      key: `group::pipeline::${pipeline.id}`,
      kind: "pipeline",
      id: pipeline.id,
      hue: hueFromId(pipeline.id),
      members: keys,
      pipeline,
      x: rect.x,
      y: rect.y - GROUP_STRIP_HEADROOM,
      w: rect.w,
      h: rect.h + GROUP_STRIP_HEADROOM,
      label: cleanTitle(pipeline.task, 60),
    });
    dockRight = Math.max(dockRight, rect.x + rect.w);
    dockBottom = Math.max(dockBottom, rect.y + rect.h);
  }

  /* Fallback docked halo for an active surface pipeline with neither placed
     members nor placeholder slots (e.g. completed but its transcripts left the
     scan): a memberless plan card, as before (issue #136). */
  let dockY = PAD;
  for (const pipeline of surfacePipelines) {
    if ((pipeline.state === "closed" && !pipeline.restored) || framedPipelineIds.has(pipeline.id)) continue;
    framedPipelineIds.add(pipeline.id);
    const rect = { x: cursor, y: dockY, w: NODE_W + GROUP_PAD * 2, h: 150 };
    groupHalos.push({
      key: `group::pipeline::${pipeline.id}`,
      kind: "pipeline",
      id: pipeline.id,
      hue: hueFromId(pipeline.id),
      members: [],
      pipeline,
      ...rect,
      label: cleanTitle(pipeline.task, 60),
    });
    dockY += rect.h + GROUP_GAP;
    dockRight = Math.max(dockRight, rect.x + rect.w);
    dockBottom = Math.max(dockBottom, rect.y + rect.h);
  }

  return {
    nodes,
    edges,
    stacks,
    decks,
    loops,
    groups: groupHalos,
    links: [
      ...deriveFlowLinks(flows, (key) => anchors.get(key) ?? null),
      ...derivePipelineLinks(pipelines, (key) => anchors.get(key) ?? null, flowImplementerPath),
    ],
    drafts,
    slots,
    byPath,
    width: Math.max(
      cursor - GROUP_GAP + PAD,
      PAD * 2 + NODE_W,
      dockRight + PAD,
      ...slots.map((slot) => slot.x + slot.w + GROUP_PAD + PAD),
    ),
    /* Extra room under the last generation for decks and expanded panels. */
    height: Math.max(bottom + PAD + 140, dockBottom + PAD),
  };
}
