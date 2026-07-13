import type { FileEntry, ProjectCatalogEntry } from "@/lib/types";
import type { Pipeline } from "@/lib/pipelines/types";
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
  if (file.root === "claude-projects") return file.kind === "session" && !file.parent;
  if (file.root === "codex-sessions") return !file.parent;
  return false;
}

export function isSubagent(file: FileEntry): boolean {
  return file.root === "claude-projects" && file.kind === "subagent";
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

/** Background helpers without agent reasoning: bash task outputs. */
export function isAuxTask(file: FileEntry): boolean {
  return file.engine === "shell";
}

export function projectKey(file: FileEntry): string {
  return file.project || "other";
}

/**
 * Initial cwd for a project draft. Handoffs preserve the source conversation's
 * exact checkout. Fresh drafts choose the canonical root seen most often in
 * the project's conversations, with newest activity breaking equal counts.
 */
export function draftWorkingDirectory(
  files: readonly FileEntry[],
  project: string,
  sourcePath?: string,
  fallbacks: readonly string[] = [],
): string {
  if (sourcePath) {
    const source = files.find((file) => file.path === sourcePath);
    if (source?.cwd?.trim()) return source.cwd.trim();
  }

  const candidates = new Map<string, { count: number; newest: number }>();
  for (const file of files) {
    if (projectKey(file) !== project) continue;
    if (file.projectRoot === null) continue;
    const cwd = file.projectRoot?.trim() || file.cwd?.trim();
    if (!cwd) continue;
    const current = candidates.get(cwd) ?? { count: 0, newest: 0 };
    current.count += 1;
    current.newest = Math.max(current.newest, file.mtime);
    candidates.set(cwd, current);
  }
  const derived = [...candidates]
    .sort(([leftPath, left], [rightPath, right]) =>
      right.count - left.count || right.newest - left.newest || leftPath.localeCompare(rightPath))[0]?.[0] ?? "";
  return derived || fallbacks.find((cwd) => cwd.trim())?.trim() || "";
}

export function projectDraftWorkingDirectory(
  files: readonly FileEntry[],
  project: string,
  projectCatalog: readonly ProjectCatalogEntry[],
  sourcePath?: string,
  fallbacks: readonly string[] = [],
  deterministicFallback = "/",
): string {
  if (sourcePath) {
    const sourceCwd = files.find((file) => file.path === sourcePath)?.cwd?.trim();
    if (sourceCwd) return sourceCwd;
  }
  const catalogRoot = projectCatalog.find((entry) => entry.project === project)?.projectRoot?.trim() ?? "";
  if (catalogRoot) return catalogRoot;
  return draftWorkingDirectory(files, project, undefined, [...fallbacks, deterministicFallback]) || deterministicFallback;
}

export interface ProjectSummary {
  project: string;
  /** Live entries anywhere in the project (branches running right now). */
  liveCount: number;
  attentionCount: number;
  /** Root conversations in the project. */
  conversations: number;
  smt: number;
  /** Present only through the full project catalog, outside the recent file set. */
  catalogOnly: boolean;
}

/* Workflow states whose strip is actively doing work: they light the rail
   dot the way a live transcript does. */
const WF_BUSY = new Set<Workflow["state"]>(["provisioning", "implementing", "reviewing", "finishing"]);

export function buildProjectSummaries(
  files: FileEntry[],
  now: number = Date.now() / 1000,
  workflows: Workflow[] = [],
  projectCatalog: ProjectCatalogEntry[] = [],
  pipelines: Pipeline[] = [],
): ProjectSummary[] {
  const map = new Map<string, ProjectSummary>();
  const summaryFor = (key: string): ProjectSummary => {
    let summary = map.get(key);
    if (!summary) {
      summary = { project: key, liveCount: 0, attentionCount: 0, conversations: 0, smt: 0, catalogOnly: true };
      map.set(key, summary);
    }
    return summary;
  };
  for (const file of files) {
    const summary = summaryFor(projectKey(file));
    summary.catalogOnly = false;
    if (file.activity === "live") summary.liveCount += 1;
    /* Same membership the attention queue counts (hard-blocked plus in-TTL
       stalled), so the rail badge, the global badge and the title agree. */
    if (attentionId(file, now) !== null) summary.attentionCount += 1;
    if (isConversation(file)) summary.conversations += 1;
    summary.smt = Math.max(summary.smt, file.mtime);
  }
  for (const entry of projectCatalog) {
    if (!entry.project) continue;
    const summary = summaryFor(entry.project);
    summary.conversations = Math.max(summary.conversations, entry.conversations);
    summary.smt = Math.max(summary.smt, entry.smt);
  }
  /* Workflows keep their stamped project reachable even before any transcript
     exists (provisioning, a parked setup): the row must be there for the
     strip's retry/close controls to be reachable at all. */
  for (const wf of workflows) {
    if (wf.state === "closed" || !wf.project) continue;
    const summary = summaryFor(wf.project);
    summary.catalogOnly = false;
    if (WF_BUSY.has(wf.state)) summary.liveCount += 1;
    if (wf.state === "needs_decision" || wf.state === "paused") summary.attentionCount += 1;
    summary.smt = Math.max(summary.smt, (Date.parse(wf.createdAt) || 0) / 1000);
  }
  for (const pipeline of pipelines) {
    if (pipeline.state === "closed" || !pipeline.project) continue;
    const summary = summaryFor(pipeline.project);
    summary.catalogOnly = false;
    if (pipeline.state === "provisioning" || pipeline.state === "running") summary.liveCount += 1;
    if (pipeline.state === "needs_decision" || pipeline.state === "paused") summary.attentionCount += 1;
    summary.smt = Math.max(summary.smt, (Date.parse(pipeline.createdAt) || 0) / 1000);
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
function columnWorthy(file: FileEntry, expandedConversationPaths?: ReadonlySet<string>): boolean {
  return (
    !isAuxTask(file) &&
    (file.activity === "live" ||
      file.proc === "running" ||
      (file.activity === "recent" && isChildConversation(file)) ||
      (isChildConversation(file) && expandedConversationPaths?.has(file.path) === true))
  );
}

function activeWork(file: FileEntry): boolean {
  return columnWorthy(file) || (isAuxTask(file) && (file.activity === "live" || file.proc === "running"));
}

function assembleGroup(
  root: FileEntry,
  kids: Map<string, FileEntry[]>,
  expandedConversationPaths?: ReadonlySet<string>,
): BranchGroup {
  const descendants = subtree(root, kids);
  const liveRank = (file: FileEntry) => (file.activity === "live" ? 0 : 1);
  /* Every child conversation in an active group renders as a connected node
     below its parent — a claude subagent, a codex child session, a reviewer
     subtask is real tree structure, not a detached right-side chip. Live and
     running non-conversation work keeps a column too. This mirrors the
     structural rule buildArchiveBranchGroups already uses; the "opens an active
     group" decision stays activity-based in buildBranchGroups, but once a group
     is open its child conversations are always wired in as nodes. */
  const branches = descendants
    .filter((file) => isChildConversation(file) || columnWorthy(file, expandedConversationPaths))
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
  /* Child conversations are all columns now; the leftovers are technical items
     (bash tasks, codex job logs, compaction-chain predecessor sessions) that
     stay as quiet chips in the group's under-deck. */
  const finished = descendants.filter((file) => !taken.has(file.path)).sort((a, b) => b.mtime - a.mtime);
  const returnable: FileEntry[] = [];
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
export interface BranchGroupOptions {
  /** Quiet conversations promoted into full scheme nodes. */
  expandedConversationPaths?: ReadonlySet<string>;
}

export function buildBranchGroups(files: FileEntry[], project: string, options: BranchGroupOptions = {}): BranchGroup[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const kids = kidsIndex(files);
  const roots = new Map<string, FileEntry>();
  const orphanTasks = new Map<string, FileEntry>();
  const { expandedConversationPaths } = options;
  for (const file of files) {
    if (projectKey(file) !== project) continue;
    const expanded = expandedConversationPaths?.has(file.path) === true;
    if (
      file.activity === "live" ||
      file.proc === "running" ||
      (file.activity === "recent" && isChildConversation(file)) ||
      (expanded && (isConversation(file) || isChildConversation(file)))
    ) {
      const root = rootOf(file, byPath);
      if (isAuxTask(root)) orphanTasks.set(root.path, root);
      else roots.set(root.path, root);
      continue;
    }
    if (file.activity === "recent" && isConversation(file)) roots.set(file.path, file);
  }
  const groups = [...roots.values()].map((root) => assembleGroup(root, kids, expandedConversationPaths));
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

/**
 * Quiet project history for the canvas fallback: latest project rows plus
 * ancestor nodes needed to keep their parent arrows intact.
 */
export function buildArchiveBranchGroups(files: FileEntry[], project: string, limit = 100): BranchGroup[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const kids = kidsIndex(files);
  const selected = new Set(
    files
      .filter((file) => projectKey(file) === project)
      .sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
      .slice(0, limit)
      .map((file) => file.path),
  );
  const keep = new Set<string>();
  for (const path of selected) {
    let cur = byPath.get(path) ?? null;
    const seen = new Set<string>();
    while (cur && projectKey(cur) === project && !seen.has(cur.path)) {
      seen.add(cur.path);
      keep.add(cur.path);
      cur = cur.parent ? (byPath.get(cur.parent) ?? null) : null;
    }
  }

  const roots = new Map<string, FileEntry>();
  const orphanTasks = new Map<string, FileEntry>();
  for (const path of keep) {
    const file = byPath.get(path);
    if (!file) continue;
    const root = rootOf(file, byPath);
    if (projectKey(root) !== project) continue;
    if (isAuxTask(root)) orphanTasks.set(root.path, root);
    else roots.set(root.path, root);
  }

  const groups: BranchGroup[] = [];
  for (const root of roots.values()) {
    const descendants = subtree(root, kids)
      .filter((file) => keep.has(file.path) && projectKey(file) === project)
      .sort((a, b) => activityBand(a) - activityBand(b) || b.mtime - a.mtime || a.path.localeCompare(b.path));
    const fullNodes = descendants.filter((file) => !isAuxTask(file) && isChildConversation(file));
    const fullPaths = new Set([root.path, ...fullNodes.map((file) => file.path)]);
    const columns: BranchColumn[] = [root, ...fullNodes].map((file) => ({ file, tasks: [] }));
    const finished = descendants.filter((file) => !fullPaths.has(file.path));
    const smt = Math.max(root.mtime, ...descendants.map((file) => file.mtime));
    groups.push({ key: root.path, columns, returnable: [], finished, smt, orphanTask: false });
  }
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
  return groups.sort((a, b) => tick5(b.smt) - tick5(a.smt) || a.key.localeCompare(b.key));
}

/** Root conversations for the quiet history list, with a non-empty fallback. */
export function quietHistoryRows(files: FileEntry[], project: string): FileEntry[] {
  const projectRows = files
    .filter((file) => projectKey(file) === project)
    .sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
  const roots = projectRows.filter(isConversation);
  return roots.length ? roots : projectRows;
}

export type ProjectView = "scheme" | "list";

export function resolveProjectView({
  preferredView,
  hasNodes,
  hasArchiveNodes,
  hasHistoryRows,
}: {
  preferredView: ProjectView | null;
  hasNodes: boolean;
  hasArchiveNodes: boolean;
  hasHistoryRows: boolean;
}): ProjectView {
  const schemeAvailable = hasNodes || hasArchiveNodes;
  /* An explicit toggle choice wins whenever the chosen view has something to
     show — the Схема/Список control must switch reliably even while the scheme
     still holds live nodes (issue #177 item 7). Previously an active project was
     pinned to the scheme regardless of a saved «list» selection, so the toggle
     read as unresponsive. */
  if (preferredView === "list" && hasHistoryRows) return "list";
  if (preferredView === "scheme" && schemeAvailable) return "scheme";
  /* No usable preference: an active project opens on the scheme, an otherwise
     quiet one with history opens on the list. */
  if (hasNodes) return "scheme";
  return hasHistoryRows ? "list" : "scheme";
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

/** Idle root conversations whose descendants still make an active dashboard group. */
export function quietRootsWithActiveDescendants(files: FileEntry[], project: string, activeRoots: ReadonlySet<string>): Set<string> {
  const kids = kidsIndex(files);
  const roots = new Set<string>();
  for (const file of files) {
    if (projectKey(file) !== project || !isConversation(file) || !activeRoots.has(file.path) || file.activity !== "idle") continue;
    if (subtree(file, kids).some(activeWork)) {
      roots.add(file.path);
    }
  }
  return roots;
}

/**
 * Leftovers without a tree of their own: childless quiet conversations and
 * parentless finished tasks/jobs. Rendered as one dense collapsed strip.
 */
export function residualItems(
  files: FileEntry[],
  project: string,
  activeRoots: ReadonlySet<string>,
  quietActiveRoots: ReadonlySet<string> = new Set(),
): FileEntry[] {
  const kids = kidsIndex(files);
  return files
    .filter((file) => {
      if (projectKey(file) !== project || file.parent) return false;
      if (quietActiveRoots.has(file.path)) return true;
      if (activeRoots.has(file.path)) return false;
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
