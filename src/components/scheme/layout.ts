import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

import type { DeckRound } from "@/components/flows/RoundDeck";
import { draftSrc } from "@/components/DraftAgentPane";
import { claimedReviewerPaths, flowByImplementer } from "@/components/flows/flowModel";

import { buildAnchorIndex, deckKey, deriveFlowLinks, type AgentLink } from "./agentLinks";
import { type BranchGroup, descendantsOf, isChildConversation, kidsIndex } from "@/components/projectModel";
import { engineColor } from "@/components/utils";

/* World geometry of the scheme canvas, in unscaled pixels. */
export const NODE_W = 600;
const ROOT_H = 780;
const CHILD_H = 680;
export const GAP_X = 48;
/* Vertical corridor between generations: arrows plus the under-deck chip. */
const GAP_Y = 130;
/* Children start slightly right of the parent's left edge — the requested
   "below and a bit to the side" staircase read. */
const INDENT = 64;
const GROUP_GAP = 150;
const PAD = 100;
/* Corridor between an implementer and its reviewer deck: wide enough for the
   two cycle arcs and the ⟳ hub between the cards. Exported so the flow strip
   can span the whole pair. */
export const LOOP_GAP = 170;
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
  /** Agent-to-agent links between board occupants (flow links today, message
      links from #12 later), endpoints resolved against byPath keys. */
  links: AgentLink[];
  drafts: DraftNode[];
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
    const rounds: DeckRound[] = flow.rounds.map((round) => ({
      round,
      file: round.reviewerPath ? (byAll.get(round.reviewerPath) ?? null) : null,
    }));
    const deck: DeckNode = { key: deckKey(flow.id), flow, rounds, x, y, w: NODE_W, h: deckHeight(flow.rounds.length, baseH) };
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
      for (const child of children) {
        edges.push({
          to: child.file.path,
          x1: x + 40,
          y1: y + h,
          x2: cx + NODE_W / 2,
          y2: childTop,
          color: engineColor(child.file),
          live: child.file.activity === "live",
        });
        cx += place(child, cx, childTop, depth + 1) + GAP_X;
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
          color: "#9a9aa4",
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
          color: "#5a51e0",
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

  let bottom = 0;
  for (const node of nodes) bottom = Math.max(bottom, node.y + node.h);
  for (const stack of stacks) bottom = Math.max(bottom, stack.y + stack.h);
  for (const deck of decks) bottom = Math.max(bottom, deck.y + deck.h);
  for (const draft of drafts) bottom = Math.max(bottom, draft.y + draft.h);
  /* Links resolve against what this pass actually placed, so geometry and
     link endpoints can never disagree. */
  const anchors = buildAnchorIndex(
    nodes.map((node) => node.file.path),
    decks.map((deck) => ({ key: deck.key, flow: deck.flow })),
    stacks.map((stack) => ({ key: stack.key, paths: stack.items.map((item) => item.file.path) })),
  );
  return {
    nodes,
    edges,
    stacks,
    decks,
    loops,
    links: deriveFlowLinks(flows, (key) => anchors.get(key) ?? null),
    drafts,
    byPath: new Map<string, SchemeRect>([
      ...nodes.map((node) => [node.file.path, node] as const),
      ...drafts.map((draft) => [draft.key, draft] as const),
      ...stacks.map((stack) => [stack.key, stack] as const),
      ...decks.map((deck) => [deck.key, deck] as const),
    ]),
    width: Math.max(cursor - GROUP_GAP + PAD, PAD * 2 + NODE_W),
    /* Extra room under the last generation for decks and expanded panels. */
    height: bottom + PAD + 140,
  };
}
