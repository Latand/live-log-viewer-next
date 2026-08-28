import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-monitor-classify-"));
const RESTORE = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, TMPDIR: process.env.TMPDIR, LLV_STATE_DIR: process.env.LLV_STATE_DIR };
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.HOME = SANDBOX;
process.env.XDG_CONFIG_HOME = path.join(SANDBOX, "config");
process.env.TMPDIR = path.join(SANDBOX, "tmp");
fs.mkdirSync(process.env.TMPDIR, { recursive: true });

const { classifyRequest, evidenceStallReason, matchEvidence } = await import("./classify");
const { requestFingerprint } = await import("./requests");
import type { EvidenceItem, OperatorRequest } from "./types";

afterAll(() => {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  /* Restore the ambient environment: the next test file in the same process
     resolves its own sandbox through os.tmpdir(). */
  for (const [key, value] of Object.entries(RESTORE)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const NOW = new Date("2026-07-27T12:00:00Z");
const OPTIONS = { now: NOW, stallAfterMs: 48 * 60 * 60 * 1000 };

function request(text: string, overrides: Partial<OperatorRequest> = {}): OperatorRequest {
  return {
    fingerprint: requestFingerprint(text),
    title: text,
    text,
    project: "viewer",
    at: "2026-07-27T09:00:00Z",
    references: [],
    asksForGithubIssue: false,
    ...overrides,
  };
}

function item(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    kind: "task",
    id: "task-1",
    title: "",
    project: "viewer",
    state: "active",
    owner: null,
    updatedAt: "2026-07-27T11:00:00Z",
    references: [],
    monitorRef: null,
    ...overrides,
  };
}

describe("evidence correlation", () => {
  test("matches on shared meaningful words and ignores stopwords", () => {
    const match = matchEvidence(request("Add a retry to the deploy script when the health check flaps"), [
      item({ id: "task-1", title: "Deploy script retry on a flapping health check" }),
      item({ id: "task-2", title: "Rename the board column labels" }),
    ]);
    expect(match?.item.id).toBe("task-1");
    expect(match!.score).toBeGreaterThan(0.5);
  });

  test("an explicit issue reference outranks wording, and says whether wording agrees", () => {
    const corroborated = matchEvidence(
      request("Finish the recurring conversation monitor in #741", { references: [741] }),
      [
        item({ id: "task-9", title: "Something else entirely", references: [] }),
        item({ kind: "issue", id: "#741", project: null, title: "recurring conversation monitor", references: [741] }),
      ],
    );
    expect(corroborated?.item.id).toBe("#741");
    expect(corroborated!.basis).toBe("reference");

    const passing = matchEvidence(
      request("Ship the archive exporter before #741 lands", { references: [741] }),
      [item({ kind: "issue", id: "#741", project: null, title: "recurring conversation monitor", references: [741] })],
    );
    expect(passing?.item.id).toBe("#741");
    expect(passing!.basis).toBe("contextual-reference");
  });

  test("another project's work can never answer for this project's request", () => {
    const asked = request("Add a retry to the deploy script when the health check flaps");
    const foreign = item({ id: "task-other", project: "other-repo", title: "Deploy script retry on a flapping health check" });
    expect(matchEvidence(asked, [foreign])).toBeNull();
    expect(matchEvidence(asked, [{ ...foreign, project: "viewer" }])?.item.id).toBe("task-other");
  });

  test("a repository-wide item correlates only through a reference the operator named", () => {
    const wording = request("Recurring conversation monitor work");
    const repoWide = item({ kind: "pull-request", id: "#744", project: null, title: "recurring conversation monitor", references: [744] });
    expect(matchEvidence(wording, [repoWide])).toBeNull();
    expect(matchEvidence(request("Finish the recurring conversation monitor in #744", { references: [744] }), [repoWide])?.item.id).toBe("#744");
  });

  test("unrelated work never matches", () => {
    expect(matchEvidence(request("Add a retry to the deploy script"), [item({ title: "Rename the board column labels" })])).toBeNull();
  });
});

describe("request classification", () => {
  test("terminal evidence reads as completed", () => {
    const result = classifyRequest(
      request("Add a retry to the deploy script"),
      [item({ title: "Deploy script retry", state: "terminal" })],
      OPTIONS,
    );
    expect(result.state).toBe("completed");
  });

  test("live evidence reads as in flight and carries the owner", () => {
    const result = classifyRequest(
      request("Add a retry to the deploy script"),
      [item({ title: "Deploy script retry", state: "active", owner: "pipeline-7" })],
      OPTIONS,
    );
    expect(result.state).toBe("in-flight");
    expect(result.match?.item.owner).toBe("pipeline-7");
  });

  test("parked evidence reads as stalled", () => {
    const result = classifyRequest(
      request("Add a retry to the deploy script"),
      [item({ title: "Deploy script retry", state: "inert" })],
      OPTIONS,
    );
    expect(result.state).toBe("stalled");
  });

  test("live evidence that stopped moving past the threshold reads as stalled", () => {
    const result = classifyRequest(
      request("Add a retry to the deploy script"),
      [item({ title: "Deploy script retry", state: "active", updatedAt: "2026-07-20T11:00:00Z" })],
      OPTIONS,
    );
    expect(result.state).toBe("stalled");
    expect(result.reason).toContain("no movement");
  });

  test("nothing correlated reads as untracked", () => {
    const result = classifyRequest(request("Add a retry to the deploy script"), [item({ title: "Rename the board columns" })], OPTIONS);
    expect(result.state).toBe("untracked");
    expect(result.match).toBeNull();
  });

  test("an ambiguous correlation is left for the operator to confirm", () => {
    const result = classifyRequest(
      request("Add a retry to the deploy script when the health check flaps"),
      /* Overlaps on two words out of five — enough to be suspicious, not
         enough to claim the request is covered. */
      [item({ title: "Deploy notes for the health dashboard rewrite" })],
      OPTIONS,
    );
    expect(result.state).toBe("awaiting-confirmation");
  });

  test("a request for a GitHub issue is surfaced unconfirmed, never actuated", () => {
    const result = classifyRequest(
      request("Create a GitHub issue for the deploy retry", { asksForGithubIssue: true }),
      [],
      OPTIONS,
    );
    expect(result.state).toBe("awaiting-confirmation");
    expect(result.reason).toContain("issue");
  });

  test("the monitor's own card is authoritative evidence for its request", () => {
    const asked = request("Add a retry to the deploy script");
    const result = classifyRequest(
      asked,
      [item({ id: "task-mon", title: "wording that would never match", monitorRef: asked.fingerprint })],
      OPTIONS,
    );
    expect(result.state).toBe("in-flight");
    expect(result.match?.item.id).toBe("task-mon");
    expect(result.reason).toContain("board");
  });

  test("a monitor card the operator finished reads as completed", () => {
    const asked = request("Add a retry to the deploy script");
    const result = classifyRequest(asked, [item({ monitorRef: asked.fingerprint, state: "terminal" })], OPTIONS);
    expect(result.state).toBe("completed");
  });

  test("an issue named in passing never retires the request that mentioned it", () => {
    /* "before #741 lands" is context, not evidence. Reading a closed issue as
       terminal here would drop a request nobody has done. */
    const result = classifyRequest(
      request("Ship the archive exporter before #741 lands", { references: [741] }),
      [item({ kind: "issue", id: "#741", project: null, title: "recurring conversation monitor", state: "terminal", references: [741] })],
      OPTIONS,
    );
    expect(result.state).toBe("awaiting-confirmation");
    expect(result.reason).toContain("in passing");
  });

  test("a reference the wording agrees with does settle the verdict", () => {
    const result = classifyRequest(
      request("Finish the recurring conversation monitor in #741", { references: [741] }),
      [item({ kind: "issue", id: "#741", project: null, title: "recurring conversation monitor", state: "terminal", references: [741] })],
      OPTIONS,
    );
    expect(result.state).toBe("completed");
  });

  test("a foreign project's card leaves the request untracked", () => {
    const result = classifyRequest(
      request("Add a retry to the deploy script when the health check flaps"),
      [item({ id: "task-other", project: "other-repo", title: "Deploy script retry on a flapping health check" })],
      OPTIONS,
    );
    expect(result.state).toBe("untracked");
    expect(result.match).toBeNull();
  });
});

/**
 * The one stall rule, and its two callers (#1245). Request classification asks
 * it with a movement threshold; the seat tick asks it with none, because it
 * holds the registry's own activity verdict for the turn and a second answer
 * derived by subtracting attempt timestamps from the clock would contradict it.
 */
describe("the shared stall rule", () => {
  const lane = { kind: "pipeline" as const, id: "pipeline_a1", state: "active" as const, updatedAt: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString() };

  test("parked is stalled outright, whichever caller asks", () => {
    expect(evidenceStallReason({ ...lane, state: "inert" }, { now: NOW, stallAfterMs: 40 * 60_000 })).toContain("is parked");
    expect(evidenceStallReason({ ...lane, state: "inert" }, { now: NOW, stallAfterMs: null })).toContain("is parked");
  });

  test("a movement threshold stalls an item that stopped moving; no threshold never does", () => {
    expect(evidenceStallReason(lane, { now: NOW, stallAfterMs: 40 * 60_000 })).toContain("no movement past the stall threshold");
    expect(evidenceStallReason(lane, { now: NOW, stallAfterMs: null })).toBeNull();
  });

  test("terminal work and an item with no movement instant are never stalled", () => {
    expect(evidenceStallReason({ ...lane, state: "terminal" }, { now: NOW, stallAfterMs: 40 * 60_000 })).toBeNull();
    expect(evidenceStallReason({ ...lane, updatedAt: null }, { now: NOW, stallAfterMs: 40 * 60_000 })).toBeNull();
  });
});
