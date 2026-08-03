/**
 * Issue #863. The acceptance properties the bounded `list_pipelines` projection
 * establishes, asserted against the same 500-pipeline production-shaped registry
 * the profile was measured on (`spikes/issue-863/`).
 *
 * The bars here are STRUCTURAL — response bytes, which fields exist, which
 * filters and ordering hold, whether a checkpoint can abandon the walk. Wall
 * clock and RSS stay in the spike script: they are the reason this exists, but
 * they are host-speed measurements and would make this suite flaky.
 */
import { describe, expect, test } from "bun:test";

import { CORPUS_BODY_MARKERS, pipelineCorpus } from "./fixtures/corpus";
import {
  PIPELINE_LIST_MAX_LIMIT,
  pipelineListRow,
  projectPipelineListRows,
  selectPipelineListRecords,
} from "./listProjection";
import type { Pipeline } from "./types";

const CORPUS_SIZE = 500;
/* A board card is identity, placement, state, cursor and per-stage counts. The
   profiled rows were 365 KB each; 4 KB is the bar that keeps a 100-row page
   under half a megabyte instead of 37 MB. */
const ROW_BUDGET_BYTES = 4 * 1024;

const corpus = pipelineCorpus(CORPUS_SIZE);
const source = () => corpus;

/** The naive filter the previous binding applied, kept as the parity oracle. */
function naiveFilter(
  pipelines: readonly Pipeline[],
  { project, state, includeClosed }: { project?: string; state?: string; includeClosed?: boolean },
): Pipeline[] {
  return pipelines
    .filter((pipeline) => !project || pipeline.project === project)
    .filter((pipeline) => !state || pipeline.state === state)
    .filter((pipeline) => includeClosed || pipeline.state !== "closed");
}

const listPage = (filter: Parameters<typeof projectPipelineListRows>[0]) =>
  projectPipelineListRows(filter, { source });

describe("bounded list rows", () => {
  test("a 100-row page stays within the row budget", async () => {
    const rows = await listPage({ project: "viewer", includeClosed: false, limit: 100 });
    expect(rows).toHaveLength(100);
    const bytes = Buffer.byteLength(JSON.stringify(rows));
    expect(bytes / rows.length).toBeLessThanOrEqual(ROW_BUDGET_BYTES);
  });

  test("no stage prompt, scaffold, spec body, relay input or transcript tail reaches a row", async () => {
    const serialized = JSON.stringify(await listPage({ project: "viewer", limit: 100 }));
    for (const marker of Object.values(CORPUS_BODY_MARKERS)) {
      expect(serialized).not.toContain(marker);
    }
  });

  test("rows carry no attempt history, only counts and the latest attempt's outcome", async () => {
    const [row] = await listPage({ project: "viewer", limit: 1 });
    expect(row).not.toHaveProperty("runs");
    expect(row).not.toHaveProperty("spec");
    expect(row.hasSpec).toBe(true);
    /* 2 stages x 6 attempts in the fixture. */
    expect(row.attemptCount).toBe(12);
    expect(row.stages.map((stage) => stage.attempts)).toEqual([6, 6]);
    for (const stage of row.stages) {
      expect(stage).not.toHaveProperty("prompt");
      expect(stage).not.toHaveProperty("effectiveRole");
      expect(stage.latestAttempt).toMatchObject({ n: 6, state: "passed", verdict: "pass" });
      expect(stage.latestAttempt).not.toHaveProperty("input");
      expect(stage.latestAttempt).not.toHaveProperty("output");
    }
  });

  test("the operator-useful identity, placement and cursor survive", async () => {
    const [record] = naiveFilter(corpus, { project: "viewer" });
    const [row] = await listPage({ project: "viewer", limit: 1 });
    expect(row).toMatchObject({
      id: record.id,
      task: record.task,
      project: "viewer",
      repoDir: record.repoDir,
      worktreeDir: record.worktreeDir,
      branch: record.branch,
      state: record.state,
      createdAt: record.createdAt,
      cursor: record.cursor && { stageId: record.cursor.stageId, state: record.cursor.state },
    });
    expect(row.stages.map((stage) => ({ id: stage.id, kind: stage.kind, roleId: stage.roleId, next: stage.next })))
      .toEqual([
        { id: "build", kind: "run", roleId: "builder", next: "review" },
        { id: "review", kind: "review-loop", roleId: "reviewer", next: null },
      ]);
  });

  test("operator free text is clamped, so a row has a length bound the registry does not", async () => {
    const long = "x".repeat(5_000);
    const row = pipelineListRow({ ...corpus[1], task: long, stateDetail: long });
    expect(row.task.length).toBeLessThan(600);
    expect(row.stateDetail!.length).toBeLessThan(600);
    expect(row.task.startsWith("x".repeat(400))).toBe(true);
  });

  /* A lineage-adopted attempt is evidence, never the stage's current work — the
     same rule `latestOperationalStageAttempt` enforces everywhere else. */
  test("a trailing historical attempt is not reported as the stage's latest", () => {
    const record = corpus[1];
    const [firstRun, ...rest] = record.runs;
    const adopted = { ...firstRun.attempts[0], n: 99, state: "failed" as const, historical: true };
    const row = pipelineListRow({
      ...record,
      runs: [{ ...firstRun, attempts: [...firstRun.attempts, adopted] }, ...rest],
    });
    expect(row.stages[0].attempts).toBe(7);
    expect(row.stages[0].latestAttempt).toMatchObject({ n: 6, state: "passed" });
    expect(row.attemptCount).toBe(13);
  });

  test("a record with no runs projects an empty history rather than throwing", () => {
    const row = pipelineListRow({ ...corpus[1], runs: undefined as never });
    expect(row.attemptCount).toBe(0);
    expect(row.stages.map((stage) => stage.latestAttempt)).toEqual([null, null]);
  });

  test("a row aliases nothing from the source record", async () => {
    const [row] = await listPage({ project: "viewer", limit: 1 });
    const [record] = naiveFilter(corpus, { project: "viewer" });
    expect(row.taskIds).not.toBe(record.taskIds);
    row.taskIds.push("mutated");
    expect(record.taskIds).not.toContain("mutated");
  });
});

