import type { Flow } from "@/lib/flows/types";
import type { FileEntry } from "@/lib/types";

import type { DeckRound } from "@/components/flows/RoundDeck";
import { claimedReviewerPaths, flowByImplementer } from "@/components/flows/flowModel";
import { type BranchGroup, descendantsOf, isChildConversation, kidsIndex } from "@/components/projectModel";
import { engineColor } from "@/components/utils";

/* World geometry of the scheme canvas, in unscaled pixels. */
export const NODE_W = 600;
const ROOT_H = 780;
const CHILD_H = 680;
const GAP_X = 48;
/* Vertical corridor between generations: arrows plus the under-deck chip. */
const GAP_Y = 130;
/* Children start slightly right of the parent's left edge — the requested
   "below and a bit to the side" staircase read. */
const INDENT = 64;
const GROUP_GAP = 150;
const PAD = 100;
/* Quiet-branch mini cards stacked under their parent pane. */
const MINI_W = 360;
const MINI_H = 52;
const MINI_GAP = 6;
const MINI_PAD = 8;
/* Rows visible before the stack starts scrolling internally. */
const MINI_MAX = 8;

export interface SchemeNode {
  file: FileEntry;
  /** Live background tasks docked inside the pane as collapsed strips. */
  tasks: FileEntry[];
  /** Quiet history lying "under" the node: previous chats, finished tasks. */
  under: FileEntry[];
  x: number;
  y: number;
  w: number;
  h: number;
  isRoot: boolean;
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

/** Review-round deck of a flow, occupying one child slot under its implementer. */
export interface DeckNode {
  key: string;
  flow: Flow;
  rounds: DeckRound[];
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SchemeLayout {
  nodes: SchemeNode[];
  edges: SchemeEdge[];
  stacks: MiniStack[];
  decks: DeckNode[];
  byPath: Map<string, SchemeNode>;
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

/* Card spines under a deck's front card (mirrors RoundDeck's TAB_STEP/TAB_MAX). */
const DECK_TAB_STEP = 30;
const DECK_TAB_MAX = 6;
const deckHeight = (roundCount: number) => CHILD_H + Math.min(Math.max(roundCount - 1, 0), DECK_TAB_MAX) * DECK_TAB_STEP;

/* Flow states in which the reviewer side is actively doing something. */
const DECK_LIVE_STATES = new Set<Flow["state"]>(["spawning", "reviewing", "relaying"]);

export function buildSchemeLayout(
  groups: BranchGroup[],
  manual: FileEntry[],
  files: FileEntry[],
  flows: Flow[] = [],
): SchemeLayout {
  const byAll = new Map(files.map((file) => [file.path, file]));
  const kids = kidsIndex(files);
  const nodes: SchemeNode[] = [];
  const edges: SchemeEdge[] = [];
  const stacks: MiniStack[] = [];
  const decks: DeckNode[] = [];
  const deckFor = flowByImplementer(flows);
  const claimed = claimedReviewerPaths(flows);
  let cursor = PAD;

  const toMini = (file: FileEntry): MiniItem => ({ file, branches: kids.get(file.path)?.length ?? 0 });

  /* One deck per implementer node: rounds resolve their reviewer transcripts
     through the full file list, so headless runs join as soon as the scanner
     sees them. */
  const placeDeck = (flow: Flow, x: number, y: number): DeckNode => {
    const rounds: DeckRound[] = flow.rounds.map((round) => ({
      round,
      file: round.reviewerPath ? (byAll.get(round.reviewerPath) ?? null) : null,
    }));
    const deck: DeckNode = { key: "deck::" + flow.id, flow, rounds, x, y, w: NODE_W, h: deckHeight(flow.rounds.length) };
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
      const children = childrenOf.get(col.file.path) ?? [];
      let cx = x + INDENT;
      for (const child of children) {
        edges.push({
          to: child.file.path,
          x1: x + 40,
          y1: y + h,
          x2: cx + NODE_W / 2,
          y2: y + h + GAP_Y,
          color: engineColor(child.file),
          live: child.file.activity === "live",
        });
        cx += place(child, cx, y + h + GAP_Y, depth + 1) + GAP_X;
      }
      /* The review deck takes the first free child slot: the loop reads as
         "the reviewer position" right under its implementer. */
      const flow = deckFor.get(col.file.path);
      if (flow) {
        const deck = placeDeck(flow, cx, y + h + GAP_Y);
        edges.push({
          to: deck.key,
          x1: x + 40,
          y1: y + h,
          x2: cx + NODE_W / 2,
          y2: y + h + GAP_Y,
          color: "#5a51e0",
          live: DECK_LIVE_STATES.has(flow.state),
        });
        cx += NODE_W + GAP_X;
      }
      const quiet = stackFor.get(col.file.path)?.filter((entry) => !claimed.has(entry.path));
      if (quiet?.length) {
        const sy = y + h + GAP_Y;
        stacks.push({
          key: col.file.path + "::stack",
          parent: col.file.path,
          items: quiet.map(toMini),
          x: cx,
          y: sy,
          w: MINI_W,
          h: stackHeight(quiet.length),
        });
        edges.push({
          to: col.file.path + "::stack",
          x1: x + 40,
          y1: y + h,
          x2: cx + MINI_W / 2,
          y2: sy,
          color: "#9a9aa4",
          live: false,
          dashed: true,
        });
        cx += MINI_W + GAP_X;
      }
      const used = cx - GAP_X - (x + INDENT);
      return used > 0 ? Math.max(NODE_W, INDENT + used) : NODE_W;
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

  let bottom = 0;
  for (const node of nodes) bottom = Math.max(bottom, node.y + node.h);
  for (const stack of stacks) bottom = Math.max(bottom, stack.y + stack.h);
  for (const deck of decks) bottom = Math.max(bottom, deck.y + deck.h);
  return {
    nodes,
    edges,
    stacks,
    decks,
    byPath: new Map(nodes.map((node) => [node.file.path, node])),
    width: Math.max(cursor - GROUP_GAP + PAD, PAD * 2 + NODE_W),
    /* Extra room under the last generation for decks and expanded panels. */
    height: bottom + PAD + 140,
  };
}
