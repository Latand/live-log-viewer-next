import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AgentRegistry } from "@/lib/agent/registry";
import { CODEX_SOL_MODEL, CODEX_TERRA_MODEL } from "@/lib/agent/models";

import { configuredReviewerFallback, FLOWS_SCHEMA_VERSION, loadFlows, mergeSeededPresets, reconcileFlowConversationOwnership, reconcileFlowConversationOwnershipCooperatively, saveFlows, seededPresetsFromRoles } from "./store";
import type { Flow, FlowPreset } from "./types";

const LEGACY_DEFAULT: FlowPreset = {
  name: "Codex high → Fable",
  implementer: { engine: "codex", model: null, effort: "high" },
  reviewer: { engine: "claude", model: "fable", effort: null },
};

test("seed migration replaces an untouched legacy preset with Sol and Sol roles", () => {
  const presets = mergeSeededPresets([LEGACY_DEFAULT]);
  expect(presets.some((preset) => preset.name === LEGACY_DEFAULT.name)).toBe(false);
  expect(presets[0]).toMatchObject({
    name: "Sol medium → Sol xhigh",
    implementer: { engine: "codex", model: CODEX_SOL_MODEL, effort: "medium" },
    reviewer: { engine: "codex", model: CODEX_SOL_MODEL, effort: "xhigh" },
  });
});

test("seed migration preserves a customized preset", () => {
  const custom = { ...LEGACY_DEFAULT, reviewer: { engine: "claude" as const, model: "fable", effort: "max" } };
  expect(mergeSeededPresets([custom])).toContainEqual(custom);
});

test("flow preset seeds derive their canonical roles from the role registry", () => {
  const presets = seededPresetsFromRoles();
  expect(presets.find((preset) => preset.name === "Sol medium → Sol xhigh")).toMatchObject({
    name: "Sol medium → Sol xhigh",
    implementer: { engine: "codex", model: CODEX_SOL_MODEL, effort: "medium" },
    reviewer: { engine: "codex", model: CODEX_SOL_MODEL, effort: "xhigh" },
  });
});

test("managed flow seeds refresh while an unmarked same-name edit wins", () => {
  const first = seededPresetsFromRoles();
  const refreshed = structuredClone(first);
  refreshed[0]!.implementer.effort = "high";
  expect(mergeSeededPresets(first, refreshed)[0]!.implementer.effort).toBe("high");

  const custom = { ...structuredClone(first[0]!), managed: undefined, implementer: { ...first[0]!.implementer, effort: "low" } };
  expect(mergeSeededPresets([custom], refreshed)).toContainEqual(custom);
});

