import type { FileEntry, ProjectCatalogEntry } from "@/lib/types";
import { projectDisplayName } from "@/lib/displayNames";
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

/** Default age horizon for automatic card placement: a root conversation whose
    last activity falls inside it keeps an automatic card even while idle; one
    beyond it leaves the canvas for quiet history / «All conversations». */
export const DEFAULT_SCHEME_AGE_HORIZON_HOURS = 48;

/**
 * Operator-tunable placement horizon. `NEXT_PUBLIC_*` is inlined into the
 * client bundle by Next (the same style `workerCollapseIdleMs` uses), so the
 * horizon can be retuned without touching this code; a missing or malformed
 * value falls back to the two-day default.
 */
export function schemeAgeHorizonSeconds(): number {
  const raw = typeof process !== "undefined" ? process.env?.NEXT_PUBLIC_LLV_SCHEME_AGE_HORIZON_HOURS : undefined;
  const hours = raw ? Number(raw) : Number.NaN;
  return (Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_SCHEME_AGE_HORIZON_HOURS) * 3_600;
}

/**
 * May this entry occupy the canvas automatically, given its age? The one age
 * judgment every automatic placement path shares — root cards, child columns,
 * engine-tray promotions and pipeline slots alike — so a conversation cannot
 * enter the map through a rule that consults no clock.
 *
 * Live and running work is never bounded: a long-running session with an old
 * transcript keeps its node. Without a clock (`now <= 0` — the server render and
 * the hydration pass) age is unknowable, so nothing is bounded and both sides
 * paint the plain activity rule. Bounded entries are never lost: they stay in
 * «All conversations», quiet history, worker stacks and parent trays.
 */
export function withinPlacementHorizon(file: FileEntry, now: number, ageHorizonSeconds: number): boolean {
  if (file.activity === "live" || file.proc === "running") return true;
  /* The activity rule stays alongside the clock so a sub-15-minute horizon
     override can never out-tighten the activity the projection calls recent. */
  if (file.activity === "recent") return true;
  return now <= 0 || now - file.mtime <= ageHorizonSeconds;
}

export function activityBand(file: FileEntry): ActivityBand {
  if (file.activity === "live") return 0;
  if (file.activity === "recent") return 1;
  if (file.activity === "stalled") return 2;
  return 3;
}

