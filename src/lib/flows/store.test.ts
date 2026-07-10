import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry } from "@/lib/agent/registry";
import { CODEX_SOL_MODEL, CODEX_TERRA_MODEL } from "@/lib/agent/models";

import { loadFlows, mergeSeededPresets, reconcileFlowConversationOwnership, saveFlows } from "./store";
import type { Flow, FlowPreset } from "./types";

const LEGACY_DEFAULT: FlowPreset = {
  name: "Codex high → Fable",
  implementer: { engine: "codex", model: null, effort: "high" },
  reviewer: { engine: "claude", model: "fable", effort: null },
};

test("seed migration replaces an untouched legacy preset with Terra and Sol roles", () => {
  const presets = mergeSeededPresets([LEGACY_DEFAULT]);
  expect(presets.some((preset) => preset.name === LEGACY_DEFAULT.name)).toBe(false);
  expect(presets[0]).toEqual({
    name: "Terra high → Sol xhigh",
    implementer: { engine: "codex", model: CODEX_TERRA_MODEL, effort: "high" },
    reviewer: { engine: "codex", model: CODEX_SOL_MODEL, effort: "xhigh" },
  });
});

test("seed migration preserves a customized preset", () => {
  const custom = { ...LEGACY_DEFAULT, reviewer: { engine: "claude" as const, model: "fable", effort: "max" } };
  expect(mergeSeededPresets([custom])).toContainEqual(custom);
});

test("flow bindings follow active conversation generations", () => {
  const previousState = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-flow-owner-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    const registry = new AgentRegistry(path.join(sandbox, "registry.json"));
    const implementer = registry.ensureConversation("codex", "/implementer-a.jsonl", "a");
    registry.setConversationMigration(implementer.id, { intentId: "impl", phase: "verifying", targetId: "b", revision: 1, error: null, updatedAt: "now" });
    registry.commitSuccessor(implementer.id, { id: "implementer-b", path: "/implementer-b.jsonl", accountId: "b" }, 1);
    const reviewer = registry.ensureConversation("codex", "/reviewer-a.jsonl", "a");
    registry.setConversationMigration(reviewer.id, { intentId: "review", phase: "verifying", targetId: "b", revision: 1, error: null, updatedAt: "now" });
    registry.commitSuccessor(reviewer.id, { id: "reviewer-b", path: "/reviewer-b.jsonl", accountId: "b" }, 1);
    const flow = {
      id: "owner-flow",
      template: "implement-review-loop",
      project: "repo",
      cwd: "/repo",
      implementerPath: "/implementer-a.jsonl",
      implementerConversationId: implementer.id,
      roles: { implementer: { engine: "codex", model: null, effort: "high" }, reviewer: { engine: "codex", model: null, effort: "xhigh" } },
      baseRef: "base",
      baseMode: "head",
      mode: "manual",
      reviewerMode: "headless",
      roundLimit: 1,
      state: "closed",
      pausedState: null,
      stateDetail: null,
      rounds: [{ n: 1, reviewerPath: "/reviewer-a.jsonl", reviewerConversationId: reviewer.id }],
      createdAt: "now",
      closedAt: "now",
    } as Flow;
    saveFlows([flow]);

    reconcileFlowConversationOwnership(registry);

    expect(loadFlows()[0]).toMatchObject({
      implementerPath: "/implementer-b.jsonl",
      implementerConversationId: implementer.id,
      rounds: [{ reviewerPath: "/reviewer-b.jsonl", reviewerConversationId: reviewer.id }],
    });
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
