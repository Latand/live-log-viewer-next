import type { Flow } from "@/lib/flows/types";
import type { Pipeline, PipelineStage } from "@/lib/pipelines/types";
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
  type AgentLink,
  type SchemeGroupSpec,
} from "./agentLinks";
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
  /** Durable identities (`conversationIdentity`) the user has crowned (issue
      #224). A group/manual root whose identity is favorited is lifted into a
      dedicated band PINNED at the very top of the scheme, ordered within the band
      by activity recency; everything else flows below. Empty ⇒ prior behavior. */
  favorites: ReadonlySet<string> = new Set(),
  /** Explicit compact-history inspections render as one pane. Their descendant
      chain remains represented by the pipeline evidence rail. */
  isolatedManualPaths: ReadonlySet<string> = new Set(),
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
  }
  const restTop = hasFavorites ? bandBottom + FAV_BAND_GAP : PAD;

  /* Reserve the row head for compact pipeline rails. This is presentation-only:
     no pipeline/task record is rewritten. Pipelines with a materialized member
     receive their surface from that member's own halo. */
  const materializedPipelineIds = new Set(
    [...groupKeyOfPath]
      .filter(([path, owner]) => owner.startsWith("pipe:") && byAll.has(path))
      .map(([, owner]) => owner.slice(5)),
  );
  const surfaceHead = surfacePipelines.filter(
    (pipeline) => (pipeline.state !== "closed" || pipeline.restored) && !materializedPipelineIds.has(pipeline.id),
  );
  const surfaceHeadWidth = surfaceHead.length ? NODE_W + GROUP_PAD * 2 + GROUP_GAP : 0;
  const surfaceHeadBottom = surfaceHead.length
    ? restTop + surfaceHead.length * (150 + GROUP_GAP) - GROUP_GAP
    : restTop;

  type PlacementMark = { nodes: number; edges: number; stacks: number; decks: number; loops: number; drafts: number };
  const markPlacement = (): PlacementMark => ({
    nodes: nodes.length,
    edges: edges.length,
    stacks: stacks.length,
    decks: decks.length,
    loops: loops.length,
    drafts: drafts.length,
  });
  const shiftPlacement = (mark: PlacementMark, dx: number, dy: number) => {
    for (const rect of nodes.slice(mark.nodes)) { rect.x += dx; rect.y += dy; }
    for (const edge of edges.slice(mark.edges)) { edge.x1 += dx; edge.x2 += dx; edge.y1 += dy; edge.y2 += dy; }
    for (const rect of stacks.slice(mark.stacks)) { rect.x += dx; rect.y += dy; }
    for (const rect of decks.slice(mark.decks)) { rect.x += dx; rect.y += dy; }
    for (const loop of loops.slice(mark.loops)) { loop.x1 += dx; loop.x2 += dx; loop.y += dy; }
    for (const rect of drafts.slice(mark.drafts)) { rect.x += dx; rect.y += dy; }
  };
  const placementBottom = (mark: PlacementMark): number => {
    let value = 0;
    for (const rect of nodes.slice(mark.nodes)) value = Math.max(value, rect.y + rect.h);
    for (const rect of stacks.slice(mark.stacks)) value = Math.max(value, rect.y + rect.h);
    for (const rect of decks.slice(mark.decks)) value = Math.max(value, rect.y + rect.h);
    for (const rect of drafts.slice(mark.drafts)) value = Math.max(value, rect.y + rect.h);
    return value;
  };

  let rowTop = restTop;
  let rowBottom = surfaceHeadBottom;
  let rowStartX = PAD + surfaceHeadWidth;
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

  /* Planned stages live in the compact group rail (#353). Configuration opens
     on demand from that rail, so planned stages contribute no world-space
     windows, obstacles, minimap blocks, or Fit All bounds. The legacy StageSlot
     type stays as the shared input for the configuration pane. */
  const slots: StageSlot[] = [];

  let bottom = 0;
  let right = 0;
  for (const node of nodes) { bottom = Math.max(bottom, node.y + node.h); right = Math.max(right, node.x + node.w); }
  for (const stack of stacks) { bottom = Math.max(bottom, stack.y + stack.h); right = Math.max(right, stack.x + stack.w); }
  for (const deck of decks) { bottom = Math.max(bottom, deck.y + deck.h); right = Math.max(right, deck.x + deck.w); }
  for (const draft of drafts) { bottom = Math.max(bottom, draft.y + draft.h); right = Math.max(right, draft.x + draft.w); }
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
  for (const spec of deriveGroups(actionableFlows, pipelines, (key) => anchors.get(key) ?? null, flowImplementerPath)) {
    const members = spec.kind === "pipeline" ? expandMembers(spec.members) : spec.members;
    const rect = groupRect(members, (key) => byPath.get(key) ?? null, GROUP_PAD);
    if (!rect) continue;
    /* Lift the top edge to enclose the hovering control strip; bottom stays put,
       so the y shrinks up and h grows by the same amount (issue #136). */
    const framed = { x: rect.x, y: rect.y - GROUP_STRIP_HEADROOM, w: rect.w, h: rect.h + GROUP_STRIP_HEADROOM };
    groupHalos.push({ ...spec, ...framed, label: groupLabel(spec) });
  }

  const framedPipelineIds = new Set(groupHalos.filter((halo) => halo.pipeline).map((halo) => halo.id));
  let dockRight = 0;
  let dockBottom = 0;
  /* Pipelines without a placed current pane receive one compact rail card.
     Only pipelines the head reservation counted may use the reserved column:
     a pipeline can be "materialized" (a member path exists in the file list)
     yet still unframed — quiet history folded into a node's under-deck never
     enters the anchor index — and with no slot reserved a rail at
     `(PAD, restTop)` would sit under the first rest-band card. Such leftovers
     dock below everything placed instead, where nothing can collide. */
  const reservedRailIds = new Set(surfaceHead.map((pipeline) => pipeline.id));
  let dockY = restTop;
  let overflowDockY = Math.max(bottom, surfaceHeadBottom) + REST_BAND_ROW_GAP;
  for (const pipeline of surfacePipelines) {
    if ((pipeline.state === "closed" && !pipeline.restored) || framedPipelineIds.has(pipeline.id)) continue;
    framedPipelineIds.add(pipeline.id);
    const reserved = reservedRailIds.has(pipeline.id);
    const rect = { x: PAD, y: reserved ? dockY : overflowDockY, w: NODE_W + GROUP_PAD * 2, h: 150 };
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
    if (reserved) dockY = rect.y + rect.h + GROUP_GAP;
    else overflowDockY = rect.y + rect.h + GROUP_GAP;
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
      ...deriveFlowLinks(actionableFlows, (key) => anchors.get(key) ?? null),
      ...derivePipelineLinks(pipelines, (key) => anchors.get(key) ?? null, flowImplementerPath),
    ],
    drafts,
    slots,
    byPath,
    width: Math.max(
      right + PAD,
      PAD * 2 + NODE_W,
      dockRight + PAD,
    ),
    /* Extra room under the last generation for decks and expanded panels. */
    height: Math.max(bottom + PAD + 140, dockBottom + PAD),
  };
}
