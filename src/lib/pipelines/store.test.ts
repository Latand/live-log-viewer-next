import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildPipeline, loadPipelines, PIPELINES_SCHEMA_VERSION, savePipelines } from "./store";
import type { PipelineStage } from "./types";

test("pipelines round-trip through a schema-versioned state file", () => {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-pipelines-store-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    const stages: PipelineStage[] = [
      { id: "build", kind: "run" as const, role: { roleId: "builder" }, engine: "codex" as const, prompt: "build", next: "review" },
      { id: "review", kind: "review-loop" as const, role: { roleId: "reviewer" }, engine: "codex" as const, prompt: "review", next: null },
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
