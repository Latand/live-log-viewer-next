import { expect, test } from "bun:test";

import type { FileEntry } from "@/lib/types";

import { livePidForPath } from "./livePane";

function e(over: Partial<FileEntry>): Pick<FileEntry, "path" | "proc" | "pid"> {
  return { path: "/x.jsonl", proc: "running", pid: 100, ...over };
}

test("resolves the running pane pid for the target path only", () => {
  const entries = [
    e({ path: "/a.jsonl", pid: 11 }),
    e({ path: "/b.jsonl", pid: 22 }),
  ];
  // Binds to the target's own path, never another session's pid.
  expect(livePidForPath(entries, "/b.jsonl")).toBe(22);
  expect(livePidForPath(entries, "/a.jsonl")).toBe(11);
});

test("ignores non-running or pid-less entries and unknown paths", () => {
  const entries = [
    e({ path: "/done.jsonl", proc: "done", pid: 33 }),
    e({ path: "/nopid.jsonl", proc: "running", pid: null }),
  ];
  expect(livePidForPath(entries, "/done.jsonl")).toBeNull();
  expect(livePidForPath(entries, "/nopid.jsonl")).toBeNull();
  expect(livePidForPath(entries, "/missing.jsonl")).toBeNull();
});
