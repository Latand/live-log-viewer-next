/* Test-only #418 regression fixture: a board far larger than the marker cap so
   the bounded projection and its cluster folding are exercised. Builds a
   SchemeLayout-shaped object directly (no second buildSchemeLayout) plus board
   tasks and collapsed worker stacks. */
import type { DeckNode, DraftNode, MiniStack, SchemeEdge, SchemeLayout, SchemeNode, SchemeRect } from "@/components/scheme/layout";
import type { WorkerStack } from "@/components/scheme/workerCollapse";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

const NODE_W = 220;
const NODE_H = 120;
const COL_GAP = 60;
const ROW_GAP = 60;
const COLS = 24;

export function fixtureFile(path: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    path,
    root: "codex-sessions",
    name: path.split("/").pop() || path,
    project: "demo",
    title: "Conversation " + path,
    engine: "codex",
    kind: "session",
    fmt: "codex",
    parent: null,
    mtime: 1,
    size: 1,
    activity: "idle",
    proc: "running",
    pid: null,
    conversationId: "conv-" + path,
    pendingQuestion: null,
    waitingInput: null,
    ...overrides,
  } as FileEntry;
}

function rectAt(index: number): SchemeRect {
  const col = index % COLS;
  const row = Math.floor(index / COLS);
  return { x: col * (NODE_W + COL_GAP), y: row * (NODE_H + ROW_GAP), w: NODE_W, h: NODE_H };
}

export interface MobileMapFixture {
  layout: SchemeLayout;
  tasks: BoardTask[];
  workerStacks: WorkerStack[];
  /** A known-good pick key (a placed root node) for the round-trip test. */
  sampleNodePath: string;
}

/** Build a fixture with `nodeCount` placed conversations (default 500, past the
    400 marker cap), plus decks, drafts, mini-stacks, tasks and worker stacks. */
export function buildMobileMapFixture(nodeCount = 500): MobileMapFixture {
  const nodes: SchemeNode[] = [];
  const edges: SchemeEdge[] = [];
  const byPath = new Map<string, SchemeRect>();
  let maxX = 0;
  let maxY = 0;

  for (let index = 0; index < nodeCount; index += 1) {
    const path = `/codex/session-${index}.jsonl`;
    const rect = rectAt(index);
    const isRoot = index % 4 === 0;
    const file = fixtureFile(path, { title: `Session ${index}`, activity: index % 3 === 0 ? "live" : "idle" });
    nodes.push({ ...rect, file, tasks: [], under: [], isRoot });
    byPath.set(path, rect);
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
    if (!isRoot && index > 0) {
      const parent = rectAt(index - 1);
      edges.push({ to: path, x1: parent.x + parent.w, y1: parent.y + parent.h / 2, x2: rect.x, y2: rect.y + rect.h / 2, color: "#888", live: false });
    }
  }

  const decks: DeckNode[] = Array.from({ length: 8 }, (_, index) => {
    const rect = rectAt(nodeCount + index);
    maxY = Math.max(maxY, rect.y + rect.h);
    return {
      key: "deck::flow-" + index,
      flow: { id: "flow-" + index, implementerPath: nodes[index]!.file.path } as DeckNode["flow"],
      rounds: [{ n: 1 } as unknown as DeckNode["rounds"][number]],
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
    };
  });

  const drafts: DraftNode[] = Array.from({ length: 4 }, (_, index) => {
    const rect = rectAt(nodeCount + 8 + index);
    maxY = Math.max(maxY, rect.y + rect.h);
    return { ...rect, key: "draft::d" + index, id: "d" + index };
  });

  const stacks: MiniStack[] = Array.from({ length: 6 }, (_, index) => {
    const rect = rectAt(nodeCount + 12 + index);
    maxY = Math.max(maxY, rect.y + rect.h);
    const item = fixtureFile(`/codex/quiet-${index}.jsonl`, { title: `Quiet ${index}` });
    return { key: "stack::s" + index, parent: nodes[index]!.file.path, items: [{ file: item, branches: 0 }], x: rect.x, y: rect.y, w: rect.w, h: rect.h };
  });

  const layout: SchemeLayout = {
    nodes,
    edges,
    stacks,
    decks,
    loops: [],
    groups: [],
    links: [],
    drafts,
    slots: [],
    regionTasks: [],
    byPath,
    width: maxX + COL_GAP,
    height: maxY + ROW_GAP,
  };

  const tasks: BoardTask[] = Array.from({ length: 12 }, (_, index) => ({
    id: "task-" + index,
    project: "demo",
    status: index % 2 ? "assigned" : "blocked",
    text: `Task ${index}\nbody`,
    placement: index % 3 ? "pinned" : "unplaced",
    ...(index % 3 ? { pos: { x: index * 200, y: -300 } } : {}),
    assignments: [],
    createdAt: "2026-07-18T00:00:00Z",
    updatedAt: "2026-07-18T00:00:00Z",
  } as unknown as BoardTask));

  const workerStacks: WorkerStack[] = Array.from({ length: 5 }, (_, index) => ({
    key: "workers::w" + index,
    kind: "flow",
    id: "flow-" + index,
    items: index === 0 ? [] : [fixtureFile(`/codex/worker-${index}.jsonl`, { title: `Worker ${index}` })],
  }));

  return { layout, tasks, workerStacks, sampleNodePath: nodes[0]!.file.path };
}
