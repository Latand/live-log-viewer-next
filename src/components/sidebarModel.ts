import type { FileEntry } from "@/lib/types";

export type SidebarFilter = "all" | "conversations" | "active";

export interface TreeNode {
  file: FileEntry;
  kids: TreeNode[];
  smt: number;
  live: boolean;
  count: number;
}

export interface TechnicalGroup {
  project: string;
  key: string;
  nodes: TreeNode[];
  count: number;
  live: boolean;
  smt: number;
}

export interface ProjectGroup {
  project: string;
  nodes: TreeNode[];
  technical: TechnicalGroup | null;
  total: number;
  live: number;
}

export function isConversation(file: FileEntry): boolean {
  if (file.root === "claude-projects") return file.kind === "сесія" || file.kind === "субагент";
  if (file.root === "codex-sessions") return !file.parent;
  return false;
}

export function isTechnicalRoot(file: FileEntry): boolean {
  return file.root === "codex-jobs" || file.root === "claude-tasks" || file.root === "codex-sessions";
}

function matchesQuery(file: FileEntry, query: string): boolean {
  if (!query) return true;
  return (file.title + file.project + (file.model ?? "")).toLowerCase().includes(query);
}

function includeSubtree(
  node: TreeNode,
  filter: SidebarFilter,
  query: string,
  underConversation = false,
): TreeNode | null {
  const conversation = isConversation(node.file);
  const kids = node.kids
    .map((kid) => includeSubtree(kid, filter, query, underConversation || conversation))
    .filter((kid): kid is TreeNode => kid !== null);
  const queryHit = matchesQuery(node.file, query);
  const keepForFilter =
    filter === "all" ||
    (filter === "conversations" && (conversation || underConversation || kids.length > 0)) ||
    (filter === "active" && (node.live || kids.length > 0));
  if (!keepForFilter) return null;
  if (query && !queryHit && kids.length === 0) return null;
  const copy: TreeNode = { ...node, kids };
  finishNode(copy);
  return copy;
}

function finishNode(node: TreeNode): TreeNode {
  node.kids = node.kids.map(finishNode).sort(compareNodeRecency);
  node.smt = Math.max(node.file.mtime, ...node.kids.map((kid) => kid.smt));
  node.live = node.file.activity === "live" || node.kids.some((kid) => kid.live);
  node.count = 1 + node.kids.reduce((sum, kid) => sum + kid.count, 0);
  return node;
}

function compareNodeRecency(a: TreeNode, b: TreeNode): number {
  return b.smt - a.smt;
}

function compareRootNode(a: TreeNode, b: TreeNode): number {
  const ac = isConversation(a.file);
  const bc = isConversation(b.file);
  if (ac !== bc) return ac ? -1 : 1;
  return b.smt - a.smt;
}

export function buildTreeGroups(files: FileEntry[], filter: SidebarFilter, query: string): ProjectGroup[] {
  const q = query.trim().toLowerCase();
  const byPath = new Map<string, TreeNode>();
  for (const file of files) {
    byPath.set(file.path, {
      file,
      kids: [],
      smt: file.mtime,
      live: file.activity === "live",
      count: 1,
    });
  }
  const roots: TreeNode[] = [];
  for (const node of byPath.values()) {
    const parent = node.file.parent ? byPath.get(node.file.parent) : null;
    if (parent && parent !== node) parent.kids.push(node);
    else roots.push(node);
  }
  const filteredRoots = roots.map(finishNode).map((node) => includeSubtree(node, filter, q)).filter((node): node is TreeNode => node !== null);
  const groups = new Map<string, TreeNode[]>();
  for (const root of filteredRoots) {
    const key = root.file.project || "інше";
    groups.set(key, (groups.get(key) ?? []).concat(root));
  }
  return [...groups.entries()]
    .map(([project, nodes]) => {
      const technicalRoots =
        filter === "conversations"
          ? []
          : nodes.filter((node) => !isConversation(node.file) && isTechnicalRoot(node.file));
      const main = nodes.filter((node) => !technicalRoots.includes(node)).sort(compareRootNode);
      const technicalNodes = technicalRoots.sort(compareNodeRecency);
      const technical: TechnicalGroup | null = technicalNodes.length
        ? {
            project,
            key: "tech:" + project,
            nodes: technicalNodes,
            count: technicalNodes.reduce((sum, node) => sum + node.count, 0),
            live: technicalNodes.some((node) => node.live),
            smt: Math.max(...technicalNodes.map((node) => node.smt)),
          }
        : null;
      const allNodes = main.concat(technicalNodes);
      return {
        project,
        nodes: main,
        technical,
        total: allNodes.reduce((sum, node) => sum + node.count, 0),
        live: allNodes.reduce((sum, node) => sum + (node.live ? 1 : 0), 0),
      };
    })
    .filter((group) => group.total > 0)
    .sort((a, b) => a.project.localeCompare(b.project, "uk"));
}

function collectFlat(node: TreeNode, out: FileEntry[]) {
  out.push(node.file);
  for (const kid of node.kids) collectFlat(kid, out);
}

export function buildFlatFiles(files: FileEntry[], filter: SidebarFilter, query: string): FileEntry[] {
  if (filter === "all" || filter === "conversations") {
    const q = query.trim().toLowerCase();
    return files
      .filter((file) => matchesQuery(file, q))
      .filter((file) => filter === "all" || isConversation(file))
      .slice()
      .sort((a, b) => b.mtime - a.mtime);
  }
  const out: FileEntry[] = [];
  for (const group of buildTreeGroups(files, filter, query)) {
    for (const node of group.nodes) collectFlat(node, out);
    if (group.technical) for (const node of group.technical.nodes) collectFlat(node, out);
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}
