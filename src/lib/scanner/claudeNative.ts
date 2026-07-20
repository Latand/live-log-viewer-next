import path from "node:path";

/**
 * Pure recognition of Claude engine-native subagent transcripts (issue #339).
 *
 * A Claude parent session writes its delegated children under a `subagents/`
 * directory beside the parent transcript. Two layouts occur in the wild:
 *
 *   direct   : <project>/<parent-session>/subagents/agent-*.jsonl
 *   workflow : <project>/<parent-session>/subagents/workflows/<id>/agent-*.jsonl
 *
 * Both collapse to the same root-parent grammar:
 *
 *   <project>/<parent-session>/subagents/** /agent-*.jsonl
 *       → <project>/<parent-session>.jsonl
 *
 * Every function here is lexical — it performs no filesystem reads. The derived
 * parent therefore survives a deleted checkout and a deleted parent transcript,
 * which is exactly the durability the board lineage needs across restarts.
 */

export interface ClaudeSubagentLineage {
  /** Root parent transcript, relative to the scan root: `<slug>/<sid>.jsonl`. */
  parentName: string;
  /** Project-slug directory (the first path segment). */
  slug: string;
  /** Parent session id — the parent transcript basename without `.jsonl`. */
  parentSessionId: string;
  /** Segments between `subagents/` and the `agent-*.jsonl` leaf. Empty for the
      direct layout; e.g. `["workflows", "<id>"]` for a Workflow child. */
  nestedSegments: string[];
}

function splitRelative(relativeName: string): string[] | null {
  if (!relativeName || relativeName.startsWith("..") || path.isAbsolute(relativeName)) return null;
  return relativeName.split(path.sep);
}

/**
 * Recognizes a Claude subagent transcript from its root-relative name and
 * returns the root-parent lineage, or null when the path is not a subagent
 * transcript. Direct and nested (Workflow) layouts resolve to the identical
 * top-level `<slug>/<sid>.jsonl` parent.
 */
export function claudeSubagentLineage(relativeName: string): ClaudeSubagentLineage | null {
  if (!relativeName.endsWith(".jsonl")) return null;
  const parts = splitRelative(relativeName);
  // <slug>/<sid>/subagents/[…nested]/agent-*.jsonl → at least four segments.
  if (!parts || parts.length < 4) return null;
  const slug = parts[0] ?? "";
  const sid = parts[1] ?? "";
  if (!slug || !sid || parts[2] !== "subagents") return null;
  const leaf = parts.at(-1) ?? "";
  if (!leaf.startsWith("agent-") || !leaf.endsWith(".jsonl")) return null;
  return {
    parentName: path.join(slug, `${sid}.jsonl`),
    slug,
    parentSessionId: sid,
    nestedSegments: parts.slice(3, -1),
  };
}

/**
 * Absolute-path convenience: resolves a subagent transcript to its absolute
 * root-parent transcript path under `root`, or null when `pathname` is not a
 * subagent transcript inside `root`.
 */
export function claudeSubagentParentPath(root: string, pathname: string): string | null {
  const lineage = claudeSubagentLineage(path.relative(root, pathname));
  return lineage ? path.join(root, lineage.parentName) : null;
}

/**
 * Lexical test for a Claude subagent leaf transcript by absolute (or any) path,
 * without needing a registered scan root. True when the basename is an
 * `agent-*.jsonl` file nested under a `subagents/` segment — the engine-native
 * child shape at any nesting depth. Used where root registration is unavailable
 * (e.g. live transcript-host receipt settling).
 */
export function isClaudeSubagentLeafPath(pathname: string): boolean {
  if (!pathname.endsWith(".jsonl")) return false;
  const base = path.basename(pathname);
  if (!base.startsWith("agent-")) return false;
  return pathname.split(path.sep).includes("subagents");
}

/**
 * Classifies Workflow bookkeeping artifacts that live under a `subagents/`
 * tree but are not conversations: the `journal.jsonl` event log and the
 * `*.meta.json` sidecars. Discovery must never surface these as cards.
 */
export function isClaudeWorkflowBookkeeping(relativeName: string): boolean {
  const parts = splitRelative(relativeName);
  if (!parts || !parts.includes("subagents")) return false;
  const base = parts.at(-1) ?? "";
  return base === "journal.jsonl" || base.endsWith(".meta.json");
}
