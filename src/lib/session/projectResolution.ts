import type { ConversationProjectOwnership } from "@/lib/accounts/migration/contracts";
import { canonicalProject } from "@/lib/projects/aliases";
import { projectInfoFromCwd } from "@/lib/scanner/describe";

/*
 * The one authoritative project-attribution path for conversation projections
 * (issue #315). Files, catalog, board, lineage stubs, resume, and structured
 * launch cards must all rank the same sources the same way:
 *
 *  1. durable conversation ownership (`conversation.projectOwnership`) —
 *     explicit operator spawn intent or a completed relocation;
 *  2. canonical repository/worktree identity derived from the cwd — including
 *     remembered worktrees whose checkout has since been deleted;
 *  3. the launch-profile project — a workflow and legacy hint only;
 *  4. the caller's fallback — scanner slug, source-conversation project for a
 *     cross-project lineage stub, or a path basename.
 *
 * Worktree grouping stays a cwd fact: an ownership or profile project renames
 * the group a conversation lands in, but never invents or erases the worktree
 * evidence that keeps siblings of one checkout together.
 */

export type ProjectAttributionSource = "ownership" | "cwd" | "launch-profile" | "fallback";

export interface ProjectAttributionInput {
  projectOwnership?: ConversationProjectOwnership | null;
  cwd?: string | null;
  /** Optional caller-owned cwd projection cache. Presence, including null,
      suppresses another disk-backed worktree resolution. */
  cwdInfo?: ReturnType<typeof projectInfoFromCwd>;
  launchProfileProject?: string | null;
  fallbackProject?: string | null;
}

export interface ProjectAttribution {
  project: string | null;
  worktree?: string;
  source: ProjectAttributionSource | null;
}

export function resolveProjectAttribution(input: ProjectAttributionInput): ProjectAttribution {
  const cwd = input.cwd?.trim();
  const cwdInfo = Object.hasOwn(input, "cwdInfo") ? input.cwdInfo ?? null : cwd ? projectInfoFromCwd(cwd) : null;
  const ownership = input.projectOwnership?.project.trim();
  if (ownership) {
    return { project: canonicalProject(ownership), ...(cwdInfo?.worktree ? { worktree: cwdInfo.worktree } : {}), source: "ownership" };
  }
  if (cwdInfo?.project) {
    return { project: cwdInfo.project, ...(cwdInfo.worktree ? { worktree: cwdInfo.worktree } : {}), source: "cwd" };
  }
  const profileProject = input.launchProfileProject?.trim();
  if (profileProject) return { project: canonicalProject(profileProject), source: "launch-profile" };
  const fallback = input.fallbackProject?.trim();
  return fallback ? { project: canonicalProject(fallback), source: "fallback" } : { project: null, source: null };
}
