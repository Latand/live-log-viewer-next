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
    pipeline.cursor = { stageId: "build", state: "running" };
    expect(() => savePipelines([pipeline])).toThrow("malformed pipeline record");
    expect(fs.existsSync(path.join(sandbox, "pipelines.json"))).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
