import os from "node:os";
import path from "node:path";

import { projectCurationSnapshot } from "@/lib/projects/curation";
import { normalizeSuggestionRoots } from "@/lib/projects/directorySuggestions";
import { knownProjectRoots } from "@/lib/scanner/projectDirectories";

/** How many known project roots are folded into anchors; well past the number
    of distinct places one machine keeps its checkouts. */
const ANCHOR_SCAN_LIMIT = 60;

/**
 * Where a project root's siblings live — the parent directory, which is where
 * the next project on this machine is overwhelmingly likely to go. A project
 * sitting directly under the filesystem root anchors on itself instead: `/` as
 * a bound is the whole machine, and the bound exists to refuse exactly that.
 */
export function anchorForProjectRoot(root: string): string {
  const parent = path.dirname(root);
  return parent === path.parse(root).root ? root : parent;
}

/* $HOME first, the same way `/api/artifact` reads it: it is what the isolated
   demo/evidence runtimes (and this module's tests) repoint, and Bun's
   `os.homedir()` ignores the env override. Taking `os.homedir()` directly here
   would mean a viewer running under an isolated home still suggests — and
   readdirs — the machine's real one. */
function homeRoot(): string {
  return path.resolve(process.env.HOME?.trim() || os.homedir());
}

/**
 * The directories create-project may suggest from and create into (#1223).
 *
 * "The roots the viewer already knows", stated once so suggestion and creation
 * cannot drift apart: the parents of every project root the scanner and the
 * curation store carry, plus the home directory as the standing fallback — the
 * same one `/api/spawn` falls back to when it knows no working directory at
 * all. Anchors lead so a browse opens on the places projects actually live;
 * home trails as the answer for a machine with no projects yet.
 */
export function suggestionRoots(): string[] {
  const candidates: string[] = [];
  for (const root of knownProjectRoots(ANCHOR_SCAN_LIMIT)) candidates.push(anchorForProjectRoot(root));
  for (const entry of projectCurationSnapshot().manualProjects) candidates.push(anchorForProjectRoot(entry.root));
  candidates.push(homeRoot());
  return normalizeSuggestionRoots(candidates);
}
