import { expect, test } from "bun:test";

import { openIssuesForProposal } from "./githubProposal";

test("open issues arrive with their titles and labels, which is what a ranking needs", async () => {
  const calls: string[][] = [];
  const issues = await openIssuesForProposal({
    cwd: "/srv/repo",
    run: async (args) => {
      calls.push(args);
      return JSON.stringify([
        { number: 1245, title: "the native seat tick", labels: [{ name: "design" }, { name: "monitor" }], updatedAt: "2026-08-28T10:00:00Z" },
        { number: 1105, title: "engine-side wake", labels: [], updatedAt: null },
      ]);
    },
  });
  expect(calls[0]).toEqual(["issue", "list", "--state", "open", "--limit", "40", "--json", "number,title,labels,updatedAt"]);
  expect(issues).toEqual([
    { number: 1245, title: "the native seat tick", labels: ["design", "monitor"], updatedAt: "2026-08-28T10:00:00Z" },
    { number: 1105, title: "engine-side wake", labels: [], updatedAt: null },
  ]);
});

test("a gh that is missing, unauthenticated or rate-limited degrades to no issues instead of failing the slot", async () => {
  expect(await openIssuesForProposal({ cwd: "/srv/repo", run: async () => { throw new Error("gh: command not found"); } })).toEqual([]);
  expect(await openIssuesForProposal({ cwd: "/srv/repo", run: async () => "not json" })).toEqual([]);
  expect(await openIssuesForProposal({ cwd: "/srv/repo", run: async () => "{}" })).toEqual([]);
});

test("a row without a usable number is dropped rather than ranked as issue zero", async () => {
  const issues = await openIssuesForProposal({
    cwd: "/srv/repo",
    run: async () => JSON.stringify([{ title: "no number" }, "a string", { number: 7, title: "kept", labels: [{ name: 7 }] }]),
  });
  expect(issues).toEqual([{ number: 7, title: "kept", labels: [], updatedAt: null }]);
});
