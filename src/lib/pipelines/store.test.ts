import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { archiveSettledPipelines, buildPipeline, checkpointPipelineRollbackMirrorsForDemotion, findPipelineRecord, loadPipelinesForStartup, loadArchivedPipelines, loadPipelines, PIPELINES_SCHEMA_VERSION, savePipelines, withPipelineMutation, withPipelineStartupAdmission } from "./store";
import type { Pipeline, PipelineStage } from "./types";

const ARCHIVE_CHILD = path.join(import.meta.dir, "archive.sqliteChild.ts");

async function waitForFile(filename: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(filename)) {
    if (Date.now() > deadline) throw new Error("archive child did not reach its transaction barrier");
    await Bun.sleep(5);
  }
}

test.each(["max", "ultra"])("Astra %s pipelines persist creation and stage edits", (effort) => {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipelines-store-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    const stages: PipelineStage[] = [
      { id: "build", kind: "run" as const, role: { roleId: "builder" }, engine: "codex" as const, prompt: "build", next: "review", effectiveRole: { roleId: "builder", engine: "codex", model: "gpt-6-astra", effort, access: "read-write", promptScaffold: "builder" } },
      { id: "review", kind: "review-loop" as const, role: { roleId: "reviewer" }, engine: "codex" as const, prompt: "review", next: null, effectiveRole: { roleId: "reviewer", engine: "codex", model: "gpt-5.6-sol", effort: "xhigh", access: "read-only", promptScaffold: "reviewer" } },
    ];
    const pipeline = buildPipeline({
      id: "abcdef12",
      task: "task",
      taskIds: ["task-1"],
      creationIntent: { kind: "task-spawn", taskId: "task-1", launchId: "launch-task-1" },
      spec: "AC1",
      project: "viewer",
      repoDir: "/repo",
      stages,
      srcPath: null,
      srcConversationId: "conversation_task_1",
      now: "now",
    });
    savePipelines([pipeline]);
    checkpointPipelineRollbackMirrorsForDemotion();
    expect(JSON.parse(fs.readFileSync(path.join(sandbox, "pipelines.json"), "utf8"))).toMatchObject({ schemaVersion: PIPELINES_SCHEMA_VERSION });
    expect(loadPipelines()).toEqual([pipeline]);
    pipeline.stages[0]!.effectiveRole.effort = effort === "max" ? "ultra" : "max";
    savePipelines([pipeline]);
    expect(loadPipelines()).toEqual([pipeline]);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("pipeline mutations preserve corrupt and future-schema registries", async () => {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipelines-corrupt-"));
  process.env.LLV_STATE_DIR = sandbox;
  const file = path.join(sandbox, "pipelines.json");
  try {
    for (const content of ["{", JSON.stringify({ schemaVersion: PIPELINES_SCHEMA_VERSION + 1, pipelines: [] })]) {
      fs.writeFileSync(file, content, "utf8");
      await expect(withPipelineMutation((_pipelines, persist) => persist())).rejects.toThrow();
      expect(fs.readFileSync(file, "utf8")).toBe(content);
    }
    const stages: PipelineStage[] = [
      { id: "build", kind: "run", prompt: "build", next: "verify", effectiveRole: { roleId: null, engine: "codex", model: "gpt-5.6-sol", effort: "medium", access: "read-write", promptScaffold: null } },
      { id: "verify", kind: "run", prompt: "verify", next: null, effectiveRole: { roleId: null, engine: "codex", model: "gpt-5.6-sol", effort: "medium", access: "read-write", promptScaffold: null } },
    ];
    const rejectsWithoutRewrite = async (pipeline: unknown) => {
      const bytes = JSON.stringify({ schemaVersion: PIPELINES_SCHEMA_VERSION, pipelines: [pipeline] });
      fs.writeFileSync(file, bytes, "utf8");
      await expect(withPipelineMutation((_pipelines, persist) => persist())).rejects.toThrow("malformed records");
      expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    };
    const malformed = buildPipeline({ id: "badbad12", task: "task", project: "viewer", repoDir: "/repo", stages, srcPath: null, srcConversationId: null, now: "now" }) as unknown as Record<string, unknown>;
    malformed.state = "teleported";
    await rejectsWithoutRewrite(malformed);

    const incompatible = buildPipeline({ id: "badrole1", task: "task", project: "viewer", repoDir: "/repo", stages, srcPath: null, srcConversationId: null, now: "now" });
    incompatible.stages[0]!.effectiveRole.model = "fable";
    await rejectsWithoutRewrite(incompatible);

    const unsafeWorktree = buildPipeline({ id: "badpath1", task: "task", project: "viewer", repoDir: "/repo", stages, srcPath: null, srcConversationId: null, now: "now" });
    unsafeWorktree.worktreeDir = "/repo";
    await rejectsWithoutRewrite(unsafeWorktree);

    const mismatchedRole = buildPipeline({ id: "badrole2", task: "task", project: "viewer", repoDir: "/repo", stages, srcPath: null, srcConversationId: null, now: "now" });
    mismatchedRole.stages[0]!.role = { roleId: "builder" };
    await rejectsWithoutRewrite(mismatchedRole);

    const expandedVerdict = buildPipeline({ id: "badverdt", task: "task", project: "viewer", repoDir: "/repo", stages, srcPath: null, srcConversationId: null, now: "now" });
    expandedVerdict.runs[0]!.attempts.push({
      n: 1,
      state: "passed",
      effectiveRole: structuredClone(expandedVerdict.stages[0]!.effectiveRole),
      launchId: null,
      conversationId: null,
      sessionId: null,
      agentPath: null,
      paneId: null,
      flowId: null,
      startedAt: null,
      completedAt: null,
      input: null,
      activatedBy: null,
      output: null,
      verdict: { status: "pass", findings: Array.from({ length: 51 }, () => "finding") },
      error: null,
    });
    await rejectsWithoutRewrite(expandedVerdict);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("savePipelines rejects a malformed record instead of poisoning the registry", () => {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipelines-save-guard-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    const stages: PipelineStage[] = [
      { id: "build", kind: "run", prompt: "build", next: "verify", effectiveRole: { roleId: null, engine: "codex", model: "gpt-5.6-sol", effort: "medium", access: "read-write", promptScaffold: null } },
      { id: "verify", kind: "run", prompt: "verify", next: null, effectiveRole: { roleId: null, engine: "codex", model: "gpt-5.6-sol", effort: "medium", access: "read-write", promptScaffold: null } },
    ];
    const pipeline = buildPipeline({ id: "guard123", task: "task", project: "viewer", repoDir: "/repo", stages, srcPath: null, srcConversationId: null, now: "now" });
    pipeline.state = "closed"; // closed with a live cursor is exactly the poison shape
    pipeline.cursor = { stageId: "build", state: "running", input: null, activatedBy: null };
    expect(() => savePipelines([pipeline])).toThrow("malformed pipeline record");
    expect(loadPipelines()).toEqual([]);
    checkpointPipelineRollbackMirrorsForDemotion();
    expect(JSON.parse(fs.readFileSync(path.join(sandbox, "pipelines.json"), "utf8"))).toMatchObject({ pipelines: [] });
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

/* ── Schema v3 (#353): v2 migration, graph validation, stage bounds ────────── */

function sandboxed(run: (sandbox: string) => void): void {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipelines-v3-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    run(sandbox);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

const v3Role = { roleId: null, engine: "codex", model: "gpt-5.6-sol", effort: "medium", access: "read-write", promptScaffold: null } as const;

function v3Stages(): PipelineStage[] {
  return [
    { id: "build", kind: "run", prompt: "build", next: "verify", effectiveRole: { ...v3Role } },
    { id: "verify", kind: "run", prompt: "verify", next: null, effectiveRole: { ...v3Role } },
  ];
}

test("current production records without verdict recovery metadata load and round-trip", () => {
  sandboxed((sandbox) => {
    const pipeline = buildPipeline({
      id: "premiss1",
      task: "task",
      project: "viewer",
      repoDir: "/repo",
      stages: v3Stages(),
      srcPath: null,
      srcConversationId: null,
      now: "2026-07-29T00:00:00.000Z",
    });
    pipeline.state = "needs_decision";
    pipeline.stateDetail = "stage completed without a valid final JSON verdict";
    pipeline.cursor = { stageId: "build", state: "running", input: null, activatedBy: null };
    pipeline.runs[0]!.attempts.push({
      n: 1,
      state: "needs_decision",
      effectiveRole: { ...v3Role },
      launchId: null,
      conversationId: null,
      sessionId: null,
      agentPath: "/codex/stage.jsonl",
      paneId: null,
      flowId: null,
      startedAt: "2026-07-29T00:00:00.000Z",
      completedAt: null,
      input: null,
      activatedBy: null,
      output: null,
      verdict: null,
      error: pipeline.stateDetail,
    });
    fs.writeFileSync(path.join(sandbox, "pipelines.json"), JSON.stringify({
      schemaVersion: PIPELINES_SCHEMA_VERSION,
      pipelines: [pipeline],
    }), "utf8");

    const loaded = loadPipelines();
    expect(loaded[0]!.runs[0]!.attempts[0]!.verdictRecovery).toBeUndefined();
    savePipelines(loaded);
    expect(loadPipelines()).toEqual(loaded);
  });
});

test("a settled legacy terminal reap protects the attempts it already inspected", () => {
  sandboxed((sandbox) => {
    const pipeline = buildPipeline({
      id: "oldreap1",
      task: "task",
      project: "viewer",
      repoDir: "/repo",
      stages: v3Stages(),
      srcPath: null,
      srcConversationId: null,
      now: "2026-07-31T00:00:00.000Z",
    });
    pipeline.state = "completed";
    pipeline.cursor = null;
    pipeline.closedAt = "2026-07-31T00:20:00.000Z";
    pipeline.runs[0]!.attempts.push({
      n: 1,
      state: "passed",
      effectiveRole: { ...v3Role },
      launchId: "launch-old-reap",
      conversationId: "conversation_old_reap",
      sessionId: "session-old-reap",
      agentPath: "/codex/old-reap.jsonl",
      paneId: null,
      flowId: null,
      startedAt: "2026-07-31T00:00:00.000Z",
      completedAt: "2026-07-31T00:10:00.000Z",
      input: null,
      activatedBy: null,
      output: "done",
      verdict: { status: "pass" },
      error: null,
    });
    const legacy = JSON.parse(JSON.stringify(pipeline)) as Record<string, unknown>;
    legacy.terminalReap = {
      rounds: 1,
      stopped: 1,
      lastAt: "2026-07-31T00:20:00.000Z",
      settledAt: "2026-07-31T00:20:00.000Z",
    };
    fs.writeFileSync(path.join(sandbox, "pipelines.json"), JSON.stringify({
      schemaVersion: PIPELINES_SCHEMA_VERSION,
      pipelines: [legacy],
    }), "utf8");

    expect(loadPipelines()[0]!.terminalReap?.settledAttempts).toEqual(["build:1"]);
  });
});

test("a v2 registry migrates in memory preserving all attempt history (#353)", () => {
  sandboxed((sandbox) => {
    const pipeline = buildPipeline({ id: "mig00001", task: "task", project: "viewer", repoDir: "/repo", stages: v3Stages(), srcPath: null, srcConversationId: null, now: "now" });
    pipeline.state = "running";
    pipeline.baseBranch = "main";
    pipeline.baseRef = "48c739bbcc87b3244aee7fb0e2d1b3f8e312548f";
    pipeline.lastPassedCommit = pipeline.baseRef;
    const attempt = {
      n: 1, state: "passed", effectiveRole: { ...v3Role }, launchId: "l1", conversationId: "conversation_1",
      sessionId: "s1", agentPath: "/codex/a.jsonl", paneId: null, flowId: null, startedAt: "t0", completedAt: "t1",
      output: "built it", verdict: { status: "pass", confidence: 0.9 }, error: null,
    };
    /* Write the registry in the exact v2 shape: no onFail, no cursor/attempt
       relay fields, plus a zero-stage draft shell. */
    const v2Pipeline = JSON.parse(JSON.stringify(pipeline)) as Record<string, unknown>;
    for (const stage of (v2Pipeline.stages as Record<string, unknown>[])) delete stage.onFail;
    (v2Pipeline.runs as { attempts: unknown[] }[])[0]!.attempts = [attempt];
    v2Pipeline.cursor = { stageId: "verify", state: "pending", input: null, activatedBy: null };
    const shell = JSON.parse(JSON.stringify(buildPipeline({ id: "mig00002", task: "shell", project: "viewer", repoDir: "/repo", stages: [], srcPath: null, srcConversationId: null, now: "now", state: "draft" }))) as Record<string, unknown>;
    shell.baseBranch = ""; shell.baseRef = ""; shell.lastPassedCommit = "";
    fs.writeFileSync(path.join(sandbox, "pipelines.json"), JSON.stringify({ schemaVersion: 2, pipelines: [v2Pipeline, shell] }), "utf8");

    const loaded = loadPipelines();
    expect(loaded).toHaveLength(2);
    /* Every historical attempt field survives; the new fields are truthful nulls. */
    expect(loaded[0]!.runs[0]!.attempts[0]).toEqual({ ...attempt, expectedReviewHeadSha: null, reviewHeadSha: null, input: null, activatedBy: null } as never);
    expect(loaded[0]!.stages.every((stage) => stage.onFail === null)).toBe(true);
    expect(loaded[0]!.cursor).toEqual({ stageId: "verify", state: "pending", input: null, activatedBy: null });
    /* The empty draft shell is seeded with the default implement action. */
    expect(loaded[1]!.stages).toHaveLength(1);
    expect(loaded[1]!.stages[0]).toMatchObject({ kind: "run", prompt: "{{task}}", next: null, onFail: null });
    expect(loaded[1]!.cursor).toMatchObject({ stageId: loaded[1]!.stages[0]!.id, state: "pending" });
    /* Importing is read-only for the rollback file; demotion checkpoints it. */
    expect(JSON.parse(fs.readFileSync(path.join(sandbox, "pipelines.json"), "utf8")).schemaVersion).toBe(2);
    savePipelines(loaded);
    checkpointPipelineRollbackMirrorsForDemotion();
    expect(JSON.parse(fs.readFileSync(path.join(sandbox, "pipelines.json"), "utf8")).schemaVersion).toBe(PIPELINES_SCHEMA_VERSION);
    expect(loadPipelines()).toEqual(loaded);
  });
});

test("a legacy registry loads pipelines with an empty durable task binding", () => {
  sandboxed((sandbox) => {
    const pipeline = buildPipeline({
      id: "legacy01",
      task: "legacy task",
      project: "viewer",
      repoDir: "/repo",
      stages: v3Stages(),
      srcPath: null,
      srcConversationId: null,
      now: "now",
    });
    const legacy = JSON.parse(JSON.stringify(pipeline)) as Record<string, unknown>;
    delete legacy.taskIds;
    fs.writeFileSync(path.join(sandbox, "pipelines.json"), JSON.stringify({
      schemaVersion: 3,
      pipelines: [legacy],
    }), "utf8");

    const loaded = loadPipelines();

    expect((loaded[0] as Pipeline & { taskIds: string[] }).taskIds).toEqual([]);
    savePipelines(loaded);
    checkpointPipelineRollbackMirrorsForDemotion();
    expect(JSON.parse(fs.readFileSync(path.join(sandbox, "pipelines.json"), "utf8")).pipelines[0].taskIds).toEqual([]);

    fs.writeFileSync(path.join(sandbox, "pipelines.json"), JSON.stringify({
      schemaVersion: PIPELINES_SCHEMA_VERSION,
      pipelines: [legacy],
    }), "utf8");
    expect(loadPipelines()).toEqual(loaded);
  });
});

test("a v4 review-loop fail edge migrates without poisoning the pipeline registry", () => {
  sandboxed((sandbox) => {
    expect(PIPELINES_SCHEMA_VERSION).toBe(5);
    const pipeline = buildPipeline({
      id: "reviewv4",
      task: "legacy review edge",
      project: "viewer",
      repoDir: "/repo",
      stages: [
        { id: "build", kind: "run", prompt: "build", next: "review", effectiveRole: { ...v3Role } },
        { id: "review", kind: "review-loop", prompt: "review", next: null, onFail: { to: "build", maxRounds: 3 }, effectiveRole: { ...v3Role, access: "read-only" } },
      ],
      srcPath: null,
      srcConversationId: null,
      now: "2026-08-05T20:47:07.961Z",
    });
    fs.writeFileSync(path.join(sandbox, "pipelines.json"), JSON.stringify({
      schemaVersion: 4,
      pipelines: [pipeline],
    }), "utf8");

    const loaded = loadPipelines();
    expect(loaded[0]!.stages.find((stage) => stage.id === "review")!.onFail).toBeNull();

    const beforeWrite = JSON.parse(fs.readFileSync(path.join(sandbox, "pipelines.json"), "utf8"));
    expect(beforeWrite).toMatchObject({
      schemaVersion: 4,
      pipelines: [{ stages: [{ id: "build" }, { id: "review", onFail: { to: "build", maxRounds: 3 } }] }],
    });

    savePipelines(loaded);
    checkpointPipelineRollbackMirrorsForDemotion();
    expect(JSON.parse(fs.readFileSync(path.join(sandbox, "pipelines.json"), "utf8"))).toMatchObject({
      schemaVersion: 5,
      pipelines: [{ stages: [{ id: "build" }, { id: "review", onFail: null }] }],
    });
  });
});

test("v3 validation: acyclic pass edges, valid fail edges, 1–8 stage bounds (#353)", () => {
  sandboxed(() => {
    /* A one-stage non-draft pipeline is the minimum graph. */
    const single = buildPipeline({ id: "one00001", task: "task", project: "viewer", repoDir: "/repo", stages: [
      { id: "implement", kind: "run", prompt: "{{task}}", next: null, effectiveRole: { ...v3Role } },
    ], srcPath: null, srcConversationId: null, now: "now" });
    expect(() => savePipelines([single])).not.toThrow();

    /* Direct links + fail-edge cycles are legal: build → verify with verify
       failing back to build. */
    const cyclic = buildPipeline({ id: "cyc00001", task: "task", project: "viewer", repoDir: "/repo", stages: v3Stages(), srcPath: null, srcConversationId: null, now: "now" });
    cyclic.stages[1]!.onFail = { to: "build", maxRounds: 3 };
    expect(() => savePipelines([cyclic])).not.toThrow();

    /* A pass-edge cycle is rejected. */
    const passCycle = buildPipeline({ id: "bad00001", task: "task", project: "viewer", repoDir: "/repo", stages: v3Stages(), srcPath: null, srcConversationId: null, now: "now" });
    passCycle.stages[1]!.next = "build";
    expect(() => savePipelines([passCycle])).toThrow("malformed pipeline record");

    /* A fail edge to a missing stage or with an out-of-bounds budget is rejected. */
    const badTarget = buildPipeline({ id: "bad00002", task: "task", project: "viewer", repoDir: "/repo", stages: v3Stages(), srcPath: null, srcConversationId: null, now: "now" });
    badTarget.stages[0]!.onFail = { to: "missing", maxRounds: 3 };
    expect(() => savePipelines([badTarget])).toThrow("malformed pipeline record");
    const badBudget = buildPipeline({ id: "bad00003", task: "task", project: "viewer", repoDir: "/repo", stages: v3Stages(), srcPath: null, srcConversationId: null, now: "now" });
    badBudget.stages[0]!.onFail = { to: "verify", maxRounds: 10 };
    expect(() => savePipelines([badBudget])).toThrow("malformed pipeline record");

    /* 8 stages fit; 9 do not. */
    const wide = (count: number) => Array.from({ length: count }, (_, index) => ({
      id: `s${index}`, kind: "run" as const, prompt: "p", next: index + 1 < count ? `s${index + 1}` : null, effectiveRole: { ...v3Role },
    }));
    expect(() => savePipelines([buildPipeline({ id: "wide0008", task: "task", project: "viewer", repoDir: "/repo", stages: wide(8), srcPath: null, srcConversationId: null, now: "now" })])).not.toThrow();
    expect(() => savePipelines([buildPipeline({ id: "wide0009", task: "task", project: "viewer", repoDir: "/repo", stages: wide(9), srcPath: null, srcConversationId: null, now: "now" })])).toThrow("malformed pipeline record");

    /* A review-loop must stay pass-reachable from a run stage. */
    const orphanReview = buildPipeline({ id: "bad00004", task: "task", project: "viewer", repoDir: "/repo", stages: [
      { id: "review", kind: "review-loop", prompt: "review", next: null, effectiveRole: { ...v3Role, access: "read-only" } },
      { id: "build", kind: "run", prompt: "build", next: null, effectiveRole: { ...v3Role } },
    ], srcPath: null, srcConversationId: null, now: "now" });
    expect(() => savePipelines([orphanReview])).toThrow("malformed pipeline record");

    /* Review verdict recovery belongs to the bound flow, so a persisted
       review-loop fail edge is rejected before it can become unreachable. */
    const reviewFailEdge = buildPipeline({ id: "bad00005", task: "task", project: "viewer", repoDir: "/repo", stages: [
      { id: "build", kind: "run", prompt: "build", next: "review", effectiveRole: { ...v3Role } },
      { id: "review", kind: "review-loop", prompt: "review", next: null, onFail: { to: "build", maxRounds: 3 }, effectiveRole: { ...v3Role, access: "read-only" } },
    ], srcPath: null, srcConversationId: null, now: "now" });
    expect(() => savePipelines([reviewFailEdge])).toThrow("malformed pipeline record");
  });
});

test("an unconfirmed host record survives a round trip and rejects a malformed one (#670)", () => {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipelines-unconfirmed-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    const pipeline = buildPipeline({
      id: "abcdef13",
      task: "task",
      taskIds: [],
      project: "viewer",
      repoDir: "/repo",
      stages: [{ id: "build", kind: "run" as const, role: { roleId: "builder" as const }, engine: "codex" as const, model: "gpt-5.6-sol", effort: "medium", access: "read-write" as const, prompt: "build", next: null, effectiveRole: { roleId: "builder" as const, engine: "codex" as const, model: "gpt-5.6-sol", effort: "medium", access: "read-write" as const, promptScaffold: "builder" } }],
      srcPath: null,
      srcConversationId: "conversation_creator",
      now: "now",
    });
    pipeline.state = "closed";
    pipeline.cursor = null;
    pipeline.closedAt = "2026-07-25T00:00:00.000Z";
    pipeline.hiddenAt = null;
    pipeline.unconfirmedHosts = [{
      stageId: "build",
      attempt: 1,
      conversationId: "conversation_build",
      agentPath: null,
      paneId: null,
      operationId: "kill-op-1",
      detail: "kill accepted as queued but termination was not confirmed",
      at: "2026-07-25T00:00:00.000Z",
    }];
    savePipelines([pipeline]);

    expect(loadPipelines()[0]!.unconfirmedHosts).toEqual(pipeline.unconfirmedHosts);

    /* An empty list normalizes away, so a settled lane carries no marker. */
    savePipelines([{ ...pipeline, unconfirmedHosts: [] }]);
    expect(loadPipelines()[0]!.unconfirmedHosts).toBeUndefined();

    expect(() => savePipelines([{
      ...pipeline,
      unconfirmedHosts: [{ stageId: "build", attempt: "one" } as never],
    }])).toThrow();
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
  }
});

test("settled pipelines archive out of the hot registry and stay readable", async () => {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipelines-archive-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    const stages: PipelineStage[] = [
      { id: "build", kind: "run", prompt: "build", next: null, effectiveRole: { roleId: null, engine: "codex", model: "gpt-5.6-sol", effort: "medium", access: "read-write", promptScaffold: null } },
    ];
    const record = (id: string, overrides: Partial<Pipeline>): Pipeline => ({
      ...buildPipeline({ id, task: `task ${id}`, project: "viewer", repoDir: "/repo", stages, srcPath: null, srcConversationId: null, now: "2026-07-01T00:00:00.000Z" }),
      ...overrides,
    });
    const nowMs = Date.parse("2026-08-05T12:00:00.000Z");
    const oldClosed = record("aaaa0001", { state: "closed", closedAt: "2026-07-10T00:00:00.000Z", cursor: null });
    const freshClosed = record("aaaa0002", { state: "closed", closedAt: "2026-08-05T00:00:00.000Z", cursor: null });
    const hiddenDraft = record("aaaa0003", { state: "draft", hiddenAt: "2026-07-15T00:00:00.000Z" });
    const running = record("aaaa0004", { state: "running" });
    savePipelines([oldClosed, freshClosed, hiddenDraft, running]);

    expect(await archiveSettledPipelines(nowMs)).toBe(2);
    const hotIds = loadPipelines().map((pipeline) => pipeline.id).sort();
    expect(hotIds).toEqual(["aaaa0002", "aaaa0004"]);
    const archivedIds = loadArchivedPipelines().map((pipeline) => pipeline.id).sort();
    expect(archivedIds).toEqual(["aaaa0001", "aaaa0003"]);

    /* By-id reads still resolve archived records; re-sweeping is idempotent. */
    expect(findPipelineRecord("aaaa0001")?.task).toBe("task aaaa0001");
    expect(findPipelineRecord("aaaa0004")?.state).toBe("running");
    expect(findPipelineRecord("missing0")).toBeNull();
    expect(await archiveSettledPipelines(nowMs)).toBe(0);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("pipeline archival rolls back failures and publishes one cross-collection snapshot", async () => {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipelines-archive-atomic-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    const stages: PipelineStage[] = [{
      id: "build",
      kind: "run",
      "prompt": "build",
      next: null,
      effectiveRole: { roleId: null, engine: "codex", model: "gpt-5.6-sol", effort: "medium", access: "read-write", promptScaffold: null },
    }];
    const settled = buildPipeline({ id: "atomic01", task: "atomic", project: "viewer", repoDir: "/repo", stages, srcPath: null, srcConversationId: null, now: "2026-07-01T00:00:00.000Z" });
    settled.state = "closed";
    settled.closedAt = "2026-07-02T00:00:00.000Z";
    settled.cursor = null;
    savePipelines([settled]);
    const now = "2026-08-05T12:00:00.000Z";
    await expect(archiveSettledPipelines(Date.parse(now), {
      beforeCommit: () => { throw new Error("injected archive failure"); },
    })).rejects.toThrow("injected archive failure");
    expect(loadPipelines().map((pipeline) => pipeline.id)).toEqual([settled.id]);
    expect(loadArchivedPipelines()).toEqual([]);

    const ready = path.join(sandbox, "archive-ready");
    const release = path.join(sandbox, "archive-release");
    const child = Bun.spawn({
      cmd: [process.execPath, ARCHIVE_CHILD, ready, release, now],
      cwd: process.cwd(),
      env: { ...process.env, LLV_STATE_DIR: sandbox },
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForFile(ready);
    expect(loadPipelines().map((pipeline) => pipeline.id)).toEqual([settled.id]);
    expect(loadArchivedPipelines()).toEqual([]);
    fs.writeFileSync(release, "release");
    const exit = await child.exited;
    if (exit !== 0) throw new Error(`archive child failed: ${await new Response(child.stderr).text()}`);
    expect(loadPipelines()).toEqual([]);
    expect(loadArchivedPipelines().map((pipeline) => pipeline.id)).toEqual([settled.id]);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});


test.each(["pipelines", "pipelines_archive"])("startup strictly rereads %s despite warm caches and preserves corrupt rows", async (collection) => {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-startup-evidence-"));
  process.env.LLV_STATE_DIR = sandbox;
  let db: Database | undefined;
  try {
    const pipeline = buildPipeline({
      id: "aaaa0001", task: "startup evidence", project: "viewer", repoDir: "/repo",
      stages: [{ id: "build", kind: "run", prompt: "build", next: null, effectiveRole: { roleId: null, engine: "codex", model: "gpt-5.6-sol", effort: "medium", access: "read-write", promptScaffold: null } }],
      srcPath: null, srcConversationId: null, now: "2026-07-01T00:00:00.000Z",
    });
    pipeline.state = "closed";
    pipeline.closedAt = pipeline.createdAt;
    pipeline.cursor = null;
    savePipelines([pipeline]);
    if (collection === "pipelines_archive") await archiveSettledPipelines(Date.parse("2026-08-05T00:00:00.000Z"));
    expect(loadPipelinesForStartup()).toHaveLength(1);
    loadPipelines();
    db = new Database(path.join(sandbox, "state.sqlite"));
    const read = () => db!.query("SELECT value_json FROM state_rows WHERE collection=? AND row_key=?").get(collection, pipeline.id) as { value_json: string };
    const original = read().value_json;
    for (const corrupt of ["{broken", JSON.stringify({ ...pipeline, runs: null })]) {
      db.query("UPDATE state_rows SET value_json=? WHERE collection=? AND row_key=?").run(corrupt, collection, pipeline.id);
      expect(() => loadPipelinesForStartup()).toThrow();
      expect(read().value_json).toBe(corrupt);
      db.query("UPDATE state_rows SET value_json=? WHERE collection=? AND row_key=?").run(original, collection, pipeline.id);
      expect(loadPipelinesForStartup()).toHaveLength(1);
    }
    if (collection === "pipelines_archive") {
      db.query("UPDATE state_rows SET value_json=? WHERE collection=? AND row_key=?").run("{broken", collection, pipeline.id);
      expect(loadArchivedPipelines()).toEqual([]);
      expect(read().value_json).toBe("{broken");
    } else {
      db.query("INSERT INTO state_rows (collection,row_key,value_json,row_order,row_revision,controller_active) VALUES ('pipelines_archive',?,?,?,?,0)").run(pipeline.id, original, 0, 1);
      expect(() => loadPipelinesForStartup()).toThrow("contradictory identities");
      expect(read().value_json).toBe(original);
    }
  } finally {
    db?.close();
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});


test.each(["pipelines.json", "pipelines-archive.json"])("startup preserves malformed legacy %s evidence before migration", async (filename) => {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-startup-legacy-"));
  process.env.LLV_STATE_DIR = sandbox;
  const archive = path.join(sandbox, filename);
  try {
    expect(loadPipelinesForStartup()).toEqual([]); // ENOENT is valid empty evidence.
    for (const corrupt of ["null", "false", "[]", "{broken", JSON.stringify({ schemaVersion: PIPELINES_SCHEMA_VERSION, pipelines: [{}] })]) {
      fs.writeFileSync(archive, corrupt);
      expect(await withPipelineStartupAdmission(async (available) => available)).toBeFalse();
      expect(fs.readFileSync(archive, "utf8")).toBe(corrupt);
      expect(fs.existsSync(path.join(sandbox, "state.sqlite"))).toBeFalse();
    }
    fs.renameSync(archive, `${archive}.saved`);
    fs.mkdirSync(archive); // A read error is not absence.
    expect(await withPipelineStartupAdmission(async (available) => available)).toBeFalse();
    expect(fs.statSync(archive).isDirectory()).toBeTrue();
    expect(fs.existsSync(path.join(sandbox, "state.sqlite"))).toBeFalse();
    fs.renameSync(archive, `${archive}.unreadable`);
    fs.writeFileSync(archive, JSON.stringify({ schemaVersion: PIPELINES_SCHEMA_VERSION, pipelines: [] }));
    expect(await withPipelineStartupAdmission(async (available) => available)).toBeTrue();
    expect(loadPipelinesForStartup()).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});


test.each(["pipelines.json", "pipelines-archive.json"])("ordinary legacy %s reads retain null-as-empty compatibility", (filename) => {
  sandboxed((sandbox) => {
    fs.writeFileSync(path.join(sandbox, filename), "null");
    expect(() => loadPipelinesForStartup()).toThrow("must be an object");
    expect(filename === "pipelines.json" ? loadPipelines() : loadArchivedPipelines()).toEqual([]);
    expect(fs.readFileSync(path.join(sandbox, filename), "utf8")).toBe("null");
  });
});
