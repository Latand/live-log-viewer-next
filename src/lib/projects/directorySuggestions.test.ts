import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, expect, test } from "bun:test";

import {
  normalizeSuggestionRoots,
  SUGGESTION_LIMIT,
  SUGGESTION_ROOT_SCAN_LIMIT,
  suggestDirectories,
  withinSuggestionRoots,
} from "./directorySuggestions";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-directory-suggestions-"));
const PROJECTS = path.join(SANDBOX, "anchor-projects");
const WORK = path.join(SANDBOX, "anchor-work");
const OUTSIDE = path.join(SANDBOX, "outside");
const ROOTS = [PROJECTS, WORK];

function makeDirs(...dirs: string[]): void {
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
}

makeDirs(
  path.join(PROJECTS, "alpha"),
  path.join(PROJECTS, "alpha", "nested-deep"),
  path.join(PROJECTS, "beta"),
  path.join(PROJECTS, ".hidden-cache"),
  path.join(WORK, "gamma-service"),
  path.join(OUTSIDE, "private-notes"),
);
fs.writeFileSync(path.join(PROJECTS, "a-file.txt"), "not a directory\n");

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("browsing with no query lists the child directories of the anchored roots, in root order", () => {
  /* The two-click case: the picker opens onto the directories that sit beside
     the projects the viewer already knows, without a character typed. */
  expect(suggestDirectories("", ROOTS)).toEqual([
    path.join(PROJECTS, "alpha"),
    path.join(PROJECTS, "beta"),
    path.join(WORK, "gamma-service"),
  ]);
});

test("a bare word filters the anchored candidates instead of being read as a path", () => {
  expect(suggestDirectories("gamma", ROOTS)).toEqual([path.join(WORK, "gamma-service")]);
  expect(suggestDirectories("no-such-directory", ROOTS)).toEqual([]);
});

test("an absolute query completes the directory it names, one level at a time", () => {
  expect(suggestDirectories(path.join(PROJECTS, "al"), ROOTS)).toEqual([path.join(PROJECTS, "alpha")]);
  expect(suggestDirectories(PROJECTS + "/", ROOTS)).toEqual([
    path.join(PROJECTS, "alpha"),
    path.join(PROJECTS, "beta"),
  ]);
  /* Completion descends only where the operator points it: the grandchild
     appears once its parent is the query, never from the browse list. */
  expect(suggestDirectories(path.join(PROJECTS, "alpha") + "/", ROOTS)).toEqual([
    path.join(PROJECTS, "alpha", "nested-deep"),
  ]);
  expect(suggestDirectories("", ROOTS)).not.toContain(path.join(PROJECTS, "alpha", "nested-deep"));
});

test("a prefix above a root completes to the root and to what it holds", () => {
  const suggestions = suggestDirectories(path.join(SANDBOX, "anchor-p"), ROOTS);
  expect(suggestions).toContain(PROJECTS);
  expect(suggestions).toContain(path.join(PROJECTS, "alpha"));
  expect(suggestions).not.toContain(WORK);
});

test("nothing outside the roots is ever suggested, however the query is aimed", () => {
  for (const query of [OUTSIDE + "/", path.join(OUTSIDE, "priv"), path.join(PROJECTS, "..", "outside") + "/", "/", "private"]) {
    for (const suggestion of suggestDirectories(query, ROOTS)) {
      expect(withinSuggestionRoots(suggestion, ROOTS)).toBe(true);
    }
  }
  expect(suggestDirectories(OUTSIDE + "/", ROOTS)).toEqual([]);
  expect(suggestDirectories("private", ROOTS)).toEqual([]);
});

test("hidden directories and plain files stay out of the browse list, and a dot prefix asks for them", () => {
  expect(suggestDirectories("", ROOTS)).not.toContain(path.join(PROJECTS, ".hidden-cache"));
  expect(suggestDirectories("", ROOTS)).not.toContain(path.join(PROJECTS, "a-file.txt"));
  expect(suggestDirectories(PROJECTS + "/.", ROOTS)).toEqual([path.join(PROJECTS, ".hidden-cache")]);
});

test("the scan is bounded: too many roots and too many children never become an unbounded walk", () => {
  const wide = path.join(SANDBOX, "wide");
  const roots: string[] = [];
  for (let index = 0; index < SUGGESTION_ROOT_SCAN_LIMIT + 2; index += 1) {
    const root = path.join(wide, `root-${index}`);
    makeDirs(path.join(root, `child-${index}`));
    roots.push(root);
  }
  const beyond = path.join(wide, `root-${SUGGESTION_ROOT_SCAN_LIMIT + 1}`, `child-${SUGGESTION_ROOT_SCAN_LIMIT + 1}`);
  expect(suggestDirectories("", roots)).not.toContain(beyond);

  const crowded = path.join(SANDBOX, "crowded");
  for (let index = 0; index < SUGGESTION_LIMIT + 10; index += 1) {
    makeDirs(path.join(crowded, `child-${String(index).padStart(3, "0")}`));
  }
  expect(suggestDirectories("", [crowded]).length).toBe(SUGGESTION_LIMIT);
});

test("roots are normalized to absolute, deduplicated paths, and the filesystem root is never one", () => {
  expect(normalizeSuggestionRoots(["/a/b/", "/a/b", "relative/path", "", "/"])).toEqual(["/a/b"]);
  expect(normalizeSuggestionRoots(["/a/b/../c"])).toEqual(["/a/c"]);
});

test("containment rejects lookalike prefixes and traversal", () => {
  expect(withinSuggestionRoots("/a/b", ["/a/b"])).toBe(true);
  expect(withinSuggestionRoots("/a/b/c", ["/a/b"])).toBe(true);
  expect(withinSuggestionRoots("/a/bc", ["/a/b"])).toBe(false);
  expect(withinSuggestionRoots("/a/b/../c", ["/a/b"])).toBe(false);
  expect(withinSuggestionRoots("relative", ["/a/b"])).toBe(false);
  expect(withinSuggestionRoots("/a/b", [])).toBe(false);
});
