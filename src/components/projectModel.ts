import type { FileEntry } from "@/lib/types";
import type { Workflow } from "@/lib/workflows/types";

import { attentionId } from "./attention";

export type ActivityBand = 0 | 1 | 2 | 3;

export const OVERVIEW = "__overview__";

/**
 * Freshness in 5-minute buckets: live files bump mtime every poll, so raw
 * mtime ties reshuffle columns continuously; bucketed time plus a path
 * tie-breaker keeps the order stable while staying recency-driven.
 */
const tick5 = (t: number) => Math.floor(t / 300);

export function activityBand(file: FileEntry): ActivityBand {
  if (file.activity === "live") return 0;
  if (file.activity === "recent") return 1;
  if (file.activity === "stalled") return 2;
  return 3;
}

export function isConversation(file: FileEntry): boolean {
  // A claude session with a parent is a compaction-chain predecessor: it
  // belongs to its successor's tree, so it no longer counts as a root.
  if (file.root === "claude-projects") return file.kind === "сесія" && !file.parent;
  if (file.root === "codex-sessions") return !file.parent;
  return false;
}

export function isSubagent(file: FileEntry): boolean {
  return file.root === "claude-projects" && file.kind === "субагент";
}

/**
 * Child conversation inside a tree: a claude subagent or a codex session
 * spawned by a job. These are conversations, never finished technical items —
 * a recent one (just answered or waiting for a reply) keeps a full column.
 */
export function isChildConversation(file: FileEntry): boolean {
  if (isSubagent(file)) return true;
  /* A conversation spawned by a handoff is a branch of its source — unlike a
     claude main with a parent from compaction chaining, which is quiet history. */
  if (file.handoff && file.parent) return true;
  return file.root === "codex-sessions" && !!file.parent;
}

/** Background helpers without agent reasoning: bash tasks and codex job service logs. */
export function isAuxTask(file: FileEntry): boolean {
  return file.engine === "shell" || file.root === "codex-jobs";
}

export function projectKey(file: FileEntry): string {
  return file.project || "інше";
}

export interface ProjectSummary {
  project: string;
  /** Live entries anywhere in the project (branches running right now). */
  liveCount: number;
  attentionCount: number;
  /** Root conversations in the project. */
  conversations: number;
  smt: number;
}

/* Workflow states whose strip is actively doing work: they light the rail
   dot the way a live transcript does. */
const WF_BUSY = new Set<Workflow["state"]>(["provisioning", "implementing", "reviewing", "finishing"]);

export function buildProjectSummaries(
  files: FileEntry[],
  now: number = Date.now() / 1000,
  workflows: Workflow[] = [],
): ProjectSummary[] {
  const map = new Map<string, ProjectSummary>();
  const summaryFor = (key: string): ProjectSummary => {
    let summary = map.get(key);
    if (!summary) {
      summary = { project: key, liveCount: 0, attentionCount: 0, conversations: 0, smt: 0 };
      map.set(key, summary);
    }
    return summary;
  };
  for (const file of files) {
    const summary = summaryFor(projectKey(file));
    if (file.activity === "live") summary.liveCount += 1;
    /* Same membership the attention queue counts (hard-blocked plus in-TTL
       stalled), so the rail badge, the global badge and the title agree. */
    if (attentionId(file, now) !== null) summary.attentionCount += 1;
    if (isConversation(file)) summary.conversations += 1;
    summary.smt = Math.max(summary.smt, file.mtime);
  }
  /* Workflows keep their stamped project reachable even before any transcript
     exists (provisioning, a parked setup): the row must be there for the
     strip's retry/close controls to be reachable at all. */
  for (const wf of workflows) {
    if (wf.state === "closed" || !wf.project) continue;
    const summary = summaryFor(wf.project);
    if (WF_BUSY.has(wf.state)) summary.liveCount += 1;
    if (wf.state === "needs_decision" || wf.state === "paused") summary.attentionCount += 1;
    summary.smt = Math.max(summary.smt, (Date.parse(wf.createdAt) || 0) / 1000);
  }
  return [...map.values()].sort((a, b) => {
    const al = a.attentionCount > 0;
    const bl = b.attentionCount > 0;
    if (al !== bl) return al ? -1 : 1;
    if (a.liveCount !== b.liveCount) return b.liveCount - a.liveCount;
    return tick5(b.smt) - tick5(a.smt) || a.project.localeCompare(b.project);
  });
}

export interface BranchColumn {
  file: FileEntry;
  /** Background tasks attached under this column as collapsed rows. */
  tasks: FileEntry[];
}