describe("filter, ordering and limit semantics are unchanged", () => {
  const cases: { name: string; filter: { project?: string; state?: string; includeClosed?: boolean } }[] = [
    { name: "unfiltered open pipelines", filter: {} },
    { name: "project", filter: { project: "viewer" } },
    { name: "state", filter: { state: "running" } },
    { name: "project + state", filter: { project: "project-2", state: "running" } },
    { name: "includeClosed", filter: { project: "viewer", includeClosed: true } },
    { name: "closed only", filter: { state: "closed", includeClosed: true } },
    { name: "a project with no pipelines", filter: { project: "absent" } },
  ];

  for (const { name, filter } of cases) {
    test(`${name} selects the same records, in registry order`, async () => {
      const expected = naiveFilter(corpus, filter).slice(0, 100);
      const rows = await listPage({ ...filter, limit: 100 });
      expect(rows.map((row) => row.id)).toEqual(expected.map((pipeline) => pipeline.id));
      expect(rows).toHaveLength(expected.length);
    });
  }

  test("closed pipelines are excluded unless includeClosed asks for them", async () => {
    const open = await listPage({ limit: PIPELINE_LIST_MAX_LIMIT });
    expect(open.some((row) => row.state === "closed")).toBe(false);
    const all = await listPage({ includeClosed: true, limit: PIPELINE_LIST_MAX_LIMIT });
    expect(all.some((row) => row.state === "closed")).toBe(true);
    /* A closed lane still reports when it closed — the board needs it to render. */
    expect(all.find((row) => row.state === "closed")!.closedAt).toBeString();
  });

  test("limit is clamped to the published bounds", async () => {
    expect(await listPage({ limit: 0 })).toHaveLength(1);
    expect(await listPage({ limit: -5 })).toHaveLength(1);
    expect(await listPage({ limit: 10_000 })).toHaveLength(PIPELINE_LIST_MAX_LIMIT);
    expect(await listPage({ limit: null })).toHaveLength(100);
    expect(await listPage({})).toHaveLength(100);
  });

  test("selection stops at the limit instead of filtering the whole registry first", () => {
    const selected = selectPipelineListRecords(corpus, { project: "viewer", limit: 5 });
    expect(selected).toHaveLength(5);
    expect(selected.map((pipeline) => pipeline.id))
      .toEqual(naiveFilter(corpus, { project: "viewer" }).slice(0, 5).map((pipeline) => pipeline.id));
  });
});

describe("cancellation", () => {
  test("a checkpoint that throws abandons the projection", async () => {
    const boom = new Error("deadline exceeded");
    let calls = 0;
    await expect(projectPipelineListRows({ limit: 100 }, {
      source,
      checkpoint: () => { calls += 1; if (calls > 1) throw boom; },
    })).rejects.toThrow("deadline exceeded");
  });

  test("the projection yields, so a deadline armed by the caller can actually land", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("caller gave up")), 0);
    await expect(projectPipelineListRows({ limit: PIPELINE_LIST_MAX_LIMIT }, {
      source,
      checkpoint: () => {
        if (controller.signal.aborted) throw controller.signal.reason as Error;
      },
    })).rejects.toThrow("caller gave up");
  });

  test("a page that fits inside one batch still completes without a checkpoint", async () => {
    expect(await projectPipelineListRows({ limit: 3 }, { source })).toHaveLength(3);
  });
});
