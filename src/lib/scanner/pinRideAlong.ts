import fs from "node:fs";
import path from "node:path";

import type { FileEntry, RootKey } from "../types";
import { activityVerdict } from "./activity";
import { isClaudeWorkflowBookkeeping } from "./claudeNative";
import { describe } from "./describe";
import { taskParts } from "./discover";
import { projectResolutionStateKey } from "./projectState";
import { EXTS, ROOTS, scanRootEntries } from "./roots";

type ScanRoot = { rootName: RootKey; root: string; bases: string[] };

/** Every scan root with the path forms it can be addressed by. An account home
    that symlinks into the shared transcript store gives one root two absolute
    forms, and a pin may name either. */
function scanRoots(): ScanRoot[] {
  return scanRootEntries().map(([rootName, root]) => ({
    rootName,
    root,
    bases: [...new Set([root, realpath(root)].filter((value): value is string => value !== null))],
  }));
}

/**
 * Which scan root owns a path, with its root key — the same containment gate
 * `pathAllowed` applies, so a pin can only ever name a transcript the scanner
 * itself would have walked. The longest matching root wins: account homes nest
 * inside one another, and the relative name must be taken from the innermost.
 */
function rootFor(pathname: string, roots: readonly ScanRoot[]): ScanRoot | null {
  let match: ScanRoot | null = null;
  const candidates = [...new Set([pathname, realpath(pathname)].filter((value): value is string => value !== null))];
  for (const scanRoot of roots) {
    const contained = scanRoot.bases.some((base) => candidates.some((candidate) => candidate.startsWith(base + path.sep)));
    if (contained && (match === null || scanRoot.root.length > match.root.length)) match = scanRoot;
  }
  return match;
}

function realpath(pathname: string): string | null {
  try {
    return fs.realpathSync(pathname);
  } catch {
    return null;
  }
}

/** Discovery's own refusals, so a pin can never surface a row discovery would
    have dropped: bookkeeping sidecars, empty transcripts, task outputs that are
    not `<slug>/<sid>/tasks/<tid>.output`, and outputs mirrored by a subagent
    transcript. */
function discoverable(rootName: RootKey, pathname: string, st: fs.Stats): boolean {
  if (!st.isFile()) return false;
  if (!EXTS.some((ext) => pathname.endsWith(ext))) return false;
  if (rootName === "claude-projects" && isClaudeWorkflowBookkeeping(path.relative(ROOTS["claude-projects"], pathname))) return false;
  if (rootName !== "claude-tasks") return st.size > 0;
  const parts = taskParts(ROOTS["claude-tasks"], pathname);
  if (!parts) return false;
  const [slug, sid, tid] = parts;
  return !fs.existsSync(path.join(ROOTS["claude-projects"], slug, sid, "subagents", `agent-${tid}.jsonl`));
}

/**
 * Identity rows for pinned transcripts the published scan left out (#950).
 *
 * The scheme window is a BOARD budget: it bounds how many conversations the
 * unpinned feed carries, ranked by recency, so whole projects sit outside it
 * once the corpus outgrows the project cap. Everything in «All conversations»
 * is clickable, though, and that click asks `/api/files?path=<pin>` for exactly
 * one record. Waiting for the pinned full-corpus scan generation to publish it
 * means the click does nothing at all for as long as that scan takes.
 *
 * So the budget sheds payload detail, never identity: one `stat` plus the
 * scanner's cached summary give path, project, title, engine and activity —
 * everything the client needs to create the card and open it — while the pinned
 * scan continues in the background and replaces these rows with fully derived
 * ones. Size only ever bounds how many bytes the summary reads; it never
 * decides whether the conversation exists.
 */
export function pinnedIdentityEntries(
  pinnedPaths: Iterable<string>,
  knownPaths: ReadonlySet<string>,
): FileEntry[] {
  const missing = [...pinnedPaths].filter((pathname) => !knownPaths.has(pathname));
  if (!missing.length) return [];
  const roots = scanRoots();
  const stateKey = projectResolutionStateKey();
  const entries: FileEntry[] = [];
  const seen = new Set<string>();
  for (const pathname of missing) {
    if (seen.has(pathname)) continue;
    seen.add(pathname);
    const owner = rootFor(pathname, roots);
    if (!owner) continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(pathname);
    } catch {
      continue;
    }
    const { rootName, root } = owner;
    if (!discoverable(rootName, pathname, st)) continue;
    const meta = describe(rootName, root, pathname, st, stateKey);
    const mtime = st.mtimeMs / 1000;
    const verdict = activityVerdict(rootName, pathname, mtime, st.size);
    entries.push({
      path: pathname,
      root: rootName,
      name: path.relative(root, pathname),
      project: meta.project,
      projectName: meta.projectName,
      projectUnresolved: meta.projectUnresolved,
      worktree: meta.worktree,
      cwd: meta.cwd,
      sessionStartedAt: meta.sessionStartedAt,
      nativeParentThreadId: meta.nativeParentThreadId,
      nativeForkSourceThreadId: meta.nativeForkSourceThreadId,
      projectRoot: meta.projectRoot,
      title: meta.title,
      engine: meta.engine,
      kind: meta.kind,
      fmt: meta.fmt,
      parent: null,
      mtime,
      size: st.size,
      activity: verdict.state,
      activityReason: verdict.reason,
      proc: null,
      pid: null,
      model: null,
      pendingQuestion: null,
      waitingInput: null,
    });
  }
  return entries;
}
