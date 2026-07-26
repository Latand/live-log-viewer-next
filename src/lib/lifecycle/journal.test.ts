import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  appendLifecycleEvents,
  lifecycleEventId,
  lifecycleJournalPath,
  queryLifecycleEvents,
  readLifecycleJournal,
  type LifecycleEventInput,
} from "./journal";
import { projectLifecycleEvents } from "./projector";
import { operatorSafeSummary } from "./vocabulary";

const sandboxes: string[] = [];
const originalStateDir = process.env.LLV_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = originalStateDir;
  for (const sandbox of sandboxes.splice(0)) fs.rmSync(sandbox, { recursive: true, force: true });
});

function sandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-journal-"));
  sandboxes.push(dir);
  process.env.LLV_STATE_DIR = path.join(dir, "state");
  return dir;
}

const reviewerStage: LifecycleEventInput[] = [
  {
    key: "pipeline:pipeline_a:stage:review:attempt:1:started",
    type: "stage_started",
    at: "2026-07-26T09:00:00.000Z",
    project: "viewer",
    pipelineId: "pipeline_a",
    stageId: "review",
    attempt: 1,
    conversationId: "conversation_reviewer",
    role: "reviewer",
    summary: "review started",
  },
  {
    key: "pipeline:pipeline_a:stage:review:attempt:1:passed",
    type: "stage_completed",
    at: "2026-07-26T09:20:00.000Z",
    project: "viewer",
    pipelineId: "pipeline_a",
    stageId: "review",
    attempt: 1,
    conversationId: "conversation_reviewer",
    role: "reviewer",
    summary: "APPROVE — no blocking findings",
  },
];

test("the journal survives a restart and a replay appends nothing twice", () => {
  sandbox();
  const first = appendLifecycleEvents(reviewerStage);
  expect(first.appended.map((event) => event.seq)).toEqual([1, 2]);
  expect(first.skipped).toBe(0);

  /* Simulated restart: nothing in memory, everything re-read from the file. */
  const persisted = readLifecycleJournal();
  expect(persisted.lastSeq).toBe(2);
  expect(persisted.events.map((event) => event.type)).toEqual(["stage_started", "stage_completed"]);
  expect(persisted.events[1]!.id).toBe(lifecycleEventId("pipeline:pipeline_a:stage:review:attempt:1:passed"));

  /* The producer re-projects the same pipeline state after the restart. */
  const replay = appendLifecycleEvents(reviewerStage);
  expect(replay.appended).toEqual([]);
  expect(replay.skipped).toBe(2);
  expect(readLifecycleJournal().events).toHaveLength(2);
  expect(readLifecycleJournal().lastSeq).toBe(2);

  /* A genuinely new transition still lands after the replay. */
  const next = appendLifecycleEvents([{ ...reviewerStage[1]!, key: "pipeline:pipeline_a:stage:review:attempt:2:passed", at: "2026-07-26T09:40:00.000Z" }]);
  expect(next.appended.map((event) => event.seq)).toEqual([3]);
});

test("events are queryable by project, pipeline, conversation and cursor", () => {
  sandbox();
  appendLifecycleEvents([
    ...reviewerStage,
    {
      key: "pipeline:pipeline_b:stage:build:attempt:1:failed",
      type: "stage_failed",
      at: "2026-07-26T09:30:00.000Z",
      project: "other",
      pipelineId: "pipeline_b",
      stageId: "build",
      attempt: 1,
      conversationId: "conversation_builder",
      role: "builder",
      summary: "tests failed",
    },
  ]);

  expect(queryLifecycleEvents({ pipelineId: "pipeline_a" }).count).toBe(2);
  expect(queryLifecycleEvents({ project: "other" }).events.map((event) => event.type)).toEqual(["stage_failed"]);
  expect(queryLifecycleEvents({ conversationId: "conversation_reviewer" }).count).toBe(2);
  const page = queryLifecycleEvents({ afterSeq: 2 });
  expect(page.events.map((event) => event.seq)).toEqual([3]);
  expect(page.cursor).toBe(3);
  expect(queryLifecycleEvents({ afterSeq: 3 }).count).toBe(0);
});

/* The synthetic secret shapes are assembled at runtime: a literal token in this
   file would be a publication finding in its own right, even a fake one. */
const FAKE_GITHUB_PREFIX = ["gh", "p_"].join("");
const FAKE_ANTHROPIC_PREFIX = ["sk", "ant", "api03"].join("-");

test("summaries are bounded and redacted, and raw output never reaches the journal", () => {
  sandbox();
  appendLifecycleEvents([{
    key: "pipeline:pipeline_c:stage:deploy:attempt:1:failed",
    type: "stage_failed",
    at: "2026-07-26T10:00:00.000Z",
    project: "viewer",
    pipelineId: "pipeline_c",
    summary: [
      "```",
      `export GITHUB_TOKEN=${FAKE_GITHUB_PREFIX}${"0123456789".repeat(4)}`,
      "```",
      `deploy failed using ${FAKE_ANTHROPIC_PREFIX}-${"a1b2c3d4".repeat(3)} ${"x".repeat(400)}`,
    ].join("\n"),
  }]);
  const [event] = readLifecycleJournal().events;
  expect(event!.summary).not.toContain(FAKE_GITHUB_PREFIX);
  expect(event!.summary).not.toContain(FAKE_ANTHROPIC_PREFIX);
  expect(event!.summary.length).toBeLessThanOrEqual(200);
  expect(event!.summary.startsWith("deploy failed")).toBe(true);

  /* The bounding helper both surfaces drop into, checked directly. */
  expect(operatorSafeSummary("```\nsecret log\n```\nfirst meaningful line\nsecond")).toBe("first meaningful line");
  expect(operatorSafeSummary("")).toBe("");
});

test("a completed reviewer attempt projects a durable stage event and a review verdict with its lineage", () => {
  sandbox();
  const pipeline = {
    id: "pipeline_review",
    project: "viewer",
    createdAt: "2026-07-26T09:00:00.000Z",
    stages: [{ id: "review", kind: "review-loop" }],
    runs: [{
      stageId: "review",
      attempts: [{
        n: 1,
        state: "passed",
        conversationId: "conversation_reviewer",
        effectiveRole: { roleId: "reviewer" },
        startedAt: "2026-07-26T09:00:00.000Z",
        completedAt: "2026-07-26T09:20:00.000Z",
        output: "APPROVE\nNO FINDINGS",
        verdict: { status: "pass", findings: [] },
      }],
    }],
  } as unknown as Parameters<typeof projectLifecycleEvents>[0]["pipelines"] extends (infer T)[] ? T : never;

  appendLifecycleEvents(projectLifecycleEvents({ pipelines: [pipeline] }));
  const events = queryLifecycleEvents({ pipelineId: "pipeline_review" }).events;
  expect(events.map((event) => event.type)).toEqual(["stage_started", "stage_completed", "review_verdict"]);
  const verdict = events.find((event) => event.type === "review_verdict")!;
  expect(verdict.state).toBe("completed");
  expect(verdict.stageId).toBe("review");
  expect(verdict.role).toBe("reviewer");
  expect(verdict.conversationId).toBe("conversation_reviewer");
  expect(verdict.summary).toContain("pass");
  expect(fs.existsSync(lifecycleJournalPath())).toBe(true);
});