export interface BranchGroup {
  key: string;
  /** Root conversation column first, live descendant branch columns after it. */
  columns: BranchColumn[];
  /** Quiet child conversations that can still be resumed: their owning session is alive. */
  returnable: FileEntry[];
  /** Finished descendants: dead-context conversations and quiet technical items. */
  finished: FileEntry[];
  /** Latest mtime across the group subtree, drives left-to-right freshness order. */
  smt: number;
  /** A parentless background task rendered as a narrow collapsed column. */
  orphanTask: boolean;
}

function rootOf(file: FileEntry, byPath: Map<string, FileEntry>): FileEntry {
  const seen = new Set<string>();
  let cur = file;
  while (cur.parent && !seen.has(cur.path)) {
    seen.add(cur.path);
    const parent = byPath.get(cur.parent);
    if (!parent) break;
    cur = parent;
  }
  return cur;
}

export function kidsIndex(files: FileEntry[]): Map<string, FileEntry[]> {
  const map = new Map<string, FileEntry[]>();
  for (const file of files) {
    if (!file.parent) continue;
    const list = map.get(file.parent);
    if (list) list.push(file);
    else map.set(file.parent, [file]);
  }
  return map;
}

export function subtree(root: FileEntry, kids: Map<string, FileEntry[]>): FileEntry[] {
  const out: FileEntry[] = [];
  const stack = [...(kids.get(root.path) ?? [])];
  const seen = new Set<string>([root.path]);
  while (stack.length) {
    const node = stack.pop()!;
    if (seen.has(node.path)) continue;
    seen.add(node.path);
    out.push(node);
    stack.push(...(kids.get(node.path) ?? []));
  }
  return out;
}

/** Subtree sizes for every entry, on one shared kids index. */
export function descendantCounts(files: FileEntry[]): Map<string, number> {
  const kids = kidsIndex(files);
  const counts = new Map<string, number>();
  for (const file of files) counts.set(file.path, subtree(file, kids).length);
  return counts;
}

/** Descendants that deserve a full transcript column next to the root. */
function columnWorthy(file: FileEntry): boolean {
  return !isAuxTask(file) && (file.activity === "live" || (file.activity === "recent" && isChildConversation(file)));
}

/**
 * A quiet child conversation is returnable while the session it would be
 * resumed from stays alive. The walk stops at the nearest ancestor session
 * record, so subagents of a compaction-chain predecessor count as finished:
 * that session's context is gone even though its successor lives on.
 */
function ownerSessionAlive(file: FileEntry, byPath: Map<string, FileEntry>): boolean {
  const seen = new Set<string>([file.path]);
  let cur = file;
  while (cur.parent && !seen.has(cur.parent)) {
    const parent = byPath.get(cur.parent);
    if (!parent) return false;
    seen.add(parent.path);
    if (parent.kind === "сесія") return parent.activity === "live" || parent.activity === "recent";
    cur = parent;
  }
  return false;
}

function assembleGroup(root: FileEntry, kids: Map<string, FileEntry[]>, byPath: Map<string, FileEntry>): BranchGroup {
  const descendants = subtree(root, kids);
  const liveRank = (file: FileEntry) => (file.activity === "live" ? 0 : 1);
  const branches = descendants
    .filter(columnWorthy)
    .sort((a, b) => liveRank(a) - liveRank(b) || tick5(b.mtime) - tick5(a.mtime) || a.path.localeCompare(b.path));
  const liveTasks = descendants
    .filter((file) => isAuxTask(file) && file.activity === "live")
    .sort((a, b) => tick5(b.mtime) - tick5(a.mtime) || a.path.localeCompare(b.path));
  const columns: BranchColumn[] = [root, ...branches].map((file) => ({ file, tasks: [] }));
  const columnByPath = new Map(columns.map((column) => [column.file.path, column]));
  for (const task of liveTasks) {
    const owner = (task.parent && columnByPath.get(task.parent)) || columns[0]!;
    owner.tasks.push(task);
  }
  const taken = new Set([...columnByPath.keys(), ...liveTasks.map((task) => task.path)]);
  const leftovers = descendants.filter((file) => !taken.has(file.path)).sort((a, b) => b.mtime - a.mtime);
  const returnable = leftovers.filter(
    (file) => isChildConversation(file) && ownerSessionAlive(file, byPath),
  );
  const returnablePaths = new Set(returnable.map((file) => file.path));
  const finished = leftovers.filter((file) => !returnablePaths.has(file.path));
  const smt = Math.max(...columns.map((column) => column.file.mtime), ...liveTasks.map((task) => task.mtime));
  return { key: root.path, columns, returnable, finished, smt, orphanTask: false };
}


