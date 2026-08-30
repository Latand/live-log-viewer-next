import { canonicalProject } from "@/lib/projects/aliases";
import { projectForCwd } from "@/lib/scanner/describe";

/** A project the caller already knows, or a cwd it can derive one from. */
export interface ConversationProjectFallback {
  project?: string | null;
  cwd?: string | null;
}

/**
 * The project a registered conversation's work belongs to, as the one key
 * #1279's binding is stored and read under.
 *
 * The order is the one every other projection of a conversation's project
 * uses: the durable ownership record first (issue #315 made it authority),
 * then the launch profile's hint, then derivation from its cwd.
 *
 * The `fallback` exists because a conversation the Viewer ADOPTED rather than
 * spawned carries an empty launch profile — no project, no cwd — and a fence
 * that resolved to null there would silently not apply to the majority of live
 * conversations. Callers pass what they already hold: the scanner's project for
 * the transcript, or the cwd read from its head.
 *
 * The answer is canonicalized, because a binding written from the accounts
 * panel is stored under the alias target and a fence read under the alias
 * source would silently not apply.
 */
export function conversationProjectKey(
  ownership: { project?: string | null } | null | undefined,
  launchProfile: { project?: string | null; cwd?: string | null } | null | undefined,
  fallback: ConversationProjectFallback = {},
): string | null {
  const named = ownership?.project?.trim() || launchProfile?.project?.trim() || "";
  if (named) return canonicalProject(named);
  const fromCwd = derive(launchProfile?.cwd);
  if (fromCwd) return fromCwd;
  const spare = fallback.project?.trim();
  if (spare) return canonicalProject(spare);
  return derive(fallback.cwd);
}

function derive(cwd: string | null | undefined): string | null {
  const trimmed = cwd?.trim();
  if (!trimmed) return null;
  const project = projectForCwd(trimmed);
  return project ? canonicalProject(project) : null;
}