export function isConversation(file: FileEntry): boolean {
  // A claude session with a parent is a compaction-chain predecessor: it
  // belongs to its successor's tree, so it no longer counts as a root.
  if (file.root === "claude-projects") {
    if (file.kind !== "session") return false;
    if (!file.parent) return true;
    /* A viewer-spawned conversation outside any pipeline/flow container is a
       root in its own project: its `parent` names the spawner's transcript —
       often a conversation of a different project — never a compaction
       predecessor of this one. Without this it renders nowhere: not a root,
       not a child (no handoff), and its parent's tree lives on another board. */
    const lineage = file.durableLineage;
    return lineage?.kind === "spawn" && !lineage.memberships.length && !file.handoff;
  }
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
  /* Durable Viewer lineage is the primary child proof for managed stages and
     flows. It survives transcript-path changes and carries the relationship
     without borrowing the operator handoff flag. */
  if (file.durableLineage?.parentConversationId) return true;
  if (file.durableLineage?.memberships.some((membership) => membership.parentConversationId)) return true;
  if (file.spawnOrigin === "viewer" && file.parent) return true;
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
  displayName: string;
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
  projectDisplayNames: Readonly<Record<string, string>> = {},
): ProjectSummary[] {
  const map = new Map<string, ProjectSummary>();
  const summaryFor = (key: string, displayName = projectDisplayName(key)): ProjectSummary => {
    let summary = map.get(key);
    if (!summary) {
      summary = { project: key, displayName, liveCount: 0, attentionCount: 0, conversations: 0, smt: 0, catalogOnly: true };
      map.set(key, summary);
    }
    return summary;
  };
  for (const file of files) {
    const summary = summaryFor(projectKey(file), projectDisplayName(projectKey(file), file.projectName));
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
    const summary = summaryFor(entry.project, projectDisplayName(entry.project, entry.displayName));
    summary.conversations = Math.max(summary.conversations, entry.conversations);
    summary.smt = Math.max(summary.smt, entry.smt);
  }
  /* Workflows keep their stamped project reachable even before any transcript
     exists (provisioning, a parked setup): the row must be there for the
     strip's retry/close controls to be reachable at all. */
  for (const wf of workflows) {
    if (wf.state === "closed" || !wf.project) continue;
    const summary = summaryFor(wf.project, projectDisplayName(wf.project, projectDisplayNames[wf.project]));
    summary.catalogOnly = false;
    if (WF_BUSY.has(wf.state)) summary.liveCount += 1;
    if (wf.state === "needs_decision" || wf.state === "paused") summary.attentionCount += 1;
    summary.smt = Math.max(summary.smt, (Date.parse(wf.createdAt) || 0) / 1000);
  }
  for (const pipeline of pipelines) {
    if ((pipeline.state === "closed" && !pipeline.restored) || !pipeline.project) continue;
    const summary = summaryFor(pipeline.project, projectDisplayName(pipeline.project, projectDisplayNames[pipeline.project]));
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

/**
 * Crowned projects float in their own pinned section above everything else;
 * inside each half the rows keep the summaries' own order (attention → live →
 * bucketed recency), so pinning changes grouping, never the recency rule.
 */
export function partitionCrownedSummaries<T extends { project: string }>(
  rows: readonly T[],
  crowned: ReadonlySet<string>,
): { crowned: T[]; rest: T[] } {
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const row of rows) (crowned.has(row.project) ? pinned : rest).push(row);
  return { crowned: pinned, rest };
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
    /* Lineage can deliberately cross project ownership (for example, an LLV
       builder spawned by a home-root orchestrator). Each project board owns
       its own visual root; following the foreign parent would duplicate the
       complete tree on both boards. The durable parent pointer remains on the
       file for explicit cross-project navigation. */
    if (projectKey(parent) !== projectKey(file)) break;
    cur = parent;
  }
  return cur;
}

