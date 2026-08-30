import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-monitor-gh-"));
const RESTORE = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
process.env.TMPDIR = path.join(SANDBOX, "tmp");
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

const { githubEvidenceSource, openIssuesForProposal, openPullRequestsForRepo } = await import("./githubEvidence");
const { evidenceFromGithub } = await import("./evidence");

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("github evidence", () => {
  test("reads pull requests and issues, and never writes", async () => {
    const invocations: string[][] = [];
    const source = githubEvidenceSource({
      cwd: SANDBOX,
      run: async (args) => {
        invocations.push(args);
        return args[0] === "pr"
          ? JSON.stringify([{ number: 737, title: "pipeline engine split", state: "OPEN", updatedAt: "2026-07-26T10:00:00Z" }])
          : JSON.stringify([{ number: 741, title: "recurring conversation monitor", state: "CLOSED", updatedAt: "2026-07-27T10:00:00Z" }]);
      },
    });
    const rows = await source();
    expect(rows.map((row) => row.number)).toEqual([737, 741]);
    expect(invocations.every((args) => args[1] === "list")).toBe(true);
    expect(invocations.flat()).not.toContain("create");

    const evidence = evidenceFromGithub(rows);
    expect(evidence[0]!.state).toBe("active");
    expect(evidence[1]!.state).toBe("terminal");
    expect(evidence[1]!.references).toEqual([741]);
  });

  test("garbage output is an error the run can degrade on, not a silent empty list", async () => {
    const source = githubEvidenceSource({ cwd: SANDBOX, run: async () => "not json" });
    expect(source()).rejects.toThrow(/parsable JSON/);
  });

  test("skips rows without a usable number", async () => {
    const source = githubEvidenceSource({ cwd: SANDBOX, run: async () => JSON.stringify([{ title: "no number" }, { number: 12, title: "ok", state: "OPEN" }]) });
    const rows = await source();
    expect(rows.map((row) => row.number)).toEqual([12, 12]);
  });
});

describe("open issues for the proactive slot", () => {
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

  test("open pull requests are read with the head branch that ties one to a lane (#1289)", async () => {
    const calls: string[][] = [];
    const pullRequests = await openPullRequestsForRepo({
      cwd: "/srv/repo",
      run: async (args) => {
        calls.push(args);
        return JSON.stringify([
          { number: 1289, title: "wake on a merge that is waiting", headRefName: "topic-merge-queue", updatedAt: "2026-08-29T10:00:00Z" },
          { number: 1285, title: "stop replaying closed lanes", headRefName: "topic-closed-lanes", updatedAt: null },
        ]);
      },
    });
    expect(calls[0]).toEqual(["pr", "list", "--state", "open", "--limit", "60", "--json", "number,title,headRefName,updatedAt"]);
    expect(pullRequests).toEqual({
      ok: true,
      pullRequests: [
        { number: 1289, title: "wake on a merge that is waiting", headRefName: "topic-merge-queue", updatedAt: "2026-08-29T10:00:00Z" },
        { number: 1285, title: "stop replaying closed lanes", headRefName: "topic-closed-lanes", updatedAt: null },
      ],
    });
    /* Read-only, like every other question asked of this seam. */
    expect(calls.flat()).not.toContain("merge");
  });

  test("a pull request with no head branch is dropped, because nothing could attribute it to a lane", async () => {
    const pullRequests = await openPullRequestsForRepo({
      cwd: "/srv/repo",
      run: async () => JSON.stringify([{ number: 5, title: "no head" }, { number: 6, title: "kept", headRefName: "topic" }]),
    });
    expect(pullRequests).toEqual({ ok: true, pullRequests: [{ number: 6, title: "kept", headRefName: "topic", updatedAt: null }] });
  });

  /* The distinction the whole reason rests on: a repository with everything
     merged answers, and answering is what makes the tick's silence mean
     something. An empty ANSWER is still an answer. */
  test("a repository with nothing open answers, rather than failing to answer", async () => {
    expect(await openPullRequestsForRepo({ cwd: "/srv/repo", run: async () => "[]" })).toEqual({ ok: true, pullRequests: [] });
  });

  /* And its mirror image: none of these establishes that a pull request
     merged, so none of them may be handed on as the empty list that says so. */
  test("a gh that cannot answer is carried as a failure, never as an empty list", async () => {
    expect(await openPullRequestsForRepo({ cwd: "/srv/repo", run: async () => { throw new Error("gh: command not found"); } }))
      .toEqual({ ok: false, unavailable: "command-failed" });
    expect(await openPullRequestsForRepo({ cwd: "/srv/repo", run: async () => "not json" }))
      .toEqual({ ok: false, unavailable: "malformed-output" });
    expect(await openPullRequestsForRepo({ cwd: "/srv/repo", run: async () => "{}" }))
      .toEqual({ ok: false, unavailable: "malformed-output" });
  });

  /* `execFile` reports the timeout it enforces as a killed child, and an
     outage reads differently from a misconfiguration to whoever is holding the
     journal line. */
  test("a gh killed at its timeout is named as a timeout", async () => {
    const killed = Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" });
    expect(await openPullRequestsForRepo({ cwd: "/srv/repo", run: async () => { throw killed; } }))
      .toEqual({ ok: false, unavailable: "timed-out" });
    expect(await openPullRequestsForRepo({ cwd: "/srv/repo", run: async () => { throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }); } }))
      .toEqual({ ok: false, unavailable: "timed-out" });
  });

  test("a row without a usable number is dropped rather than ranked as issue zero", async () => {
    const issues = await openIssuesForProposal({
      cwd: "/srv/repo",
      run: async () => JSON.stringify([{ title: "no number" }, "a string", { number: 7, title: "kept", labels: [{ name: 7 }] }]),
    });
    expect(issues).toEqual([{ number: 7, title: "kept", labels: [], updatedAt: null }]);
  });
});