test("flow preset seeds fall back to the role default when a saved builder override is semantically invalid", () => {
  const previousState = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-flow-bad-override-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    /* saveRoleOverrides refuses this override on this branch, so the bytes
       land via a hand-edit; the fail-closed loader rejects the file and
       seeding degrades to the built-in defaults either way. */
    fs.writeFileSync(
      path.join(sandbox, "role-presets.json"),
      JSON.stringify({ schemaVersion: 1, overrides: { builder: { config: { model: "not-a-gpt-model" } } } }),
      "utf8",
    );
    expect(() => seededPresetsFromRoles()).not.toThrow();
    expect(seededPresetsFromRoles().find((preset) => preset.name === "Sol medium → Sol xhigh")?.implementer).toEqual({
      engine: "codex",
      model: CODEX_SOL_MODEL,
      effort: "medium",
    });
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("an untouched pre-registry flow preset migrates to the current role config", () => {
  const previous = {
    name: "Terra high → Fable",
    implementer: { engine: "codex" as const, model: CODEX_TERRA_MODEL, effort: "high" },
    reviewer: { engine: "claude" as const, model: "fable", effort: null },
  };
  expect(mergeSeededPresets([previous]).find((preset) => preset.name === "Sol medium → Fable")?.reviewer).toEqual({
    engine: "claude",
    model: "fable",
    effort: "high",
  });
});

test("flow specs persist in the versioned state file and legacy flow entries load", () => {
  const previousState = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-flow-spec-"));
  process.env.LLV_STATE_DIR = sandbox;
  const flow = {
    id: "spec-flow",
    template: "implement-review-loop",
    project: "repo",
    cwd: "/repo",
    implementerPath: "/implementer.jsonl",
    roles: { implementer: { engine: "codex" as const, model: null, effort: "high" }, reviewer: { engine: "codex" as const, model: null, effort: "xhigh" } },
    baseRef: "base",
    baseMode: "head" as const,
    mode: "auto" as const,
    reviewerMode: "headless" as const,
    roundLimit: 5,
    state: "waiting_ready" as const,
    stateDetail: null,
    rounds: [],
    createdAt: "now",
    closedAt: null,
  } satisfies Flow;
  try {
    saveFlows([{ ...flow, spec: "Ship the feature\nAC1: Reviewer receives this context" }]);
    expect(JSON.parse(fs.readFileSync(path.join(sandbox, "flows.json"), "utf8"))).toMatchObject({
      schemaVersion: FLOWS_SCHEMA_VERSION,
      flows: [{ spec: "Ship the feature\nAC1: Reviewer receives this context" }],
    });

    fs.writeFileSync(path.join(sandbox, "flows.json"), JSON.stringify({ flows: [flow] }));
    expect(loadFlows()).toEqual([{
      ...flow,
      implementerConversationId: null,
      reviewerFallback: configuredReviewerFallback(),
      pausedState: null,
      kickoffDelivery: null,
    }]);
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
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

test("a path-only flow resolves every resume generation in one reconciliation", () => {
  const previousState = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-flow-resume-chain-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    const registry = new AgentRegistry(path.join(sandbox, "registry.json"));
    const paths = [
      "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1326.jsonl",
      "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1327.jsonl",
      "/sessions/rollout-019f4906-3f67-7b72-9fbc-9ec3b5ad1328.jsonl",
    ];
    const conversation = registry.ensureConversation("codex", paths[0]!, "a");
    for (const pathname of paths.slice(1)) {
      const begun = registry.beginSpawnRequest({
        engine: "codex",
        cwd: "/repo",
        accountId: "a",
        conversationId: conversation.id,
        purpose: "resume-successor",
      });
      if (begun.kind !== "created") throw new Error("expected create");
      registry.settleSpawn(begun.receipt.launchId, {
        key: { engine: "codex", sessionId: pathname.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)![0]! },
        artifactPath: pathname,
        cwd: "/repo",
        accountId: "a",
        status: "live",
        host: null,
        claimEpoch: 0,
        claimOwner: null,
        pendingAction: null,
      });
    }
    saveFlows([{
      id: "resume-chain-flow",
      template: "implement-review-loop",
      project: "repo",
      cwd: "/repo",
      implementerPath: paths[0]!,
      implementerConversationId: null,
      roles: { implementer: { engine: "codex", model: null, effort: "high" }, reviewer: { engine: "codex", model: null, effort: "xhigh" } },
      baseRef: "base",
      baseMode: "head",
      mode: "manual",
      reviewerMode: "headless",
      roundLimit: 1,
      state: "waiting_ready",
      pausedState: null,
      stateDetail: null,
      rounds: [],
      createdAt: "now",
      closedAt: null,
    } as Flow]);

    reconcileFlowConversationOwnership(registry);

    expect(loadFlows()[0]).toMatchObject({
      implementerConversationId: conversation.id,
      implementerPath: paths[2],
    });
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("cooperative ownership reconciliation preserves a flow closed during a yield", async () => {
  const previousState = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-flow-ownership-race-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    const registry = new AgentRegistry(path.join(sandbox, "registry.json"));
    const owner = registry.ensureConversation("codex", "/implementer-a.jsonl", "a");
    registry.setConversationMigration(owner.id, { intentId: "impl", phase: "verifying", targetId: "b", revision: 1, error: null, updatedAt: "now" });
    registry.commitSuccessor(owner.id, { id: "implementer-b", path: "/implementer-b.jsonl", accountId: "b" }, 1);
    const flows = Array.from({ length: 17 }, (_, index): Flow => ({
      id: `ownership-race-${index}`,
      template: "implement-review-loop",
      project: "repo",
      cwd: "/repo",
      implementerPath: "/implementer-a.jsonl",
      implementerConversationId: owner.id,
      roles: { implementer: { engine: "codex", model: null, effort: "high" }, reviewer: { engine: "codex", model: null, effort: "xhigh" } },
      baseRef: "base",
      baseMode: "head",
      mode: "manual",
      reviewerMode: "headless",
      roundLimit: 1,
      state: "waiting_ready",
      pausedState: null,
      stateDetail: null,
      rounds: [],
      createdAt: "now",
      closedAt: null,
    }));
    saveFlows(flows);

    const reconciliation = reconcileFlowConversationOwnershipCooperatively(registry);
    await new Promise<void>((resolve) => setImmediate(() => {
      const current = loadFlows();
      current[0] = { ...current[0]!, state: "closed", closedAt: "closed-during-yield" };
      saveFlows(current);
      resolve();
    }));
    await reconciliation;

    expect(loadFlows()[0]).toMatchObject({
      state: "closed",
      closedAt: "closed-during-yield",
      implementerPath: "/implementer-b.jsonl",
      implementerConversationId: owner.id,
    });
  } finally {
    if (previousState === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previousState;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("seed presets survive an unreadable role overrides file", () => {
  const previous = process.env.LLV_STATE_DIR;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-flow-seed-corrupt-"));
  process.env.LLV_STATE_DIR = sandbox;
  try {
    fs.writeFileSync(path.join(sandbox, "role-presets.json"), "{", "utf8");
    expect(seededPresetsFromRoles().find((preset) => preset.name === "Sol medium → Sol xhigh")).toMatchObject({
      implementer: { engine: "codex", model: CODEX_SOL_MODEL, effort: "medium" },
    });
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR;
    else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
