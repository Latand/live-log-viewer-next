import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildPipeline, loadPipelines, PIPELINES_SCHEMA_VERSION, savePipelines, withPipelineMutation } from "./store";
import type { PipelineStage } from "./types";

test("pipelines round-trip through a schema-versioned state file", () => {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipelines-store-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    const stages: PipelineStage[] = [
      { id: "build", kind: "run" as const, role: { roleId: "builder" }, engine: "codex" as const, prompt: "build", next: "review", effectiveRole: { roleId: "builder", engine: "codex", model: "gpt-5.6-sol", effort: "medium", access: "read-write", promptScaffold: "builder" } },
      { id: "review", kind: "review-loop" as const, role: { roleId: "reviewer" }, engine: "codex" as const, prompt: "review", next: null, effectiveRole: { roleId: "reviewer", engine: "codex", model: "gpt-5.6-sol", effort: "xhigh", access: "read-only", promptScaffold: "reviewer" } },
    ];
    const pipeline = buildPipeline({ id: "abcdef12", task: "task", spec: "AC1", project: "viewer", repoDir: "/repo", stages, srcPath: null, srcConversationId: null, now: "now" });
    savePipelines([pipeline]);
    expect(JSON.parse(fs.readFileSync(path.join(sandbox, "pipelines.json"), "utf8"))).toMatchObject({ schemaVersion: PIPELINES_SCHEMA_VERSION });
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
    expect(fs.existsSync(path.join(sandbox, "pipelines.json"))).toBe(false);
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
    expect(loaded[0]!.runs[0]!.attempts[0]).toEqual({ ...attempt, input: null, activatedBy: null } as never);
    expect(loaded[0]!.stages.every((stage) => stage.onFail === null)).toBe(true);
    expect(loaded[0]!.cursor).toEqual({ stageId: "verify", state: "pending", input: null, activatedBy: null });
    /* The empty draft shell is seeded with the default implement action. */
    expect(loaded[1]!.stages).toHaveLength(1);
    expect(loaded[1]!.stages[0]).toMatchObject({ kind: "run", prompt: "{{task}}", next: null, onFail: null });
    expect(loaded[1]!.cursor).toMatchObject({ stageId: loaded[1]!.stages[0]!.id, state: "pending" });
    /* Load is read-only: the file still says v2 until the next mutation. */
    expect(JSON.parse(fs.readFileSync(path.join(sandbox, "pipelines.json"), "utf8")).schemaVersion).toBe(2);
    savePipelines(loaded);
    expect(JSON.parse(fs.readFileSync(path.join(sandbox, "pipelines.json"), "utf8")).schemaVersion).toBe(PIPELINES_SCHEMA_VERSION);
    expect(loadPipelines()).toEqual(loaded);
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
  });
});
