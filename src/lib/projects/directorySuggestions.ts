import fs from "node:fs";
import path from "node:path";

/**
 * Directory completion for a project that does not exist yet (issue #1223).
 *
 * `DirectoryPicker` filters a list it is handed and never reads a disk, which
 * is enough for relaunching an agent where one already ran and useless for
 * creating a project: the target directory is, by definition, the one place
 * the known-directories list does not carry. So the rail needs real filesystem
 * completion — and completion over a whole machine is neither answerable nor
 * safe to hand to a browser.
 *
 * The bound is the anchor set: the directories where the viewer's projects
 * already live (see `suggestionRoots`), already capped there so suggestion and
 * creation are handed the same list. Everything here is expressed against that
 * set — a browse lists one level below each root, a typed path completes inside
 * the roots one directory read at a time, and nothing outside them is ever read
 * or returned, symlinks followed. There is no recursive walk anywhere here.
 *
 * Creation reads the same bound through `boundedTarget`, so a directory that
 * cannot be created is never offered.
 */

/** Most suggestions one answer carries; the picker is a list to read, not a listing. */
export const SUGGESTION_LIMIT = 40;
/** Names kept from one directory read, so a pathological directory cannot
    turn a browse into an unbounded response. */
export const SUGGESTION_ENTRY_SCAN_LIMIT = 200;

/** Absolute, `..`-free, trailing-slash-free — the one spelling everything here
    compares. A relative path has no place in a bound and answers null. */
function normalizeDirectory(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) return null;
  return path.normalize(trimmed).replace(/(.)\/+$/, "$1");
}

/**
 * The roots as this module compares them. The filesystem root is dropped
 * rather than normalized: a bound of `/` is the whole machine, which is the
 * one thing the bound exists to refuse.
 */
export function normalizeSuggestionRoots(candidates: Iterable<string>): string[] {
  const roots: string[] = [];
  for (const candidate of candidates) {
    const normalized = normalizeDirectory(candidate);
    if (!normalized || normalized === path.parse(normalized).root) continue;
    if (!roots.includes(normalized)) roots.push(normalized);
  }
  return roots;
}

/** Whether a path is a root or sits under one. Both sides are normalized, so
    `..` cannot walk out and `/a/bc` is not inside `/a/b`. */
export function withinSuggestionRoots(target: string, roots: readonly string[]): boolean {
  const normalized = normalizeDirectory(target);
  if (!normalized) return false;
  return normalizeSuggestionRoots(roots).some(
    (root) => normalized === root || normalized.startsWith(root + path.sep),
  );
}

/**
 * The bound in the two spellings a check needs: the roots **as written**, which
 * a query is measured against before anything is read, and the roots **as the
 * filesystem sees them**, which every path that will be read, offered or
 * created is measured against once its symlinks are followed.
 *
 * The written spelling alone is not enough — a link inside an anchor is spelled
 * inside the bound while it lands outside it — and the resolved spelling alone
 * would readdir a traversal before judging it.
 */
interface SuggestionBound {
  written: string[];
  resolved: string[];
}

function realDirectory(directory: string): string | null {
  try {
    return fs.realpathSync.native(directory);
  } catch {
    return null;
  }
}

function suggestionBound(roots: readonly string[]): SuggestionBound {
  const written = normalizeSuggestionRoots(roots);
  /* A root whose realpath fails keeps its written spelling: dropping it would
     narrow the bound away from a directory the operator can still read, while
     anything under it that resolves elsewhere is refused all the same. */
  return { written, resolved: normalizeSuggestionRoots(written.map((root) => realDirectory(root) ?? root)) };
}

/**
 * The directory a create request will actually touch: `requested` resolved the
 * way the kernel resolves it — segment by segment, following every link, so a
 * `..` after one lands where the link points rather than where the string
 * suggests. Null when that lands outside `roots`, or when there is nothing to
 * resolve from: only an absolute path names a place on its own.
 *
 * This is the whole of creation's bound, and it is one definition on purpose
 * (issue #1223). Comparing a lexically normalized string (`path.normalize`,
 * `path.resolve`) and then handing the raw one to `fs.mkdirSync` checked a path
 * the kernel never visits: `<anchor>/link-out/../escaped` reads as
 * `<anchor>/escaped` and is created wherever the link leads. What is returned
 * here is what the caller creates, so the two cannot diverge.
 */
export function boundedTarget(requested: string, roots?: readonly string[]): string | null {
  if (!path.isAbsolute(requested)) return null;
  const parsed = path.parse(requested);
  let target = parsed.root;
  for (const segment of requested.slice(parsed.root.length).split(path.sep)) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      target = path.dirname(target);
      continue;
    }
    const next = path.join(target, segment);
    target = realDirectory(next) ?? next;
  }
  if (!roots) return target;
  return withinSuggestionRoots(target, suggestionBound(roots).resolved) ? target : null;
}

/** Whether a directory may be read at all: inside the bound as written, so a
    typed `..` never reaches a stat, and still inside it once resolved. */
function readableDirectory(directory: string, bound: SuggestionBound): boolean {
  if (!withinSuggestionRoots(directory, bound.written)) return false;
  const real = realDirectory(directory);
  return real !== null && withinSuggestionRoots(real, bound.resolved);
}