/**
 * One group per active branch tree: the root conversation opens the group,
 * live descendant agents (subagents, codex rollouts) get their own columns.
 * Live background tasks (bash, codex job logs) never take a full column —
 * they attach to their parent's column as collapsed rows; a parentless one
 * becomes a narrow stub group. Every other descendant of the tree — finished
 * subagents, quiet tasks, compaction-chain predecessor sessions — stays
 * visible as a collapsed chip in the group's `finished` stack. Recent root
 * conversations and recent child conversations (claude subagents, codex
 * job sessions) keep full columns too, because "done between user messages"
 * must not hide active work.
 */
export function buildBranchGroups(files: FileEntry[], project: string): BranchGroup[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const kids = kidsIndex(files);
  const roots = new Map<string, FileEntry>();
  const orphanTasks = new Map<string, FileEntry>();
  for (const file of files) {
    if (projectKey(file) !== project) continue;
    if (file.activity === "live" || (file.activity === "recent" && isChildConversation(file))) {
      const root = rootOf(file, byPath);
      if (isAuxTask(root)) orphanTasks.set(root.path, root);
      else roots.set(root.path, root);
      continue;
    }
    if (file.activity === "recent" && isConversation(file)) roots.set(file.path, file);
  }
  const groups = [...roots.values()].map((root) => assembleGroup(root, kids, byPath));
  for (const task of orphanTasks.values()) {
    groups.push({
      key: task.path,
      columns: [{ file: task, tasks: [] }],
      returnable: [],
      finished: [],
      smt: task.mtime,
      orphanTask: true,
    });
  }
  /* Conversations own the freshness order; parentless task stubs trail the row. */
  return groups.sort((a, b) => {
    if (a.orphanTask !== b.orphanTask) return a.orphanTask ? 1 : -1;
    return tick5(b.smt) - tick5(a.smt) || a.key.localeCompare(b.key);
  });
}

export interface TreeCard {
  root: FileEntry;
  /** All descendants of the root, any activity. */
  branchCount: number;
  /** Latest mtime across the tree. */
  smt: number;
  band: ActivityBand;
}

/**
 * Quiet trees of the project: root conversations without a dashboard group
 * but with descendants. Shown as compact collapsed cards on the same canvas,
 * expandable in place.
 */
export function collapsedTrees(files: FileEntry[], project: string, activeRoots: ReadonlySet<string>): TreeCard[] {
  const kids = kidsIndex(files);
  const cards: TreeCard[] = [];
  for (const file of files) {
    if (projectKey(file) !== project || !isConversation(file) || activeRoots.has(file.path)) continue;
    const descendants = subtree(file, kids);
    if (!descendants.length) continue;
    let smt = file.mtime;
    let band = activityBand(file);
    for (const node of descendants) {
      smt = Math.max(smt, node.mtime);
      band = Math.min(band, activityBand(node)) as ActivityBand;
    }
    cards.push({ root: file, branchCount: descendants.length, smt, band });
  }
  return cards.sort((a, b) => a.band - b.band || b.smt - a.smt);
}

/**
 * Leftovers without a tree of their own: childless quiet conversations and
 * parentless finished tasks/jobs. Rendered as one dense collapsed strip.
 */
export function residualItems(files: FileEntry[], project: string, activeRoots: ReadonlySet<string>): FileEntry[] {
  const kids = kidsIndex(files);
  return files
    .filter((file) => {
      if (projectKey(file) !== project || file.parent || activeRoots.has(file.path)) return false;
      if (kids.get(file.path)?.length) return false;
      return file.activity !== "live";
    })
    .sort((a, b) => activityBand(a) - activityBand(b) || b.mtime - a.mtime);
}

export interface DescendantRow {
  file: FileEntry;
  /** 1 for direct children, 2 for grandchildren, … */
  depth: number;
}

/** Depth-first subtree of a node: children stay under their parent, siblings ordered by state then recency. */
export function descendantsOf(file: FileEntry | null, files: FileEntry[]): DescendantRow[] {
  if (!file) return [];
  const kids = kidsIndex(files);
  const out: DescendantRow[] = [];
  const seen = new Set<string>([file.path]);
  const walk = (parent: FileEntry, depth: number) => {
    const children = (kids.get(parent.path) ?? [])
      .filter((child) => !seen.has(child.path))
      .sort((a, b) => activityBand(a) - activityBand(b) || b.mtime - a.mtime);
    for (const child of children) {
      seen.add(child.path);
      out.push({ file: child, depth });
      walk(child, depth + 1);
    }
  };
  walk(file, 1);
  return out;
}
