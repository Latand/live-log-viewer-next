import type { FileEntry } from "@/lib/types";

/*
 * Presentation names (issue #345, mobile audit finding 3).
 *
 * The canonical project key is a dashed cwd slug (`projectFromSlug`), and a
 * Viewer-spawned session's fallback title is the head of its machine-authored
 * spawn prompt. Both are load-bearing identity — grouping, routing, ownership,
 * lineage and search all key on them — but neither is a name a person should
 * read: `-agents-tools-live-log-viewer-next` starts with a dash, «You are the
 * Orchestrator. Drive work…» is a prompt, not a title.
 *
 * This module is the single presentation layer over those identifiers. Every
 * function is pure and display-only: callers keep the canonical value for
 * keys, handlers, comparisons and search, and pass only the RENDERED text
 * through here. Nothing on disk or in the read model's identity fields ever
 * changes, so live and deleted worktrees of the same repo (which resolve to
 * the same canonical key) always present the same name.
 */

/** Dashed slug prefixes of known repo containers whose remainder is the repo
    name itself. `~/.agents/tools/<repo>` encodes (after the home prefix is
    stripped) as `-agents-tools-<repo>` — the leading-dash project of the
    audit. Mirrors the repo roots `scanner/describe.ts` recognizes. */
const CONTAINER_SLUG_PREFIXES = ["-agents-tools-"];

/**
 * Human name of a canonical project key. A known container prefix is dropped
 * to leave the repo name; any other leading-dash slug at least loses the
 * dashes. Everything already readable (plain repo names, the home project,
 * "other") passes through untouched. Never returns an empty string.
 */
export function projectDisplayName(project: string): string {
  for (const prefix of CONTAINER_SLUG_PREFIXES) {
    if (project.startsWith(prefix) && project.length > prefix.length) {
      return project.slice(prefix.length);
    }
  }
  const undashed = project.replace(/^-+/, "");
  return undashed || project;
}

/**
 * Rail-filter predicate: a query matches a project when it matches the
 * canonical key OR the presented name, so typing what the row shows works
 * while key-based muscle memory keeps working. An empty query matches all.
 */
export function projectMatchesQuery(project: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return project.toLowerCase().includes(q) || projectDisplayName(project).toLowerCase().includes(q);
}

/** Built-in role names (lib/roles/defaults) accepted even when a legacy
    scaffold spells them lowercase («You are the reviewer in an
    implement-review loop…»). */
const KNOWN_ROLE_WORDS = new Set([
  "orchestrator",
  "reviewer",
  "builder",
  "architect",
  "cleaner",
  "prod-auditor",
  "deployer",
  "verifier",
]);

/** A role word is a single capitalized token («Orchestrator», «Prod-auditor»)
    or a known built-in role name in any case. */
function roleWordOf(descriptor: string): string | null {
  const word = descriptor.split(" ").filter(Boolean).at(-1) ?? "";
  if (/^[A-Z][A-Za-z-]{1,24}$/.test(word)) return word;
  if (KNOWN_ROLE_WORDS.has(word.toLowerCase())) return word[0]!.toUpperCase() + word.slice(1);
  return null;
}

/**
 * Compact display title for a session whose title is a raw spawn-prompt
 * scaffold: «You are a Builder in tdd mode. Implement…» → «Builder — tdd»,
 * «You are the Orchestrator. Drive work…» → «Orchestrator». Returns null for
 * anything that does not look like a role scaffold — a human-authored title,
 * a conversational «You are right, …» with no role word, or a bare «You are
 * the X» with no directive after it — so callers fall back to the raw title.
 */
export function rolePromptDisplayTitle(title: string): string | null {
  const head = /^You are (?:the |an? )?([^.,:]{1,60}?)[.,:]/.exec(title);
  if (!head || !title.slice(head[0].length).trim()) return null;
  let descriptor = head[1]!.trim();
  let mode: string | null = null;
  const inClause = descriptor.indexOf(" in ");
  if (inClause > 0) {
    const context = descriptor.slice(inClause + " in ".length).trim();
    descriptor = descriptor.slice(0, inClause).trim();
    const modeMatch = /^(\S+) mode$/.exec(context);
    /* An unresolved template placeholder ({{mode}}) is not a mode. */
    if (modeMatch && !modeMatch[1]!.includes("{")) mode = modeMatch[1]!;
  }
  const role = roleWordOf(descriptor);
  if (!role) return null;
  return mode ? `${role} — ${mode}` : role;
}

/**
 * Read-model overlay: replaces spawn-scaffold titles with their compact role
 * form. Runs AFTER the durable role-title overlay (issue #325) — a worker
 * with a durable role and an owning task already carries «subject — role» and
 * no longer matches the scaffold shape — so this is the fallback for
 * prompt-only sessions: legacy spawns without durable lineage and fresh role
 * spawns not yet claimed by a task. A user rename (signalled by a preserved
 * `autoTitle`) keeps final precedence; the compact form then only replaces
 * its Reset base. Native transcripts are never rewritten.
 */
export function overlayPromptDisplayTitles(files: FileEntry[]): void {
  for (const file of files) {
    if (file.engine !== "claude" && file.engine !== "codex") continue;
    if (file.autoTitle !== undefined) {
      const compact = rolePromptDisplayTitle(file.autoTitle);
      if (compact) file.autoTitle = compact;
      continue;
    }
    const compact = rolePromptDisplayTitle(file.title);
    if (compact) file.title = compact;
  }
}