/** A symlinked project directory is a directory to the operator, so it is one
    here too — as long as it lands inside the bound. A real subdirectory of a
    directory already proven inside cannot leave it, so the resolve runs for the
    rare link entry alone. */
function entryIsOfferableDirectory(target: string, entry: fs.Dirent, bound: SuggestionBound): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  const real = realDirectory(target);
  if (real === null || !withinSuggestionRoots(real, bound.resolved)) return false;
  try {
    return fs.statSync(real).isDirectory();
  } catch {
    return false;
  }
}

/** One directory read: the child directories of `directory`, alphabetical.
    Dot directories answer only a dot prefix — a browse is about projects, and
    caches are what a home directory otherwise fills the list with. */
function childDirectories(directory: string, bound: SuggestionBound, prefix = ""): string[] {
  if (!readableDirectory(directory, bound)) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const wantsHidden = prefix.startsWith(".");
  const lowered = prefix.toLowerCase();
  const names: string[] = [];
  for (const entry of entries) {
    if (names.length >= SUGGESTION_ENTRY_SCAN_LIMIT) break;
    if (entry.name.startsWith(".") && !wantsHidden) continue;
    if (lowered && !entry.name.toLowerCase().startsWith(lowered)) continue;
    if (!entryIsOfferableDirectory(path.join(directory, entry.name), entry, bound)) continue;
    names.push(entry.name);
  }
  names.sort((a, b) => a.localeCompare(b));
  return names.map((name) => path.join(directory, name));
}

/** What the anchors offer without a path to complete: one level below each
    root, kept apart by root so no anchor can spend another's share. `withRoots`
    adds the roots themselves, which a typed prefix reaching down towards them
    is asking about. */
function anchoredGroups(bound: SuggestionBound, withRoots: boolean): string[][] {
  return bound.written.map((root) => [
    ...(withRoots ? [root] : []),
    ...childDirectories(root, bound),
  ]);
}

/**
 * Spends the answer's budget across the anchors a round at a time.
 *
 * Concatenating the anchors and truncating once meant the first crowded one
 * filled the whole answer and every later anchor — the $HOME fallback
 * included — was unreachable without typing an absolute path (issue #1223).
 * A machine that keeps its checkouts in one container holds a hundred siblings
 * there, so that was the default experience, not an edge case.
 *
 * Every anchor is served its first entry before any anchor is served a second,
 * so a starved anchor is always represented; what is left once the small
 * anchors are exhausted still goes to whoever has more to give, so the answer
 * stays as full as it was. The rows come back grouped by root, in root order —
 * this is a list to read, and round-robin ordering would interleave places that
 * have nothing to do with each other.
 */
function shareBudget(groups: readonly (readonly string[])[], limit: number): string[] {
  const taken = groups.map(() => 0);
  let total = 0;
  let served = true;
  while (total < limit && served) {
    served = false;
    for (let index = 0; index < groups.length && total < limit; index += 1) {
      if (taken[index] >= groups[index].length) continue;
      taken[index] += 1;
      total += 1;
      served = true;
    }
  }
  return groups.flatMap((group, index) => group.slice(0, taken[index]));
}

/** Every whitespace-separated token appears somewhere in the path — the same
    filter the picker applies on the client, so both narrow alike. */
function matchesTokens(directory: string, query: string): boolean {
  const haystack = directory.toLowerCase();
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

/**
 * Directories to offer for `query`, all of them inside `roots`.
 *
 * An absolute query is a path being spelled out: the directory it names is
 * read when it lies inside the bound, so completion descends exactly where the
 * operator points it and one level at a time. A query that reaches down
 * *towards* the roots from above completes to the roots themselves. Anything
 * else is a filter word, and filters the anchors' children.
 */
export function suggestDirectories(query: string, roots: readonly string[], limit = SUGGESTION_LIMIT): string[] {
  const bound = suggestionBound(roots);
  const trimmed = query.trim();
  if (path.isAbsolute(trimmed)) {
    /* Split on the raw query, not a normalized one: a trailing "." is a prefix
       the operator typed, and normalizing would eat it. */
    const cut = trimmed.lastIndexOf("/");
    const parent = normalizeDirectory(trimmed.slice(0, cut + 1));
    const prefix = trimmed.slice(cut + 1);
    /* The branch is decided on the written bound: a query aimed above the
       roots is not a directory to read but a prefix reaching down towards
       them. Whether the named directory may actually be read — the resolved
       half of the bound — is `childDirectories`' to answer, in one place. */
    if (parent && withinSuggestionRoots(parent, bound.written)) {
      /* One directory read, so there is only ever one root's worth to spend. */
      return childDirectories(parent, bound, prefix).slice(0, limit);
    }
    const lowered = trimmed.toLowerCase();
    return shareBudget(
      anchoredGroups(bound, true).map((group) => group.filter((directory) => directory.toLowerCase().startsWith(lowered))),
      limit,
    );
  }
  return shareBudget(
    anchoredGroups(bound, false).map((group) => (trimmed ? group.filter((directory) => matchesTokens(directory, trimmed)) : group)),
    limit,
  );
}