function beginsProjectSegment(file: FileEntry, byPath: Map<string, FileEntry>): boolean {
  if (!file.parent || !isChildConversation(file)) return false;
  const parent = byPath.get(file.parent);
  return Boolean(parent && projectKey(parent) !== projectKey(file));
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

/** Descendants reachable without crossing the root's project boundary. */
function projectSubtree(root: FileEntry, kids: Map<string, FileEntry[]>): FileEntry[] {
  const out: FileEntry[] = [];
  const stack = [...(kids.get(root.path) ?? [])];
  const seen = new Set<string>([root.path]);
  const project = projectKey(root);
  while (stack.length) {
    const node = stack.pop()!;
    if (seen.has(node.path)) continue;
    seen.add(node.path);
    if (projectKey(node) !== project) continue;
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

/** Engine-native subagent placement handed down by the S2 tray projection
    (issue #142): `promoted` children force a full node even when idle (an
    attention override), `folded` children are excluded from every node surface
    because they render as a compact parent-tray row instead. */
export interface EnginePlacement {
  promotedEnginePaths?: ReadonlySet<string>;
  foldedEnginePaths?: ReadonlySet<string>;
}

/** Descendants that deserve a full transcript column next to the root. */
function columnWorthy(
  file: FileEntry,
  expandedConversationPaths?: ReadonlySet<string>,
  placement?: EnginePlacement,
  keepExpandedPaths?: ReadonlySet<string>,
): boolean {
  /* A folded engine child owns exactly one surface — its parent tray — so it is
     never a column, and a promoted one is a full node regardless of activity. */
  if (placement?.foldedEnginePaths?.has(file.path)) return false;
  if (keepExpandedPaths && !keepExpandedPaths.has(file.path)) return false;
  if (placement?.promotedEnginePaths?.has(file.path)) return true;
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
  placement?: EnginePlacement,
  placeableByAge: (file: FileEntry) => boolean = () => true,
  keepExpandedPaths?: ReadonlySet<string>,
): BranchGroup {
  /* Stop traversal at the first foreign owner so a later same-project node
     cannot leak through that foreign branch and appear twice. */
  const descendants = projectSubtree(root, kids);
  const liveRank = (file: FileEntry) => (file.activity === "live" ? 0 : 1);
  /* A child conversation is wired in as a connected node while the ROOT is
     actively working (its quiet children are live-relevant context) or while
     the child itself is worth a column: live, running, recent, promoted, or
     explicitly expanded (columnWorthy). The previous unconditional child
     column made every conveyor tree erupt — one settled root touched inside
     the age horizon dragged its whole history of finished workers onto the
     canvas as full nodes. Under a quiet root a settled child now rests as a
     chip in the group's under-deck, one expand-click away, exactly like every
     other finished technical item. */
  /* The working root's quiet children are live-relevant context only while they
     are inside the placement age horizon: an active root touched today must not
     drag a worker it finished three weeks ago back onto the canvas as a full
     column. The aged one rests in the under-deck like any other finished item. */
  const rootActive = root.activity === "live" || root.proc === "running";
  const branches = descendants
    .filter((file) => (rootActive
      && isChildConversation(file)
      && placeableByAge(file)
      && (!keepExpandedPaths || keepExpandedPaths.has(file.path))
      && !placement?.foldedEnginePaths?.has(file.path))
      || columnWorthy(file, expandedConversationPaths, placement, keepExpandedPaths))
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
  /* The leftovers — settled child conversations, bash tasks, codex job logs,
     compaction-chain predecessor sessions — stay as quiet chips in the
     group's under-deck. */
  const finished = descendants.filter((file) => !taken.has(file.path)).sort((a, b) => b.mtime - a.mtime);
  const returnable: FileEntry[] = [];
  const smt = Math.max(...columns.map((column) => column.file.mtime), ...liveTasks.map((task) => task.mtime));
  return { key: root.path, columns, returnable, finished, smt, orphanTask: false };
}


/**
 * One conversation, one node.
 *
 * Two group roots can sit on a single lineage: `groupRootFor` lifts a placed
 * descendant to the topmost ancestor the HORIZON allows, but an ancestor past
 * the horizon can still be on the canvas through a rule that consults no clock
 * (an operator expansion, an engine promotion), and a `recent` conversation
 * mid-chain becomes a root without any lift at all. Each root then assembles
 * over its WHOLE subtree, so a card below both was emitted twice under one key
 * — React's "two children with the same key", and a duplicated card on the
 * board.
 *
 * Ownership is resolved the way the drawn hierarchy already reads: a card
 * belongs to the group whose root is its NEAREST ancestor, so it hangs under
 * the closest generation still drawn and never under a further one as well. A
 * group root another group already renders as a column is redundant in full and
 * drops out; nothing leaves the canvas, because the column that displaced it is
 * the same card.
 */
function singleOwnership(groups: BranchGroup[], byPath: Map<string, FileEntry>): BranchGroup[] {
  /* Steps from `file` up to `rootPath`, or Infinity when it is no ancestor. */
  const distanceTo = (file: FileEntry, rootPath: string): number => {
    let cursor: FileEntry | undefined = file;
    const seen = new Set<string>();
    for (let steps = 0; cursor && !seen.has(cursor.path); steps += 1) {
      if (cursor.path === rootPath) return steps;
      seen.add(cursor.path);
      cursor = cursor.parent ? byPath.get(cursor.parent) : undefined;
    }
    return Number.POSITIVE_INFINITY;
  };
  const columnedElsewhere = new Set<string>();
  for (const group of groups) {
    for (const column of group.columns) {
      if (column.file.path !== group.key) columnedElsewhere.add(column.file.path);
    }
  }
  const kept = groups.filter((group) => !columnedElsewhere.has(group.key));
  const owner = new Map<string, BranchGroup>();
  for (const group of kept) {
    for (const column of group.columns) {
      const held = owner.get(column.file.path);
      if (!held || distanceTo(column.file, group.key) < distanceTo(column.file, held.key)) owner.set(column.file.path, group);
    }
  }
  return kept.map((group) => {
    const columns = group.columns.filter((column) => owner.get(column.file.path) === group);
    if (columns.length === group.columns.length) return group;
    /* The freshness sort key follows the columns that stayed. */
    const smt = Math.max(...columns.map((column) => column.file.mtime), ...columns.flatMap((column) => column.tasks.map((task) => task.mtime)));
    return { ...group, columns, smt };
  });
}

/**
 * One group per active branch tree: the root conversation opens the group,
 * live descendant agents (subagents, codex rollouts) get their own columns.
 * Live background tasks (bash, codex job logs) never take a full column —
 * they attach to their parent's column as collapsed rows; a parentless one
 * becomes a narrow stub group. Every other descendant of the tree — finished
 * subagents, quiet tasks, compaction-chain predecessor sessions — stays
 * visible as a collapsed chip in the group's `finished` stack. Root
 * conversations with activity inside the placement age horizon (~48 h,
 * `NEXT_PUBLIC_LLV_SCHEME_AGE_HORIZON_HOURS`) keep automatic cards even while
 * idle — the operator's conversation from earlier today belongs on the map —
 * and roots whose whole tree aged past the horizon leave the canvas for quiet
 * history. Recent child conversations (claude subagents, codex job sessions)
 * keep full columns too, because "done between user messages" must not hide
 * active work.
 *
 * The horizon bounds EVERY automatic placement here, whatever the entry's role
 * in the tree (`withinPlacementHorizon`): a root card, a child column under a
 * working root, and the root a placed descendant opens its group at. Live and
 * running work is exempt at any age, an explicit expansion still places, and
 * everything bounded off the canvas keeps its chip in the group's under-deck,
 * its row in quiet history and its entry in «All conversations».
 */
export interface BranchGroupOptions {
  /** Quiet conversations promoted into full scheme nodes. */
  expandedConversationPaths?: ReadonlySet<string>;
  /** Engine-native subagent placement from the S2 tray projection (#142). */
  enginePlacement?: EnginePlacement;
  /** Wall clock in epoch seconds for the placement age horizon. `0` — the
      server render and the hydration pass — applies no age judgment, so both
      sides paint the plain activity rule and no hydration skew appears. */
  now?: number;
  /** Placement age horizon in seconds; defaults to the env-tunable value. */
  ageHorizonSeconds?: number;
  /** Result of the board's shared keepExpanded predicate. When supplied, every
      automatic root and child placement must belong to this set. */
  keepExpandedPaths?: ReadonlySet<string>;
}

export function buildBranchGroups(files: FileEntry[], project: string, options: BranchGroupOptions = {}): BranchGroup[] {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const kids = kidsIndex(files);
  const roots = new Map<string, FileEntry>();
  const orphanTasks = new Map<string, FileEntry>();
  const { expandedConversationPaths, enginePlacement, keepExpandedPaths } = options;
  const now = options.now ?? 0;
  const ageHorizon = options.ageHorizonSeconds ?? schemeAgeHorizonSeconds();
  /* The automatic-placement age horizon. Without a clock (`now === 0`, the
     server/hydration render) age is unknowable, so the test degrades to the
     plain `recent` activity rule rather than inventing an age. The `recent`
     clause stays alongside the clock so a sub-15-minute horizon override can
     never out-tighten the activity the projection already calls recent. */
  const recentlyActive = (file: FileEntry) =>
    file.activity === "recent" || (now > 0 && now - file.mtime <= ageHorizon);
  /* The same horizon, asked of any entry a rule wants to place. */
  const placeableByAge = (file: FileEntry) => withinPlacementHorizon(file, now, ageHorizon);
  /* Which card opens the group a placed descendant belongs to. Its tree root
     normally does — but a root beyond the horizon is never resurrected by fresh
     work below it: a worker answering today must not drag a conversation from
     three weeks ago back onto the canvas. The placed descendant then opens its
     own group and its aged root stays in quiet history, one click away through
     the arrow's unresolved parent and «All conversations». */
  const groupRootFor = (file: FileEntry): FileEntry => {
    /* The TOPMOST placeable ancestor inside the project, so two placed
       descendants of one aged root still share a single group instead of
       rendering the same conversation under two keys. */
    let best = file;
    let cursor = file;
    const seen = new Set<string>([file.path]);
    while (cursor.parent && !seen.has(cursor.parent)) {
      const parent = byPath.get(cursor.parent);
      if (!parent || projectKey(parent) !== projectKey(file)) break;
      seen.add(parent.path);
      cursor = parent;
      if (placeableByAge(parent) && (!keepExpandedPaths || keepExpandedPaths.has(parent.path))) best = parent;
    }
    return best;
  };
  for (const file of files) {
    if (projectKey(file) !== project) continue;
    const keepExpanded = !keepExpandedPaths || keepExpandedPaths.has(file.path);
    /* A cross-project child starts an independently owned visual segment. Keep
       its root card after the child becomes quiet while the durable parent
       pointer continues to support explicit cross-project navigation. The
       horizon bounds this card like any other root's: once the segment's
       activity ages out it leaves the canvas (a live or running one never
       does), and only an explicit expansion below can still place it. */
    if (beginsProjectSegment(file, byPath)) {
      if (keepExpanded && (now === 0 || file.activity === "live" || file.proc === "running" || recentlyActive(file))) {
        roots.set(file.path, file);
        continue;
      }
    }
    const expanded = expandedConversationPaths?.has(file.path) === true;
    if (keepExpanded && (
      file.activity === "live" ||
      file.proc === "running" ||
      (recentlyActive(file) && isChildConversation(file)) ||
      /* A promoted engine child (e.g. an idle child holding a pending question)
         must still open its parent's group so it can render as a full node. */
      enginePlacement?.promotedEnginePaths?.has(file.path) === true ||
      (expanded && (isConversation(file) || isChildConversation(file)))
    )) {
      const root = groupRootFor(file);
      if (isAuxTask(root)) orphanTasks.set(root.path, root);
      else roots.set(root.path, root);
      continue;
    }
    if (keepExpanded && recentlyActive(file) && isConversation(file)) roots.set(file.path, file);
  }
  const groups = singleOwnership(
    [...roots.values()].map((root) => assembleGroup(root, kids, expandedConversationPaths, enginePlacement, placeableByAge, keepExpandedPaths)),
    byPath,
  );
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
    const descendants = projectSubtree(root, kids)
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
 * Unsettled trees of the project that have not entered a full dashboard group.
 * Fully idle history stays in the history surface instead of repopulating the
 * canvas and minimap with one compact card per old worker tree.
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
    if (band < 3) cards.push({ root: file, branchCount: descendants.length, smt, band });
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

function collectDescendants(
  file: FileEntry | null,
  files: FileEntry[],
  include: (child: FileEntry) => boolean,
): DescendantRow[] {
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
      if (!include(child)) continue;
      out.push({ file: child, depth });
      walk(child, depth + 1);
    }
  };
  walk(file, 1);
  return out;
}

/** Depth-first subtree of a node: children stay under their parent, siblings ordered by state then recency. */
export function descendantsOf(file: FileEntry | null, files: FileEntry[]): DescendantRow[] {
  return collectDescendants(file, files, () => true);
}

/** Descendants owned by the root's project, stopping traversal at every foreign boundary. */
export function projectDescendantsOf(file: FileEntry | null, files: FileEntry[]): DescendantRow[] {
  if (!file) return [];
  const project = projectKey(file);
  return collectDescendants(file, files, (child) => projectKey(child) === project);
}
