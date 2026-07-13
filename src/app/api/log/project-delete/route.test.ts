import { expect, test } from "bun:test";

import { projectDeletionMembershipMatches } from "./route";

test("project deletion rejects membership added after the client catalog snapshot", () => {
  const expected = new Set(["/sessions/one.jsonl", "/sessions/two.jsonl"]);

  expect(projectDeletionMembershipMatches(expected, [
    { path: "/sessions/one.jsonl" },
    { path: "/sessions/two.jsonl" },
  ])).toBe(true);
  expect(projectDeletionMembershipMatches(expected, [
    { path: "/sessions/one.jsonl" },
    { path: "/sessions/two.jsonl" },
    { path: "/sessions/new-running.jsonl" },
  ])).toBe(false);
});
