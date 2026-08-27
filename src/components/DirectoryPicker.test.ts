import { expect, test } from "bun:test";

import { directoryChoices, directoryRows, elideDirectoryHead, isDirectoryPath, matchesDirectoryQuery, splitDirectoryPath } from "./DirectoryPicker";

test("the last segment is what a path is split on, so it is never the part that shortens", () => {
  expect(splitDirectoryPath("/repos/viewer/.worktrees/fix-887")).toEqual({ head: "/repos/viewer/.worktrees/", tail: "fix-887" });
  /* A trailing slash is the operator's typing, not a segment of its own. */
  expect(splitDirectoryPath("/repos/viewer/")).toEqual({ head: "/repos/", tail: "viewer" });
  expect(splitDirectoryPath("/")).toEqual({ head: "", tail: "/" });
  expect(splitDirectoryPath("relative-dir")).toEqual({ head: "", tail: "relative-dir" });
});

test("an over-long head elides in the middle, keeping the root and the segments next to the tail", () => {
  const head = "/home/user/Projects/live-log-viewer/.worktrees/";
  expect(elideDirectoryHead(head, 96)).toBe(head);
  const elided = elideDirectoryHead(head, 30);
  expect(elided.startsWith("/home/")).toBe(true);
  expect(elided).toContain("…");
  /* The segment that sits right against the tail survives — it is what tells
     `…/live-log-viewer/.worktrees/fix` from `…/other-repo/.worktrees/fix`. */
  expect(elided.endsWith(".worktrees/")).toBe(true);
  expect(elided.length).toBeLessThanOrEqual(30);
});

test("two sibling checkouts stay distinguishable after elision", () => {
  const a = elideDirectoryHead("/home/user/Projects/live-log-viewer/.worktrees/", 34);
  const b = elideDirectoryHead("/home/user/Projects/other-viewer/.worktrees/", 34);
  expect(a).not.toBe(b);
});

test("a single enormous segment elides instead of swallowing the whole head", () => {
  const head = "/home/" + "x".repeat(200) + "/deep/";
  const elided = elideDirectoryHead(head, 24);
  expect(elided).toBe("/home/…/deep/");
});

test("every filter token must appear somewhere in the path", () => {
  expect(matchesDirectoryQuery("/repos/live-log-viewer/.worktrees/fix-887", "viewer 887")).toBe(true);
  expect(matchesDirectoryQuery("/repos/live-log-viewer/.worktrees/fix-887", "VIEWER")).toBe(true);
  expect(matchesDirectoryQuery("/repos/live-log-viewer/.worktrees/fix-887", "viewer 999")).toBe(false);
  /* An empty filter matches everything: the list opens browsable. */
  expect(matchesDirectoryQuery("/repos/anything", "   ")).toBe(true);
});

test("only a path naming a place from a fixed root is offered as a directory", () => {
  expect(isDirectoryPath("/mnt/scratch")).toBe(true);
  expect(isDirectoryPath("~")).toBe(true);
  expect(isDirectoryPath("~/Projects/atlas")).toBe(true);
  /* A fragment with a slash in it is still a filter (issue #1223): only the
     side that resolves it has a working directory, and it is never the one the
     operator meant. */
  expect(isDirectoryPath("atlas/.worktrees/fix")).toBe(false);
  expect(isDirectoryPath("887 follow")).toBe(false);
});

test("the chosen directory heads the list exactly once", () => {
  expect(directoryChoices("/repos/b", ["/repos/a", "/repos/b", " /repos/b ", ""])).toEqual(["/repos/b", "/repos/a"]);
  expect(directoryChoices("", ["/repos/a"])).toEqual(["/repos/a"]);
});

test("an untouched query lists everything; a typed one filters and offers itself", () => {
  const known = ["/repos/a", "/repos/b"];
  expect(directoryRows(known, "/repos/a", true).map((row) => row.value)).toEqual(known);
  /* A bare word is a filter, not a directory: it narrows the list and is not
     offered as a path of its own. */
  expect(directoryRows(known, "b", false).map((row) => row.value)).toEqual(["/repos/b"]);
  expect(directoryRows(known, "nothing-here", false)).toEqual([]);
  const typed = directoryRows(known, "/elsewhere/checkout", false);
  expect(typed).toEqual([{ key: "typed", value: "/elsewhere/checkout", kind: "typed" }]);
  /* A query that names a known directory exactly is not offered twice. */
  expect(directoryRows(known, "/repos/a", false).map((row) => row.kind)).toEqual(["known"]);
});
