import path from "node:path";

import type { FileEntry } from "@/lib/types";

/*
 * Durable project affinity for split lineages.
 *
 * A Viewer-launched root conversation can carry a transcript cwd ABOVE the
 * repository its family actually works in (e.g. an orchestrator opened from a
 * project board with cwd=$HOME) while every worker it spawned runs inside that
 * repository's checkout or worktree. Attributing each entry purely by its own
 * cwd then splits ONE durable lineage across two sidebar projects — the root
 * under the home-directory project, its children under the repo — and the
 * split reappears on every refresh because it is recomputed from the same
 * transcript data.
 *
 * This overlay is the durable affinity rule: a family groups under the project
 * its lineage actually works in. It is a pure projection over the scanned
 * entries plus the registry lineage already stamped on them (`durableLineage`,
 * `parent`), so it survives refresh by construction and never rewrites any
 * transcript. The fences keep it surgical:
 *
 *  - only a WEAK member adopts — one whose project derives from a bare
 *    directory (no worktree resolution, `projectRoot === cwd`), i.e. the cwd
 *    itself names no repository mapping;
 *  - it adopts only from STRONG lineage members — descendants whose project
 *    root sits strictly BELOW the weak member's cwd, so the member provably
 *    sat above the repository its family works in;
 *  - every strong member must agree on ONE project; a family spanning several
 *    repositories keeps today's attribution rather than guessing;
 *  - a session with no such lineage is never touched, so unrelated
 *    home-directory sessions stay exactly where they are.
 */

/** A member whose project came from a bare directory: nothing resolved a
    worktree/repo mapping for its cwd, so its attribution is just the cwd.
    Durable conversation ownership (issue #315) is never weak — an explicit
    operator or relocation decision must not be regrouped by lineage. */
function isWeakAttribution(file: FileEntry): boolean {
  return Boolean(file.cwd) && !file.worktree && file.projectRoot === file.cwd && !file.projectOwnership;
}

/** Is `ancestor` a strict path ancestor of `descendant`? */
function isProperPathAncestor(ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return false;
  const rel = path.relative(ancestor, descendant);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function overlayLineageProjectAffinity(files: readonly FileEntry[]): void {
  const byPath = new Map<string, FileEntry>();
  const byConversationId = new Map<string, FileEntry>();
  for (const file of files) {
    byPath.set(file.path, file);
    if (file.conversationId && !byConversationId.has(file.conversationId)) {
      byConversationId.set(file.conversationId, file);
    }
  }
  const parentOf = (file: FileEntry): FileEntry | null => {
    const parentId = file.durableLineage?.parentConversationId;
    const byId = parentId ? byConversationId.get(parentId) : undefined;
    if (byId && byId !== file) return byId;
    const viaPath = file.parent ? byPath.get(file.parent) : undefined;
    return viaPath && viaPath !== file ? viaPath : null;
  };

  /* Family root of each entry, cycle-safe. */
  const children = new Map<string, FileEntry[]>();
  const rootOf = (file: FileEntry): FileEntry => {
    let cursor = file;
    const seen = new Set<string>([cursor.path]);
    for (;;) {
      const parent = parentOf(cursor);
      if (!parent || seen.has(parent.path)) return cursor;
      seen.add(parent.path);
      cursor = parent;
    }
  };
  for (const file of files) {
    const parent = parentOf(file);
    if (!parent) continue;
    const list = children.get(parent.path);
    if (list) list.push(file);
    else children.set(parent.path, [file]);
  }

  const familiesByRoot = new Map<string, FileEntry[]>();
  for (const file of files) {
    const root = rootOf(file);
    const family = familiesByRoot.get(root.path);
    if (family) family.push(file);
    else familiesByRoot.set(root.path, [file]);
  }

  for (const [rootPath, family] of familiesByRoot) {
    if (family.length < 2) continue;
    const root = byPath.get(rootPath)!;
    const weakMembers = family.filter(isWeakAttribution);
    if (!weakMembers.length) continue;
    /* Strong members: their project root sits strictly below the ROOT's cwd —
       the family provably works inside repositories the root sat above. */
    const rootCwd = root.cwd;
    if (!rootCwd || !isWeakAttribution(root)) continue;
    const strong = family.filter((member) =>
      member !== root
      && member.project
      && member.cwd
      && member.projectRoot
      && isProperPathAncestor(rootCwd, member.projectRoot));
    if (!strong.length) continue;
    const projects = new Set(strong.map((member) => member.project));
    if (projects.size !== 1) continue;
    const adopted = strong[0]!.project;
    /* The dominant strong root names the shared repository. */
    const rootCounts = new Map<string, number>();
    for (const member of strong) rootCounts.set(member.projectRoot!, (rootCounts.get(member.projectRoot!) ?? 0) + 1);
    const adoptedRoot = [...rootCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
    for (const member of weakMembers) {
      if (member.project === adopted) continue;
      if (member !== root && (!member.cwd || !isProperPathAncestor(member.cwd, adoptedRoot))) continue;
      member.project = adopted;
      member.projectRoot = adoptedRoot;
    }
  }
}
